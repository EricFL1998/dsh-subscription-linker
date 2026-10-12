/**
 * Loopback OAuth: PKCE helpers plus a temporary local redirect listener.
 *
 * Providers that complete authorization in the browser (xAI, Google) redirect to
 * a `127.0.0.1` URL this process owns for the duration of one attempt. The
 * authorization code never leaves the machine, and `state` is validated before
 * the code is accepted so a stray or replayed redirect cannot settle the login.
 *
 * @module dsh-plugin-subscription-oauth/auth/pkce-flow
 */

import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { RequestListener, Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { LoginPrompt } from '../protocol.js'
import type { AuthAttempt, AuthFlow } from './flow.js'
import type { SessionBase } from './store.js'

/** One PKCE verifier/challenge pair; the verifier stays local until exchange. */
export interface PkcePair {
  verifier: string
  challenge: string
}

/** Mint a fresh PKCE pair (32-byte verifier, S256 challenge). */
export function createPkce(): PkcePair {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** Mint a random OAuth `state` value. */
export function randomState(): string {
  return randomBytes(32).toString('base64url')
}

/** Inputs an authorize-URL builder needs for one attempt. */
export interface LoopbackAuthorizeInput {
  /** Loopback redirect URI pointing at the temporary listener. */
  redirectUri: string
  state: string
  pkce: PkcePair
}

/** Inputs a token exchange needs once the code arrives. */
export interface LoopbackExchangeInput<S extends SessionBase> {
  code: string
  redirectUri: string
  pkce: PkcePair
  state: string
  /** Aborts when the attempt is cancelled or times out. */
  signal: AbortSignal
}
/** Static facts of one provider's loopback flow. */
export interface LoopbackFlowSpec<S extends SessionBase> {
  /** Ports tried in order; the first free one wins. */
  readonly ports: readonly number[]
  /** Path the provider redirects to. */
  readonly callbackPath: string
  /** Attempt lifetime; defaults to three minutes. */
  readonly timeoutMs?: number
  /**
   * Resolve anything `buildAuthorizeUrl` needs but only an async step can fetch,
   * such as OIDC discovery endpoints. Called before the listener is opened.
   */
  prepare?(): Promise<void>
  /** Build the URL the user's browser opens. */
  buildAuthorizeUrl(input: LoopbackAuthorizeInput): string
  /** Exchange the authorization code for a session. */
  exchange(input: LoopbackExchangeInput<S>): Promise<S>
}

/** Attempt lifetime when a spec names none. */
export const DEFAULT_FLOW_TIMEOUT_MS = 180_000

/** Message every cancelled attempt rejects with. */
export const LOGIN_CANCELLED_MESSAGE = 'login cancelled'

const SUCCESS_PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>Login successful</title></head>'
  + '<body style="font-family:sans-serif"><h1>Login successful</h1>'
  + '<p>You can close this tab and return to DeepSeek Harness.</p></body></html>'

/** One bound listener set: every address family answers the same handler. */
interface BoundServers {
  servers: Server[]
  port: number
}

/**
 * Addresses one listen host covers.
 *
 * `localhost` resolves to `::1` or `127.0.0.1` depending on the client, and a
 * listener binds exactly one family per call — a browser picking the other gets
 * connection-refused and the login times out, so both families must serve.
 */
function listenHosts(host: string): readonly string[] {
  return host === 'localhost' ? ['127.0.0.1', '::1'] : [host]
}

/** True when an address family simply does not exist here (safe to skip). */
function familyUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EADDRNOTAVAIL' || code === 'EPROTONOSUPPORT'
}

/** Listen on the first port free on every loopback family. */
async function listen(handler: RequestListener, host: string, ports: readonly number[]): Promise<BoundServers> {
  const hosts = listenHosts(host)
  let lastError: unknown
  for (const candidate of ports) {
    const servers: Server[] = []
    let port = candidate
    let unusable = false
    for (const address of hosts) {
      const server = createServer(handler)
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error): void => reject(error)
          server.once('error', onError)
          server.listen(port, address, () => {
            server.removeListener('error', onError)
            resolve()
          })
        })
        const bound = server.address() as AddressInfo | null
        if (bound === null) throw new Error(`callback listener on ${address}:${String(port)} has no address`)
        if (port === 0) port = bound.port
        servers.push(server)
      } catch (error: unknown) {
        server.close()
        if (familyUnavailable(error)) continue
        lastError = error
        unusable = true
        break
      }
    }
    if (unusable || servers.length === 0) {
      for (const server of servers) server.close()
      continue
    }
    return { servers, port }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`callback listener could not bind ${host} (ports ${ports.join(', ')})`)
}

/**
 * Owns at most one in-flight loopback login per provider.
 *
 * A listener is created per attempt and closed as soon as the attempt settles,
 * so nothing stays open on this machine between logins.
 */
export class LoopbackFlow<S extends SessionBase> implements AuthFlow<S> {
  private readonly attempts = new Map<string, AuthAttempt<S>>()

  /**
   * @param key - provider route key, so one attempt runs at a time per route.
   * @param spec - static flow facts for this provider.
   */
  constructor(
    private readonly key: string,
    private readonly spec: LoopbackFlowSpec<S>,
    private readonly host = '127.0.0.1',
  ) {}

  pending(): AuthAttempt<S> | undefined {
    return this.attempts.get(this.key)
  }

  async start(): Promise<AuthAttempt<S>> {
    if (this.attempts.has(this.key)) {
      throw new Error(`a ${this.key} login attempt is already in progress`)
    }
    const pkce = createPkce()
    const state = randomState()
    const timeoutMs = this.spec.timeoutMs ?? DEFAULT_FLOW_TIMEOUT_MS
    const controller = new AbortController()
    // Discovery-backed specs resolve their endpoints before anything is bound.
    await this.spec.prepare?.()

    let settle!: (session: S) => void
    let fail!: (error: Error) => void
    const session = new Promise<S>((resolve, reject) => {
      settle = resolve
      fail = reject
    })
    session.catch(() => undefined)

    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let servers: Server[] = []
    /** The bound port, known once the listener is up; the handler runs later. */
    let port = 0
    const finish = (error?: Error, value?: S): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      for (const server of servers) {
        server.close()
        server.closeAllConnections()
      }
      this.attempts.delete(this.key)
      controller.abort()
      if (error !== undefined) fail(error)
      else if (value !== undefined) settle(value)
    }

    const handler: RequestListener = (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname !== this.spec.callbackPath) {
        response.writeHead(404, { 'content-type': 'text/plain' })
        response.end('not found')
        return
      }
      const reported = url.searchParams.get('error_description') ?? url.searchParams.get('error')
      if (reported !== null) {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end('<!doctype html><html><body><h1>Login failed</h1></body></html>')
        finish(new Error(`authorization failed: ${reported}`))
        return
      }
      if (url.searchParams.get('state') !== state) {
        // A stray or replayed redirect must not kill the real attempt.
        response.writeHead(400, { 'content-type': 'text/plain' })
        response.end('state mismatch')
        return
      }
      const code = url.searchParams.get('code')
      if (code === null || code.length === 0) {
        response.writeHead(400, { 'content-type': 'text/plain' })
        response.end('missing authorization code')
        return
      }
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(SUCCESS_PAGE)
      const redirectUri = `http://${this.host}:${String(port)}${this.spec.callbackPath}`
      void this.spec.exchange({ code, redirectUri, pkce, state, signal: controller.signal })
        .then((session) => { finish(undefined, session) })
        .catch((error: unknown) => {
          finish(error instanceof Error ? error : new Error(String(error)))
        })
    }

    const bound = await listen(handler, this.host, this.spec.ports)
    servers = bound.servers
    port = bound.port
    const redirectUri = `http://${this.host}:${String(port)}${this.spec.callbackPath}`

    timer = setTimeout(() => {
      finish(new Error(`login timed out after ${String(Math.round(timeoutMs / 1000))}s`))
    }, timeoutMs)
    timer.unref?.()

    const prompt: LoginPrompt = { url: this.spec.buildAuthorizeUrl({ redirectUri, state, pkce }), expiresAt: Date.now() + timeoutMs, mode: 'open-url' }
    const attempt: AuthAttempt<S> = {
      prompt,
      session,
      cancel: () => { finish(new Error(LOGIN_CANCELLED_MESSAGE)) },
    }
    this.attempts.set(this.key, attempt)
    return attempt
  }
}

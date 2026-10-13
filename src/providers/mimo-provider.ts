/**
 * The `mimo` provider route's wiring: credential store, Xiaomi QR/password
 * login, model catalog, and its Settings card facts.
 *
 * @module dsh-plugin-subscription-oauth/providers/mimo-provider
 */

import { REAUTH_REQUIRED, ProviderError } from '../errors.js'
import { TokenStore } from '../auth/store.js'
import { TokenManager } from '../auth/tokens.js'
import type { AuthAttempt, AuthFlow } from '../auth/flow.js'
import { LOGIN_CANCELLED_MESSAGE } from '../auth/device-flow.js'
import {
  finishMimoSignIn,
  mimoCredentialsFrom,
  readMimoUsage,
  refreshMimoSession,
  startMimoSignIn,
  waitMimoPoll,
  type MimoCredentials,
} from '../auth/mimo-flow.js'
import {
  MimoAdapter,
  MIMO_CODE_URL,
  MIMO_CONTEXT_WINDOW,
  MIMO_DEFAULT_MODEL,
  MIMO_MODELS,
  MIMO_PROVIDER_ID,
  MIMO_PROVIDER_NAME,
  parseMimoSession,
  type MimoSession,
} from './mimo.js'
import type { ProviderSpec } from '../auth/provider-controller.js'
import { ProviderController } from '../auth/provider-controller.js'
import type { ProviderRoute } from '../auth/registry.js'
import type { ModelPreferences } from '../settings.js'
import { proxiedFetch } from '../http.js'
import type { FetchFn } from '../http.js'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { UsageWindow } from '../protocol.js'

/** Everything the MiMo route needs from the plugin configuration. */
export interface MimoProviderOptions {
  /** Absolute path of `auth.json`. */
  credentialFile: string
  /** Abandon a stream after this much silence. */
  streamIdleTimeoutMs: number
  /** Model the picker preselects. */
  defaultModel?: string
  /** Shared model-visibility preferences. */
  preferences: ModelPreferences
  /** Resolve the attachment service per request. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Invoked when the catalog or its visibility changed. */
  onCatalogChanged?: () => void
  onWarn?: (message: string) => void
  /** Fetch implementation; defaults to the proxy-aware fetch. */
  fetchFn?: FetchFn
}

/** Wait, honouring cancellation. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error(LOGIN_CANCELLED_MESSAGE))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(new Error(LOGIN_CANCELLED_MESSAGE))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Build the `mimo` route: its adapter and its login/lifecycle controller.
 *
 * @param options - resolved endpoints, paths, and shared services.
 * @returns the route, ready to register and to serve over RPC.
 */
export function createMimoProvider(options: MimoProviderOptions): ProviderRoute {
  const fetchFn = options.fetchFn ?? proxiedFetch
  const store = new TokenStore<MimoSession>(options.credentialFile, MIMO_PROVIDER_ID, parseMimoSession)

  const toSession = (
    creds: MimoCredentials,
    cookies: Record<string, string>,
    userId: string,
  ): MimoSession => ({
    accessToken: JSON.stringify(cookies),
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    accountId: userId,
    apiBase: creds.base,
    mimoCreds: JSON.stringify(creds),
    mimoCookies: JSON.stringify(cookies),
    region: creds.region,
  })

  /** The in-flight attempt, so `pending()` is stable across calls. */
  let current: AuthAttempt<MimoSession> | undefined

  const flow: AuthFlow<MimoSession> = {
    async start(): Promise<AuthAttempt<MimoSession>> {
      const start = await startMimoSignIn(fetchFn)
      const controller = new AbortController()
      const session = (async (): Promise<MimoSession> => {
        while (true) {
          if (controller.signal.aborted) throw new Error(LOGIN_CANCELLED_MESSAGE)
          const poll = await waitMimoPoll(start, fetchFn)
          if (poll !== undefined) {
            const { creds, cookies } = await finishMimoSignIn(poll, start.device, fetchFn)
            return toSession(creds, cookies, creds.userId)
          }
          await sleep(1000, controller.signal)
        }
      })()
      const attempt: AuthAttempt<MimoSession> = {
        prompt: {
          url: start.url,
          expiresAt: start.until,
          mode: 'open-url',
        },
        session,
        cancel: () => { controller.abort() },
      }
      current = attempt
      void session.catch(() => undefined).finally(() => {
        if (current === attempt) current = undefined
      })
      return attempt
    },
    pending(): AuthAttempt<MimoSession> | undefined {
      return current
    },
  }

  const tokens = new TokenManager<MimoSession>({
    store,
    displayName: MIMO_PROVIDER_NAME,
    // The app signs on again after a day; renew a little ahead of that.
    preemptMs: 10 * 60 * 1000,
    refresh: async (session) => {
      let creds: MimoCredentials
      try {
        creds = JSON.parse(session.mimoCreds) as MimoCredentials
      } catch {
        throw new ProviderError(`${MIMO_PROVIDER_NAME} sign-in has expired; connect the account again`, REAUTH_REQUIRED)
      }
      try {
        const renewed = await refreshMimoSession(creds, fetchFn)
        return { accessToken: JSON.stringify(renewed.cookies), expiresAt: renewed.expiresAt }
      } catch (error) {
        if (error instanceof Error && /lapsed/i.test(error.message)) {
          throw new ProviderError(`${MIMO_PROVIDER_NAME} sign-in has expired; connect the account again`, REAUTH_REQUIRED)
        }
        throw error
      }
    },
  })

  const adapter = new MimoAdapter({
    streamIdleTimeoutMs: options.streamIdleTimeoutMs,
    tokens,
    ...options.onWarn === undefined ? {} : { onWarn: options.onWarn },
    ...options.resolveAttachments === undefined ? {} : { resolveAttachments: options.resolveAttachments },
    hiddenModels: () => options.preferences.hiddenIds(MIMO_PROVIDER_ID),
    userModels: () => options.preferences.extraIds(MIMO_PROVIDER_ID),
    fetchFn,
  })

  const spec: ProviderSpec<MimoSession> = {
    id: MIMO_PROVIDER_ID,
    displayName: MIMO_PROVIDER_NAME,
    codeUrl: MIMO_CODE_URL,
    credentialFile: options.credentialFile,
    // MiMo ships a fixed two-model catalog; there is no discovery endpoint.
    discovery: false,
    defaultModel: options.defaultModel ?? MIMO_DEFAULT_MODEL,
    catalog: () => adapter.catalogEntries(),
    catalogOwn: () => adapter.ownCatalogEntries(),
    fallbackContextWindow: MIMO_CONTEXT_WINDOW,
    discover: () => Promise.resolve(undefined),
    usage: async (_accessToken, account) => {
      const held = await store.get(account)
      if (held === undefined) return undefined
      let creds: MimoCredentials
      let cookies: Record<string, string>
      try {
        creds = JSON.parse(held.mimoCreds) as MimoCredentials
        cookies = JSON.parse(held.mimoCookies) as Record<string, string>
      } catch {
        return undefined
      }
      const read = await readMimoUsage({ cookies, userId: creds.userId }, creds, fetchFn)
      return { plan: read.plan, ...read.renewsAt === undefined ? {} : { renewsAt: read.renewsAt }, windows: read.windows }
    },
    details: () => [
      { key: 'provider', value: MIMO_PROVIDER_NAME },
      { key: 'credentialFile', value: options.credentialFile },
    ],
    applyDiscovery: () => {},
  }

  const controller = new ProviderController<MimoSession>({
    spec,
    store,
    tokens,
    flow,
    preferences: options.preferences,
    ...options.onCatalogChanged === undefined ? {} : { onCatalogChanged: options.onCatalogChanged },
    ...options.onWarn === undefined ? {} : { onWarn: options.onWarn },
  })

  return {
    id: controller.id,
    displayName: controller.displayName,
    credentialFile: controller.credentialFile,
    adapter,
    status: () => controller.status(),
    login: (account?: string) => controller.login(account),
    cancel: () => controller.cancel(),
    logout: (account?: string) => controller.logout(account),
    setDefault: (account: string) => controller.setDefault(account),
    refresh: (account?: string) => controller.refresh(account),
    discover: (force?: boolean) => controller.discover(force),
    setModelVisible: (id: string, visible: boolean) => controller.setModelVisible(id, visible),
    setModelOrder: (ids: readonly string[]) => controller.setModelOrder(ids),
    addModel: (id: string) => controller.addModel(id),
    removeModel: (id: string) => controller.removeModel(id),
    usage: (force?: boolean) => controller.usage(force),
    reload: () => controller.reload(),
  }
}

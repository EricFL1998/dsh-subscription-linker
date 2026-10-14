/** The grok route: OIDC discovery, token handling, catalog, and the wire. */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createUserMessage, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

import { REAUTH_REQUIRED, ProviderError } from '../src/errors.js'
import type { TokenManager } from '../src/auth/tokens.js'
import {
  createGrokDiscovery,
  exchangeGrokCode,
  fastWordOf,
  GROK_CALLBACK_PORT,
  GROK_CLIENT_ID,
  GROK_DISCOVERY_URL,
  GROK_MODELS,
  GROK_SCOPE,
  GrokAdapter,
  identityFromGrokTokens,
  parseGrokSession,
  parseGrokTokenPayload,
  refreshGrokToken,
} from '../src/providers/grok.js'
import type { GrokAdapterOptions, GrokSession } from '../src/providers/grok.js'
import { createPkce } from '../src/auth/pkce-flow.js'

/** Build an unsigned JWT whose payload carries the given claims. */
function jwtWithClaims(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${header}.${payload}.signature`
}

/** A token manager that always answers with one usable token. */
function tokenManager(resolve?: TokenManager<GrokSession>['resolve']): TokenManager<GrokSession> {
  const manager = {
    resolve: resolve ?? (async () => ({ account: 'user-1', accessToken: 'token', expiresAt: Date.now() + 60_000 })),
    session: async () => ({ account: 'user-1', session: { accessToken: 'token', expiresAt: Date.now() + 60_000 } }),
    accounts: async () => ['user-1'],
    defaultAccount: async () => 'user-1',
  }
  return manager as unknown as TokenManager<GrokSession>
}

/** Adapter options with the given overrides. */
function adapterOptions(overrides: Partial<GrokAdapterOptions> = {}): GrokAdapterOptions {
  return {
    apiBase: 'https://api.x.ai/v1',
    discovery: false,
    streamIdleTimeoutMs: 5_000,
    tokens: tokenManager(),
    ...overrides,
  }
}

/** A minimal one-turn request. */
function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'grok',
    model: 'grok-4.6',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })],
    ...overrides,
  }
}

/** Collect every chunk a stream produces. */
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** An SSE response body for the given event objects. */
function sseResponse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** A JSON response. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * A realistic cached payload: the public `/models` rows plus the account's CLI catalog.
 *
 * It mirrors what the two live endpoints really answer: the public list enumerates the
 * models (including an image model and a wide-context variant) and states a display name,
 * while the CLI catalog — the only surface that names a fast variant — states the window
 * and reasoning ladder.
 */
function cachedPayload() {
  return {
    public: [
      { id: 'grok-4.7', name: 'Grok 4.7', context_length: 256_000, modalities: { input: ['text', 'image'] } },
      { id: 'grok-4.7@500k', context_length: 500_000 },
      { id: 'grok-imagine-image' },
      { id: 'grok-9.9' },
    ],
    cli: [
      {
        id: 'grok-4.7',
        context_window: 256_000,
        supports_reasoning_effort: true,
        reasoning_effort: 'high',
        reasoning_efforts: [{ value: 'low' }, { value: 'high' }],
      },
      { id: 'grok-4.7-build-fast', context_window: 256_000 },
    ],
  }
}

describe('Grok OAuth constants', () => {
  test('pins the CLI client registration', () => {
    assert.equal(GROK_CLIENT_ID, 'b1a00492-073a-47ea-816f-4c329264a828')
    assert.equal(GROK_DISCOVERY_URL, 'https://auth.x.ai/.well-known/openid-configuration')
    assert.equal(GROK_CALLBACK_PORT, 56121)
    assert.match(GROK_SCOPE, /grok-cli:access/)
  })
})

describe('parseGrokSession', () => {
  const base = { accessToken: 'a', tokenEndpoint: 'https://auth.x.ai/oauth2/token', expiresAt: 1 }

  test('accepts a complete session and rejects the rest', () => {
    assert.deepEqual(parseGrokSession(base), { ...base, issuer: 'https://auth.x.ai' })
    assert.equal(parseGrokSession({ ...base, accessToken: '' }), undefined)
    assert.equal(parseGrokSession({ ...base, tokenEndpoint: undefined }), undefined)
    assert.equal(parseGrokSession({ ...base, expiresAt: 'soon' }), undefined)
    assert.equal(parseGrokSession('nope'), undefined)
  })

  test('keeps the recorded issuer when one is stored', () => {
    assert.equal(parseGrokSession({ ...base, issuer: 'https://accounts.x.ai' })?.issuer, 'https://accounts.x.ai')
  })
})

describe('parseGrokTokenPayload', () => {
  test('computes an absolute expiry and keeps the id token', () => {
    const before = Date.now()
    const tokens = parseGrokTokenPayload({
      access_token: 'access',
      refresh_token: 'refresh',
      id_token: 'id',
      expires_in: 3600,
    })
    assert.equal(tokens.accessToken, 'access')
    assert.equal(tokens.refreshToken, 'refresh')
    assert.equal(tokens.idToken, 'id')
    assert.ok(tokens.expiresAt >= before + 3_600_000)
  })

  test('retains the previous refresh token when the response omits one', () => {
    assert.equal(parseGrokTokenPayload({ access_token: 'a', expires_in: 60 }, 'previous').refreshToken, 'previous')
    assert.equal(parseGrokTokenPayload({ access_token: 'a', expires_in: 60 }).refreshToken, undefined)
  })

  test('rejects a payload without a usable lifetime', () => {
    assert.throws(() => parseGrokTokenPayload({ access_token: 'a' }), /missing required fields/)
    assert.throws(() => parseGrokTokenPayload({ expires_in: 60 }), /missing required fields/)
    assert.throws(() => parseGrokTokenPayload({ access_token: 'a', expires_in: -1 }), /missing required fields/)
    assert.throws(
      () => parseGrokTokenPayload({ access_token: 'a', expires_in: Number.MAX_VALUE }),
      /missing required fields/,
    )
  })
})

describe('identityFromGrokTokens', () => {
  test('prefers the id token and lowercases the email', () => {
    const identity = identityFromGrokTokens('opaque', jwtWithClaims({ sub: 'subject', email: 'A@X.ai' }))
    assert.deepEqual(identity, { accountId: 'subject', email: 'a@x.ai' })
  })

  test('falls back to the access token, and yields nothing for opaque tokens', () => {
    assert.equal(identityFromGrokTokens(jwtWithClaims({ sub: 'from-access' })).accountId, 'from-access')
    assert.deepEqual(identityFromGrokTokens('opaque', 'also-opaque'), {})
  })
})

describe('createGrokDiscovery', () => {
  test('resolves and caches the endpoints', async () => {
    let calls = 0
    const fetchFn: typeof fetch = async (input) => {
      calls += 1
      assert.equal(String(input), GROK_DISCOVERY_URL)
      return jsonResponse({
        authorization_endpoint: 'https://auth.x.ai/oauth2/authorize',
        token_endpoint: 'https://auth.x.ai/oauth2/token',
      })
    }
    const discover = createGrokDiscovery(fetchFn)
    const first = await discover()
    const second = await discover()
    assert.equal(first.tokenEndpoint, 'https://auth.x.ai/oauth2/token')
    assert.deepEqual(first, second)
    assert.equal(calls, 1)
  })

  test('refuses an endpoint outside the trusted hosts', async () => {
    const fetchFn: typeof fetch = async () => jsonResponse({
      authorization_endpoint: 'https://evil.example/authorize',
      token_endpoint: 'https://auth.x.ai/oauth2/token',
    })
    await assert.rejects(createGrokDiscovery(fetchFn)(), /untrusted authorization_endpoint/)
  })

  test('refuses a plaintext or port-bearing endpoint', async () => {
    const insecure: typeof fetch = async () => jsonResponse({
      authorization_endpoint: 'http://auth.x.ai/authorize',
      token_endpoint: 'https://auth.x.ai:8443/token',
    })
    await assert.rejects(createGrokDiscovery(insecure)(), /untrusted authorization_endpoint/)
  })

  test('reports a discovery failure and a malformed document', async () => {
    const failing: typeof fetch = async () => new Response('nope', { status: 503 })
    await assert.rejects(createGrokDiscovery(failing)(), /discovery failed \(HTTP 503\)/)
    const partial: typeof fetch = async () => jsonResponse({ authorization_endpoint: 'https://auth.x.ai/a' })
    await assert.rejects(createGrokDiscovery(partial)(), /missing authorization\/token endpoints/)
  })
})

describe('token endpoint calls', () => {
  test('exchanges a code with PKCE and the CLI client id', async () => {
    let body = ''
    const fetchFn: typeof fetch = async (_input, init) => {
      body = String(init?.body ?? '')
      return jsonResponse({ access_token: 'access', refresh_token: 'refresh', expires_in: 60 })
    }
    const pkce = createPkce()
    const tokens = await exchangeGrokCode({
      fetchFn,
      tokenEndpoint: 'https://auth.x.ai/oauth2/token',
      code: 'the-code',
      redirectUri: `http://127.0.0.1:${String(GROK_CALLBACK_PORT)}/callback`,
      pkce,
      signal: new AbortController().signal,
    })
    assert.equal(tokens.accessToken, 'access')
    assert.match(body, /grant_type=authorization_code/)
    assert.match(body, /code=the-code/)
    assert.match(body, new RegExp(`client_id=${GROK_CLIENT_ID}`))
    assert.match(body, new RegExp(`code_verifier=${pkce.verifier}`))
    assert.match(body, /code_challenge_method=S256/)
    assert.match(body, /redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A56121%2Fcallback/)
  })

  test('surfaces the provider description on a failed exchange', async () => {
    const fetchFn: typeof fetch = async () => jsonResponse({ error: 'invalid_grant' }, 400)
    await assert.rejects(exchangeGrokCode({
      fetchFn,
      tokenEndpoint: 'https://auth.x.ai/oauth2/token',
      code: 'c',
      redirectUri: 'http://127.0.0.1:56121/callback',
      pkce: createPkce(),
      signal: new AbortController().signal,
    }), /invalid_grant/)
  })

  test('refreshes with the CLI client id and keeps the refresh token', async () => {
    let body = ''
    const fetchFn: typeof fetch = async (_input, init) => {
      body = String(init?.body ?? '')
      return jsonResponse({ access_token: 'fresh', expires_in: 60 })
    }
    const tokens = await refreshGrokToken({
      fetchFn,
      tokenEndpoint: 'https://auth.x.ai/oauth2/token',
      refreshToken: 'old',
    })
    assert.equal(tokens.refreshToken, 'old')
    assert.match(body, /grant_type=refresh_token/)
    assert.match(body, /refresh_token=old/)
  })

  test('a refused refresh is a re-authentication failure', async () => {
    const fetchFn: typeof fetch = async () => jsonResponse({ error: 'invalid_grant' }, 400)
    await assert.rejects(
      refreshGrokToken({ fetchFn, tokenEndpoint: 'https://auth.x.ai/oauth2/token', refreshToken: 'old' }),
      (error: unknown) => error instanceof ProviderError && error.code === REAUTH_REQUIRED,
    )
  })
})

describe('GrokAdapter catalog', () => {
  test('describes the route it serves', () => {
    const adapter = new GrokAdapter(adapterOptions())
    assert.deepEqual(adapter.providerInfo('grok'), { id: 'grok', name: 'Grok (X Premium)' })
  })

  test('lists the seeded models with no invented reasoning ladder', async () => {
    const adapter = new GrokAdapter(adapterOptions())
    const models = await adapter.listModels('grok')
    // `auto` is pinned first; the seeds follow in curated order.
    assert.deepEqual(models.map((model) => model.id), GROK_MODELS.map((entry) => entry.id))
    const resolved = await adapter.resolveModel('grok', 'grok-4.6')
    assert.equal(resolved.context?.contextWindow, 256_000)
    assert.equal(resolved.reasoning, undefined)
  })

  test('the listing decides membership and the CLI catalog states the metadata', async () => {
    const fetchFn: typeof fetch = async (input) => {
      if (String(input).includes('cli-chat-proxy')) {
        return jsonResponse({
          data: [{
            id: 'grok-5',
            context_window: 1_000_000,
            supports_reasoning_effort: true,
            reasoning_effort: 'high',
            reasoning_efforts: [{ value: 'low' }, { value: 'high' }],
          }],
        })
      }
      return jsonResponse({ data: [{ id: 'grok-4.6' }, { id: 'grok-5' }, { id: 'grok-2-image' }, { id: 42 }] })
    }
    const adapter = new GrokAdapter(adapterOptions({ discovery: true, fetchFn }))
    const ids = await adapter.fetchCatalog('token', undefined) as readonly string[] | undefined
    // Image models and malformed entries are not chat models.
    assert.deepEqual(ids, ['grok-4.6', 'grok-5'])
    adapter.discover(ids ?? [])
    const models = await adapter.listModels('grok')
    // The endpoint's own rows are the whole membership: the seed no longer appends
    // grok-4.5 or grok-4.7 to a listing that does not serve them.
    assert.deepEqual(models.map((model) => model.id), ['grok-4.6', 'grok-5'])
    // A seed still describes a row the listing named but did not describe.
    assert.equal(models[0]?.name, 'Grok 4.6')
    const resolved = await adapter.resolveModel('grok', 'grok-5')
    assert.equal(resolved.context?.contextWindow, 1_000_000)
    assert.deepEqual(resolved.reasoning?.efforts.map((effort) => String(effort.id)), ['low', 'high'])
    assert.equal(String(resolved.reasoning?.defaultEffort), 'high')
  })

  test('learns the account fast variant from its own CLI catalog', async () => {
    // Ground truth from the live endpoints: the public model list holds no fast id at
    // all, the CLI catalog answers only for the account's bearer, and the id it names is
    // `grok-4.7-build-fast` — not `grok-4.7-build-fast@500k`, which the Responses
    // endpoint refuses.
    const seen: { url: string, authorization: string | null }[] = []
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input)
      seen.push({ url, authorization: new Headers(init?.headers).get('authorization') })
      if (url.includes('cli-chat-proxy')) {
        return jsonResponse({
          data: [
            { id: 'grok-4.7', context_window: 256_000 },
            { id: 'grok-4.7-build-fast', context_window: 256_000 },
          ],
        })
      }
      return jsonResponse({ data: [{ id: 'grok-4.7' }, { id: 'grok-imagine-image' }] })
    }
    const adapter = new GrokAdapter(adapterOptions({ discovery: true, fetchFn }))
    const ids = await adapter.fetchCatalog('account-token', undefined) as readonly string[] | undefined
    // The fast variant is not a picker row of its own; it rides the base model's.
    assert.deepEqual(ids, ['grok-4.7'])
    assert.deepEqual(
      seen.find((call) => call.url.includes('cli-chat-proxy'))?.authorization,
      'Bearer account-token',
    )
    assert.deepEqual(adapter.fastPairOf('grok-4.7'), { baseId: 'grok-4.7', wireId: 'grok-4.7-build-fast' })
    // Asked about the fast id itself, the pair still names the row to switch back to.
    assert.deepEqual(adapter.fastPairOf('grok-4.7-build-fast'), { baseId: 'grok-4.7', wireId: 'grok-4.7-build-fast' })
    assert.equal(adapter.fastPairOf('grok-4.5'), undefined)
    // The row keeps its own id, so the picker always offers a way back to the standard
    // model; the variant is a wire id the `fast` rung dispatches, never a picker row.
    const models = await adapter.listModels('grok')
    assert.equal(models.some((model) => model.id === 'grok-4.7-build-fast'), false)
    assert.equal(models.some((model) => model.id === 'grok-4.7'), true)
    // The endpoint's own figure always wins: the old code widened a seed with
    // `Math.max(seed, live)`, so the shipped 500k for grok-4.7 overrode the 256k the CLI
    // catalog states. A live window is now the row's window, seed or no seed.
    assert.equal((await adapter.resolveModel('grok', 'grok-4.7')).context?.contextWindow, 256_000)
    // The row declares the `fast` rung, which is what the quick-mode button selects.
    const base = await adapter.resolveModel('grok', 'grok-4.7')
    assert.equal(base.reasoning?.efforts.some((effort) => String(effort.id) === 'fast'), true)
    // The fast variant still resolves, with its base model's metadata, under its own wire
    // id — a session that selected it before this build keeps working.
    const fast = await adapter.resolveModel('grok', 'grok-4.7-build-fast')
    assert.equal(fast.id, 'grok-4.7-build-fast')
    assert.equal(fast.name, 'Grok 4.7')
    assert.equal(fast.context?.contextWindow, 256_000)
  })

  test('honours the hidden-model set', async () => {
    const adapter = new GrokAdapter(adapterOptions({ hiddenModels: async () => new Set(['grok-4.5']) }))
    assert.deepEqual((await adapter.listModels('grok')).map((model) => model.id), ['grok-4.6', 'grok-4.7'])
    // Still resolvable, so an existing session keeps working.
    assert.equal((await adapter.resolveModel('grok', 'grok-4.5')).id, 'grok-4.5')
    assert.equal(adapter.catalogEntries().some((entry) => entry.id === 'grok-4.5'), true)
  })

  test('warns and keeps the last catalog when discovery fails', async () => {
    const warnings: string[] = []
    const adapter = new GrokAdapter(adapterOptions({
      discovery: true,
      onWarn: (message) => warnings.push(message),
      fetchFn: async () => new Response('boom', { status: 500 }),
    }))
    assert.equal(await adapter.fetchCatalog('token'), undefined)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /keeping the last catalog/)
  })

  test('a refused credential is not reported as a discovery failure', async () => {
    const warnings: string[] = []
    const adapter = new GrokAdapter(adapterOptions({
      discovery: true,
      onWarn: (message) => warnings.push(message),
      fetchFn: async () => new Response('unauthorized', { status: 401 }),
    }))
    assert.equal(await adapter.fetchCatalog('token'), undefined)
    assert.deepEqual(warnings, [])
  })
})

describe('GrokAdapter cached catalog', () => {
  test('derives the catalog from the cached listing', async () => {
    const adapter = new GrokAdapter(adapterOptions({ cachedListing: async () => cachedPayload() }))
    const models = await adapter.listModels('grok')
    // Membership and order are the endpoint's own listing: the image model is not a chat
    // row, the `@500k` variant folds onto its base, and the cold-start seed adds nothing
    // the listing did not name.
    assert.deepEqual(models.map((model) => model.id), ['grok-4.7', 'grok-9.9'])
    assert.equal(models[0]?.name, 'Grok 4.7')
    assert.deepEqual(models[0]?.inputModalities, ['text', 'image'])
    const resolved = await adapter.resolveModel('grok', 'grok-4.7')
    // The widest context variant the listing offers is the window the base row serves,
    // because that is the variant the row dispatches to.
    assert.equal(resolved.context?.contextWindow, 500_000)
    assert.deepEqual(resolved.reasoning?.efforts.map((effort) => String(effort.id)), ['low', 'high', 'fast'])
    assert.equal(String(resolved.reasoning?.defaultEffort), 'high')
  })

  test('reads the cached listing once, and a picker query never asks the endpoint', async () => {
    let reads = 0
    let requests = 0
    const adapter = new GrokAdapter(adapterOptions({
      discovery: true,
      cachedListing: async () => {
        reads += 1
        return cachedPayload()
      },
      fetchFn: async () => {
        requests += 1
        throw new Error('a picker query must not fetch')
      },
    }))
    await adapter.listModels('grok')
    await adapter.listModels('grok')
    await adapter.resolveModel('grok', 'grok-4.7')
    assert.equal(reads, 1)
    assert.equal(requests, 0)
  })

  test('keeps the fast pairing and the context-variant mapping from the cache', async () => {
    const adapter = new GrokAdapter(adapterOptions({ cachedListing: async () => cachedPayload() }))
    await adapter.hydrate()
    // The CLI catalog is the only listing that names `grok-4.7-build-fast`; the cached
    // payload keeps it, so the button pairs with its base after a restart.
    assert.deepEqual(adapter.fastPairOf('grok-4.7'), { baseId: 'grok-4.7', wireId: 'grok-4.7-build-fast' })
    // The `@Nk` context variant never becomes a row of its own: the base row resolves to
    // the widest variant the listing offered.
    assert.equal(adapter.resolveModelId('grok-4.7'), 'grok-4.7@500k')
    assert.equal(adapter.resolveModelId('grok-9.9'), 'grok-9.9')
    assert.equal(adapter.catalogEntries().some((entry) => entry.id === 'grok-4.7@500k'), false)
  })

  test('a cache miss is a warning, never a failure', async () => {
    const warnings: string[] = []
    const adapter = new GrokAdapter(adapterOptions({
      cachedListing: async () => { throw new Error('no cache') },
      onWarn: (message) => warnings.push(message),
    }))
    assert.deepEqual(
      (await adapter.listModels('grok')).map((model) => model.id),
      GROK_MODELS.map((entry) => entry.id),
    )
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /cached model catalog unavailable/)
  })

  test('fetchCatalog caches exactly one payload holding both listings', async () => {
    const saved: unknown[] = []
    const fetchFn: typeof fetch = async (input) => String(input).includes('cli-chat-proxy')
      ? jsonResponse({ data: [{ id: 'grok-4.7', context_window: 256_000 }, { id: 'grok-4.7-build-fast' }] })
      : jsonResponse({ data: [{ id: 'grok-4.7' }, { id: 'grok-imagine-image' }] })
    const adapter = new GrokAdapter(adapterOptions({
      discovery: true,
      fetchFn,
      saveListing: async (payload) => { saved.push(payload) },
    }))
    assert.deepEqual(await adapter.fetchCatalog('token'), ['grok-4.7'])
    assert.equal(saved.length, 1)
    assert.deepEqual(saved[0], {
      public: [{ id: 'grok-4.7' }, { id: 'grok-imagine-image' }],
      cli: [{ id: 'grok-4.7', context_window: 256_000 }, { id: 'grok-4.7-build-fast' }],
    })
  })

  test('a cache write failure is a warning, never a failed read', async () => {
    const warnings: string[] = []
    const adapter = new GrokAdapter(adapterOptions({
      discovery: true,
      onWarn: (message) => warnings.push(message),
      fetchFn: async () => jsonResponse({ data: [{ id: 'grok-4.7' }] }),
      saveListing: async () => { throw new Error('disk full') },
    }))
    assert.deepEqual(await adapter.fetchCatalog('token'), ['grok-4.7'])
    assert.match(warnings.join('\n'), /model catalog cache write failed/)
  })

  test('re-derives the same catalog from what a live read cached', async () => {
    const saved: unknown[] = []
    const fetchFn: typeof fetch = async (input) => String(input).includes('cli-chat-proxy')
      ? jsonResponse({ data: [{ id: 'grok-4.7-build-fast', context_window: 500_000 }] })
      : jsonResponse({ data: [{ id: 'grok-4.7', context_length: 500_000 }, { id: 'grok-4.7@500k' }] })
    const live = new GrokAdapter(adapterOptions({
      discovery: true,
      fetchFn,
      saveListing: async (payload) => { saved.push(payload) },
    }))
    const ids = await live.fetchCatalog('token')
    const cached = new GrokAdapter(adapterOptions({ cachedListing: async () => saved[0] }))
    assert.deepEqual((await cached.listModels('grok')).map((model) => model.id), ids)
    assert.deepEqual(cached.fastPairOf('grok-4.7'), { baseId: 'grok-4.7', wireId: 'grok-4.7-build-fast' })
    assert.equal((await cached.resolveModel('grok', 'grok-4.7')).context?.contextWindow, 500_000)
  })
})

describe('GrokAdapter requests', () => {
  test('posts an xAI Responses request with the expected knobs', async () => {
    let seenUrl = ''
    let seenBody: Record<string, unknown> = {}
    let seenHeaders = new Headers()
    const fetchFn: typeof fetch = async (input, init) => {
      seenUrl = String(input)
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      seenHeaders = new Headers(init?.headers)
      return sseResponse([{ type: 'response.completed', response: {} }])
    }
    const adapter = new GrokAdapter(adapterOptions({ fetchFn }))
    await collect(adapter.stream(request({
      reasoningEffort: ReasoningEffortId('high'),
      sessionId: 'session-1' as Branded<'SessionId'>,
      tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }],
      temperature: 0.5,
      system: 'be brief',
    })))

    assert.equal(seenUrl, 'https://api.x.ai/v1/responses')
    assert.equal(seenBody.model, 'grok-4.6')
    assert.equal(seenBody.stream, true)
    assert.equal(seenBody.store, false)
    assert.deepEqual(seenBody.reasoning, { effort: 'high' })
    assert.equal(seenBody.prompt_cache_key, 'session-1')
    // xAI does not take Kimi's encrypted-reasoning include, nor a temperature.
    assert.equal(Object.hasOwn(seenBody, 'include'), false)
    assert.equal(Object.hasOwn(seenBody, 'temperature'), false)
    assert.equal(seenBody.instructions, 'be brief')
    assert.deepEqual(seenBody.tools, [
      { type: 'function', name: 'read_file', description: 'Read', parameters: { type: 'object' }, strict: false },
    ])
    assert.equal(seenBody.tool_choice, 'auto')
    assert.equal(seenBody.parallel_tool_calls, true)
    assert.equal(seenHeaders.get('authorization'), 'Bearer token')
    assert.equal(seenHeaders.get('accept'), 'text/event-stream')
    // The harness attribution is present without a CLI product token.
    assert.match(seenHeaders.get('user-agent') ?? '', /^deepseek-harness\//)
  })

  test('the fast rung dispatches the variant under the row id', async () => {
    let seenBody: Record<string, unknown> = {}
    const fetchFn: typeof fetch = async (input, init) => {
      if (String(input).includes('/models')) {
        return jsonResponse({ data: [{ id: 'grok-4.7' }, { id: 'grok-4.7-build-fast' }] })
      }
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return sseResponse([{ type: 'response.completed', response: {} }])
    }
    const adapter = new GrokAdapter(adapterOptions({ discovery: true, fetchFn }))
    await adapter.fetchCatalog('token', undefined)
    assert.deepEqual(adapter.fastPairOf('grok-4.7'), { baseId: 'grok-4.7', wireId: 'grok-4.7-build-fast' })
    // The selection keeps the row's own id — that is what the host validated — and the
    // request goes to the variant, with no `fast` effort sent to xAI.
    await collect(adapter.stream(request({ model: 'grok-4.7', reasoningEffort: ReasoningEffortId('fast') })))
    assert.equal(seenBody.model, 'grok-4.7-build-fast')
    assert.equal(Object.hasOwn(seenBody, 'reasoning'), false)
  })

  test('streams a response into harness chunks', async () => {
    const fetchFn: typeof fetch = async () => sseResponse([
      { type: 'response.output_text.delta', item_id: 'i1', content_index: 0, delta: 'Hi' },
      { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 1 } } },
    ])
    const chunks = await collect(new GrokAdapter(adapterOptions({ fetchFn })).stream(request()))
    assert.deepEqual(chunks.map((chunk) => chunk.type), ['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  })

  test('retries once with a forced refresh after a 401', async () => {
    let calls = 0
    const forced: boolean[] = []
    const fetchFn: typeof fetch = async () => {
      calls += 1
      return calls === 1 ? new Response('unauthorized', { status: 401 }) : sseResponse([{ type: 'response.completed', response: {} }])
    }
    const tokens = tokenManager(async (_account?: string, force?: boolean) => {
      forced.push(force === true)
      return { account: 'user-1', accessToken: 'token', expiresAt: Date.now() + 60_000 }
    })
    await collect(new GrokAdapter(adapterOptions({ fetchFn, tokens })).stream(request()))
    assert.equal(calls, 2)
    assert.deepEqual(forced, [false, true])
  })

  test('names the fix when the login has expired', async () => {
    const tokens = tokenManager(async () => {
      throw new ProviderError('no Grok (X Premium) account is signed in', REAUTH_REQUIRED)
    })
    await assert.rejects(
      collect(new GrokAdapter(adapterOptions({ tokens })).stream(request())),
      (error: unknown) => error instanceof LlmError
        && error.failure.code === 'INVALID_CREDENTIAL'
        && /Settings → Subscriptions/.test(error.message),
    )
  })

  test('the seeded models follow the curated order', async () => {
    const models = await new GrokAdapter(adapterOptions()).listModels('grok')
    assert.deepEqual(models.map((model) => model.id), GROK_MODELS.map((entry) => entry.id))
  })

  test('pairs a fast id with the longest listed prefix of its own name', async () => {
    // No curated alias names this variant: the pair is derived purely from the id —
    // a provider that names its variants after the base model needs no hardcoded map.
    const fetchFn: typeof fetch = async () => jsonResponse({
      data: [{ id: 'grok-9.9' }, { id: 'grok-9.9-build-fast' }],
    })
    const adapter = new GrokAdapter(adapterOptions({ discovery: true, fetchFn }))
    await adapter.fetchCatalog('token', undefined)
    assert.deepEqual(adapter.fastPairOf('grok-9.9'), { baseId: 'grok-9.9', wireId: 'grok-9.9-build-fast' })
    assert.deepEqual(adapter.fastPairOf('grok-9.9-build-fast'), { baseId: 'grok-9.9', wireId: 'grok-9.9-build-fast' })
  })

  test('fastWordOf reads the fast word out of a variant id', () => {
    assert.equal(fastWordOf('grok-4.7-build-fast'), 'fast')
    assert.equal(fastWordOf('kimi-for-coding-highspeed'), 'highspeed')
    assert.equal(fastWordOf('some-turbo-model'), 'turbo')
    assert.equal(fastWordOf('grok-4.7'), 'fast')
  })
})

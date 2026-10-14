/**
 * The Ark sign-in and control plane.
 *
 * The fixtures here are the shapes the live service and the official CLI actually
 * produced, so the parsers and the signer are pinned to reality rather than to a
 * guess about it.
 *
 * @module dsh-plugin-subscription-oauth/test/ark
 */

import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { describe, test } from 'node:test'

import {
  ARK_CLIENT_ID,
  ARK_SCOPE,
  buildArkAuthorizeUrl,
  exchangeArkCode,
  parseArkTokenPayload,
  refreshArkToken,
} from '../src/auth/ark-flow.js'
import {
  ARK_CONTROL_HOST,
  createArkApiKey,
  listArkApiKeys,
  parseArkFreeUsage,
  parseArkPlanUsage,
  readArkApiKey,
  signArkRequest,
} from '../src/auth/ark-control.js'
import type { ArkStsCredentials } from '../src/auth/ark-control.js'
import { ArkAdapter, ARK_DEFAULT_MODEL, ARK_PROVIDER_ID, parseArkSession, readArkUsage } from '../src/providers/ark.js'
import type { ArkAdapterOptions } from '../src/providers/ark.js'

/** A JSON response the way the services send one. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** A base64url JWT whose payload states one expiry. */
function jwt(expSeconds: number): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'RS256' })}.${part({ exp: expSeconds })}.sig`
}

/** Credentials shaped like the CLI's `sts.json`. */
const credentials: ArkStsCredentials = {
  accessKeyId: 'AKTtest-access-key',
  secretAccessKey: 'test-secret-key',
  sessionToken: 'test-session-token',
  expiresAt: Date.now() + 3_600_000,
}

/** An adapter with the smallest set of collaborators its methods touch. */
function adapter(options: Partial<ArkAdapterOptions> = {}): ArkAdapter {
  return new ArkAdapter({
    apiBase: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    discovery: false,
    streamIdleTimeoutMs: 5_000,
    tokens: {} as never,
    ...options,
  })
}

/** The token manager of an account that is signed in. */
const signedIn = {
  session: async () => ({ account: 'a', session: { apiKey: 'k', expiresAt: Date.now() + 3_600_000 } }),
} as never

/**
 * One `/models` answer, in the shape the plan's own base sends: the OpenAI-compatible
 * envelope, whose rows state their own name, window and reasoning ladder.
 *
 * `deepseek-v5-thinking` is here to be a model this build has never shipped;
 * `doubao-image-gen` is agent-called rather than picked, so it is never a row.
 */
const ARK_LISTING = {
  object: 'list',
  data: [
    { id: 'ark-code-latest', object: 'model', name: 'Ark Code (latest)', context_window: 262_144 },
    {
      id: 'doubao-seed-2.0-code',
      object: 'model',
      display_name: 'Doubao Seed 2.0 Code',
      context_length: 524_288,
      think_efforts: { valid_efforts: ['low', 'high'], default_effort: 'high' },
    },
    {
      id: 'deepseek-v5-thinking',
      object: 'model',
      name: 'DeepSeek V5 Thinking',
      context_window: 1_000_000,
      modalities: { input: ['text', 'image'] },
    },
    { id: 'doubao-image-gen', object: 'model', name: 'Doubao Image Gen' },
  ],
}

describe('Ark sign-in', () => {
  test('the authorize URL carries the scope the CLI sends', () => {
    const url = new URL(buildArkAuthorizeUrl({
      redirectUri: 'http://127.0.0.1:51789/oauth/callback',
      state: 'state-1',
      pkce: { verifier: 'verifier', challenge: 'challenge' },
    }))
    assert.equal(url.origin, 'https://signin.volcengine.com')
    assert.equal(url.pathname, '/authorize/oauth/authorize')
    assert.equal(url.searchParams.get('client_id'), ARK_CLIENT_ID)
    assert.equal(url.searchParams.get('scope'), ARK_SCOPE)
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:51789/oauth/callback')
  })

  test('a token reply is read the way the CLI stores it', () => {
    // The field names come from the CLI's own identities/<id>/token.json.
    const tokens = parseArkTokenPayload({
      id_token: jwt(1_900_000_000),
      refresh_token: 'refresh-1',
      client_id: ARK_CLIENT_ID,
      timestamp_ms: 1_791_786_442_135,
      expires_in: 900,
    })
    assert.equal(tokens.refreshToken, 'refresh-1')
    assert.equal(tokens.expiresAt, 1_900_000_000_000)
  })

  test('the access_token is read as the STS credential it is', () => {
    // The live endpoint answers `token_type: urn:ietf:params:oauth:token-type:
    // access_token_sts` and puts the credentials in `access_token` as JSON. This is
    // what signs the control plane, so it must survive parsing.
    const tokens = parseArkTokenPayload({
      id_token: jwt(1_900_000_000),
      expires_in: 900,
      token_type: 'urn:ietf:params:oauth:token-type:access_token_sts',
      access_token: JSON.stringify({
        access_key_id: 'AKTtest',
        secret_access_key: 'secret',
        session_token: 'session',
      }),
    })
    assert.equal(tokens.sts?.accessKeyId, 'AKTtest')
    assert.equal(tokens.sts?.secretAccessKey, 'secret')
    assert.equal(tokens.sts?.sessionToken, 'session')
    // The lifetime comes from the same `expires_in` the id token is issued with.
    assert.ok((tokens.sts?.expiresAt ?? 0) > Date.now())
  })

  test('an opaque access token yields no STS rather than a broken one', () => {
    // Not every reply carries STS; a plain opaque token must not be mistaken for one.
    const tokens = parseArkTokenPayload({ id_token: jwt(1_900_000_000), access_token: 'opaque-token' })
    assert.equal(tokens.sts, undefined)
    assert.equal(tokens.idToken, jwt(1_900_000_000))
  })

  test('a reply that omits a refresh token keeps the stored one', () => {
    const tokens = parseArkTokenPayload({ id_token: jwt(1_900_000_000) }, 'kept-refresh')
    assert.equal(tokens.refreshToken, 'kept-refresh')
  })

  test('a reply without an id token is refused', () => {
    assert.throws(() => parseArkTokenPayload({ refresh_token: 'r' }), /empty id_token/)
  })

  test('the exchange posts the code and verifier', async () => {
    let body = ''
    const fetchFn: typeof fetch = async (_input, init) => {
      body = String(init?.body)
      return jsonResponse({ id_token: jwt(1_900_000_000), refresh_token: 'r' })
    }
    const tokens = await exchangeArkCode({
      fetchFn,
      code: 'the-code',
      redirectUri: 'http://127.0.0.1:51789/oauth/callback',
      pkce: { verifier: 'the-verifier', challenge: 'the-challenge' },
      signal: new AbortController().signal,
    })
    const params = new URLSearchParams(body)
    assert.equal(params.get('grant_type'), 'authorization_code')
    assert.equal(params.get('code'), 'the-code')
    assert.equal(params.get('code_verifier'), 'the-verifier')
    assert.equal(params.get('client_id'), ARK_CLIENT_ID)
    assert.equal(tokens.refreshToken, 'r')
  })

  test('the refresh grant posts the refresh token', async () => {
    let body = ''
    const fetchFn: typeof fetch = async (_input, init) => {
      body = String(init?.body)
      return jsonResponse({ id_token: jwt(1_900_000_000) })
    }
    await refreshArkToken({ fetchFn, refreshToken: 'stored-refresh' })
    const params = new URLSearchParams(body)
    assert.equal(params.get('grant_type'), 'refresh_token')
    assert.equal(params.get('refresh_token'), 'stored-refresh')
  })

  test('a refusal names the service reason', async () => {
    const fetchFn: typeof fetch = async () => jsonResponse({ error: 'invalid_grant', error_description: 'expired' }, 400)
    await assert.rejects(
      () => refreshArkToken({ fetchFn, refreshToken: 'r' }),
      /invalid_grant|expired/,
    )
  })
})

describe('Ark control plane', () => {
  test('signs with the scope and headers the service expects', () => {
    const at = new Date('2026-10-12T06:00:00Z')
    const headers = signArkRequest({ method: 'POST', query: 'Action=GetCodingPlanUsage&Version=2024-01-01', body: '', credentials, at })
    assert.equal(headers.host, ARK_CONTROL_HOST)
    assert.equal(headers['x-date'], '20261012T060000Z')
    assert.equal(headers['x-security-token'], credentials.sessionToken)
    // The credential scope is date/region/service/request.
    assert.match(headers.authorization ?? '', /^HMAC-SHA256 Credential=AKTtest-access-key\/20261012\/cn-beijing\/ark\/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=[0-9a-f]{64}$/)
  })

  test('the signature is a deterministic HMAC chain over the canonical request', () => {
    const at = new Date('2026-10-12T06:00:00Z')
    const query = 'Action=GetCodingPlanUsage&Version=2024-01-01'
    const headers = signArkRequest({ method: 'POST', query, body: '', credentials, at })
    const contentSha = createHash('sha256').update('').digest('hex')
    const canonical = [
      'POST', '/', query,
      'content-type:application/x-www-form-urlencoded',
      `host:${ARK_CONTROL_HOST}`,
      `x-content-sha256:${contentSha}`,
      'x-date:20261012T060000Z',
      '',
      'content-type;host;x-content-sha256;x-date',
      contentSha,
    ].join('\n')
    const stringToSign = ['HMAC-SHA256', '20261012T060000Z', '20261012/cn-beijing/ark/request', createHash('sha256').update(canonical).digest('hex')].join('\n')
    const kSigning = createHmac('sha256', createHmac('sha256', createHmac('sha256', createHmac('sha256', credentials.secretAccessKey).update('20261012').digest()).update('cn-beijing').digest()).update('ark').digest()).update('request').digest()
    const expected = createHmac('sha256', kSigning).update(stringToSign).digest('hex')
    assert.ok((headers.authorization ?? '').endsWith(expected), 'signature must match the derived signing key')
  })

  test('reads the free allowance a live response carried', () => {
    // Trimmed from a real ListModelChargeItems body.
    const free = parseArkFreeUsage({
      ResponseMetadata: { Action: 'ListModelChargeItems' },
      Result: {
        Items: [
          { FoundationModelName: 'doubao-seed-2-1-lite', InferenceFreeUsage: { Consumed: 0, Total: 500000 } },
          { FoundationModelName: 'deepseek-v4-1-flash', InferenceFreeUsage: { Consumed: 250, Total: 500000 } },
          // No free tier: the field is absent and must not be reported as zero.
          { FoundationModelName: 'no-free-tier' },
        ],
      },
    })
    assert.deepEqual(free.map((entry) => entry.model), ['doubao-seed-2-1-lite', 'deepseek-v4-1-flash'])
    assert.equal(free[1]?.consumed, 250)
    assert.equal(free[1]?.total, 500000)
  })

  test('reads a plan-less account as a state, not an error', () => {
    // The exact body the service returned for an account with no Coding Plan.
    const plan = parseArkPlanUsage({
      ResponseMetadata: { Action: 'GetCodingPlanUsage' },
      Result: { HasReward: false, Status: 'Reclaimed', UpdateTimestamp: 1791786829 },
    })
    assert.equal(plan.subscribed, false)
    assert.equal(plan.status, 'Reclaimed')
    assert.deepEqual(plan.periods, [])
  })

  test('reads a subscribed plan\'s periods', () => {
    // The shape the CLI's own help documents, with its worked example.
    const plan = parseArkPlanUsage({
      Result: {
        subscribed: true,
        coding_usage: {
          periods: [
            { label: '5h', used: 250, total: 1000, percent: 25, reset_at: '2024-05-30T05:26:40+08:00' },
            { label: 'weekly', used: 12500, total: 50000, percent: 25, reset_at: '2024-06-06T00:26:40+08:00' },
          ],
        },
      },
    })
    assert.equal(plan.subscribed, true)
    assert.deepEqual(plan.periods.map((period) => period.label), ['5h', 'weekly'])
    assert.equal(plan.periods[0]?.used, 250)
    assert.equal(plan.periods[0]?.total, 1000)
    assert.equal(plan.periods[0]?.resetsAt, Date.parse('2024-05-30T05:26:40+08:00'))
  })

  test('an Agent Plan body is read from its own envelope', () => {
    const plan = parseArkPlanUsage({
      Result: { subscribed: true, afp_usage: { plan_type: 'small', periods: [{ label: 'monthly', percent: 10 }] } },
    })
    assert.equal(plan.subscribed, true)
    assert.deepEqual(plan.periods.map((period) => period.label), ['monthly'])
  })

  test('mints a key with the shape the service validated', async () => {
    // The required fields were learned from the service's own validation errors; the
    // body must be JSON, because a nested array is not expressible in the form
    // encoding the flat actions use.
    let sent: { query: string, body: string, contentType: string | null } | undefined
    const fetchFn: typeof fetch = async (input, init) => {
      sent = {
        query: String(input),
        body: String(init?.body),
        contentType: new Headers(init?.headers).get('content-type'),
      }
      return jsonResponse({ Result: { Id: 4802015 } })
    }
    const id = await createArkApiKey({ credentials, fetchFn, name: 'dsh-test' })
    assert.equal(id, 4802015)
    assert.match(sent?.query ?? '', /Action=CreateApiKey&Version=2024-01-01/)
    assert.equal(sent?.contentType, 'application/json')
    const payload = JSON.parse(sent?.body ?? '{}') as Record<string, unknown>
    assert.equal(payload.Name, 'dsh-test')
    assert.equal(payload.ProjectName, 'default')
    assert.deepEqual(payload.AccessControlInfo, { AllowAll: true })
    // An empty array is rejected by the service as invalid; one empty object is accepted.
    assert.deepEqual(payload.ResourceInstances, [{}])
  })

  test('reads a key value back, and refuses an empty answer', async () => {
    const fetchFn: typeof fetch = async () => jsonResponse({ Result: { ApiKey: 'ark-abc123', SID: 'apik-1' } })
    assert.equal(await readArkApiKey({ credentials, fetchFn, id: 1 }), 'ark-abc123')

    const empty: typeof fetch = async () => jsonResponse({ Result: {} })
    await assert.rejects(() => readArkApiKey({ credentials, fetchFn: empty, id: 1 }), /no key/)
  })

  test('lists the account keys so a sign-in can reuse one', async () => {
    const fetchFn: typeof fetch = async () => jsonResponse({
      Result: {
        TotalCount: 1,
        Items: [{ Id: 7, Name: 'dsh-plugin-subscription-oauth', Status: 'Active', Key: 'ark-secret' }],
      },
    })
    const keys = await listArkApiKeys({ credentials, fetchFn })
    assert.deepEqual(keys, [{ id: 7, name: 'dsh-plugin-subscription-oauth', status: 'Active' }])
  })
})

describe('Ark route', () => {
  test('names itself for the picker', () => {
    assert.deepEqual(adapter().providerInfo(ARK_PROVIDER_ID), { id: ARK_PROVIDER_ID, name: 'Volcengine Ark' })
  })

  test('accepts a session and refuses one without a key', () => {
    const session = parseArkSession({ apiKey: 'key-1', expiresAt: 1_800_000_000_000, idToken: 'id-1', refreshToken: 'r' })
    assert.equal(session?.apiKey, 'key-1')
    // The data plane takes the key, so a session without one is unusable.
    assert.equal(parseArkSession({ expiresAt: 1 }), undefined)
    assert.equal(parseArkSession({ apiKey: 'key-1' }), undefined)
    assert.equal(parseArkSession(null), undefined)
  })

  test('offers nothing while signed out', async () => {
    const signedOut = adapter({ tokens: { session: async () => undefined } as never, cachedListing: async () => ARK_LISTING.data })
    // A catalog is not an entitlement: a model that cannot be called is not offered.
    assert.deepEqual(await signedOut.listModels(ARK_PROVIDER_ID), [])
  })

  test('the cached listing is the whole roster, names and windows included', async () => {
    const subject = adapter({ tokens: signedIn, cachedListing: async () => ARK_LISTING.data })
    const models = await subject.listModels(ARK_PROVIDER_ID)
    assert.deepEqual(
      models.map((model) => model.id),
      ['ark-code-latest', 'doubao-seed-2.0-code', 'deepseek-v5-thinking'],
    )
    // The plan's own display name and window, not a shipped guess.
    assert.equal(models[1]?.name, 'Doubao Seed 2.0 Code')
    const resolved = await subject.resolveModel(ARK_PROVIDER_ID, 'doubao-seed-2.0-code')
    assert.equal(resolved.context?.contextWindow, 524_288)
    assert.deepEqual(resolved.reasoning?.efforts.map((effort) => String(effort.id)), ['low', 'high'])
    assert.equal(String(resolved.reasoning?.defaultEffort), 'high')
  })

  test('a model this build never shipped is published from the listing alone', async () => {
    const subject = adapter({ tokens: signedIn, cachedListing: async () => ARK_LISTING.data })
    const entry = (await subject.listModels(ARK_PROVIDER_ID)).find((model) => model.id === 'deepseek-v5-thinking')
    assert.equal(entry?.name, 'DeepSeek V5 Thinking')
    assert.ok(subject.ownCatalogEntries().some((own) => own.id === 'deepseek-v5-thinking'))
  })

  test('an id the listing omits is not published as a row', async () => {
    const subject = adapter({ tokens: signedIn, cachedListing: async () => ARK_LISTING.data })
    const ids = (await subject.listModels(ARK_PROVIDER_ID)).map((model) => model.id)
    // `glm-5.3` was on the table this build used to ship for Ark; the plan no longer
    // serves it, so it must not be offered on this build's say-so.
    assert.equal(ids.includes('glm-5.3'), false)
    // It stays dispatchable — the plan, not this build, is what refuses it.
    assert.equal((await subject.resolveModel(ARK_PROVIDER_ID, 'glm-5.3')).id, 'glm-5.3')
  })

  test('an image model is called by an agent, never offered as a row', async () => {
    const subject = adapter({ tokens: signedIn, cachedListing: async () => ARK_LISTING.data })
    const ids = (await subject.listModels(ARK_PROVIDER_ID)).map((model) => model.id)
    assert.equal(ids.includes('doubao-image-gen'), false)
    await subject.hydrate()
    assert.equal(subject.imageModelId(), 'doubao-image-gen')
  })

  test('a picker query never asks the endpoint', async () => {
    let calls = 0
    const subject = adapter({
      tokens: signedIn,
      cachedListing: async () => ARK_LISTING.data,
      fetchFn: async () => {
        calls += 1
        throw new Error('a picker query must not fetch')
      },
    })
    assert.equal((await subject.listModels(ARK_PROVIDER_ID)).length, 3)
    await subject.resolveModel(ARK_PROVIDER_ID, 'deepseek-v5-thinking')
    assert.equal(calls, 0)
  })

  test('the cached listing is read once per session', async () => {
    let reads = 0
    const subject = adapter({
      tokens: signedIn,
      cachedListing: async () => {
        reads += 1
        return ARK_LISTING.data
      },
    })
    await subject.listModels(ARK_PROVIDER_ID)
    await subject.listModels(ARK_PROVIDER_ID)
    assert.equal(reads, 1)
  })

  test('a cache stored as the endpoint envelope is read too', async () => {
    const subject = adapter({ tokens: signedIn, cachedListing: async () => ARK_LISTING })
    assert.deepEqual(
      (await subject.listModels(ARK_PROVIDER_ID)).map((model) => model.id),
      ['ark-code-latest', 'doubao-seed-2.0-code', 'deepseek-v5-thinking'],
    )
  })

  test('an unreadable cache is a warning, and no roster is invented to fill it', async () => {
    const warnings: string[] = []
    const subject = adapter({
      tokens: signedIn,
      cachedListing: async () => {
        throw new Error('unreadable')
      },
      onWarn: (message) => { warnings.push(message) },
    })
    // Only the configured default remains: this build has no table of its own to show.
    assert.deepEqual(
      (await subject.listModels(ARK_PROVIDER_ID)).map((model) => model.id),
      [ARK_DEFAULT_MODEL],
    )
    assert.match(warnings.join('\n'), /cached model catalog unavailable \(unreadable\)/)
  })

  test('fetchCatalog adopts the live rows and caches exactly one payload', async () => {
    const saved: unknown[] = []
    const subject = adapter({
      tokens: signedIn,
      discovery: true,
      fetchFn: async () => jsonResponse(ARK_LISTING),
      saveListing: async (payload) => { saved.push(payload) },
    })
    assert.deepEqual(
      await subject.fetchCatalog('key-1'),
      ['ark-code-latest', 'doubao-seed-2.0-code', 'deepseek-v5-thinking'],
    )
    // The endpoint's own rows are what is kept, so a later build reads more of them.
    assert.equal(saved.length, 1)
    assert.deepEqual(saved[0], ARK_LISTING.data)
    const resolved = await subject.resolveModel(ARK_PROVIDER_ID, 'deepseek-v5-thinking')
    assert.equal(resolved.context?.contextWindow, 1_000_000)
  })

  test('a cache write failure is a warning, not a failed read', async () => {
    const warnings: string[] = []
    const subject = adapter({
      tokens: signedIn,
      discovery: true,
      fetchFn: async () => jsonResponse(ARK_LISTING),
      saveListing: async () => { throw new Error('disk full') },
      onWarn: (message) => { warnings.push(message) },
    })
    assert.equal((await subject.fetchCatalog('key-1'))?.length, 3)
    assert.match(warnings.join('\n'), /model catalog cache write failed \(disk full\)/)
  })

  test('a refused listing keeps the catalog it already had', async () => {
    const warnings: string[] = []
    const subject = adapter({
      tokens: signedIn,
      discovery: true,
      cachedListing: async () => ARK_LISTING.data,
      fetchFn: async () => jsonResponse({ error: 'nope' }, 503),
      onWarn: (message) => { warnings.push(message) },
    })
    await subject.hydrate()
    assert.equal(await subject.fetchCatalog('key-1'), undefined)
    assert.ok(subject.ownCatalogEntries().some((entry) => entry.id === 'deepseek-v5-thinking'))
    assert.match(warnings.join('\n'), /HTTP 503/)
  })

  test('an unknown id is still dispatchable', async () => {
    const resolved = await adapter({ tokens: signedIn, cachedListing: async () => ARK_LISTING.data })
      .resolveModel(ARK_PROVIDER_ID, 'doubao-new-2027')
    assert.equal(resolved.id, 'doubao-new-2027')
    assert.equal(resolved.context?.contextWindow, 262_144)
  })

  test('the allowance reader says why it cannot read the plan', async () => {
    // The quota needs the control plane's STS credentials, which the plugin does not
    // hold; stating that is better than showing a figure that is not the account's.
    const read = await readArkUsage({ credentials, fetchFn: async () => jsonResponse({}) })
    assert.deepEqual(read.windows, [])
    assert.equal(typeof read.usageError, 'string')
  })
})

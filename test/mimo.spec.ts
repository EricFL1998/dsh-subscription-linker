/**
 * Xiaomi MiMo: the session/sign-in surface and the wire adapter.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  Jar,
  MIMO_HOSTS,
  MIMO_REGION,
  MimoSignInLapsed,
  mimoCredentialsFrom,
  readMimoUsage,
  type MimoCredentials,
} from '../src/auth/mimo-flow.js'
import { MimoAdapter, MIMO_MODELS, MIMO_MODELS_PATH, MIMO_PUBLIC_API_BASE, parseMimoSession } from '../src/providers/mimo.js'
import type { MimoSession } from '../src/providers/mimo.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

import type { TokenManager } from '../src/auth/tokens.js'

const ACCOUNT = 'https://account.xiaomi.com'

/** A fetch that records requests and plays back canned responses by URL. */
function recorder(routes: Record<string, () => Response>) {
  const seen: { url: string, headers: Headers, body?: string | undefined }[] = []
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    const body = init?.body === undefined || typeof init?.body === 'string' ? init?.body : String(init.body)
    seen.push({ url, headers, body })
    const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))
    if (route === undefined) return new Response('not found', { status: 404 })
    return route[1]()
  }
  return { fetchFn, seen }
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

/** A fetch that answers every request with one canned listing response. */
function listingFetch(answer: () => Response) {
  const seen: { url: string, authorization: string, userAgent: string }[] = []
  const fetchFn: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers)
    seen.push({
      url: String(input),
      authorization: headers.get('authorization') ?? '',
      userAgent: headers.get('user-agent') ?? '',
    })
    return answer()
  }
  return { fetchFn, seen }
}

/** One listing body in the shape Xiaomi documents: an OpenAI-style envelope. */
function documentedListing(rows: readonly Record<string, unknown>[]): Response {
  return json({ object: 'list', data: rows.map((row) => ({ object: 'model', owned_by: 'xiaomi', ...row })) })
}

/** One SSE body from chat-completions frames. */
function sse(frames: string[]): Response {
  const body = frames.map((frame) => `data: ${frame}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** A usable signed-in MiMo session. */
function session(overrides: Partial<MimoSession> = {}): MimoSession {
  return {
    accessToken: '{"serviceToken":"st","userId":"u1"}',
    expiresAt: Date.now() + 60_000,
    accountId: 'u1',
    apiBase: MIMO_HOSTS[MIMO_REGION as keyof typeof MIMO_HOSTS],
    mimoCreds: JSON.stringify({ userId: 'u1', cUserId: '', passToken: 'pt', deviceId: 'pc_x', region: MIMO_REGION, base: MIMO_HOSTS[MIMO_REGION as keyof typeof MIMO_HOSTS] }),
    mimoCookies: '{"serviceToken":"st","userId":"u1","cUserId":"cu"}',
    ...overrides,
  }
}

function tokens(session: MimoSession): TokenManager<MimoSession> {
  const manager = {
    resolve: async () => ({ account: 'u1', accessToken: session.accessToken, expiresAt: session.expiresAt }),
    session: async () => ({ account: 'u1', session }),
    accounts: async () => ['u1'],
    defaultAccount: async () => 'u1',
  }
  return manager as unknown as TokenManager<MimoSession>
}

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'mimo',
    model: 'mimo-pro',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })],
    ...overrides,
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

test('parseMimoSession keeps a valid shape and drops the rest', () => {
  const good = parseMimoSession(session())
  assert.equal(good?.accountId, 'u1')
  assert.equal(good?.apiBase, MIMO_HOSTS[MIMO_REGION as keyof typeof MIMO_HOSTS])
  assert.equal(parseMimoSession({ accessToken: 'x' }), undefined)
  assert.equal(parseMimoSession(null), undefined)
  assert.equal(parseMimoSession('mimo'), undefined)
})

test('the cookie jar seeds, stores, and rebuilds a header', () => {
  const jar = new Jar()
  jar.seed(ACCOUNT, 'userId', 'u1')
  jar.seed(ACCOUNT, 'passToken', 'pt')
  assert.equal(jar.header(`${ACCOUNT}/`), 'userId=u1; passToken=pt')
  assert.equal(jar.forOrigin(MIMO_HOSTS.SGP).serviceToken, undefined)
})

test('mimoCredentialsFrom builds a durable credential from a poll', () => {
  const creds = mimoCredentialsFrom({ userId: 'u1', cUserId: 'cu', passToken: 'pt' }, 'pc_dev')
  assert.equal(creds.userId, 'u1')
  assert.equal(creds.passToken, 'pt')
  assert.equal(creds.deviceId, 'pc_dev')
  assert.equal(creds.region, MIMO_REGION)
  assert.equal(creds.base, MIMO_HOSTS[MIMO_REGION as keyof typeof MIMO_HOSTS])
})

test('listModels offers both models and omits hidden ones', async () => {
  const adapter = new MimoAdapter({
    streamIdleTimeoutMs: 1000,
    tokens: tokens(session()),
    hiddenModels: async () => new Set(['mimo-flash']),
  })
  const models = await adapter.listModels('mimo')
  assert.deepEqual(models.map((model) => model.id), ['mimo-pro'])
  assert.equal(models[0]?.name, 'MiMo Pro')
})

test('listModels is empty while signed out', async () => {
  const adapter = new MimoAdapter({
    streamIdleTimeoutMs: 1000,
    tokens: {
      resolve: async () => { throw new Error('signed out') },
      session: async () => undefined,
      accounts: async () => [],
      defaultAccount: async () => undefined,
    } as unknown as TokenManager<MimoSession>,
  })
  assert.deepEqual(await adapter.listModels('mimo'), [])
})

test('the built-in roster is what the picker shows before any listing', async () => {
  const adapter = new MimoAdapter({ streamIdleTimeoutMs: 1000, tokens: tokens(session()) })
  const models = await adapter.listModels('mimo')
  assert.deepEqual(models.map((model) => model.id), ['mimo-pro', 'mimo-flash'])
  assert.equal(models[0]?.name, 'MiMo Pro')
  assert.deepEqual(adapter.catalogEntries().map((entry) => entry.id), ['mimo-pro', 'mimo-flash'])
})

test('a cached listing is the catalog, and a picker query asks the network for nothing', async () => {
  let reads = 0
  let fetches = 0
  const adapter = new MimoAdapter({
    streamIdleTimeoutMs: 1000,
    tokens: tokens(session()),
    cachedListing: async () => {
      reads += 1
      return {
        object: 'list',
        data: [
          { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro', context_window: 262_144 },
          { id: 'mimo-v2.5-flash', name: 'MiMo V2.5 Flash', context_window: 131_072 },
        ],
      }
    },
    fetchFn: (async () => { fetches += 1; return json({}) }) as typeof fetch,
  })
  const models = await adapter.listModels('mimo')
  assert.deepEqual(models.map((model) => model.id), ['mimo-v2.5-pro', 'mimo-v2.5-flash'])
  assert.equal(models[0]?.name, 'MiMo V2.5 Pro')
  const resolved = await adapter.resolveModel('mimo', 'mimo-v2.5-flash')
  assert.equal(resolved.name, 'MiMo V2.5 Flash')
  assert.equal(resolved.context?.contextWindow, 131_072)
  // One picker query: no request at all, and the cached table is read once.
  assert.equal(fetches, 0)
  assert.equal(reads, 1)
})

test('a cache read failure is a miss, never an empty picker', async () => {
  const warnings: string[] = []
  const adapter = new MimoAdapter({
    streamIdleTimeoutMs: 1000,
    tokens: tokens(session()),
    cachedListing: async () => { throw new Error('cache gone') },
    onWarn: (message) => { warnings.push(message) },
  })
  const models = await adapter.listModels('mimo')
  assert.deepEqual(models.map((model) => model.id), ['mimo-pro', 'mimo-flash'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /cached MiMo model catalog unavailable/)
})

test('fetchCatalog adopts the documented listing and writes exactly one cache payload', async () => {
  const saved: unknown[] = []
  const rows = [{ id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro', context_window: 262_144 }]
  const { fetchFn, seen } = listingFetch(() => documentedListing(rows))
  const adapter = new MimoAdapter({
    streamIdleTimeoutMs: 1000,
    tokens: tokens(session()),
    fetchFn,
    saveListing: async (payload) => { saved.push(payload) },
  })
  const ids = await adapter.fetchCatalog('session-credential')
  assert.deepEqual(ids, ['mimo-v2.5-pro'])
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.url, 'https://api.xiaomimimo.com/v1/models')
  assert.equal(seen[0]?.url, `${MIMO_PUBLIC_API_BASE}${MIMO_MODELS_PATH}`)
  assert.equal(seen[0]?.authorization, 'Bearer session-credential')
  assert.match(seen[0]!.userAgent, /^miNative PC\//)
  // Exactly one write, and it is the listing's own rows.
  assert.equal(saved.length, 1)
  assert.deepEqual(saved[0], rows.map((row) => ({ object: 'model', owned_by: 'xiaomi', ...row })))
  // The listing is the catalog: the app roster it does not name is gone from the picker.
  const models = await adapter.listModels('mimo')
  assert.deepEqual(models.map((model) => model.id), ['mimo-v2.5-pro'])
  assert.equal(models[0]?.name, 'MiMo V2.5 Pro')
  assert.equal((await adapter.resolveModel('mimo', 'mimo-v2.5-pro')).context?.contextWindow, 262_144)
})

test('a live row keeps the seed metadata only where the listing is silent', async () => {
  const { fetchFn } = listingFetch(() => documentedListing([
    { id: 'mimo-pro' },
    { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro', context_window: 262_144 },
  ]))
  const adapter = new MimoAdapter({ streamIdleTimeoutMs: 1000, tokens: tokens(session()), fetchFn })
  assert.deepEqual(await adapter.fetchCatalog('tok'), ['mimo-pro', 'mimo-v2.5-pro'])
  // The seed describes this id, so its name and window fill the row's silence.
  const pro = await adapter.resolveModel('mimo', 'mimo-pro')
  assert.equal(pro.name, 'MiMo Pro')
  assert.equal(pro.context?.contextWindow, 1_000_000)
  // A row the seed does not describe keeps what the listing itself stated.
  const live = await adapter.resolveModel('mimo', 'mimo-v2.5-pro')
  assert.equal(live.name, 'MiMo V2.5 Pro')
  assert.equal(live.context?.contextWindow, 262_144)
})

test('discover keeps the metadata of an id the listing already described', async () => {
  const { fetchFn } = listingFetch(() => documentedListing([{ id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro', context_window: 262_144 }]))
  const adapter = new MimoAdapter({ streamIdleTimeoutMs: 1000, tokens: tokens(session()), fetchFn })
  await adapter.fetchCatalog('tok')
  adapter.discover(['mimo-v2.5-pro'])
  const entry = adapter.catalogEntries()[0]
  assert.equal(entry?.name, 'MiMo V2.5 Pro')
  assert.equal(entry?.contextWindow, 262_144)
})

test('a listing that does not answer keeps the roster, writes nothing, and warns once', async () => {
  const answers: (() => Response)[] = [
    // A non-2xx refusal.
    () => json({ error: { message: 'not found' } }, 404),
    // A 2xx body with no rows.
    () => json({ object: 'list' }),
    // A 2xx body that is not JSON at all.
    () => new Response('not json', { status: 200 }),
  ]
  for (const answer of answers) {
    const warnings: string[] = []
    const saved: unknown[] = []
    const { fetchFn, seen } = listingFetch(answer)
    const adapter = new MimoAdapter({
      streamIdleTimeoutMs: 1000,
      tokens: tokens(session()),
      fetchFn,
      saveListing: async (payload) => { saved.push(payload) },
      onWarn: (message) => { warnings.push(message) },
    })
    assert.equal(await adapter.fetchCatalog('tok'), undefined)
    assert.equal(seen.length, 1)
    assert.equal(warnings.length, 1)
    assert.equal(saved.length, 0)
    // One failure is stated once, however often the refresh asks.
    await adapter.fetchCatalog('tok')
    assert.equal(warnings.length, 1)
    assert.deepEqual((await adapter.listModels('mimo')).map((model) => model.id), ['mimo-pro', 'mimo-flash'])
  }
})

test('discovery switched off leaves the roster alone and asks nothing', async () => {
  let fetches = 0
  const adapter = new MimoAdapter({
    streamIdleTimeoutMs: 1000,
    tokens: tokens(session()),
    discovery: false,
    fetchFn: (async () => { fetches += 1; return json({}) }) as typeof fetch,
  })
  assert.equal(await adapter.fetchCatalog('tok'), undefined)
  assert.equal(fetches, 0)
  assert.deepEqual((await adapter.listModels('mimo')).map((model) => model.id), ['mimo-pro', 'mimo-flash'])
})

test('the stream posts chat completions with the session cookies', async () => {
  let seenCookie = ''
  let seenBody: Record<string, unknown> = {}
  const { fetchFn } = recorder({
    'https://mimo-server-sgp.xiaomimimo.com/api/route/chat/completions': () => {
      return sse([
        JSON.stringify({ choices: [{ delta: { content: 'Hi' } }] }),
        JSON.stringify({ choices: [{ delta: { content: ' there' } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
      ])
    },
  })
  const wrapping: typeof fetch = async (input, init) => {
    seenCookie = new Headers(init?.headers).get('cookie') ?? ''
    seenBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    return fetchFn(input, init)
  }
  const adapter = new MimoAdapter({ streamIdleTimeoutMs: 1000, tokens: tokens(session()), fetchFn: wrapping })
  const chunks = await collect(adapter.stream(request()))
  assert.equal(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'Hi'), true)
  assert.equal(chunks.some((chunk) => chunk.type === 'finish'), true)
  assert.match(seenCookie, /serviceToken=st/)
  assert.match(seenCookie, /cUserId=cu/)
  assert.equal(seenBody.model, 'mimo-pro')
  assert.equal(seenBody.stream, true)
})

test('a 401 surfaces as an invalid credential, not a network fault', async () => {
  const { fetchFn } = recorder({
    'https://mimo-server-sgp.xiaomimimo.com/api/route/chat/completions': () => json({ error: { message: 'unauthorized' } }, 401),
  })
  const adapter = new MimoAdapter({ streamIdleTimeoutMs: 1000, tokens: tokens(session()), fetchFn })
  await assert.rejects(
    () => collect(adapter.stream(request())),
    (error: unknown) => {
      const record = error as { failure?: { code?: string } }
      return record?.failure?.code === 'INVALID_CREDENTIAL'
    },
  )
})

test('MIMO_MODELS carries Pro and Flash with the shared window', () => {
  assert.deepEqual(MIMO_MODELS.map((entry) => entry.id), ['mimo-pro', 'mimo-flash'])
  assert.ok(MIMO_MODELS.every((entry) => entry.contextWindow === 1_000_000))
})

test('readMimoUsage reads the plan and the weekly allowance', async () => {
  const creds: MimoCredentials = {
    userId: 'u1',
    cUserId: '',
    passToken: 'pt',
    deviceId: 'pc_x',
    region: MIMO_REGION,
    base: MIMO_HOSTS[MIMO_REGION as keyof typeof MIMO_HOSTS],
  }
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input)
    if (url.includes('/user/xiaomi/subscription/self')) {
      return new Response(
        JSON.stringify({ code: 0, data: { current: { title: 'MiMo Pro', endTime: '2026-11-06' } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.includes('/user/usage')) {
      return new Response(
        JSON.stringify({ code: 0, data: { percent: 70, resetDate: '2026-10-20' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const read = await readMimoUsage({ cookies: { serviceToken: 'st' }, userId: 'u1' }, creds, fetchFn)
  assert.equal(read.plan, 'MiMo Pro')
  assert.ok(read.renewsAt !== undefined)
  assert.equal(read.windows.length, 1)
  const week = read.windows[0]!
  assert.equal(week.label, '7 days')
  assert.ok(Math.abs(week.usedPercent! - 30) < 0.001)
  assert.ok(week.resetsAt !== undefined)
})

test('readMimoUsage shows the plan alone when there is no weekly allowance', async () => {
  const creds: MimoCredentials = {
    userId: 'u1',
    cUserId: '',
    passToken: 'pt',
    deviceId: 'pc_x',
    region: MIMO_REGION,
    base: MIMO_HOSTS[MIMO_REGION as keyof typeof MIMO_HOSTS],
  }
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input)
    if (url.includes('/user/xiaomi/subscription/self')) {
      return new Response(JSON.stringify({ code: 0, data: { current: { planTier: 3 } } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/user/usage')) {
      // The free offer: no percent/reset.
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const read = await readMimoUsage({ cookies: { serviceToken: 'st' }, userId: 'u1' }, creds, fetchFn)
  assert.equal(read.plan, 'Pro')
  assert.equal(read.windows.length, 0)
})

test('readMimoUsage folds the Token Plan into the windows', async () => {
  const creds: MimoCredentials = {
    userId: 'u1',
    cUserId: '',
    passToken: 'pt',
    deviceId: 'pc_x',
    region: MIMO_REGION,
    base: MIMO_HOSTS[MIMO_REGION as keyof typeof MIMO_HOSTS],
  }
  // A first platform read (no cookies) answers 401 with a serviceLogin URL, which the
  // passToken follows through a couple of redirects; hand those redirects cookies so
  // the page read then answers with the data.
  const platformCookies = { serviceToken: 'pst' }
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input)
    const cookie = new Headers(init?.headers).get('cookie') ?? ''
    // App plan and weekly allowance come from the MiMo server.
    if (url.includes('mimo-server')) {
      if (url.includes('/user/xiaomi/subscription/self')) {
        return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ code: 0, data: { percent: 50, resetDate: '2026-10-20' } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    // The platform signs on with the passToken when no session cookie is present: a page
    // read answers 401 with a serviceLogin URL; the redirect hops through account to sts,
    // which sets the platform cookie and serves the detail page.
    if (url.includes('account.xiaomi.com')) {
      return new Response('', { status: 302, headers: { location: 'https://platform.xiaomimimo.com/sts' } })
    }
    if (url.includes('platform.xiaomimimo.com')) {
      if (url.includes('/sts')) {
        return new Response(JSON.stringify({ code: 0, data: { planName: 'Pro', expired: false, currentPeriodEnd: '2026-11-06 23:59:59' } }), { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'serviceToken=pst; Path=/' } })
      }
      if (cookie.includes('serviceToken=pst')) {
        if (url.includes('/tokenPlan/usage')) {
          return new Response(JSON.stringify({ code: 0, data: { monthUsage: { items: [{ name: 'month_total_token', used: 6810000, limit: 10000000 }] } } }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response(JSON.stringify({ code: 0, data: { planName: 'Pro', expired: false, currentPeriodEnd: '2026-11-06 23:59:59' } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ loginUrl: 'https://account.xiaomi.com/serviceLogin' }), { status: 401, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const read = await readMimoUsage({ cookies: { serviceToken: 'st' }, userId: 'u1' }, creds, fetchFn)
  // No app plan: the Token Plan names the account's plan.
  assert.equal(read.plan, 'Token Plan Pro')
  assert.ok(read.renewsAt !== undefined)
  // The weekly window plus the Token Plan's credits.
  assert.equal(read.windows.length, 2)
  assert.equal(read.windows[0]?.label, '7 days')
  const token = read.windows[1]!
  assert.equal(token.label, 'Token Plan')
  assert.equal(token.used, 6810000)
  assert.equal(token.limit, 10000000)
  assert.ok(Math.abs(token.usedPercent! - 68.1) < 0.1)
})

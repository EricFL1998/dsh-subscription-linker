/**
 * WorkBuddy China: the sign-in surface and the wire adapter.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseWorkBuddySession,
  mergeWorkBuddyToken,
  readWorkBuddyUsage,
  workbuddyDomain,
  workbuddyHeaders,
  workbuddyRefreshable,
  workbuddyStale,
  type WorkBuddySession,
  type WorkBuddyTokenSet,
} from '../src/auth/workbuddy-flow.js'
import {
  WORKBUDDY_CATALOG,
  WorkBuddyAdapter,
  WORKBUDDY_PROVIDER_NAME,
  conversationIdsFor,
  workbuddyModelsUrl,
} from '../src/providers/workbuddy.js'
import type { WorkBuddyAdapterOptions } from '../src/providers/workbuddy.js'
import type { TokenManager } from '../src/auth/tokens.js'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

function session(overrides: Partial<WorkBuddySession> = {}): WorkBuddySession {
  return {
    accessToken: 'at-1',
    expiresAt: Date.now() + 60 * 60 * 1000,
    accountId: 'coder',
    uid: 'u1',
    refreshToken: 'rt-1',
    ...overrides,
  }
}

function tokens(session: WorkBuddySession): TokenManager<WorkBuddySession> {
  const manager = {
    resolve: async () => ({ account: 'coder', accessToken: session.accessToken, expiresAt: session.expiresAt }),
    session: async () => ({ account: 'coder', session }),
    accounts: async () => ['coder'],
    defaultAccount: async () => 'coder',
  }
  return manager as unknown as TokenManager<WorkBuddySession>
}

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'workbuddy',
    model: 'hy4-preview-f',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })],
    ...overrides,
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

/** A chat-completions SSE body from frames. */
function sse(frames: string[]): Response {
  const body = frames.map((frame) => `data: ${frame}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** A chat-completions SSE body delivered as raw network reads (to exercise reassembly). */
function sseChunked(chunks: string[]): Response {
  const body = chunks.map((chunk) => new TextEncoder().encode(chunk))
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of body) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** A JSON response the way WorkBuddy's console sends one. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** An adapter with the smallest set of collaborators its methods touch. */
function adapter(options: Partial<WorkBuddyAdapterOptions> = {}): WorkBuddyAdapter {
  return new WorkBuddyAdapter({
    discovery: true,
    streamIdleTimeoutMs: 1000,
    tokens: tokens(session()),
    ...options,
  })
}

/**
 * One listing in the shape WorkBuddy's console answers with: the model table, and the
 * agents whose `models` lists decide what the account may use.
 *
 * The `cli` list is deliberately ordered differently from the table, and narrower than it:
 * `glm-5.3` and `kimi-k2.8-preview` are rows the account may see but not call. `hy4-preview`,
 * `space-bunny`, `step-5-preview` and `wb-fresh` are live ids this build never shipped,
 * while `hy3` and `glm-5.3-flash` are shipped ids the listing describes differently (or not
 * at all), so the reading rules are visible.
 */
const LISTING = {
  code: 0,
  data: {
    models: [
      { id: 'hy3', name: 'Hy3', maxInputTokens: 300_000, supportsImages: true, descriptionEn: 'Hy3 on the console', vendor: 'tencent' },
      { id: 'space-bunny', name: 'Space Bunny', contextWindow: 256_000, supportsImages: false, reasoning: { effort: 'medium', summary: 'auto' } },
      { id: 'auto', name: 'Auto', maxInputTokens: 168_000, supportsImages: false, isDefault: true },
      { id: 'step-5-preview', name: 'Step 5 Preview', maxAllowedSize: 512_000, supportsImages: false, reasoning: { effort: 'turbo' } },
      { id: 'hy4-preview', name: 'Hy4 Preview', maxInputTokens: 1_000_000, supportsImages: true, reasoning: { effort: 'high' } },
      { id: 'glm-5.3-flash' },
      { id: 'wb-fresh', name: 'WorkBuddy Fresh', supportsImages: true },
      { id: 'glm-5.3', name: 'GLM-5.3', maxInputTokens: 1_000_000, supportsImages: false },
      { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', maxInputTokens: 256_000, supportsImages: false },
    ],
    agents: [
      { name: 'chat', models: ['auto', 'glm-5.3'] },
      { name: 'cli', models: ['auto', 'hy3', 'hy4-preview', 'space-bunny', 'step-5-preview', 'glm-5.3-flash', 'wb-fresh'] },
    ],
    endpoint: 'https://copilot.tencent.com',
    mergeStrategy: 'append',
  },
}

/** The ids the listing above makes available, in the order its own `cli` agent states them. */
const LISTED_IDS = ['auto', 'hy3', 'hy4-preview', 'space-bunny', 'step-5-preview', 'glm-5.3-flash', 'wb-fresh']

test('parseWorkBuddySession keeps a valid shape and drops the rest', () => {
  const good = parseWorkBuddySession(session())
  assert.equal(good?.accountId, 'coder')
  assert.equal(good?.uid, 'u1')
  assert.equal(parseWorkBuddySession({ accessToken: 'x' }), undefined)
  assert.equal(parseWorkBuddySession('workbuddy'), undefined)
  assert.equal(parseWorkBuddySession(null), undefined)
})

test('mergeWorkBuddyToken folds expiresIn and refreshExpiresAt', () => {
  const now = Date.now()
  const merged = mergeWorkBuddyToken(
    { accessToken: 'old', expiresAt: 0 },
    { accessToken: 'new', expiresIn: 3600, refreshToken: 'rt', refreshExpiresIn: 7200 },
  )
  assert.equal(merged.accessToken, 'new')
  assert.equal(merged.refreshToken, 'rt')
  assert.ok(Math.abs(merged.expiresAt - (now + 3600 * 1000)) < 5000)
  assert.ok(Math.abs((merged.refreshExpiresAt ?? 0) - (now + 7200 * 1000)) < 5000)
})

test('workbuddyDomain falls back to the API host', () => {
  assert.equal(workbuddyDomain({ domain: 'copilot.tencent.com' }), 'copilot.tencent.com')
  assert.equal(workbuddyDomain({}), 'copilot.tencent.com')
})

test('workbuddyHeaders carries the account, client, and enterprise attribution', () => {
  const headers = workbuddyHeaders({ accessToken: 'at', uid: 'u1', enterpriseId: 'ent1', expiresAt: 0 })
  assert.equal(headers.Authorization, 'Bearer at')
  assert.equal(headers['X-User-Id'], 'u1')
  assert.equal(headers['X-Enterprise-Id'], 'ent1')
  assert.equal(headers['X-IDE-Name'], 'WorkBuddy')
  assert.equal(headers['User-Agent'], 'WorkBuddy/5.5.6')
})

test('workbuddyStale and workbuddyRefreshable read the token lifetimes', () => {
  assert.equal(workbuddyStale({ expiresAt: Date.now() + 30_000 }), true)
  assert.equal(workbuddyStale({ expiresAt: Date.now() + 10 * 60 * 1000 }), false)
  assert.equal(workbuddyStale({ expiresAt: 0 }), false)
  assert.equal(workbuddyRefreshable({ accessToken: 'a', expiresAt: 0 }), false)
  assert.equal(workbuddyRefreshable({ accessToken: 'a', expiresAt: 0, refreshToken: 'rt' }), true)
  assert.equal(
    workbuddyRefreshable({ accessToken: 'a', expiresAt: 0, refreshToken: 'rt', refreshExpiresAt: Date.now() - 1 }),
    false,
  )
})

test('WORKBUDDY_CATALOG ships the China models with their windows and efforts', () => {
  const ids = WORKBUDDY_CATALOG.map((entry) => entry.id)
  assert.ok(ids.includes('hy4-preview-f'))
  assert.ok(ids.includes('glm-5.3'))
  assert.ok(ids.includes('kimi-k3-1'))
  const hy4 = WORKBUDDY_CATALOG.find((entry) => entry.id === 'hy4-preview-f')
  assert.equal(hy4?.contextWindow, 1_000_000)
  assert.deepEqual(hy4?.reasoningEfforts, ['high'])
})

test('listModels offers the catalog and omits hidden ids', async () => {
  const adapter = new WorkBuddyAdapter({
    discovery: true,
    streamIdleTimeoutMs: 1000,
    tokens: tokens(session()),
    hiddenModels: async () => new Set(['auto']),
  })
  const models = await adapter.listModels('workbuddy')
  assert.ok(models.length > 0)
  assert.equal(models.some((model) => model.id === 'auto'), false)
  assert.equal(models.some((model) => model.id === 'hy4-preview-f'), true)
})

test('listModels is empty while signed out', async () => {
  const adapter = new WorkBuddyAdapter({
    discovery: true,
    streamIdleTimeoutMs: 1000,
    tokens: {
      resolve: async () => { throw new Error('signed out') },
      session: async () => undefined,
      accounts: async () => [],
      defaultAccount: async () => undefined,
    } as unknown as TokenManager<WorkBuddySession>,
  })
  assert.deepEqual(await adapter.listModels('workbuddy'), [])
})

test('workbuddyModelsUrl scopes the listing to the enterprise, or to personal', () => {
  assert.equal(workbuddyModelsUrl('ent-1'), 'https://copilot.tencent.com/console/enterprises/ent-1/models')
  // An account that states no enterprise reads the personal listing.
  assert.equal(workbuddyModelsUrl(), 'https://copilot.tencent.com/console/enterprises/personal/models')
  assert.equal(workbuddyModelsUrl('   '), 'https://copilot.tencent.com/console/enterprises/personal/models')
})

test('the cached listing is the catalog, and the shipped rows it drops are gone', async () => {
  const subject = adapter({ cachedListing: async () => LISTING })
  const models = await subject.listModels('workbuddy')
  // Membership and order are the account's own `cli` list, not this build's table.
  assert.deepEqual(models.map((model) => model.id), LISTED_IDS)
  // A model this build never shipped is published from the listing alone.
  assert.ok(subject.ownCatalogEntries().some((entry) => entry.id === 'space-bunny'))
  assert.ok(subject.catalogEntries().some((entry) => entry.id === 'wb-fresh'))
  // Shipped rows the console does not serve are not offered on this build's say-so.
  assert.equal(models.some((model) => model.id === 'hy4-preview-f'), false)
  assert.equal(models.some((model) => model.id === 'hy3-x'), false)
  // A row the account may see but not call is not offered either.
  assert.equal(models.some((model) => model.id === 'glm-5.3'), false)
})

test('each row states its own name, window, modalities and reasoning rung', async () => {
  const subject = adapter({ cachedListing: async () => LISTING })
  const hy3 = (await subject.listModels('workbuddy')).find((model) => model.id === 'hy3')
  assert.equal(hy3?.name, 'Hy3')
  const described = await subject.resolveModel('workbuddy', 'hy3')
  // `maxInputTokens` is the first figure the row states, so it wins over the seed table's
  // 192 000 for this id, and the row's own description is what the picker shows.
  assert.equal(described.context?.contextWindow, 300_000)
  assert.deepEqual(described.inputModalities, ['text', 'image'])
  assert.equal(described.description, 'Hy3 on the console')

  // A few rows state `contextWindow` instead, and some only `maxAllowedSize`.
  const bunny = await subject.resolveModel('workbuddy', 'space-bunny')
  assert.equal(bunny.context?.contextWindow, 256_000)
  assert.deepEqual(bunny.inputModalities, ['text'])
  assert.deepEqual(bunny.reasoning?.efforts.map((effort) => String(effort.id)), ['medium'])
  assert.equal(String(bunny.reasoning?.defaultEffort), 'medium')
  assert.equal((await subject.resolveModel('workbuddy', 'step-5-preview')).context?.contextWindow, 512_000)
  // `turbo` is not a rung the harness has a word for, so it is dropped, not advertised.
  assert.equal((await subject.resolveModel('workbuddy', 'step-5-preview')).reasoning, undefined)
  assert.deepEqual(
    (await subject.resolveModel('workbuddy', 'hy4-preview')).reasoning?.efforts.map((effort) => String(effort.id)),
    ['high'],
  )

  // A row that states no window at all takes the advertised fallback…
  assert.equal((await subject.resolveModel('workbuddy', 'wb-fresh')).context?.contextWindow, 168_000)
  // …while one the seed table knows is described by it where the row is silent.
  const flash = await subject.resolveModel('workbuddy', 'glm-5.3-flash')
  assert.equal(flash.name, 'GLM-5.3-Flash')
  assert.equal(flash.context?.contextWindow, 1_000_000)
  assert.deepEqual(flash.reasoning?.efforts.map((effort) => String(effort.id)), ['low', 'high', 'max'])
})

test('the cli agent decides membership; without one the whole table is served', async () => {
  const narrowed = adapter({ cachedListing: async () => LISTING })
  const ids = (await narrowed.listModels('workbuddy')).map((model) => model.id)
  assert.equal(ids.includes('glm-5.3'), false)
  assert.equal(ids.includes('kimi-k2.8-preview'), false)

  // No `cli` entry: every model row is available, which is the console's own fallback.
  const whole = adapter({ cachedListing: async () => ({ data: { models: LISTING.data.models, agents: [{ name: 'chat', models: ['auto'] }] } }) })
  const every = (await whole.listModels('workbuddy')).map((model) => model.id)
  assert.equal(every.length, LISTING.data.models.length)
  assert.ok(every.includes('glm-5.3'))

  // An empty `cli` list is not a membership of none either.
  const empty = adapter({ cachedListing: async () => ({ data: { models: LISTING.data.models, agents: [{ name: 'cli', models: [] }] } }) })
  assert.equal((await empty.listModels('workbuddy')).length, LISTING.data.models.length)
})

test('a picker query asks the console nothing', async () => {
  let calls = 0
  const subject = adapter({
    cachedListing: async () => LISTING,
    fetchFn: async () => {
      calls += 1
      throw new Error('a picker query must not fetch')
    },
  })
  const models = await subject.listModels('workbuddy')
  assert.equal(models.length, LISTED_IDS.length)
  await subject.resolveModel('workbuddy', 'hy4-preview')
  await subject.resolveModel('workbuddy', 'never-shipped')
  assert.equal(calls, 0)
})

test('the cached listing is read once, and an unreadable cache falls back to the seed', async () => {
  let reads = 0
  const subject = adapter({
    cachedListing: async () => {
      reads += 1
      return LISTING
    },
  })
  await subject.listModels('workbuddy')
  await subject.listModels('workbuddy')
  assert.equal(reads, 1)

  const warnings: string[] = []
  const broken = adapter({
    cachedListing: async () => { throw new Error('unreadable') },
    onWarn: (message) => { warnings.push(message) },
  })
  const ids = (await broken.listModels('workbuddy')).map((model) => model.id)
  // A cache miss is never a failure: the seed table is still shown.
  assert.ok(ids.includes('hy4-preview-f'))
  assert.match(warnings.join('\n'), /cached model catalog unavailable \(unreadable\)/)
})

test('fetchCatalog reads the console route for the session enterprise', async () => {
  const seen: { url: string, headers: Headers }[] = []
  const saved: unknown[] = []
  const subject = adapter({
    tokens: tokens(session({ enterpriseId: 'ent-1' })),
    fetchFn: async (input, init) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers) })
      return jsonResponse(LISTING)
    },
    saveListing: async (payload) => { saved.push(payload) },
  })
  assert.deepEqual(await subject.fetchCatalog('at-1'), LISTED_IDS)
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.url, 'https://copilot.tencent.com/console/enterprises/ent-1/models')
  const headers = seen[0]!.headers
  assert.equal(headers.get('authorization'), 'Bearer at-1')
  assert.equal(headers.get('accept'), 'application/json, text/plain, */*')
  assert.equal(headers.get('x-requested-with'), 'XMLHttpRequest')
  assert.equal(headers.get('x-enterprise-id'), 'ent-1')
  assert.equal(headers.get('x-tenant-id'), 'ent-1')
  assert.equal(headers.get('x-user-id'), 'u1')
  // Exactly one cache payload, and it is the console's own answer — enough to rebuild the
  // same catalog, `cli` membership included.
  assert.equal(saved.length, 1)
  assert.deepEqual(saved[0], LISTING)
  // The listing just read is what the route now serves.
  assert.deepEqual(subject.ownCatalogEntries().map((entry) => entry.id), LISTED_IDS)
})

test('fetchCatalog addresses the personal listing when the session states no enterprise', async () => {
  let url = ''
  const subject = adapter({
    fetchFn: async (input) => {
      url = String(input)
      return jsonResponse(LISTING)
    },
  })
  assert.deepEqual(await subject.fetchCatalog('at-1'), LISTED_IDS)
  assert.equal(url, 'https://copilot.tencent.com/console/enterprises/personal/models')
})

test('discovery switched off reads nothing and keeps the seed table', async () => {
  let calls = 0
  const subject = adapter({
    discovery: false,
    fetchFn: async () => {
      calls += 1
      return jsonResponse(LISTING)
    },
  })
  assert.equal(await subject.fetchCatalog('at-1'), undefined)
  assert.equal(calls, 0)
  assert.ok((await subject.listModels('workbuddy')).some((model) => model.id === 'hy4-preview-f'))
})

test('a refused listing keeps the catalog the route already had, and warns once', async () => {
  const warnings: string[] = []
  const subject = adapter({
    cachedListing: async () => LISTING,
    fetchFn: async () => new Response('nope', { status: 500 }),
    onWarn: (message) => { warnings.push(message) },
  })
  // No picker query ran first: the read itself has to fall back to the cached listing,
  // not to the seed table this build ships.
  assert.equal(await subject.fetchCatalog('at-1'), undefined)
  assert.deepEqual(subject.ownCatalogEntries().map((entry) => entry.id), LISTED_IDS)
  assert.equal(warnings.filter((message) => /HTTP 500/.test(message)).length, 1)
})

test('an unparsable listing keeps the catalog the route already had', async () => {
  const warnings: string[] = []
  const subject = adapter({
    cachedListing: async () => LISTING,
    fetchFn: async () => new Response('<html>gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    onWarn: (message) => { warnings.push(message) },
  })
  assert.equal(await subject.fetchCatalog('at-1'), undefined)
  assert.deepEqual(subject.ownCatalogEntries().map((entry) => entry.id), LISTED_IDS)
  assert.match(warnings.join('\n'), /WorkBuddy model list unavailable; keeping the last catalog/)
})

test('an empty listing keeps the catalog the route already had', async () => {
  const warnings: string[] = []
  const subject = adapter({
    cachedListing: async () => LISTING,
    fetchFn: async () => jsonResponse({ code: 0, data: { models: [], agents: [{ name: 'cli', models: [] }] } }),
    onWarn: (message) => { warnings.push(message) },
  })
  assert.equal(await subject.fetchCatalog('at-1'), undefined)
  assert.deepEqual(subject.ownCatalogEntries().map((entry) => entry.id), LISTED_IDS)
  assert.match(warnings.join('\n'), /empty catalog; keeping the last catalog/)
})

test('a failed read with no cache leaves the shipped table in place', async () => {
  const warnings: string[] = []
  const subject = adapter({
    fetchFn: async () => new Response('down', { status: 503 }),
    onWarn: (message) => { warnings.push(message) },
  })
  assert.equal(await subject.fetchCatalog('at-1'), undefined)
  assert.deepEqual((await subject.listModels('workbuddy')).map((model) => model.id), WORKBUDDY_CATALOG.map((entry) => entry.id))
  assert.match(warnings.join('\n'), /HTTP 503/)
})

test('a discovered id joins the catalog without displacing what the listing stated', async () => {
  const subject = adapter({ cachedListing: async () => LISTING })
  await subject.hydrate()
  subject.discover(['auto', 'hy3', 'wb-brand-new'])
  assert.deepEqual(subject.catalogEntries().map((entry) => entry.id), ['auto', 'hy3', 'wb-brand-new'])
  // The listing described `hy3`; reporting its id again must not erase that.
  assert.equal(subject.catalogEntries().find((entry) => entry.id === 'hy3')?.contextWindow, 300_000)
  // An id only the seed table knows keeps the seed's metadata.
  assert.equal(subject.catalogEntries().find((entry) => entry.id === 'auto')?.contextWindow, 168_000)
})

test('the stream posts chat completions with the WorkBuddy headers', async () => {
  let seenBody: Record<string, unknown> = {}
  let seenUa = ''
  const fetchFn: typeof fetch = async (_input, init) => {
    seenUa = new Headers(init?.headers).get('user-agent') ?? ''
    seenBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    return sse([
      JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }),
      JSON.stringify({ choices: [{ delta: { content: ' from WorkBuddy' } }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } }),
    ])
  }
  const adapter = new WorkBuddyAdapter({ discovery: true, streamIdleTimeoutMs: 1000, tokens: tokens(session()), fetchFn })
  const chunks = await collect(adapter.stream(request()))
  assert.equal(seenUa, 'WorkBuddy/5.5.6')
  assert.equal(seenBody.model, 'hy4-preview-f')
  assert.equal(seenBody.stream, true)
  assert.ok(Array.isArray(seenBody.messages))
  // WorkBuddy refuses a chat that doesn't open with a system message: the request gets
  // WorkBuddy's default one, ahead of the conversation.
  const messages = seenBody.messages as { role: string, content: string }[]
  assert.equal(messages[0]?.role, 'system')
  assert.equal(messages[0]?.content, 'You are a helpful assistant.')
  assert.equal(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'Hello'), true)
  assert.equal(chunks.some((chunk) => chunk.type === 'usage'), true)
  assert.equal(chunks.some((chunk) => chunk.type === 'finish'), true)
})

/** Everything the harness would assemble from a chunk stream. */
function assemble(chunks: StreamChunk[]): { blocks: unknown[], finish: string } {
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  return { blocks: assembler.blocks(), finish: assembler.finish.kind }
}

test('the answer the reader sees is the text its block-end closes', async () => {
  // The assembler keeps `block-end`'s block as the block's content and never looks at the
  // deltas again, so a close that carries an empty text leaves the reader a blank answer
  // however much streamed in. The gateway's trailing empty function stub must not add
  // blocks of its own either.
  const fetchFn: typeof fetch = async () => sse([
    JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '' } }] }),
    JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }),
    JSON.stringify({ choices: [{ delta: { content: ' from WorkBuddy' } }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } }),
    JSON.stringify({ choices: [{ delta: { role: 'assistant', function_call: { name: '', arguments: '' }, tool_calls: [] } }], finish_reason: 'stop' }),
  ])
  const adapter = new WorkBuddyAdapter({ discovery: true, streamIdleTimeoutMs: 1000, tokens: tokens(session()), fetchFn })
  const seen = assemble(await collect(adapter.stream(request())))
  assert.deepEqual(seen.blocks, [{ type: 'text', text: 'Hello from WorkBuddy' }])
  assert.equal(seen.finish, 'stop')
})

test('a streamed tool call rides its own block instead of folding into the text', async () => {
  const fetchFn: typeof fetch = async () => sse([
    JSON.stringify({ choices: [{ delta: { content: 'Reading' } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path"' } }] } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"/x"}' } }] } }] }),
    JSON.stringify({ choices: [{ delta: { function_call: { name: '', arguments: '' }, tool_calls: [] } }], finish_reason: 'tool_calls' }),
  ])
  const adapter = new WorkBuddyAdapter({ discovery: true, streamIdleTimeoutMs: 1000, tokens: tokens(session()), fetchFn })
  const seen = assemble(await collect(adapter.stream(request())))
  assert.deepEqual(seen.blocks, [
    { type: 'text', text: 'Reading' },
    { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"/x"}' },
  ])
  assert.equal(seen.finish, 'tool-calls')
})

test('a tool with an unsafe name is made safe for the wire and renamed back in the answer', async () => {
  let seenBody: Record<string, unknown> = {}
  const fetchFn: typeof fetch = async (_input, init) => {
    seenBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    return sse([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":"/x"}' } }] } }] }),
    ])
  }
  const adapter = new WorkBuddyAdapter({ discovery: true, streamIdleTimeoutMs: 1000, tokens: tokens(session()), fetchFn })
  const withTools = { ...request(), tools: [{ name: 'read.file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }] }
  const chunks = await collect(adapter.stream(withTools))
  // The unsafe name went out safe: a `.` became `_`.
  const tools = seenBody.tools as { function: { name: string } }[]
  assert.equal(tools[0]?.function.name, 'read_file')
  // The model's call is renamed back to the name the client declared.
  const call = chunks.find((chunk) => chunk.type === 'tool-call-delta' && chunk.name !== undefined)
  assert.equal(call?.type === 'tool-call-delta' ? call.name : undefined, 'read.file')
})

test('a credits-exhausted 403 names the package fix, not a network fault', async () => {
  const fetchFn: typeof fetch = async () =>
    new Response(JSON.stringify({ code: 14018, msg: 'Credits exhausted' }), { status: 403, headers: { 'content-type': 'application/json' } })
  const adapter = new WorkBuddyAdapter({ discovery: true, streamIdleTimeoutMs: 1000, tokens: tokens(session()), fetchFn })
  await assert.rejects(
    () => collect(adapter.stream(request())),
    (error: unknown) => error instanceof Error && /active credit package/i.test(error.message),
  )
})

test('a 401 on the resolved token forces one refresh and retries the chat', async () => {
  let calls = 0
  const seenTokens: string[] = []
  const seenTurns: string[] = []
  const fetchFn: typeof fetch = async (_input, init) => {
    calls += 1
    seenTokens.push(new Headers(init?.headers).get('authorization') ?? '')
    seenTurns.push(new Headers(init?.headers).get('x-conversation-request-id') ?? '')
    if (calls === 1) return jsonResponse({ code: 401, msg: 'token expired' }, 401)
    return sse([JSON.stringify({ choices: [{ delta: { content: 'Refreshed' } }] })])
  }
  // The first resolve() answers with the stored (now stale) token; the force refresh after
  // the 401 hands back a new one, and the retry must carry it.
  let refreshed = false
  const manager = {
    resolve: async (_account?: string, force?: boolean) => {
      if (force === true) refreshed = true
      return {
        account: 'coder',
        accessToken: refreshed ? 'at-fresh' : 'at-stale',
        expiresAt: Date.now() + 60 * 60 * 1000,
      }
    },
    session: async () => ({ account: 'coder', session: session(refreshed ? { accessToken: 'at-fresh' } : { accessToken: 'at-stale' }) }),
    accounts: async () => ['coder'],
    defaultAccount: async () => 'coder',
  } as unknown as TokenManager<WorkBuddySession>
  const adapter = new WorkBuddyAdapter({ discovery: true, streamIdleTimeoutMs: 1000, tokens: manager, fetchFn })
  const chunks = await collect(adapter.stream({ ...request(), sessionId: 'sess-retry' as never }))
  assert.equal(calls, 2)
  assert.ok(refreshed)
  assert.equal(seenTokens[0], 'Bearer at-stale')
  assert.equal(seenTokens[1], 'Bearer at-fresh')
  // The refresh retry is the same user send: same turn id, never a fresh one per attempt.
  assert.match(seenTurns[0] ?? '', /^[0-9a-f]{32}$/)
  assert.equal(seenTurns[1], seenTurns[0])
  assert.ok(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'Refreshed'))
})

test('a 401 that survives the refresh is a plain credential failure', async () => {
  let calls = 0
  const fetchFn: typeof fetch = async () => {
    calls += 1
    return jsonResponse({ code: 401, msg: 'still expired' }, 401)
  }
  let forceCalls = 0
  const manager = {
    resolve: async (_account?: string, force?: boolean) => {
      if (force === true) forceCalls += 1
      return { account: 'coder', accessToken: 'at', expiresAt: Date.now() + 60 * 60 * 1000 }
    },
    session: async () => ({ account: 'coder', session: session() }),
    accounts: async () => ['coder'],
    defaultAccount: async () => 'coder',
  } as unknown as TokenManager<WorkBuddySession>
  const adapter = new WorkBuddyAdapter({ discovery: true, streamIdleTimeoutMs: 1000, tokens: manager, fetchFn })
  await assert.rejects(() => collect(adapter.stream(request())))
  assert.equal(calls, 2)
  assert.equal(forceCalls, 1)
})

test('one send carries a stable turn id across retries and tool steps', async () => {
  const base = request()
  // One user send: a request and its tool-result step carry the same turn id, and the
  // conversation id is the session's, as WorkBuddy's own client keeps them.
  const first = conversationIdsFor(
    { model: 'm', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }] },
    { ...base, sessionId: 'sess-1' as never },
  )
  const afterTools = conversationIdsFor(
    { model: 'm', messages: [
      { role: 'system', content: 's' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 't', arguments: '{}' } }] },
      { role: 'tool', content: 'out' },
    ] },
    { ...base, sessionId: 'sess-1' as never },
  )
  assert.equal(typeof first.message, 'string')
  assert.match(first.message, /^[0-9a-f]{32}$/)
  assert.match(first.turn, /^[0-9a-f]{32}$/)
  assert.match(afterTools.turn, /^[0-9a-f]{32}$/)
  // The message/request id is one request's own; the turn id is one user send's own.
  assert.notEqual(first.message, afterTools.message)
  assert.equal(first.turn, afterTools.turn)
  assert.equal(first.conversation, afterTools.conversation)
  assert.match(first.conversation ?? '', /^[0-9a-f]{32}$/)

  // The user's next message is another send: another turn id, the same conversation.
  const second = conversationIdsFor(
    { model: 'm', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'next' }] },
    { ...base, sessionId: 'sess-1' as never },
  )
  assert.notEqual(second.turn, first.turn)
  assert.equal(second.conversation, first.conversation)

  // A different session is another conversation, another turn.
  const other = conversationIdsFor(
    { model: 'm', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }] },
    { ...base, sessionId: 'sess-2' as never },
  )
  assert.notEqual(other.conversation, first.conversation)

  // No session and no user message: no conversation id is invented, the turn is fresh.
  const bare = conversationIdsFor({ model: 'm', messages: [{ role: 'system', content: 's' }] }, base)
  assert.equal(bare.conversation, undefined)
  assert.match(bare.turn, /^[0-9a-f]{32}$/)
})

test('a wire finish_reason length reads as max-tokens, not a clean stop', async () => {
  const fetchFn: typeof fetch = async () => sse([
    JSON.stringify({ choices: [{ delta: { content: 'part' } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }),
  ])
  const adapter = new WorkBuddyAdapter({ discovery: true, streamIdleTimeoutMs: 1000, tokens: tokens(session()), fetchFn })
  const seen = assemble(await collect(adapter.stream(request())))
  assert.deepEqual(seen.blocks, [{ type: 'text', text: 'part' }])
  assert.equal(seen.finish, 'max-tokens')
})

test('readWorkBuddyUsage reads the precise spent against the live packages', async () => {
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input)
    // The precise source: each live package's remaining and size.
    if (url.includes('/billing/meter/get-user-resource')) {
      return new Response(
        JSON.stringify({ code: 0, data: { Response: { Data: { Accounts: [
          { CapacityType: 1, CapacityRemain: '700', CapacitySize: '1000' },
          { CapacityType: 1, CapacityRemain: '375', CapacitySize: '500', ExpiredTime: '2026-11-01 00:00:00' },
        ] } } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const token: WorkBuddyTokenSet = { accessToken: 'at', uid: 'u1', expiresAt: Date.now() + 60_000 }
  const read = await readWorkBuddyUsage(token, 'Pro', fetchFn, { spent: 425 })
  assert.equal(read.windows.length, 1)
  const credits = read.windows[0]!
  assert.equal(credits.label, 'Credits')
  assert.equal(credits.used, 425)
  assert.equal(credits.limit, 1500)
  assert.ok(Math.abs(credits.usedPercent! - (100 * 425) / 1500) < 0.001)
  assert.ok(credits.resetsAt !== undefined)
})

test('readWorkBuddyUsage falls back to the summary when the package list fails', async () => {
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input)
    if (url.includes('/billing/meter/get-user-resource') && !url.includes('summary')) {
      return new Response('boom', { status: 500 })
    }
    if (url.includes('/billing/meter/get-user-resource-summary')) {
      return new Response(
        JSON.stringify({ code: 0, data: { IsPaidUser: true, Packages: [
          { CycleTotalCapacity: '1000', CycleUsedCapacity: '250' },
          { CycleTotalCapacity: '500', CycleUsedCapacity: '125' },
        ] } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const token: WorkBuddyTokenSet = { accessToken: 'at', uid: 'u1', expiresAt: Date.now() + 60_000 }
  const read = await readWorkBuddyUsage(token, 'Pro', fetchFn)
  assert.equal(read.plan, 'Pro')
  assert.equal(read.windows.length, 1)
  const credits = read.windows[0]!
  assert.equal(credits.used, 375)
  assert.equal(credits.limit, 1500)
})

test('readWorkBuddyUsage falls back to the enterprise meter for an enterprise account', async () => {
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input)
    if (url.includes('/billing/meter/get-user-resource-summary')) {
      return new Response(JSON.stringify({ code: 0, data: { IsPaidUser: true, Packages: [] } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/billing/meter/get-enterprise-user-usage')) {
      return new Response(
        JSON.stringify({ code: 0, data: { limitNum: '800', credit: '200', cycleResetTime: '2026-10-20 00:00:00' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const token: WorkBuddyTokenSet = { accessToken: 'at', uid: 'u1', enterpriseId: 'ent1', expiresAt: Date.now() + 60_000 }
  const read = await readWorkBuddyUsage(token, undefined, fetchFn)
  assert.equal(read.plan, 'Enterprise')
  assert.equal(read.windows[0]?.used, 200)
  assert.equal(read.windows[0]?.limit, 800)
  assert.ok(read.windows[0]?.resetsAt !== undefined)
})

test('an SSE event split across network reads, and two events in one read, both reassemble', async () => {
  const frameA = JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] })
  const frameB = JSON.stringify({ choices: [{ delta: { content: 'lo' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
  // frameA is split mid-value across the first three reads; the fourth read carries frameA's
  // tail, a whole second event (frameB), and the terminator — the shapes that used to drop a
  // fragment and leave a block without its block-end.
  const eventA = `data: ${frameA}\n\n`
  const eventB = `data: ${frameB}\n\ndata: [DONE]\n\n`
  const fetchFn: typeof fetch = async () => sseChunked([
    eventA.slice(0, 20),
    eventA.slice(20, 30),
    eventA.slice(30),
    eventB,
  ])
  const adapter = new WorkBuddyAdapter({ discovery: true, streamIdleTimeoutMs: 1000, tokens: tokens(session()), fetchFn })
  const seen = assemble(await collect(adapter.stream(request())))
  assert.deepEqual(seen.blocks, [{ type: 'text', text: 'Hello' }])
  assert.equal(seen.finish, 'stop')
})

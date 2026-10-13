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
import { WORKBUDDY_CATALOG, WorkBuddyAdapter, WORKBUDDY_PROVIDER_NAME } from '../src/providers/workbuddy.js'
import type { TokenManager } from '../src/auth/tokens.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
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
  assert.equal(headers['X-Tenant-Id'], 'ent1')
  assert.equal(headers['X-IDE-Name'], 'WorkBuddy')
  assert.match(headers['User-Agent'], /^WorkBuddy\//)
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
  const adapter = new WorkBuddyAdapter({ streamIdleTimeoutMs: 1000, tokens: tokens(session()), fetchFn })
  const chunks = await collect(adapter.stream(request()))
  assert.match(seenUa, /^WorkBuddy\//)
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

test('a tool with an unsafe name is made safe for the wire and renamed back in the answer', async () => {
  let seenBody: Record<string, unknown> = {}
  const fetchFn: typeof fetch = async (_input, init) => {
    seenBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    return sse([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":"/x"}' } }] } }] }),
    ])
  }
  const adapter = new WorkBuddyAdapter({ streamIdleTimeoutMs: 1000, tokens: tokens(session()), fetchFn })
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
  const adapter = new WorkBuddyAdapter({ streamIdleTimeoutMs: 1000, tokens: tokens(session()), fetchFn })
  await assert.rejects(
    () => collect(adapter.stream(request())),
    (error: unknown) => error instanceof Error && /active credit package/i.test(error.message),
  )
})

test('readWorkBuddyUsage reads the account credits from the resource summary', async () => {
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input)
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
  assert.equal(credits.label, 'Credits')
  assert.equal(credits.used, 375)
  assert.equal(credits.limit, 1500)
  assert.ok(Math.abs(credits.usedPercent! - 25) < 0.001)
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

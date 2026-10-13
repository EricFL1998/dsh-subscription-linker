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
import { MimoAdapter, MIMO_MODELS, parseMimoSession } from '../src/providers/mimo.js'
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

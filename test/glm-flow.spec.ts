/**
 * The ZCode/BigModel OAuth flow: what it sends, and what it accepts back.
 *
 * @module dsh-plugin-subscription-oauth/test/glm-flow
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { GLM_BROKER_PROVIDER, pollGlmFlow, startGlmFlow } from '../src/auth/glm-flow.js'

/** A JSON response the way the broker sends one. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** A JWT whose only interesting claim is `exp`. */
function jwtWithExpiry(expSeconds: number): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'HS256' })}.${part({ exp: expSeconds, sub: 'user-1' })}.signature`
}

/** The `init` answer, as the live endpoint returns it. */
function initBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    code: 0,
    msg: '',
    data: {
      flow_id: 'flow-1',
      poll_token: 'server-side-token',
      authorize_url: `https://bigmodel.cn/login?appId=zcode&redirect=https://zcode.z.ai/api/v1/oauth/cli/callback/${GLM_BROKER_PROVIDER}&state=abc`,
      expires_at: 1_800_000_000,
      poll_interval_sec: 2,
      ...overrides,
    },
    logid: 'log-1',
  }
}

describe('GLM sign-in flow', () => {
  test('init asks the broker for a BigModel flow and returns the URL to open', async () => {
    let seenUrl = ''
    let seenAuth = ''
    let seenBody: Record<string, unknown> = {}
    const fetchFn: typeof fetch = async (input, init) => {
      seenUrl = String(input)
      seenAuth = new Headers(init?.headers).get('authorization') ?? ''
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse(initBody())
    }
    const flow = await startGlmFlow({ fetchFn })
    assert.equal(seenUrl, 'https://zcode.z.ai/api/v1/oauth/cli/init')
    assert.equal(seenBody.provider, GLM_BROKER_PROVIDER)
    // The poll is authenticated by a secret only this caller holds.
    assert.match(seenAuth, /^Bearer [0-9a-f]{64}$/)
    assert.equal(flow.flowId, 'flow-1')
    assert.equal(flow.pollIntervalMs, 2_000)
    assert.equal(flow.expiresAt, 1_800_000_000_000)
    // The URL is handed over unchanged: its callback is completed server-side.
    assert.match(flow.authorizeUrl, /^https:\/\/bigmodel\.cn\/login\?/)
    assert.match(flow.authorizeUrl, /oauth\/cli\/callback\/bigmodel/)
  })

  test('a business refusal is an error, not a flow', async () => {
    const fetchFn: typeof fetch = async () => jsonResponse({ code: 3004, msg: 'invalid_flow', data: {} })
    await assert.rejects(() => startGlmFlow({ fetchFn }), /invalid_flow/)
  })

  test('a non-https authorize URL is refused', async () => {
    const fetchFn: typeof fetch = async () => jsonResponse(initBody({ authorize_url: 'http://bigmodel.cn/login' }))
    await assert.rejects(() => startGlmFlow({ fetchFn }), /not https/)
  })

  test('polling is pending until the broker says ready', async () => {
    const start = await startGlmFlow({ fetchFn: async () => jsonResponse(initBody()) })
    const pending: typeof fetch = async () => jsonResponse({ code: 0, msg: '', data: { status: 'pending' } })
    assert.equal(await pollGlmFlow({ fetchFn: pending }, start), undefined)
  })

  test('a ready flow yields both tokens, with the JWT expiry as the deadline', async () => {
    const start = await startGlmFlow({ fetchFn: async () => jsonResponse(initBody()) })
    const exp = 1_900_000_000
    let seenUrl = ''
    const fetchFn: typeof fetch = async (input) => {
      seenUrl = String(input)
      return jsonResponse({
        code: 0,
        msg: '',
        data: {
          status: 'ready',
          token: jwtWithExpiry(exp),
          user: { user_id: 'account-9', name: 'someone@example.com' },
          bigmodel: { access_token: 'bigmodel-access', refresh_token: 'bigmodel-refresh' },
        },
      })
    }
    const tokens = await pollGlmFlow({ fetchFn }, start)
    assert.equal(seenUrl, 'https://zcode.z.ai/api/v1/oauth/cli/poll/flow-1')
    assert.equal(tokens?.accessToken, 'bigmodel-access')
    assert.equal(tokens?.refreshToken, 'bigmodel-refresh')
    assert.equal(tokens?.accountId, 'account-9')
    assert.equal(tokens?.label, 'someone@example.com')
    assert.equal(tokens?.expiresAt, exp * 1000)
  })

  test('a refused flow is reported as refused', async () => {
    const start = await startGlmFlow({ fetchFn: async () => jsonResponse(initBody()) })
    const failed: typeof fetch = async () => jsonResponse({ code: 0, msg: '', data: { status: 'failed' } })
    await assert.rejects(() => pollGlmFlow({ fetchFn: failed }, start), /refused in the browser/)
  })

  test('a completed flow without both tokens is refused', async () => {
    const start = await startGlmFlow({ fetchFn: async () => jsonResponse(initBody()) })
    const partial: typeof fetch = async () => jsonResponse({
      code: 0,
      msg: '',
      data: { status: 'ready', token: jwtWithExpiry(1_900_000_000), user: {}, bigmodel: {} },
    })
    await assert.rejects(() => pollGlmFlow({ fetchFn: partial }, start), /without the tokens/)
  })

  test('an expired flow is refused before any request', async () => {
    const start = await startGlmFlow({ fetchFn: async () => jsonResponse(initBody()), now: () => 1_700_000_000_000 })
    let called = false
    const fetchFn: typeof fetch = async () => {
      called = true
      return jsonResponse({ code: 0, msg: '', data: { status: 'pending' } })
    }
    await assert.rejects(() => pollGlmFlow({ fetchFn, now: () => 1_900_000_000_000 }, start), /expired/)
    assert.equal(called, false)
  })
})

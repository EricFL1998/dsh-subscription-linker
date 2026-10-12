/**
 * The GLM route: session parsing, the shipped catalog, and the allowance reader.
 *
 * @module dsh-plugin-subscription-oauth/test/glm
 */

import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'

import {
  GLM_DEFAULT_MODEL,
  GLM_MODELS,
  GlmAdapter,
  parseGlmQuota,
  parseGlmSession,
  readGlmUsage,
} from '../src/providers/glm.js'
import type { GlmAdapterOptions } from '../src/providers/glm.js'
import { createGlmProvider } from '../src/providers/glm-provider.js'
import { ModelPreferences } from '../src/settings.js'

/** A JSON response the way the coding host sends one. */
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

/** An adapter with the smallest set of collaborators its methods touch. */
function adapter(options: Partial<GlmAdapterOptions> = {}): GlmAdapter {
  return new GlmAdapter({
    apiBase: 'https://open.bigmodel.cn/api/coding/paas/v4',
    discovery: true,
    streamIdleTimeoutMs: 5_000,
    tokens: {} as never,
    ...options,
  })
}

describe('GLM session', () => {
  test('accepts a complete session and rejects the rest', () => {
    const session = parseGlmSession({
      accessToken: 'access',
      zcodeJwt: 'jwt',
      expiresAt: 1_800_000_000_000,
      refreshToken: 'refresh',
      accountId: 'account-1',
      email: 'a@b.c',
    })
    assert.equal(session?.accessToken, 'access')
    assert.equal(session?.zcodeJwt, 'jwt')
    assert.equal(session?.refreshToken, 'refresh')
    // The JWT is what the plan is bound to, so a session without one is unusable.
    assert.equal(parseGlmSession({ accessToken: 'access', expiresAt: 1 }), undefined)
    assert.equal(parseGlmSession({ zcodeJwt: 'jwt', expiresAt: 1 }), undefined)
    assert.equal(parseGlmSession({ accessToken: 'access', zcodeJwt: 'jwt' }), undefined)
    assert.equal(parseGlmSession(null), undefined)
  })
})

describe('GLM catalog', () => {
  test('names itself for the picker', () => {
    assert.deepEqual(adapter().providerInfo('glm'), { id: 'glm', name: 'GLM (BigModel)' })
  })

  test('ships the coding-plan family, with the flagship recommended', () => {
    const ids = GLM_MODELS.map((entry) => entry.id)
    assert.ok(ids.includes(GLM_DEFAULT_MODEL))
    assert.ok(ids.includes('glm-5.3-flash'))
    // The wire ids are lowercase; the display name is not what the endpoint takes.
    assert.ok(ids.every((id) => id === id.toLowerCase()))
  })

  test('resolves a known model with its window and reasoning ladder', async () => {
    const resolved = await adapter().resolveModel('glm', 'glm-5.3')
    assert.equal(resolved.context?.contextWindow, 1_048_576)
    assert.deepEqual(resolved.reasoning?.efforts.map((entry) => String(entry.id)), ['low', 'high', 'max'])
  })

  test('an unknown id is still dispatchable, with the family window', async () => {
    const resolved = await adapter().resolveModel('glm', 'glm-9-preview')
    assert.equal(resolved.id, 'glm-9-preview')
    assert.equal(resolved.context?.contextWindow, 1_048_576)
    assert.equal(resolved.reasoning, undefined)
  })

  test('flash declares image input; the rest read text', async () => {
    const flash = await adapter().resolveModel('glm', 'glm-5.3-flash')
    const flagship = await adapter().resolveModel('glm', 'glm-5.3')
    assert.deepEqual(flash.inputModalities, ['text', 'image'])
    assert.deepEqual(flagship.inputModalities, ['text'])
  })

  test('the picker omits hidden ids and lists hand-added ones', async () => {
    const subject = adapter({
      hiddenModels: () => new Set(['glm-5']),
      userModels: () => ['glm-4.6'],
    })
    const ids = (await subject.listModels('glm')).map((model) => model.id)
    assert.ok(!ids.includes('glm-5'))
    assert.ok(ids.includes('glm-4.6'))
    // A hand-added id is published, but it is not part of the route's own catalog.
    assert.ok(!subject.ownCatalogEntries().some((entry) => entry.id === 'glm-4.6'))
    assert.ok(subject.catalogEntries().some((entry) => entry.id === 'glm-4.6'))
  })

  test('a discovered id joins the catalog without displacing shipped metadata', async () => {
    const subject = adapter()
    subject.discover(['glm-5.3', 'glm-6-preview'])
    const ids = subject.catalogEntries().map((entry) => entry.id)
    assert.ok(ids.includes('glm-6-preview'))
    assert.equal(ids.filter((id) => id === 'glm-5.3').length, 1)
    assert.equal(subject.catalogEntries().find((entry) => entry.id === 'glm-5.3')?.name, 'GLM-5.3')
  })
})

describe('GLM allowance', () => {
  test('maps the unit/number pairs onto the two windows', () => {
    const windows = parseGlmQuota({
      code: 0,
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 42.5, nextResetTime: '2026-11-02T00:00:00Z' },
          { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 7 },
        ],
      },
    })
    assert.deepEqual(windows.map((window) => window.label), ['5h', 'weekly'])
    assert.equal(windows[0]?.usedPercent, 42.5)
    assert.equal(windows[0]?.resetsAt, Date.parse('2026-11-02T00:00:00Z'))
    assert.equal(windows[1]?.usedPercent, 7)
  })

  test('a percentage is derived when the row states only amounts', () => {
    const windows = parseGlmQuota({
      data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, currentValue: 25, usage: 100 }] },
    })
    assert.equal(windows[0]?.usedPercent, 25)
  })

  test('non-quota rows are skipped rather than shown as an allowance', () => {
    const windows = parseGlmQuota({
      data: {
        limits: [
          { type: 'TIME_LIMIT', unit: 3, number: 5, percentage: 99 },
          { type: 'TOKENS_LIMIT', unit: 9, number: 9, percentage: 50 },
          { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10 },
        ],
      },
    })
    assert.deepEqual(windows.map((window) => window.label), ['5h'])
    assert.equal(windows[0]?.usedPercent, 10)
  })

  test('an unexpected body states no windows instead of inventing them', () => {
    assert.deepEqual(parseGlmQuota(null), [])
    assert.deepEqual(parseGlmQuota({ data: {} }), [])
    assert.deepEqual(parseGlmQuota({ data: { limits: 'nope' } }), [])
  })

  test('reads the host with the bare key, which is what BigModel accepts', async () => {
    let seenUrl = ''
    let seenAuth: string | null = ''
    const fetchFn: typeof fetch = async (input, init) => {
      seenUrl = String(input)
      seenAuth = new Headers(init?.headers).get('authorization')
      return jsonResponse({ code: 0, data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 5 }] } })
    }
    const read = await readGlmUsage({ origin: 'https://open.bigmodel.cn', accessToken: 'key-1', fetchFn })
    assert.equal(seenUrl, 'https://open.bigmodel.cn/api/monitor/usage/quota/limit')
    // No `Bearer` scheme: the host refuses one and never renders the quota.
    assert.equal(seenAuth, 'key-1')
    assert.equal(read.windows[0]?.usedPercent, 5)
  })

  test('a refused read is an error carrying the host status', async () => {
    const fetchFn: typeof fetch = async () => jsonResponse({ error: { message: 'nope' } }, 401)
    await assert.rejects(() => readGlmUsage({ origin: 'https://open.bigmodel.cn', accessToken: 'k', fetchFn }), /HTTP 401/)
  })
})

describe('GLM route login', () => {
  /** A route whose broker answers `init`, then reports the flow as pending. */
  async function route(withTokens = false) {
    const directory = await mkdtemp(path.join(tmpdir(), 'glm-route-'))
    const fetchFn: typeof fetch = async (input) => {
      if (String(input).includes('/cli/init')) {
        return jsonResponse({
          code: 0,
          msg: '',
          data: {
            flow_id: 'flow-9',
            poll_token: 'server-token',
            authorize_url: 'https://bigmodel.cn/login?appId=zcode&state=s1',
            expires_at: Math.floor(Date.now() / 1000) + 300,
            poll_interval_sec: 1,
          },
        })
      }
      if (withTokens) {
        return jsonResponse({
          code: 0,
          msg: '',
          data: {
            status: 'ready',
            token: `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.sig`,
            user: { user_id: 'acct-1', name: 'someone@example.com' },
            bigmodel: { access_token: 'bm-access', refresh_token: 'bm-refresh' },
          },
        })
      }
      return jsonResponse({ code: 0, msg: '', data: { status: 'pending' } })
    }
    const provider = createGlmProvider({
      credentialFile: path.join(directory, 'auth.json'),
      discovery: false,
      streamIdleTimeoutMs: 5_000,
      preferences: new ModelPreferences(path.join(directory, 'preferences.json')),
      fetchFn,
    })
    return provider
  }

  test('a sign-in hands the card the URL to open and reports itself as pending', async () => {
    const provider = await route()
    const started = await provider.login()
    // The card opens this; the browser finishes the flow on the broker's callback.
    assert.match(started.prompt.url, /^https:\/\/bigmodel\.cn\/login\?/)
    assert.equal(started.prompt.mode, 'open-url')
    // `busy` and `pending` are what the card renders while the user is in the browser.
    assert.equal(started.status.busy, true)
    assert.equal(started.status.pending?.url, started.prompt.url)
    await provider.cancel()
    // Cancelling drops the attempt, so the card stops claiming a login is running.
    assert.equal((await provider.status()).busy, false)
    assert.equal((await provider.status()).pending, undefined)
  })

  test('a completed flow stores the account under its own id', async () => {
    const provider = await route(true)
    await provider.login()
    const session = await (async () => {
      // Wait for the stored credential rather than the attempt: the controller
      // persists it once the polled flow completes.
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const status = await provider.status()
        if (status.accounts.length > 0) return status
        await new Promise((resolve) => { setTimeout(resolve, 20) })
      }
      return await provider.status()
    })()
    assert.equal(session.loggedIn, true)
    assert.equal(session.accounts[0]?.account, 'acct-1')
    assert.equal(session.accounts[0]?.label, 'someone@example.com')
  })
})

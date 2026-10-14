/**
 * The GLM route: session parsing, the model catalog it derives from the endpoint's own
 * listing, and the allowance reader.
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

/**
 * One `/models` answer, in the shape the coding host sends: the OpenAI-compatible
 * envelope, whose rows state their own name, window and reasoning ladder.
 *
 * `glm-6-ultra` is here to be a model this build has never shipped; `glm-5.3-image` is
 * agent-called rather than picked, so it is never a row.
 */
const GLM_LISTING = {
  object: 'list',
  data: [
    {
      id: 'glm-5.3',
      object: 'model',
      name: 'GLM-5.3',
      context_length: 1_048_576,
      modalities: { input: ['text'] },
      think_efforts: { valid_efforts: ['low', 'high', 'max'], default_effort: 'max' },
    },
    {
      id: 'glm-6-ultra',
      object: 'model',
      display_name: 'GLM-6 Ultra',
      context_window: 2_000_000,
      modalities: { input: ['text', 'image'] },
      reasoning: { effort: { valid: ['low', 'medium'], default: 'medium' } },
    },
    {
      id: 'glm-5.3-flash',
      object: 'model',
      name: 'GLM-5.3 Flash',
      context_length: 1_048_576,
      modalities: { input: ['text', 'image'] },
    },
    { id: 'glm-5.3-image', object: 'model', name: 'GLM-5.3 Image' },
  ],
}

/** An adapter with the smallest set of collaborators its methods touch. */
function adapter(options: Partial<GlmAdapterOptions> = {}): GlmAdapter {
  return new GlmAdapter({
    apiBase: 'https://open.bigmodel.cn/api/coding/paas/v4',
    discovery: true,
    streamIdleTimeoutMs: 5_000,
    tokens: { session: async () => ({ account: 'user-1', session: {} }) } as never,
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

  test('the cached listing is the whole catalog, names and windows included', async () => {
    const subject = adapter({ cachedListing: async () => GLM_LISTING.data })
    const models = await subject.listModels('glm')
    assert.deepEqual(models.map((model) => model.id), ['glm-5.3', 'glm-6-ultra', 'glm-5.3-flash'])
    // The endpoint's own display name and modalities, not a shipped guess.
    assert.equal(models[1]?.name, 'GLM-6 Ultra')
    assert.deepEqual(models[1]?.inputModalities, ['text', 'image'])
    const resolved = await subject.resolveModel('glm', 'glm-6-ultra')
    assert.equal(resolved.context?.contextWindow, 2_000_000)
    assert.deepEqual(resolved.reasoning?.efforts.map((effort) => String(effort.id)), ['low', 'medium'])
    assert.equal(String(resolved.reasoning?.defaultEffort), 'medium')
  })

  test('a model this build never shipped is published from the listing alone', async () => {
    const subject = adapter({ cachedListing: async () => GLM_LISTING.data })
    const entry = (await subject.listModels('glm')).find((model) => model.id === 'glm-6-ultra')
    assert.equal(entry?.name, 'GLM-6 Ultra')
    // Nothing in this build names that id: membership comes from the endpoint.
    assert.ok(subject.ownCatalogEntries().some((own) => own.id === 'glm-6-ultra'))
  })

  test('an id the listing omits is not published as a row', async () => {
    const subject = adapter({ cachedListing: async () => GLM_LISTING.data })
    const ids = (await subject.listModels('glm')).map((model) => model.id)
    // `glm-5.2` was in the table this build used to ship; the endpoint no longer
    // serves it, so it must not be offered on this build's say-so.
    assert.equal(ids.includes('glm-5.2'), false)
    // It stays dispatchable — the endpoint, not this build, is what refuses it.
    const resolved = await subject.resolveModel('glm', 'glm-5.2')
    assert.equal(resolved.id, 'glm-5.2')
    assert.equal(resolved.reasoning, undefined)
  })

  test('an image model is called by an agent, never offered as a row', async () => {
    const subject = adapter({ cachedListing: async () => GLM_LISTING.data })
    const ids = (await subject.listModels('glm')).map((model) => model.id)
    assert.equal(ids.includes('glm-5.3-image'), false)
    await subject.hydrate()
    assert.equal(subject.imageModelId(), 'glm-5.3-image')
  })

  test('a picker query never asks the endpoint', async () => {
    let calls = 0
    const subject = adapter({
      cachedListing: async () => GLM_LISTING.data,
      fetchFn: async () => {
        calls += 1
        throw new Error('a picker query must not fetch')
      },
    })
    const models = await subject.listModels('glm')
    assert.equal(models.length, 3)
    await subject.resolveModel('glm', 'glm-6-ultra')
    assert.equal(calls, 0)
  })

  test('the cached listing is read once per session', async () => {
    let reads = 0
    const subject = adapter({
      cachedListing: async () => {
        reads += 1
        return GLM_LISTING.data
      },
    })
    await subject.listModels('glm')
    await subject.listModels('glm')
    assert.equal(reads, 1)
  })

  test('a cache stored as the endpoint envelope is read too', async () => {
    const subject = adapter({ cachedListing: async () => GLM_LISTING })
    const ids = (await subject.listModels('glm')).map((model) => model.id)
    assert.deepEqual(ids, ['glm-5.3', 'glm-6-ultra', 'glm-5.3-flash'])
  })

  test('an unreadable cache is a warning, and no roster is invented to fill it', async () => {
    const warnings: string[] = []
    const subject = adapter({
      cachedListing: async () => {
        throw new Error('unreadable')
      },
      onWarn: (message) => { warnings.push(message) },
    })
    // Only the configured default remains: this build has no table of its own to show.
    assert.deepEqual((await subject.listModels('glm')).map((model) => model.id), [GLM_DEFAULT_MODEL])
    assert.match(warnings.join('\n'), /cached model catalog unavailable \(unreadable\)/)
  })

  test('fetchCatalog adopts the live rows and caches exactly one payload', async () => {
    const saved: unknown[] = []
    const subject = adapter({
      fetchFn: async () => jsonResponse(GLM_LISTING),
      saveListing: async (payload) => { saved.push(payload) },
    })
    assert.deepEqual(
      await subject.fetchCatalog('token'),
      ['glm-5.3', 'glm-6-ultra', 'glm-5.3-flash'],
    )
    // The endpoint's own rows are what is kept, so a later build reads more of them.
    assert.equal(saved.length, 1)
    assert.deepEqual(saved[0], GLM_LISTING.data)
    // The table just read is what the route now serves, with its stated windows.
    const resolved = await subject.resolveModel('glm', 'glm-6-ultra')
    assert.equal(resolved.context?.contextWindow, 2_000_000)
  })

  test('a cache write failure is a warning, not a failed read', async () => {
    const warnings: string[] = []
    const subject = adapter({
      fetchFn: async () => jsonResponse(GLM_LISTING),
      saveListing: async () => { throw new Error('disk full') },
      onWarn: (message) => { warnings.push(message) },
    })
    assert.deepEqual(
      await subject.fetchCatalog('token'),
      ['glm-5.3', 'glm-6-ultra', 'glm-5.3-flash'],
    )
    assert.match(warnings.join('\n'), /model catalog cache write failed \(disk full\)/)
  })

  test('a refused listing keeps the catalog it already had', async () => {
    const warnings: string[] = []
    const subject = adapter({
      cachedListing: async () => GLM_LISTING.data,
      fetchFn: async () => jsonResponse({ error: { message: 'nope' } }, 500),
      onWarn: (message) => { warnings.push(message) },
    })
    await subject.hydrate()
    assert.equal(await subject.fetchCatalog('token'), undefined)
    assert.ok(subject.ownCatalogEntries().some((entry) => entry.id === 'glm-6-ultra'))
    assert.match(warnings.join('\n'), /HTTP 500/)
  })

  test('the picker omits hidden ids and lists hand-added ones', async () => {
    const subject = adapter({
      cachedListing: async () => GLM_LISTING.data,
      hiddenModels: () => new Set(['glm-5.3-flash']),
      userModels: () => ['glm-4.6'],
    })
    const ids = (await subject.listModels('glm')).map((model) => model.id)
    assert.equal(ids.includes('glm-5.3-flash'), false)
    assert.ok(ids.includes('glm-4.6'))
    // A hand-added id is published, but it is not part of the route's own catalog.
    assert.ok(!subject.ownCatalogEntries().some((entry) => entry.id === 'glm-4.6'))
    assert.ok(subject.catalogEntries().some((entry) => entry.id === 'glm-4.6'))
  })

  test('a discovered id joins the catalog without displacing live metadata', async () => {
    const subject = adapter({ cachedListing: async () => GLM_LISTING.data })
    await subject.hydrate()
    subject.discover(['glm-5.3', 'glm-6-preview'])
    const ids = subject.catalogEntries().map((entry) => entry.id)
    assert.ok(ids.includes('glm-6-preview'))
    assert.equal(ids.filter((id) => id === 'glm-5.3').length, 1)
    // The cached listing described the row; reporting its id again must not erase that.
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

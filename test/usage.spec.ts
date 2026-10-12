/** Plan and allowance reads: the Kimi `/usages` shapes and the Grok billing ones. */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { grokTierName, readGrokUsage, readKimiUsage } from '../src/providers/usage.js'

/** A JSON response. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** An unsigned JWT carrying a `tier` claim. */
function tierToken(tier: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ tier })).toString('base64url')
  return `${header}.${payload}.signature`
}

describe('readKimiUsage', () => {
  test('reads both windows and their resets from the usages field', async () => {
    // Trimmed from a live `/coding/v1/usages` body: the reset lives in
    // `usages.<window>.reset_time`, which the parser originally did not look at, so
    // the card showed its windows with no reset at all.
    const fetchFn: typeof fetch = async () => jsonResponse({
      usage: { limit: '100', used: '100', resetTime: '2026-10-12T08:52:38.264008Z' },
      limits: [{
        window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
        detail: { limit: '100', remaining: '100', resetTime: '2026-10-12T09:52:38.264008Z' },
      }],
      usages: {
        limit_5h: { used_ratio: 0, reset_time: '2026-10-12T09:52:37Z' },
        limit_7d: { used_ratio: 1, reset_time: '2026-10-12T08:52:37Z' },
      },
    })
    const usage = await readKimiUsage({ apiBase: 'https://api.kimi.com/coding/v1', accessToken: 'token', fetchFn })
    assert.deepEqual(usage?.windows.map((window) => window.label), ['5h', 'weekly'])
    // Every window must carry its reset: that is what the card renders.
    for (const window of usage?.windows ?? []) {
      assert.equal(typeof window.resetsAt, 'number', `${window.label} has no reset`)
    }
    // The 5h row states its own `resetTime` in `limits[].detail`, which is the more
    // specific source and wins; the weekly row is the top-level `usage` row, whose
    // own `resetTime` likewise wins over the `usages` restatement.
    assert.equal(usage?.windows[0]?.resetsAt, Date.parse('2026-10-12T09:52:38.264008Z'))
    assert.equal(usage?.windows[1]?.resetsAt, Date.parse('2026-10-12T08:52:38.264008Z'))
  })

  test('a window with only a usages reset still reports it', async () => {
    // The shape that regressed: no `limits[]` at all, so `usages.*.reset_time` is
    // the only reset the payload states.
    const fetchFn: typeof fetch = async () => jsonResponse({
      usages: {
        limit_5h: { used_ratio: 0.25, reset_time: '2026-10-12T09:52:37Z' },
        limit_7d: { used_ratio: 0.5, reset_time: '2026-10-19T08:52:37Z' },
      },
    })
    const usage = await readKimiUsage({ apiBase: 'https://api.kimi.com/coding/v1', accessToken: 'token', fetchFn })
    assert.deepEqual(usage?.windows.map((window) => window.label), ['5h', 'weekly'])
    assert.equal(usage?.windows[0]?.resetsAt, Date.parse('2026-10-12T09:52:37Z'))
    assert.equal(usage?.windows[1]?.resetsAt, Date.parse('2026-10-19T08:52:37Z'))
  })

  test('reads the weekly row off the top-level usage field', async () => {
    const fetchFn: typeof fetch = async (input, init) => {
      assert.match(String(input), /\/coding\/v1\/usages$/)
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer token')
      return jsonResponse({ usage: { limit: 100, used: 25, resetsAt: '2026-11-01T00:00:00Z' } })
    }
    const usage = await readKimiUsage({ apiBase: 'https://api.kimi.com/coding/v1', accessToken: 'token', fetchFn })
    assert.equal(usage?.windows.length, 1)
    const window = usage?.windows[0]
    assert.equal(window?.label, 'weekly')
    assert.equal(window?.usedPercent, 25)
    assert.equal(window?.resetsAt, Date.parse('2026-11-01T00:00:00Z'))
  })

  test('unwraps a data envelope and reads the rolling windows out of limits', async () => {
    const usage = await readKimiUsage({
      apiBase: 'https://api.kimi.com/coding/v1',
      accessToken: 'token',
      fetchFn: async () => jsonResponse({
        usage: null,
        data: {
          limits: [
            {
              name: 'five_hour',
              detail: { limit: 40, remaining: 30 },
              window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR', resetsAt: 1_800_000_000_000 },
            },
            {
              title: 'weekly limit',
              detail: { utilization: 62.5 },
            },
          ],
          totalQuota: { limit: 1_000, used: 125 },
        },
      }),
    })
    assert.deepEqual(usage?.windows.map((window) => window.label), ['5h', 'weekly'])
    assert.equal(usage?.windows[0]?.usedPercent, 25)
    assert.equal(usage?.windows[0]?.resetsAt, 1_800_000_000_000)
    assert.equal(usage?.windows[1]?.usedPercent, 62.5)
    // The payload's `totalQuota` is not published as a third meter.
    assert.equal(usage?.windows.some((window) => window.label === 'credits'), false)
  })

  test('a payload stating only a credit total yields no windows', async () => {
    const usage = await readKimiUsage({
      apiBase: 'https://api.kimi.com/coding/v1',
      accessToken: 'token',
      fetchFn: async () => jsonResponse({ data: { totalQuota: { limit: 1_000, used: 125 } } }),
    })
    assert.equal(usage, undefined)
  })

  test('a stated plan name is carried through', async () => {
    const usage = await readKimiUsage({
      apiBase: 'https://api.kimi.com/coding/v1',
      accessToken: 'token',
      fetchFn: async () => jsonResponse({ plan: 'Kimi Code Pro', usage: { limit: 10, used: 1 } }),
    })
    assert.equal(usage?.plan, 'Kimi Code Pro')
  })

  test('an endpoint that states nothing, or fails, yields no usage', async () => {
    const silent = await readKimiUsage({
      apiBase: 'https://api.kimi.com/coding/v1',
      accessToken: 'token',
      fetchFn: async () => jsonResponse({}),
    })
    assert.equal(silent, undefined)
    const failing = await readKimiUsage({
      apiBase: 'https://api.kimi.com/coding/v1',
      accessToken: 'token',
      fetchFn: async () => new Response('nope', { status: 500 }),
    })
    assert.equal(failing, undefined)
    const offline = await readKimiUsage({
      apiBase: 'https://api.kimi.com/coding/v1',
      accessToken: 'token',
      fetchFn: async () => { throw new Error('offline') },
    })
    assert.equal(offline, undefined)
  })
})

describe('grokTierName', () => {
  test('maps the access token tier claim onto a plan name', () => {
    assert.equal(grokTierName(tierToken(1)), 'SuperGrok')
    assert.equal(grokTierName(tierToken(4)), 'X Premium+')
    assert.equal(grokTierName(tierToken(99)), '99')
    assert.equal(grokTierName('opaque'), undefined)
  })
})

describe('readGrokUsage', () => {
  test('reads the ready-made credit percentage and period end', async () => {
    let seenHeaders = new Headers()
    const usage = await readGrokUsage({
      accessToken: tierToken(1),
      fetchFn: async (_input, init) => {
        seenHeaders = new Headers(init?.headers)
        return jsonResponse({
          config: {
            creditUsagePercent: 12.5,
            currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-11-08T00:00:00Z' },
          },
        })
      },
    })
    assert.equal(usage?.windows[0]?.label, 'weekly')
    assert.equal(usage?.windows[0]?.usedPercent, 12.5)
    assert.equal(usage?.windows[0]?.resetsAt, Date.parse('2026-11-08T00:00:00Z'))
    // The proxy only honors bearer tokens presented as the Grok CLI.
    assert.equal(seenHeaders.get('x-xai-token-auth'), 'xai-grok-cli')
    assert.match(seenHeaders.get('authorization') ?? '', /^Bearer /)
    // The tier comes from the token, because the response omits it.
    assert.equal(usage?.plan, 'SuperGrok')
  })

  test('derives the percentage from the legacy cent-valued shape', async () => {
    const usage = await readGrokUsage({
      accessToken: tierToken(3),
      fetchFn: async () => jsonResponse({
        subscriptionTier: 'X Premium',
        config: { monthlyLimit: { val: 2_000 }, used: { val: 500 }, billingPeriodEnd: '2026-12-01T00:00:00Z' },
      }),
    })
    assert.equal(usage?.windows[0]?.label, 'credits')
    assert.equal(usage?.windows[0]?.usedPercent, 25)
    assert.equal(usage?.windows[0]?.limit, 2_000)
    assert.equal(usage?.windows[0]?.used, 500)
    assert.equal(usage?.windows[0]?.resetsAt, Date.parse('2026-12-01T00:00:00Z'))
    assert.equal(usage?.plan, 'X Premium')
  })

  test('a billing payload with no allowance yields no usage', async () => {
    const usage = await readGrokUsage({
      accessToken: tierToken(0),
      fetchFn: async () => jsonResponse({ config: null }),
    })
    assert.equal(usage, undefined)
  })
})

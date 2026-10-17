/**
 * The composer usage chip's pure helpers.
 *
 * The chip itself is React and is verified through the preview harness; what is worth
 * asserting here is the reduction from a route's usage to one line, because that is
 * where a wrong answer would show a plausible but false figure.
 *
 * @module dsh-plugin-subscription-oauth/test/usage-chip
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { accountReadingsOf, balanceOf, formatBalance, formatReset, mergeAccountWindows, pickWindow, providerOf, readingOf, shortLabel, shortWindow, windowName } from '../src/client/UsageChip.js'
import type { AccountReading } from '../src/client/UsageChip.js'
import type { ProviderUsage, UsageWindow } from '../src/protocol.js'

/** One account's usage with the given windows. */
function usage(windows: readonly UsageWindow[], plan?: string): ProviderUsage {
  return {
    account: 'a',
    windows,
    fetchedAt: 0,
    ...plan === undefined ? {} : { plan },
  }
}

describe('providerOf', () => {
  test('prefers the selection in force over the last one used', () => {
    // `next` is what the picker shows now; reading it first is what makes the chip
    // follow a model change immediately instead of after the next message.
    assert.equal(providerOf({
      next: { provider: 'grok', model: 'grok-4.7' },
      lastUsed: { provider: 'kimi', model: 'kimi-for-coding' },
    }), 'grok')
  })

  test('falls back to the last used selection', () => {
    assert.equal(providerOf({
      next: null,
      lastUsed: { provider: 'kimi', model: 'kimi-for-coding' },
    }), 'kimi')
  })

  test('states nothing before any selection exists', () => {
    assert.equal(providerOf({ next: null, lastUsed: null }), undefined)
    assert.equal(providerOf(undefined), undefined)
  })
})

describe('shortLabel', () => {
  test('abbreviates the routes this plugin serves', () => {
    assert.equal(shortLabel('antigravity', 'Google Antigravity'), 'Anti')
    assert.equal(shortLabel('kimi', 'Kimi Code'), 'Kimi')
    assert.equal(shortLabel('ark', 'Volcengine Ark'), 'Ark')
  })

  test('falls back to an unknown route\'s first word', () => {
    // A route somebody else registered still gets a recognisable name rather than a
    // generic placeholder.
    assert.equal(shortLabel('other', 'Some Long Name'), 'Some')
    assert.equal(shortLabel('other', '   '), 'other')
  })
})

describe('shortWindow', () => {
  test('abbreviates the window names the providers use', () => {
    assert.equal(shortWindow('weekly'), '7d')
    assert.equal(shortWindow('5h'), '5h')
    assert.equal(shortWindow('monthly'), 'mo')
  })

  test('is case-insensitive and passes short names through', () => {
    assert.equal(shortWindow('Weekly'), '7d')
    assert.equal(shortWindow('1d'), '1d')
  })

  test('truncates a long unrecognised name rather than dropping it', () => {
    assert.equal(shortWindow('fortnightly'), 'fort')
  })

  test('names an Antigravity family and its window, not just its first four letters', () => {
    // `gemini` and `gemini_weekly` both shortened to `gemi`, so four cells named one thing.
    assert.equal(shortWindow('gemini'), 'G5h')
    assert.equal(shortWindow('gemini_weekly'), 'G7d')
    assert.equal(shortWindow('claude'), 'C5h')
    assert.equal(shortWindow('claude_weekly'), 'C7d')
  })
})

describe('windowName', () => {
  const t = ((key: string) => key) as unknown as Parameters<typeof windowName>[0]

  test('names a window this build has copy for', () => {
    assert.equal(windowName(t, 'gemini_weekly'), 'usage_gemini_weekly')
    assert.equal(windowName(t, 'claude'), 'usage_claude')
  })

  test('keeps a label this build has no copy for', () => {
    assert.equal(windowName(t, 'chat_widget'), 'chat_widget')
  })
})

describe('mergeAccountWindows', () => {
  const reading = (account: string, windows: UsageWindow[]): AccountReading => ({ account, windows })

  test('averages the same share across accounts into one window', () => {
    // Two accounts at 50 % of the same allowance read as one window at 50 % of the pool.
    const merged = mergeAccountWindows([
      reading('a', [{ label: 'weekly', usedPercent: 50 }]),
      reading('b', [{ label: 'weekly', usedPercent: 50 }]),
    ])
    assert.equal(merged.length, 1)
    assert.equal(merged[0]?.label, 'weekly')
    assert.equal(merged[0]?.usedPercent, 50)
  })

  test('averages percentages when amounts are not stated', () => {
    const merged = mergeAccountWindows([
      reading('a', [{ label: '5h', usedPercent: 20 }]),
      reading('b', [{ label: '5h', usedPercent: 60 }]),
    ])
    assert.equal(merged[0]?.usedPercent, 40)
  })

  test('takes the soonest reset across accounts', () => {
    const sooner = Date.now() + 60_000
    const later = Date.now() + 120_000
    const merged = mergeAccountWindows([
      reading('a', [{ label: 'weekly', usedPercent: 50, resetsAt: later }]),
      reading('b', [{ label: 'weekly', usedPercent: 50, resetsAt: sooner }]),
    ])
    assert.equal(merged[0]?.resetsAt, sooner)
  })

  test('orders windows by period, shortest first', () => {
    // The rolling `5h` window reads before the `weekly` one, the way the providers state
    // them — a reader scans what resets soonest as the nearer limit.
    const merged = mergeAccountWindows([
      reading('a', [
        { label: 'weekly', usedPercent: 90 },
        { label: '5h', usedPercent: 10 },
      ]),
    ])
    assert.deepEqual(merged.map((window) => window.label), ['5h', 'weekly'])
  })

  test('leaves a credit balance out of the merge, since money is not a shared allowance', () => {
    const merged = mergeAccountWindows([
      reading('a', [{ label: 'credits', used: 1, limit: 2 }]),
      reading('b', [{ label: 'weekly', usedPercent: 30 }]),
    ])
    // `credits` is money, not a share of a shared allowance, so it is not merged into the
    // compact line; only the percentage-metered `weekly` is.
    assert.deepEqual(merged.map((window) => window.label), ['weekly'])
  })
})

describe('balanceOf', () => {
  test('lists topped-up wallets before bonus wallets', () => {
    const wallets = balanceOf({
      wallets: [{ currency: 'CNY', balance: '6.89' }],
      bonusWallets: [{ currency: 'CNY', balance: '2' }],
    })
    assert.deepEqual(wallets?.map((wallet) => `${wallet.currency}:${wallet.balance}:${wallet.bonus}`), ['CNY:6.89:false', 'CNY:2:true'])
  })

  test('drops a bonus wallet that holds nothing', () => {
    // The platform reports a bonus wallet for every currency whether or not there is a
    // bonus; an empty one would read as `+¥0`, which is noise rather than information.
    const wallets = balanceOf({
      wallets: [{ currency: 'CNY', balance: '6.33' }],
      bonusWallets: [{ currency: 'CNY', balance: '0' }],
    })
    assert.deepEqual(wallets?.map((wallet) => `${wallet.currency}:${wallet.balance}:${wallet.bonus}`), ['CNY:6.33:false'])
  })

  test('keeps a bonus wallet that holds something', () => {
    const wallets = balanceOf({
      wallets: [{ currency: 'CNY', balance: '6.33' }],
      bonusWallets: [{ currency: 'CNY', balance: '2.5' }],
    })
    assert.deepEqual(wallets?.map((wallet) => `${wallet.currency}:${wallet.balance}:${wallet.bonus}`), ['CNY:6.33:false', 'CNY:2.5:true'])
  })

  test('reduces no balance, an empty read, or no wallets to nothing', () => {
    assert.equal(balanceOf(undefined), undefined)
    assert.equal(balanceOf(null), undefined)
    assert.equal(balanceOf({ wallets: [], bonusWallets: [] }), undefined)
  })
})

describe('formatBalance', () => {
  test('renders money to two decimals, rounded, with a currency symbol', () => {
    assert.equal(formatBalance({ currency: 'CNY', balance: '6.89', bonus: false }), '¥6.89')
    // A balance reads to the cent, and `1.5` for `1.50` would mislead.
    assert.equal(formatBalance({ currency: 'USD', balance: '1.5', bonus: false }), '$1.50')
    // Rounds to two places.
    assert.equal(formatBalance({ currency: 'USD', balance: '1.097', bonus: false }), '$1.10')
    assert.equal(formatBalance({ currency: 'USD', balance: '1.096', bonus: false }), '$1.10')
  })

  test('marks a bonus wallet with a plus and leaves an odd currency named', () => {
    assert.equal(formatBalance({ currency: 'CNY', balance: '2', bonus: true }), '+¥2.00')
    assert.equal(formatBalance({ currency: 'EUR', balance: '3', bonus: false }), 'EUR 3.00')
  })
})

describe('pickWindow', () => {
  test('shows the window closest to its limit', () => {
    // A plan meters a rolling five-hour window and a weekly one; the one that will stop
    // work soonest is the one worth the space.
    const windows: UsageWindow[] = [
      { label: '5h', usedPercent: 12 },
      { label: 'weekly', usedPercent: 71 },
    ]
    assert.equal(pickWindow(windows)?.label, 'weekly')
  })

  test('ignores windows that state no percentage', () => {
    const windows: UsageWindow[] = [
      { label: 'credits', used: 5, limit: 100 },
      { label: 'weekly', usedPercent: 40 },
    ]
    assert.equal(pickWindow(windows)?.label, 'weekly')
  })

  test('states nothing when no window states a percentage', () => {
    assert.equal(pickWindow([{ label: 'credits', used: 1, limit: 2 }]), undefined)
    assert.equal(pickWindow([]), undefined)
  })

  test('keeps the first of two equal windows, which is the stated order', () => {
    const windows: UsageWindow[] = [
      { label: '5h', usedPercent: 50 },
      { label: 'weekly', usedPercent: 50 },
    ]
    assert.equal(pickWindow(windows)?.label, '5h')
  })
})

describe('readingOf', () => {
  test('reduces a route to its provider, label and window', () => {
    const reading = readingOf('kimi', 'Kimi Code', [usage([{ label: 'weekly', usedPercent: 25 }], 'pro')])
    assert.equal(reading?.provider, 'kimi')
    assert.equal(reading?.label, 'Kimi Code')
    assert.equal(reading?.window.label, 'weekly')
    assert.equal(reading?.plan, 'pro')
  })

  test('keeps every metered window, so the compact line can show them all', () => {
    // The compact line reads `5h 25% 7d 71%`, so both windows have to survive; the
    // window that states no percentage is dropped rather than rendered as 0%.
    const reading = readingOf('kimi', 'Kimi Code', [
      usage([{ label: '5h', usedPercent: 25 }, { label: 'weekly', usedPercent: 71 }, { label: 'credits' }]),
    ])
    assert.deepEqual(reading?.windows.map((window) => window.label), ['5h', 'weekly'])
    // The most constrained still leads, for the meter and the title.
    assert.equal(reading?.window.label, 'weekly')
  })

  test('skips an account that states nothing and reads the next', () => {
    // A route can hold several accounts; the first may be one the endpoint could not
    // answer for, which must not blank the chip.
    const reading = readingOf('grok', 'Grok', [
      usage([{ label: 'credits' }]),
      usage([{ label: 'weekly', usedPercent: 3 }]),
    ])
    assert.equal(reading?.window.usedPercent, 3)
  })

  test('states nothing when the route reported no figure at all', () => {
    assert.equal(readingOf('glm', 'GLM', []), undefined)
    assert.equal(readingOf('glm', 'GLM', [usage([])]), undefined)
  })
})

describe('formatReset', () => {
  const now = Date.parse('2026-10-12T12:00:00Z')

  test('reads days and hours for a long window', () => {
    assert.equal(formatReset(now + (6 * 24 + 20) * 3_600_000, now), '6d20h')
  })

  test('reads whole hours under a day', () => {
    assert.equal(formatReset(now + 5 * 3_600_000, now), '5h')
  })

  test('reads minutes under an hour', () => {
    assert.equal(formatReset(now + 40 * 60_000, now), '40m')
  })

  test('never rounds a live window down to zero', () => {
    // A window a few seconds out is still a window; "0m" would read as expired.
    assert.equal(formatReset(now + 5_000, now), '1m')
  })

  test('a passed reset reads as now', () => {
    assert.equal(formatReset(now - 1_000, now), 'now')
  })

  test('no stated reset formats as nothing', () => {
    assert.equal(formatReset(undefined, now), undefined)
  })
})

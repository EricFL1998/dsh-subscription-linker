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

import { formatReset, pickWindow, readingOf, shortLabel, shortWindow } from '../src/client/UsageChip.js'
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

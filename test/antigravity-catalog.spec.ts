/** Antigravity's catalog filter and its two metered allowances. */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  antigravityEffortsFor,
  antigravityWindowsFromModels,
  mergeQuotaWindows,
  parseAntigravityModelQuota,
  parseAntigravityModels,
  parseAntigravityQuotaSummary,
  wireIdFor,
} from '../src/providers/antigravity-catalog.js'

/** The instant every quota test measures a reset from. */
const NOW = Date.parse('2026-10-17T03:00:00Z')

/** A `fetchAvailableModels` body with both agent and non-agent surfaces. */
function availableModels(): unknown {
  return {
    models: {
      'gemini-3.1-pro-low': { displayName: 'Gemini 3.1 Pro (Low)', maxTokens: 1_048_576, supportsImages: true },
      'gemini-pro-agent': { displayName: 'Gemini 3.1 Pro (High)', maxTokens: 1_048_576, supportsImages: true },
      'gemini-3.8-flash': { displayName: 'Gemini 3.8 Flash', maxTokens: 1_000_000, supportsImages: true },
      'gemini-3.1-flash-image': { displayName: 'Gemini 3.1 Flash Image', maxTokens: 32_000, supportsImages: true },
      'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6', maxTokens: 200_000, inputTokenLimit: 200_000 },
      'gpt-oss-120b-medium': { displayName: 'GPT-OSS 120B (Medium)', maxInputTokens: 131_072 },
      'tab-completion': { displayName: 'Tab', maxTokens: 4_096 },
      'commit-message': { displayName: 'Commit message', maxTokens: 4_096 },
      'audio-transcription': { displayName: 'Transcription', maxTokens: 4_096 },
    },
    agentModelSorts: [{
      groups: [
        { modelIds: ['gemini-3.1-pro-low', 'gemini-pro-agent', 'gemini-3.8-flash'] },
        { modelIds: ['claude-sonnet-4-6', 'gpt-oss-120b-medium'] },
      ],
    }],
    imageGenerationModelIds: ['gemini-3.1-flash-image'],
  }
}

describe('parseAntigravityModels', () => {
  test('keeps the agent grouping plus the documented extras, in order', () => {
    const entries = parseAntigravityModels(availableModels())
    // One row per model the service names: "Gemini 3.1 Pro" is one family even though
    // its two tiers carry unrelated ids, and the row keeps the id it defaults to.
    assert.deepEqual(entries.map((entry) => entry.id), [
      'gemini-pro-agent',
      'gemini-3.8-flash',
      'claude-sonnet-4-6',
      'gpt-oss-120b-medium',
    ])
    // Image models, tabs, commit messages and transcription are not agent-callable.
    assert.equal(entries.some((entry) => /image|tab|commit|transcription/.test(entry.id)), false)
  })

  test('carries the advertised name, window and modalities', () => {
    const entries = parseAntigravityModels(availableModels())
    const claude = entries.find((entry) => entry.id === 'claude-sonnet-4-6')
    assert.equal(claude?.name, 'Claude Sonnet 4.6')
    assert.equal(claude?.contextWindow, 200_000)
    // No `supportsImages`, so the row is text-only rather than assumed multimodal.
    assert.deepEqual(claude?.inputModalities, ['text'])
    assert.equal(entries.find((entry) => entry.id === 'gemini-3.8-flash')?.inputModalities?.join('/'), 'text/image')
  })

  test('one family carries the ladder its tiers really serve', () => {
    const entries = parseAntigravityModels(availableModels())
    // The bracket is the level: "Gemini 3.1 Pro (Low)" and "(High)" are two rungs of
    // one row, and the row takes the name without the bracket.
    const pro = entries.find((entry) => entry.name === 'Gemini 3.1 Pro')
    assert.deepEqual(pro?.reasoningEfforts, ['low', 'high'])
    assert.deepEqual(pro?.aliases, ['gemini-3.1-pro-low'])
    // A family with a single listing offers no level: there is no other rung to pick.
    assert.deepEqual(entries.find((entry) => entry.id === 'gemini-3.8-flash')?.reasoningEfforts, [])
    assert.deepEqual(entries.find((entry) => entry.name === 'GPT-OSS 120B')?.reasoningEfforts, ['medium'])
    assert.deepEqual(antigravityEffortsFor('claude-opus-4-6'), ['low', 'medium', 'high', 'max'])
    assert.deepEqual(antigravityEffortsFor('gpt-oss-120b'), ['low', 'medium', 'high'])
    assert.deepEqual(antigravityEffortsFor('mystery-model'), [])
  })

  test('a collapsed row dispatches an id the account listed', () => {
    const entries = parseAntigravityModels({
      models: {
        'gemini-3.5-flash-extra-low': { displayName: 'Gemini 3.5 Flash (Low)', maxTokens: 1_048_576 },
        'gemini-3.5-flash-low': { displayName: 'Gemini 3.5 Flash (Medium)', maxTokens: 1_048_576 },
        'gemini-3-flash-agent': { displayName: 'Gemini 3.5 Flash (High)', maxTokens: 1_048_576 },
        'gemini-3-flash': { displayName: 'Gemini 3 Flash', maxTokens: 1_048_576 },
        'gemini-3.8-flash-tiered': { displayName: 'Gemini 3.8 Flash', maxTokens: 1_000_000 },
        'gpt-oss-120b-medium': { displayName: 'GPT-OSS 120B (Medium)', maxInputTokens: 131_072 },
      },
    })
    // The service names the family, not the id: "Gemini 3.5 Flash (High)" is served as
    // `gemini-3-flash-agent`, and it folds into the 3.5 Flash row, not into 3 Flash.
    assert.deepEqual(entries.map((entry) => entry.id), [
      'gemini-3-flash-agent',
      'gemini-3-flash',
      'gemini-3.8-flash-tiered',
      'gpt-oss-120b-medium',
    ])
    const flash = entries.find((entry) => entry.id === 'gemini-3-flash-agent')
    assert.equal(flash?.name, 'Gemini 3.5 Flash')
    assert.deepEqual(flash?.reasoningEfforts, ['low', 'medium', 'high'])
    assert.deepEqual(flash?.aliases, ['gemini-3.5-flash-extra-low', 'gemini-3.5-flash-low'])
    // Every level of the row dispatches the id the listing gave that level, and the
    // name's own level wins over the id's: `-extra-low` is the rung the service calls Low.
    assert.equal(wireIdFor('gemini-3-flash-agent', 'low'), 'gemini-3.5-flash-extra-low')
    assert.equal(wireIdFor('gemini-3-flash-agent', 'medium'), 'gemini-3.5-flash-low')
    assert.equal(wireIdFor('gemini-3-flash-agent', 'high'), 'gemini-3-flash-agent')
    assert.equal(wireIdFor('gemini-3-flash-agent'), 'gemini-3-flash-agent')
    // A row listing only its High tier still takes the family's own spellings for the
    // other levels rather than sending the tiered id for all three.
    assert.equal(wireIdFor('gemini-3.8-flash-tiered', 'high'), 'gemini-3.8-flash-tiered')
    assert.equal(wireIdFor('gemini-3.8-flash-tiered', 'low'), 'gemini-3.8-flash-low')
    assert.equal(wireIdFor('gemini-3.8-flash-tiered'), 'gemini-3.8-flash-tiered')
    // A row with no named level of its own dispatches nothing but itself.
    assert.equal(wireIdFor('gemini-3-flash', 'low'), 'gemini-3-flash')
    assert.equal(wireIdFor('gpt-oss-120b-medium', 'medium'), 'gpt-oss-120b-medium')
    // A row no listing covers is left to the caller's own fallback, never guessed here.
    assert.equal(wireIdFor('mystery-model'), undefined)
  })

  test('falls back to every entry when the response carries no grouping', () => {
    const entries = parseAntigravityModels({
      models: {
        'gemini-3-pro': { displayName: 'Gemini 3 Pro' },
        'commit-message': { displayName: 'Commit message' },
      },
    })
    assert.deepEqual(entries.map((entry) => entry.id), ['gemini-3-pro'])
  })

  test('an unknown shape yields no models rather than invented ones', () => {
    assert.deepEqual(parseAntigravityModels({}), [])
    assert.deepEqual(parseAntigravityModels(null), [])
  })
})

describe('parseAntigravityQuotaSummary', () => {
  test('reads both families with their rolling and weekly buckets', () => {
    const windows = parseAntigravityQuotaSummary({
      groups: [
        {
          displayName: 'Gemini models',
          buckets: [
            { window: '5h', remainingFraction: 0.25, resetTime: '2026-11-02T00:00:00Z' },
            { window: 'weekly', remainingFraction: 0.5 },
          ],
        },
        {
          displayName: 'Claude and 3P models',
          buckets: [
            { window: '5h', remaining: { remainingFraction: 0.9 } },
            { window: 'weekly', remainingPercentage: 40 },
          ],
        },
      ],
    })
    assert.deepEqual(windows.map((window) => window.label), ['gemini', 'gemini_weekly', 'claude', 'claude_weekly'])
    assert.equal(windows[0]?.usedPercent, 75)
    assert.equal(windows[0]?.resetsAt, Date.parse('2026-11-02T00:00:00Z'))
    assert.equal(windows[1]?.usedPercent, 50)
    // A nested `remaining` object and a percentage are both understood.
    assert.equal(windows[2]?.usedPercent, 10)
    assert.equal(windows[3]?.usedPercent, 60)
  })

  test('an unlabelled group or an unreadable bucket is skipped', () => {
    const windows = parseAntigravityQuotaSummary({
      groups: [
        { displayName: 'Something else', buckets: [{ window: 'weekly', remainingFraction: 0.5 }] },
        { displayName: 'Gemini models', buckets: [{ window: 'daily', remainingFraction: 0.5 }] },
      ],
    })
    assert.deepEqual(windows, [])
  })

  test('a bucket with no remainder left is spent, not unknown', () => {
    // Google drops `remainingFraction` once a bucket is gone; the weekly one below is
    // therefore exhausted rather than unreported.
    const windows = parseAntigravityQuotaSummary({
      groups: [{
        displayName: 'Claude and GPT models',
        buckets: [{ bucketId: '3p-weekly', window: 'weekly', resetTime: '2026-10-20T07:18:48Z' }],
      }],
    })
    assert.deepEqual(windows.map((window) => window.label), ['claude_weekly'])
    assert.equal(windows[0]?.usedPercent, 100)
    assert.equal(windows[0]?.resetsAt, Date.parse('2026-10-20T07:18:48Z'))
  })

  test('a disabled bucket states no window at all', () => {
    // The weekly limit is the one being enforced, so Google reports the group's five-hour
    // bucket as full and disables it. Its "full" remainder is not a free five hours.
    const windows = parseAntigravityQuotaSummary({
      groups: [{
        displayName: 'Claude and GPT models',
        buckets: [
          { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0, resetTime: '2026-10-20T07:18:48Z' },
          { bucketId: '3p-5h', window: '5h', remainingFraction: 1, disabled: true },
        ],
      }],
    })
    assert.deepEqual(windows.map((window) => window.label), ['claude_weekly'])
    assert.equal(windows[0]?.usedPercent, 100)
  })

  test('an unknown shape yields nothing', () => {
    assert.deepEqual(parseAntigravityQuotaSummary({}), [])
    assert.deepEqual(parseAntigravityQuotaSummary(null), [])
  })
})

describe('parseAntigravityModelQuota', () => {
  test('falls back to the per-model figures, one per family and bucket', () => {
    const windows = parseAntigravityModelQuota({
      models: {
        'gemini-3.1-pro-low': { quotaInfo: { remainingFraction: 0.4 } },
        'gemini-3.8-flash': { quotaInfo: { remainingFraction: 0.7 } },
        'claude-sonnet-4-6': { quotaInfo: { remainingFraction: 0.2, resetTime: '2026-10-24T03:00:00Z' } },
      },
    }, NOW)
    assert.deepEqual(windows.map((window) => window.label), ['gemini', 'claude_weekly'])
    // Each family reports its worst-spent model.
    assert.equal(windows[0]?.usedPercent, 60)
    assert.equal(windows[1]?.usedPercent, 80)
    assert.equal(windows[1]?.resetsAt, Date.parse('2026-10-24T03:00:00Z'))
  })

  test('a model whose quota states only a reset has spent its allowance', () => {
    // This is what an exhausted Claude allowance looks like from the catalog: the weekly
    // bucket spent, so only its reset is left to state.
    const windows = parseAntigravityModelQuota({
      models: {
        'claude-sonnet-4-6': { quotaInfo: { resetTime: '2026-10-24T03:00:00Z' } },
        'gemini-3.8-flash-tiered': { quotaInfo: { remainingFraction: 0.35, resetTime: '2026-10-17T05:00:00Z' } },
      },
    }, NOW)
    assert.deepEqual(windows.map((window) => window.label), ['gemini', 'claude_weekly'])
    assert.equal(Math.round(windows[0]?.usedPercent ?? 0), 65)
    assert.equal(windows[1]?.usedPercent, 100)
  })

  test('classifies by display name and tier, not only by id', () => {
    const windows = parseAntigravityModelQuota({
      models: {
        'third-party-model': { displayName: 'Opus 4.6', quotaInfo: { remainingFraction: 0.5 } },
      },
    }, NOW)
    assert.deepEqual(windows.map((window) => window.label), ['claude'])
  })
})

describe('antigravityWindowsFromModels', () => {
  test('a reset a few hours out is the rolling bucket of its family', () => {
    const windows = antigravityWindowsFromModels(new Map([
      ['gemini-3.8-flash-tiered', { remainingFraction: 0.4, resetTime: '2026-10-17T05:00:00Z' }],
    ]), NOW)
    assert.deepEqual(windows.map((window) => window.label), ['gemini'])
    assert.equal(windows[0]?.usedPercent, 60)
    assert.equal(windows[0]?.resetsAt, Date.parse('2026-10-17T05:00:00Z'))
  })

  test('a reset a week out is the weekly bucket, which the service states instead', () => {
    // Once the weekly limit binds, the per-model entry carries the weekly figure rather
    // than the five-hour one; it is a weekly reading and must not be shown as a rolling one.
    const windows = antigravityWindowsFromModels(new Map([
      ['gemini-3.8-flash-tiered', { remainingFraction: 0.1, resetTime: '2026-10-19T02:31:28Z' }],
    ]), NOW)
    assert.deepEqual(windows.map((window) => window.label), ['gemini_weekly'])
    assert.equal(windows[0]?.usedPercent, 90)
  })

  test('takes the worst model of a bucket and skips one that states nothing', () => {
    const windows = antigravityWindowsFromModels(new Map([
      ['gemini-3-flash', { remainingFraction: 0.8, resetTime: '2026-10-17T06:00:00Z' }],
      ['gemini-2.5-pro', { remainingFraction: 0.35, resetTime: '2026-10-17T06:00:00Z' }],
      ['gemini-3.1-flash-lite', {}],
      ['claude-opus-4-6-thinking', { resetTime: '2026-10-17T05:00:00Z' }],
    ]), NOW)
    assert.deepEqual(windows.map((window) => window.label), ['gemini', 'claude'])
    assert.equal(Math.round(windows[0]?.usedPercent ?? 0), 65)
    // A rolling quota that states only its reset is spent.
    assert.equal(windows[1]?.usedPercent, 100)
  })
})

describe('mergeQuotaWindows', () => {
  test('raises a row to the per-model figure and keeps a higher summary one', () => {
    const windows = mergeQuotaWindows(
      [
        { label: 'gemini', usedPercent: 0, resetsAt: 1 },
        { label: 'gemini_weekly', usedPercent: 99.5 },
        { label: 'claude_weekly', usedPercent: 100 },
      ],
      [
        { label: 'gemini', usedPercent: 60.4, resetsAt: 2 },
        { label: 'claude', usedPercent: 100 },
      ],
    )
    assert.deepEqual(windows.map((window) => window.label), ['gemini', 'gemini_weekly', 'claude', 'claude_weekly'])
    // The live rolling figure wins, and it carries its own reset.
    assert.equal(windows[0]?.usedPercent, 60.4)
    assert.equal(windows[0]?.resetsAt, 2)
    assert.equal(windows[1]?.usedPercent, 99.5)
    // A row the summary omitted is added rather than dropped.
    assert.equal(windows[2]?.usedPercent, 100)
    assert.equal(windows[3]?.usedPercent, 100)
  })

  test('a per-model weekly figure can confirm or raise the weekly row', () => {
    const windows = mergeQuotaWindows(
      [{ label: 'gemini_weekly', usedPercent: 40 }],
      [{ label: 'gemini_weekly', usedPercent: 90, resetsAt: 3 }],
    )
    assert.deepEqual(windows, [{ label: 'gemini_weekly', usedPercent: 90, resetsAt: 3 }])
  })

  test('a summary figure higher than the per-model one is kept', () => {
    const windows = mergeQuotaWindows(
      [{ label: 'gemini', usedPercent: 75 }],
      [{ label: 'gemini', usedPercent: 40 }, { label: 'gemini_weekly', usedPercent: 10 }],
    )
    assert.deepEqual(windows.map((window) => window.label), ['gemini', 'gemini_weekly'])
    assert.equal(windows[0]?.usedPercent, 75)
    assert.equal(windows[1]?.usedPercent, 10)
  })

  test('an empty summary is just the per-model windows', () => {
    assert.deepEqual(mergeQuotaWindows([], []), [])
    const windows = mergeQuotaWindows([], [{ label: 'gemini', usedPercent: 70 }])
    assert.deepEqual(windows, [{ label: 'gemini', usedPercent: 70 }])
  })
})

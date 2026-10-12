/** Antigravity's catalog filter and its two metered allowances. */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  antigravityEffortsFor,
  parseAntigravityModelQuota,
  parseAntigravityModels,
  parseAntigravityQuotaSummary,
} from '../src/providers/antigravity-catalog.js'

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
    assert.deepEqual(entries.map((entry) => entry.id), [
      'gemini-3.1-pro-low',
      'gemini-pro-agent',
      'gemini-3.8-flash',
      'claude-sonnet-4-6',
      'gpt-oss-120b-medium',
      'gemini-3.1-flash-image',
    ])
    // Tabs, commit messages and transcription are not agent-callable.
    assert.equal(entries.some((entry) => /tab|commit|transcription/.test(entry.id)), false)
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

  test('a tier-suffixed id advertises no ladder, a base id does', () => {
    const entries = parseAntigravityModels(availableModels())
    assert.equal(entries.find((entry) => entry.id === 'gemini-3.1-pro-low')?.reasoningEfforts, undefined)
    assert.deepEqual(entries.find((entry) => entry.id === 'gemini-3.8-flash')?.reasoningEfforts, ['low', 'medium', 'high'])
    assert.deepEqual(antigravityEffortsFor('claude-opus-4-6'), ['low', 'medium', 'high', 'max'])
    assert.deepEqual(antigravityEffortsFor('gpt-oss-120b'), ['low', 'medium', 'high'])
    assert.deepEqual(antigravityEffortsFor('mystery-model'), [])
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

  test('an unknown shape yields nothing', () => {
    assert.deepEqual(parseAntigravityQuotaSummary({}), [])
    assert.deepEqual(parseAntigravityQuotaSummary(null), [])
  })
})

describe('parseAntigravityModelQuota', () => {
  test('falls back to the per-model figures, one per family', () => {
    const windows = parseAntigravityModelQuota({
      models: {
        'gemini-3.1-pro-low': { quotaInfo: { remainingFraction: 0.4 } },
        'gemini-3.8-flash': { quotaInfo: { remainingFraction: 0.7 } },
        'claude-sonnet-4-6': { quotaInfo: { remainingFraction: 0.2, resetTime: '2026-11-03T00:00:00Z' } },
      },
    })
    assert.deepEqual(windows.map((window) => window.label), ['gemini', 'claude'])
    // Each family reports its worst-spent model.
    assert.equal(windows[0]?.usedPercent, 60)
    assert.equal(windows[1]?.usedPercent, 80)
    assert.equal(windows[1]?.resetsAt, Date.parse('2026-11-03T00:00:00Z'))
  })

  test('classifies by display name and tier, not only by id', () => {
    const windows = parseAntigravityModelQuota({
      models: {
        'third-party-model': { displayName: 'Opus 4.6', quotaInfo: { remainingFraction: 0.5 } },
      },
    })
    assert.deepEqual(windows.map((window) => window.label), ['claude'])
  })
})

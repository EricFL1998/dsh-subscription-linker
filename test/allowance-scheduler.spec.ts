/**
 * The cross-request allowance scheduler and the streamer's account selection.
 *
 * @module dsh-plugin-subscription-oauth/test/allowance-scheduler
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { AllowanceScheduler } from '../src/auth/allowance-scheduler.js'

describe('AllowanceScheduler', () => {
  test('an account with a future reset is spent until it passes', () => {
    const s = new AllowanceScheduler()
    const future = Date.now() + 3 * 60 * 60 * 1000
    s.noteReset('kimi', 'a', future)
    assert.equal(s.isSpentUntilReset('kimi', 'a'), true)
    assert.equal(s.resetAt('kimi', 'a'), future)
  })

  test('a reset that has passed is no longer spent', () => {
    const s = new AllowanceScheduler()
    s.noteReset('kimi', 'a', Date.now() - 1000)
    assert.equal(s.isSpentUntilReset('kimi', 'a'), false)
    assert.equal(s.resetAt('kimi', 'a'), undefined)
  })

  test('an account never recorded is not spent', () => {
    const s = new AllowanceScheduler()
    assert.equal(s.isSpentUntilReset('kimi', 'unknown'), false)
    assert.equal(s.resetAt('kimi', 'unknown'), undefined)
  })

  test('an account recorded without a reset time is not spent', () => {
    const s = new AllowanceScheduler()
    s.noteReset('kimi', 'a', undefined)
    assert.equal(s.isSpentUntilReset('kimi', 'a'), false)
  })

  test('providers do not share account state', () => {
    const s = new AllowanceScheduler()
    const future = Date.now() + 60_000
    s.noteReset('kimi', 'a', future)
    assert.equal(s.isSpentUntilReset('grok', 'a'), false)
    assert.equal(s.isSpentUntilReset('kimi', 'a'), true)
  })
})

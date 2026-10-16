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

  test('clear forgets one account so it is no longer spent', () => {
    const s = new AllowanceScheduler()
    const future = Date.now() + 60_000
    s.noteReset('kimi', 'a', future)
    s.noteReset('kimi', 'b', future)
    assert.equal(s.isSpentUntilReset('kimi', 'a'), true)
    s.clear('kimi', 'a')
    assert.equal(s.isSpentUntilReset('kimi', 'a'), false)
    // Other accounts are untouched.
    assert.equal(s.isSpentUntilReset('kimi', 'b'), true)
  })

  test('clear on an unknown provider or account is a no-op', () => {
    const s = new AllowanceScheduler()
    s.clear('unknown', 'a')
    s.noteReset('kimi', 'a', Date.now() + 60_000)
    s.clear('kimi', 'unknown')
    assert.equal(s.isSpentUntilReset('kimi', 'a'), true)
  })

  test('a cooled account is spent until the cooldown passes', () => {
    const s = new AllowanceScheduler()
    s.coolDown('antigravity', 'a', Date.now() + 60_000)
    assert.equal(s.isCooling('antigravity', 'a'), true)
    assert.equal(s.isSpentUntilReset('antigravity', 'a'), true)
    // A different account is untouched.
    assert.equal(s.isCooling('antigravity', 'b'), false)
  })

  test('a cooldown that has passed no longer marks the account spent', () => {
    const s = new AllowanceScheduler()
    s.coolDown('antigravity', 'a', Date.now() - 1000)
    assert.equal(s.isCooling('antigravity', 'a'), false)
    assert.equal(s.isSpentUntilReset('antigravity', 'a'), false)
  })

  test('a reset and a cooldown coexist; the sooner one governs', () => {
    const s = new AllowanceScheduler()
    s.noteReset('antigravity', 'a', Date.now() + 60 * 60 * 1000)
    s.coolDown('antigravity', 'a', Date.now() + 60_000)
    assert.equal(s.isSpentUntilReset('antigravity', 'a'), true)
    // Clearing the reset leaves the cooldown; the account is still spent until it passes.
    s.noteReset('antigravity', 'a', undefined)
    assert.equal(s.isSpentUntilReset('antigravity', 'a'), true)
  })

  test('a gated account is gated until the memory lapses, and is not a cooldown', () => {
    const s = new AllowanceScheduler()
    s.markGated('antigravity', 'a', Date.now() + 60_000)
    assert.equal(s.isGated('antigravity', 'a'), true)
    // Gating is its own state: the account is skipped rather than retried after a beat.
    assert.equal(s.isCooling('antigravity', 'a'), false)
    assert.equal(s.isGated('antigravity', 'b'), false)
    assert.equal(s.isGated('grok', 'a'), false)
  })

  test('a gate whose memory has passed is probed again', () => {
    const s = new AllowanceScheduler()
    s.markGated('antigravity', 'a', Date.now() - 1000)
    assert.equal(s.isGated('antigravity', 'a'), false)
  })

  test('a gate keeps the allowance state it was learned beside', () => {
    const s = new AllowanceScheduler()
    const future = Date.now() + 60 * 60 * 1000
    s.noteReset('antigravity', 'a', future)
    s.markGated('antigravity', 'a', Date.now() + 60_000)
    assert.equal(s.resetAt('antigravity', 'a'), future)
    assert.equal(s.isGated('antigravity', 'a'), true)
  })
})

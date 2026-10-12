/** Endpoint constants, URL normalisation, and the plugin's config schema. */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  KIMI_DEFAULT_API_BASE,
  KIMI_DEFAULT_MODEL,
  KIMI_DEFAULT_OAUTH_HOST,
  KIMI_RESPONSES_PATH,
  normalizeApiBase,
  normalizeOAuthHost,
  resolveApiBase,
  resolveOAuthHost,
} from '../src/constants.js'
import { Config } from '../src/index.js'

describe('normalizeOAuthHost', () => {
  test('trims and strips trailing slashes', () => {
    assert.equal(normalizeOAuthHost('  https://auth.kimi.com//  '), 'https://auth.kimi.com')
  })
})

describe('normalizeApiBase', () => {
  test('strips a trailing slash', () => {
    assert.equal(normalizeApiBase(`${KIMI_DEFAULT_API_BASE}/`), KIMI_DEFAULT_API_BASE)
  })

  test('strips a full Responses URL back to its base', () => {
    assert.equal(normalizeApiBase(`${KIMI_DEFAULT_API_BASE}${KIMI_RESPONSES_PATH}`), KIMI_DEFAULT_API_BASE)
    assert.equal(normalizeApiBase(`${KIMI_DEFAULT_API_BASE}${KIMI_RESPONSES_PATH}/`), KIMI_DEFAULT_API_BASE)
  })

  test('leaves a bare base alone', () => {
    assert.equal(normalizeApiBase(KIMI_DEFAULT_API_BASE), KIMI_DEFAULT_API_BASE)
  })
})

describe('environment resolution', () => {
  test('defaults to Kimi when the environment is silent', () => {
    assert.equal(resolveOAuthHost({}), KIMI_DEFAULT_OAUTH_HOST)
    assert.equal(resolveApiBase({}), KIMI_DEFAULT_API_BASE)
  })

  test('honours the documented overrides, in priority order', () => {
    assert.equal(resolveOAuthHost({ KIMI_CODE_OAUTH_HOST: 'https://staging.example' }), 'https://staging.example')
    assert.equal(resolveOAuthHost({ KIMI_OAUTH_HOST: 'https://legacy.example' }), 'https://legacy.example')
    assert.equal(
      resolveOAuthHost({ KIMI_CODE_OAUTH_HOST: 'https://first.example', KIMI_OAUTH_HOST: 'https://second.example' }),
      'https://first.example',
    )
    assert.equal(resolveApiBase({ KIMI_CODE_API_BASE: 'https://relay.example/v1/' }), 'https://relay.example/v1')
    assert.equal(resolveApiBase({ KIMI_CODE_API_BASE: 'https://relay.example/v1/responses' }), 'https://relay.example/v1')
    assert.equal(resolveApiBase({ KIMI_API_BASE: 'https://other.example/v1' }), 'https://other.example/v1')
  })

  test('ignores blank overrides', () => {
    assert.equal(resolveApiBase({ KIMI_CODE_API_BASE: '   ' }), KIMI_DEFAULT_API_BASE)
  })
})

describe('Config schema', () => {
  test('applies the documented defaults', () => {
    const config = Config({}) as Record<string, unknown>
    assert.equal(config.enabled, true)
    assert.equal(config.discovery, true)
    assert.equal(config.streamIdleTimeoutMs, 300_000)
    assert.equal(config.defaultModel, KIMI_DEFAULT_MODEL)
    assert.deepEqual(config.extraModels, [])
  })

  test('keeps explicit values', () => {
    const config = Config({
      oauthHost: 'https://staging.example',
      apiBase: 'https://relay.example/v1',
      discovery: false,
      defaultModel: 'k3',
      extraModels: ['k3-next'],
    }) as Record<string, unknown>
    assert.equal(config.oauthHost, 'https://staging.example')
    assert.equal(config.discovery, false)
    assert.equal(config.defaultModel, 'k3')
    assert.deepEqual(config.extraModels, ['k3-next'])
  })

  test('rejects a non-numeric idle budget', () => {
    // The schema's input type is numeric, so an invalid value only reaches it
    // from an untyped source — a hand-written config file — which is exactly
    // the case being covered.
    const malformed: unknown = { streamIdleTimeoutMs: 'soon' }
    assert.throws(() => Config(malformed as never))
  })
})

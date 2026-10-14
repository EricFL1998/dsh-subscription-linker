/**
 * The `model-variants` read the composer's quick-mode button makes.
 *
 * The button asks once, when the composer mounts, and hides itself when the answer names no
 * variant. That answer is derived from the route's listing, which is read asynchronously, so
 * this spec pins the property that regressed: asking *before* anything else has read the
 * listing must still answer correctly, because "not yet known" and "has none" are
 * indistinguishable to the caller.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import { ModelPreferences } from '../src/settings.js'
import { createKimiProvider } from '../src/providers/kimi-provider.js'
import { createGrokProvider } from '../src/providers/grok.js'

let directory: string
let preferences: ModelPreferences

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'model-variants-'))
  preferences = new ModelPreferences(path.join(directory, 'preferences.json'))
})

after(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** The Kimi listing the endpoint answers with, captured from the live service. */
const KIMI_LISTING: readonly unknown[] = [
  {
    id: 'kimi-for-coding',
    display_name: 'K2.8 Preview',
    context_length: 1_048_576,
    think_efforts: { valid_efforts: ['low', 'high', 'max'], default_effort: 'max' },
  },
  { id: 'kimi-for-coding-highspeed', display_name: 'K2.7 Code Highspeed', context_length: 262_144 },
  { id: 'k3', display_name: 'K3', context_length: 1_048_576 },
]

/** The payload Grok's two listings produce, in the shape its cache keeps. */
const GROK_LISTING = {
  public: [{ id: 'grok-4.7', context_length: 500_000 }],
  cli: [{ id: 'grok-4.7', context_window: 256_000 }, { id: 'grok-4.7-build-fast' }],
}

describe('the composer’s variant read', () => {
  test('Kimi answers the fast pair when asked before anything else', async () => {
    // Nothing has called listModels or resolveModel: this is a composer mounting first,
    // which is exactly the order that used to hide the button for the whole session.
    const route = createKimiProvider({
      dataDir: directory,
      credentialFile: path.join(directory, 'auth.json'),
      oauthHost: 'https://auth.kimi.com',
      apiBase: 'https://api.kimi.com/coding/v1',
      discovery: false,
      streamIdleTimeoutMs: 5_000,
      preferences,
      cachedListing: async () => KIMI_LISTING,
      saveListing: async () => undefined,
    })
    assert.deepEqual(await route.modelVariants?.('kimi-for-coding'), {
      fast: 'kimi-for-coding-highspeed',
      fastBase: 'kimi-for-coding',
      fastRung: 'highspeed',
    })
    // A row with no variant, once a listing has been read, is a final answer — no `pending`,
    // so the composer asks once and hides the button instead of re-asking.
    assert.deepEqual(await route.modelVariants?.('k3'), {})
  })

  test('Grok answers the fast pair from its own two listings', async () => {
    const route = createGrokProvider({
      credentialFile: path.join(directory, 'grok-auth.json'),
      discovery: false,
      streamIdleTimeoutMs: 5_000,
      preferences,
      cachedListing: async () => GROK_LISTING,
      saveListing: async () => undefined,
    })
    assert.deepEqual(await route.modelVariants?.('grok-4.7'), {
      fast: 'grok-4.7-build-fast',
      fastBase: 'grok-4.7',
      fastRung: 'fast',
    })
  })

  test('a route with no cached listing says it is still loading, not that there is none', async () => {
    const route = createKimiProvider({
      dataDir: directory,
      credentialFile: path.join(directory, 'auth.json'),
      oauthHost: 'https://auth.kimi.com',
      apiBase: 'https://api.kimi.com/coding/v1',
      discovery: false,
      streamIdleTimeoutMs: 5_000,
      preferences,
    })
    // Nothing to read and no listing to read. The answer is provisional and says so, which
    // is what lets the composer ask again instead of hiding a button that should be there.
    assert.deepEqual(await route.modelVariants?.('kimi-for-coding'), { pending: true })
  })

  test('a listing that names no variant stops saying it is loading', async () => {
    const route = createKimiProvider({
      dataDir: directory,
      credentialFile: path.join(directory, 'auth.json'),
      oauthHost: 'https://auth.kimi.com',
      apiBase: 'https://api.kimi.com/coding/v1',
      discovery: false,
      streamIdleTimeoutMs: 5_000,
      preferences,
      cachedListing: async () => [{ id: 'k3', display_name: 'K3', context_length: 1_048_576 }],
      saveListing: async () => undefined,
    })
    // A listing was read and it names no variant for this row: the answer is final, so the
    // composer does not keep asking for a button that will never appear.
    assert.deepEqual(await route.modelVariants?.('k3'), {})
  })
})

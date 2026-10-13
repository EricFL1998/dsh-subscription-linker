/** Model-visibility preferences: what the picker must offer, and what it must not. */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import { ModelPreferences } from '../src/settings.js'
import { KimiAdapter } from '../src/providers/kimi.js'
import type { KimiAdapterOptions, KimiSession } from '../src/providers/kimi.js'
import type { TokenManager } from '../src/auth/tokens.js'

let directory: string

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'kimi-prefs-'))
})

after(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** A token manager the catalog query never needs. */
function tokenManager(): TokenManager<KimiSession> {
  return {
    resolve: async () => ({ account: 'user-1', accessToken: 'token', expiresAt: Date.now() + 60_000 }),
    session: async () => ({ account: 'user-1', session: { accessToken: 'token', expiresAt: Date.now() + 60_000 } }),
    accounts: async () => [],
    defaultAccount: async () => undefined,
  } as unknown as TokenManager<KimiSession>
}

/** Adapter options with the given visibility source. */
function adapterOptions(overrides: Partial<KimiAdapterOptions> = {}): KimiAdapterOptions {
  return {
    apiBase: 'https://api.kimi.com/coding/v1',
    discovery: false,
    streamIdleTimeoutMs: 5_000,
    tokens: tokenManager(),
    ...overrides,
  }
}

describe('ModelPreferences', () => {
  test('everything is visible before any choice is stored', async () => {
    const preferences = new ModelPreferences(path.join(directory, 'fresh', 'preferences.json'))
    assert.equal(await preferences.hiddenIds('kimi').then((ids) => ids.has('k3')), false)
    assert.deepEqual([...(await preferences.hiddenIds('kimi'))], [])
  })

  test('hiding and showing one model round-trips through the file', async () => {
    const file = path.join(directory, 'roundtrip', 'preferences.json')
    const preferences = new ModelPreferences(file)

    assert.equal(await preferences.setVisible('kimi', 'k3-256k', false), true)
    assert.deepEqual([...(await preferences.hiddenIds('kimi'))], ['k3-256k'])
    // A repeated write of the same state is not a change.
    assert.equal(await preferences.setVisible('kimi', 'k3-256k', false), false)

    const reopened = new ModelPreferences(file)
    assert.deepEqual([...(await reopened.hiddenIds('kimi'))], ['k3-256k'])
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { hidden: { kimi: ['k3-256k'] }, order: {}, auto: { order: [], off: [] }, extra: {} })

    assert.equal(await preferences.setVisible('kimi', 'k3-256k', true), true)
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { hidden: {}, order: {}, auto: { order: [], off: [] }, extra: {} })
  })

  test('hidden lists are per provider and never leak across routes', async () => {
    const file = path.join(directory, 'per-provider', 'preferences.json')
    const preferences = new ModelPreferences(file)
    await preferences.setVisible('kimi', 'k3', false)
    await preferences.setVisible('grok', 'grok-4.6', false)
    assert.deepEqual([...(await preferences.hiddenIds('kimi'))], ['k3'])
    assert.deepEqual([...(await preferences.hiddenIds('grok'))], ['grok-4.6'])
    // Clearing one leaves the other alone.
    await preferences.setVisible('kimi', 'k3', true)
    assert.deepEqual([...(await preferences.hiddenIds('kimi'))], [])
    assert.deepEqual([...(await preferences.hiddenIds('grok'))], ['grok-4.6'])
  })

  test('an earlier flat document migrates to the Kimi section', async () => {
    const dir = path.join(directory, 'legacy')
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, 'preferences.json')
    await writeFile(file, JSON.stringify({ hidden: ['k3-256k'] }), 'utf8')
    const preferences = new ModelPreferences(file)
    assert.deepEqual([...(await preferences.hiddenIds('kimi'))], ['k3-256k'])
    assert.deepEqual([...(await preferences.hiddenIds('grok'))], [])
  })

  test('a corrupt or unexpected document means everything is visible', async () => {
    const dir = path.join(directory, 'corrupt')
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, 'preferences.json')

    await writeFile(file, '{ not json', 'utf8')
    assert.deepEqual([...(await new ModelPreferences(file).hiddenIds('kimi'))], [])

    await writeFile(file, JSON.stringify({ hidden: { kimi: ['k3', 42, null, ''] } }), 'utf8')
    const preferences = new ModelPreferences(file)
    // Only usable string ids count.
    assert.deepEqual([...(await preferences.hiddenIds('kimi'))], ['k3'])
  })

  test('concurrent first reads all see the stored document', async () => {
    const file = path.join(directory, 'race', 'preferences.json')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({
      hidden: { kimi: ['k3'] },
      order: { kimi: ['k3', 'k3-256k'] },
      extra: { kimi: ['k3-next'] },
    }), 'utf8')

    // A cold object read three ways at once: none may come back empty because a
    // sibling read won the load race.
    const preferences = new ModelPreferences(file)
    const [hidden, order, extra] = await Promise.all([
      preferences.hiddenIds('kimi'),
      preferences.orderOf('kimi'),
      preferences.extraIds('kimi'),
    ])
    assert.deepEqual([...hidden], ['k3'])
    assert.deepEqual(order, ['k3', 'k3-256k'])
    assert.deepEqual(extra, ['k3-next'])

    // The same holds for a batch larger than one tick.
    const cold = new ModelPreferences(file)
    const results = await Promise.all(Array.from({ length: 8 }, (_value, index) =>
      index % 2 === 0 ? cold.hiddenIds('kimi') : cold.extraIds('kimi')))
    for (const result of results) {
      assert.notDeepEqual([...result], [])
    }
  })

  test('a hand-added model id round-trips and can be forgotten', async () => {
    const file = path.join(directory, 'hand-added', 'preferences.json')
    const preferences = new ModelPreferences(file)
    assert.deepEqual([...(await preferences.extraIds('kimi'))], [])

    assert.equal(await preferences.addExtra('kimi', 'k3-next'), true)
    // Adding the same id twice is not a change.
    assert.equal(await preferences.addExtra('kimi', 'k3-next'), false)
    assert.deepEqual([...(await preferences.extraIds('kimi'))], ['k3-next'])
    // It belongs to one route only.
    assert.deepEqual([...(await preferences.extraIds('grok'))], [])

    const reopened = new ModelPreferences(file)
    assert.deepEqual([...(await reopened.extraIds('kimi'))], ['k3-next'])

    assert.equal(await preferences.removeExtra('kimi', 'k3-next'), true)
    assert.equal(await preferences.removeExtra('kimi', 'k3-next'), false)
    assert.deepEqual([...(await preferences.extraIds('kimi'))], [])
  })

  test('reload picks up another writer', async () => {
    const dir = path.join(directory, 'reload')
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, 'preferences.json')
    const preferences = new ModelPreferences(file)
    assert.deepEqual([...(await preferences.hiddenIds('kimi'))], [])
    await writeFile(file, JSON.stringify({ hidden: { kimi: ['k3'] } }), 'utf8')
    // Still cached until asked.
    assert.deepEqual([...(await preferences.hiddenIds('kimi'))], [])
    await preferences.reload()
    assert.deepEqual([...(await preferences.hiddenIds('kimi'))], ['k3'])
  })
})

describe('KimiAdapter visibility', () => {
  test('offers every model when nothing is hidden', async () => {
    const adapter = new KimiAdapter(adapterOptions({
      hiddenModels: async () => new Set<string>(),
    }))
    assert.deepEqual(
      (await adapter.listModels('kimi')).map((model) => model.id),
      ['kimi-for-coding', 'kimi-for-coding-highspeed', 'k3', 'k3[1m]', 'k3-256k'],
    )
  })

  test('omits only the hidden ids, and re-reads the set per query', async () => {
    let hidden = new Set(['k3-256k'])
    const adapter = new KimiAdapter(adapterOptions({ hiddenModels: async () => hidden }))
    assert.deepEqual(
      (await adapter.listModels('kimi')).map((model) => model.id),
      ['kimi-for-coding', 'kimi-for-coding-highspeed', 'k3', 'k3[1m]'],
    )
    // A settings change takes effect at the next query, with no rebuild.
    hidden = new Set(['k3', 'k3-256k'])
    assert.deepEqual(
      (await adapter.listModels('kimi')).map((model) => model.id),
      ['kimi-for-coding', 'kimi-for-coding-highspeed', 'k3[1m]'],
    )
  })

  test('a hidden model stays resolvable and listed in the settings catalog', async () => {
    const adapter = new KimiAdapter(adapterOptions({
      hiddenModels: async () => new Set(['k3-256k']),
    }))
    // The settings page must still be able to show it, so it can be re-enabled.
    assert.equal(adapter.catalogEntries().some((entry) => entry.id === 'k3-256k'), true)
    const resolved = await adapter.resolveModel('kimi', 'k3-256k')
    assert.equal(resolved.id, 'k3-256k')
    assert.equal(resolved.context?.contextWindow, 262_144)
  })

  test('a preferences read failure keeps the full catalog', async () => {
    const warnings: string[] = []
    const adapter = new KimiAdapter(adapterOptions({
      hiddenModels: async () => { throw new Error('disk offline') },
      onWarn: (message) => warnings.push(message),
    }))
    assert.equal((await adapter.listModels('kimi')).length, 5)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /model preferences unavailable/)
  })
})

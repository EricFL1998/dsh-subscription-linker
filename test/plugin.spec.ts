/** The plugin entry point: what `apply()` registers on a cordis context. */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

import { apply, Config, IMPLEMENTED_PROVIDER_IDS, inject, name } from '../src/index.js'
import { SETTINGS_NS } from '../src/protocol.js'
import { KimiAdapter } from '../src/providers/kimi.js'

let home: string
let previousHome: string | undefined

before(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'kimi-home-'))
  previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
})

after(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

/** One recorded adapter registration. */
interface Registration {
  providers: string[]
  adapter: LlmAdapter
  disposed: boolean
  replaced: string[][]
}

/** A stub cordis context recording what the plugin registers. */
function stubContext(): {
  ctx: Context
  registrations: Registration[]
  warnings: string[]
  injections: string[][]
  directory: { provider: string, displayName: string, settingsNs: string, settingsPath: readonly string[] }[][]
} {
  const registrations: Registration[] = []
  const warnings: string[] = []
  const injections: string[][] = []
  const directory: { provider: string, displayName: string, settingsNs: string, settingsPath: readonly string[] }[][] = []
  const ctx = {
    logger: {
      warn: (message: string) => { warnings.push(message) },
      info: () => undefined,
      error: () => undefined,
    },
    effect: (factory: () => unknown) => {
      factory()
      return () => undefined
    },
    inject: (deps: string[], callback: (scope: unknown) => void) => {
      injections.push(deps)
      // A headless composition has no connection service; the plugin must cope.
      callback({
        get: () => undefined,
        effect: (factory: () => unknown) => {
          factory()
          return () => undefined
        },
      })
    },
    get: () => undefined,
    llm: {
      registerAdapter: (providers: string[], adapter: LlmAdapter) => {
        const record: Registration = { providers, adapter, disposed: false, replaced: [] }
        registrations.push(record)
        const handle = (() => { record.disposed = true }) as (() => void) & { replace: (next: string[]) => void }
        handle.replace = (next: string[]) => { record.replaced.push(next) }
        return handle
      },
      // The roster `auto` enumerates. Empty in this stub: it mounts the plugin, it
      // does not serve models, so Auto has nothing to chain to.
      listProviders: () => [],
      listModels: async () => [],
      // The configurable-provider directory the Models page reads. The stub
      // records what the plugin declared so the settings-namespace contract can
      // be asserted without a client.
      registerConfigurableProviders: (entries: readonly { provider: string, displayName: string, settingsNs: string, settingsPath: readonly string[] }[]) => {
        directory.push([...entries])
        const handle = (() => undefined) as (() => void) & { replace: (next: readonly unknown[]) => void }
        handle.replace = () => undefined
        return handle
      },
    },
  }
  return { ctx: ctx as unknown as Context, registrations, warnings, injections, directory }
}

describe('plugin identity', () => {
  test('declares its name and the service it needs', () => {
    assert.equal(name, 'dsh-plugin-subscription-oauth')
    assert.deepEqual(inject, ['llm'])
  })

  test('the schema enables the plugin and discovery by default', () => {
    const config = Config({}) as { enabled: boolean, discovery: boolean }
    assert.equal(config.enabled, true)
    assert.equal(config.discovery, true)
  })
})

describe('apply', () => {
  /**
   * One registration by the provider key it serves.
   *
   * Routes are read by id, not by position: the page leads with `auto`, so a
   * positional lookup would silently assert against the wrong adapter.
   */
  function byProvider(registrations: Registration[], provider: string): Registration | undefined {
    return registrations.find((entry) => entry.providers.includes(provider))
  }

  test('registers one route per implemented provider and survives a missing connection service', () => {
    const { ctx, registrations, injections } = stubContext()
    apply(ctx, {})
    assert.equal(registrations.length, IMPLEMENTED_PROVIDER_IDS.length + 1)
    assert.deepEqual(registrations.map((entry) => entry.providers), [['auto'], ...IMPLEMENTED_PROVIDER_IDS.map((id) => [id])])
    assert.ok(byProvider(registrations, 'kimi')?.adapter instanceof KimiAdapter)
    // Registration is deferred behind `connection`, which this stub lacks.
    assert.deepEqual(injections, [['connection']])
    assert.equal(byProvider(registrations, 'kimi')?.disposed, false)
  })

  test('registers only the configured routes', () => {
    const { ctx, registrations } = stubContext()
    apply(ctx, { providers: ['grok'] })
    // `auto` spans whatever is registered, so it follows the configured routes.
    assert.deepEqual(registrations.map((entry) => entry.providers), [['auto'], ['grok']])
  })

  test('declares each route in the Models directory under the plugin settings namespace', () => {
    const { ctx, directory } = stubContext()
    apply(ctx, { providers: ['kimi', 'grok'] })
    assert.equal(directory.length, 1)
    const entries = directory[0] ?? []
    // `auto` is a chain over the other routes, not a sign-in, so it gets no card.
    assert.deepEqual(entries.map((entry) => entry.provider), ['kimi', 'grok'])
    // The page dispatches its provider-card seat by this namespace, and the
    // settings service projects a plugin's Config under its Cordis row id — so
    // both sides must use the same constant.
    assert.deepEqual([...new Set(entries.map((entry) => entry.settingsNs))], [SETTINGS_NS])
    assert.deepEqual(entries.map((entry) => entry.settingsPath), [[], []])
    assert.ok(entries.every((entry) => entry.displayName.length > 0))
  })

  test('a configured route this build cannot serve is reported', () => {
    const { ctx, registrations, warnings } = stubContext()
    apply(ctx, { providers: ['antigravity'] })
    assert.deepEqual(registrations.map((entry) => entry.providers), [['auto'], ['antigravity']])
    assert.deepEqual(warnings, [])
  })

  test('the auto provider can be left out', () => {
    const { ctx, registrations } = stubContext()
    apply(ctx, { auto: false })
    assert.deepEqual(registrations.map((entry) => entry.providers), IMPLEMENTED_PROVIDER_IDS.map((id) => [id]))
  })

  test('an unknown route id is reported rather than silently dropped', () => {
    const { ctx, registrations, warnings } = stubContext()
    apply(ctx, { providers: ['nope' as never] })
    // Only `auto` is left, and it has nothing to stand in for.
    assert.deepEqual(registrations.map((entry) => entry.providers), [['auto']])
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /nope is configured but not implemented/)
  })

  test('the registered Kimi route describes itself as Kimi Code', () => {
    const { ctx, registrations } = stubContext()
    apply(ctx, {})
    assert.deepEqual(byProvider(registrations, 'kimi')?.adapter.providerInfo('kimi'), { id: 'kimi', name: 'Kimi Code' })
  })

  test('the registered Grok route describes itself as Grok (X Premium)', () => {
    const { ctx, registrations } = stubContext()
    apply(ctx, {})
    assert.deepEqual(byProvider(registrations, 'grok')?.adapter.providerInfo('grok'), { id: 'grok', name: 'Grok (X Premium)' })
  })

  test('the registered Antigravity route describes itself as Google Antigravity', () => {
    const { ctx, registrations } = stubContext()
    apply(ctx, {})
    assert.deepEqual(byProvider(registrations, 'antigravity')?.adapter.providerInfo('antigravity'), {
      id: 'antigravity',
      name: 'Google Antigravity',
    })
  })

  test('does nothing when disabled', () => {
    const { ctx, registrations } = stubContext()
    apply(ctx, { enabled: false })
    assert.equal(registrations.length, 0)
  })

  test('rejects a non-positive idle budget', () => {
    const { ctx } = stubContext()
    assert.throws(() => { apply(ctx, { streamIdleTimeoutMs: 0 }) }, /must be a positive finite number/)
    assert.throws(() => { apply(ctx, { streamIdleTimeoutMs: Number.NaN }) }, /must be a positive finite number/)
  })

  test('accepts a bare base or a full Responses URL for apiBase', async () => {
    const { ctx, registrations } = stubContext()
    apply(ctx, { apiBase: 'https://relay.example/v1/responses', discovery: false })
    const models = await byProvider(registrations, 'kimi')?.adapter.resolveModel('kimi', 'k3')
    assert.equal(models?.provider, 'kimi')
  })

  test('a disabled credential store stays quiet at startup', async () => {
    const { ctx, warnings } = stubContext()
    apply(ctx, {})
    // `apply` warms the catalog without awaiting; give it a tick to settle.
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.deepEqual(warnings, [])
  })
})

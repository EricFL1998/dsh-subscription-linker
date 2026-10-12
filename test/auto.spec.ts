/** The `auto` provider: the chain it walks, its switches, and its delegation. */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

import { AUTO_PROVIDER_ID, AutoAdapter, autoKey, createAutoProvider, parseAutoKey } from '../src/providers/auto.js'
import { SubscriptionRegistry } from '../src/auth/registry.js'
import type { ProviderRoute } from '../src/auth/registry.js'
import { ModelPreferences } from '../src/settings.js'
import type { ProviderStatus } from '../src/protocol.js'

let directory: string

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'kimi-auto-'))
})

after(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** A stub route that lists two models and records every stream call. */
function stubRoute(id: string, models: readonly string[], fail?: string): { route: ProviderRoute, calls: string[] } {
  const calls: string[] = []
  class Stub extends LlmAdapter {
    override async listModels(): Promise<{ provider: string, id: string, name: string }[]> {
      return models.map((model) => ({ provider: id, id: model, name: `${id} ${model}` }))
    }

    override async resolveModel(_provider: string, model: string) {
      return {
        provider: id,
        id: model,
        name: model,
        context: { contextWindow: 1_000 },
        reasoning: { efforts: [{ id: 'high' as never, name: 'High' }] },
      }
    }

    override async *stream(options: { model: string }): AsyncIterable<StreamChunk> {
      calls.push(options.model)
      if (options.model === fail) throw new LlmError(`${id} refused ${options.model}`, 'PROVIDER_ERROR')
      yield { type: 'text-delta', index: 0, text: `${id}:${options.model}` }
    }
  }
  const status: ProviderStatus = {
    provider: id,
    displayName: id,
    loggedIn: true,
    busy: false,
    accounts: [],
    credentialFile: 'x',
    discovery: false,
    models: [],
    details: [],
  }
  return {
    calls,
    route: {
      id,
      displayName: id,
      credentialFile: 'x',
      adapter: new Stub(),
      status: async () => status,
      login: async () => { throw new Error('unused') },
      cancel: async () => status,
      logout: async () => status,
      setDefault: async () => status,
      refresh: async () => { throw new Error('unused') },
      discover: async () => status,
      setModelVisible: async () => status,
      setModelOrder: async () => status,
      addModel: async () => status,
      removeModel: async () => status,
      usage: async () => ({ usage: [], status }),
      reload: async () => status,
    },
  }
}

/** One auto provider over the given stub routes, with a real preferences file. */
async function harness(
  routes: readonly ProviderRoute[],
  name = `prefs-${String(Math.random()).slice(2)}`,
): Promise<{ route: ProviderRoute, adapter: AutoAdapter, preferences: ModelPreferences, registry: SubscriptionRegistry }> {
  const preferences = new ModelPreferences(path.join(directory, `${name}.json`))
  const registry = new SubscriptionRegistry(routes)
  const route = createAutoProvider({ preferences, registry })
  registry.register(route)
  return { route, adapter: route.adapter as AutoAdapter, preferences, registry }
}

/** Every chunk an auto request produced. */
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** A minimal request for the auto entry. */
function call(model = AUTO_PROVIDER_ID) {
  return {
    provider: AUTO_PROVIDER_ID,
    model,
    messages: [],
  } as never
}

describe('auto keys', () => {
  test('round-trip through a provider/model key', () => {
    assert.equal(autoKey('kimi', 'k3'), 'kimi/k3')
    assert.deepEqual(parseAutoKey('kimi/k3'), { provider: 'kimi', model: 'k3' })
    // A model id may itself contain a slash: only the first one separates.
    assert.deepEqual(parseAutoKey('kimi/k3/1m'), { provider: 'kimi', model: 'k3/1m' })
    assert.equal(parseAutoKey('k3'), undefined)
    assert.equal(parseAutoKey('/k3'), undefined)
    assert.equal(parseAutoKey('kimi/'), undefined)
  })
})

describe('the auto provider', () => {
  test('spans every route in registration order', async () => {
    const a = stubRoute('a', ['a1', 'a2'])
    const b = stubRoute('b', ['b1'])
    const { adapter } = await harness([a.route, b.route])
    assert.deepEqual(
      (await adapter.chain()).map((candidate) => autoKey(candidate.provider, candidate.model)),
      ['a/a1', 'a/a2', 'b/b1'],
    )
    assert.deepEqual(
      (await adapter.listModels(AUTO_PROVIDER_ID)).map((model) => model.id),
      [AUTO_PROVIDER_ID],
    )
  })

  test('a stored order wins, and unlisted candidates follow it', async () => {
    const a = stubRoute('a', ['a1', 'a2'])
    const b = stubRoute('b', ['b1'])
    const { adapter, preferences } = await harness([a.route, b.route])
    await preferences.setAutoOrder(['b/b1', 'a/a2'])
    assert.deepEqual(
      (await adapter.chain()).map((candidate) => autoKey(candidate.provider, candidate.model)),
      ['b/b1', 'a/a2', 'a/a1'],
    )
  })

  test('the rows the card renders follow the order a drop persisted', async () => {
    const a = stubRoute('a', ['a1', 'a2'])
    const b = stubRoute('b', ['b1'])
    const { adapter, preferences, route } = await harness([a.route, b.route])
    // What the drop sends back: the same ids the card was showing, rearranged.
    await route.setModelOrder(['b/b1', 'a/a2', 'a/a1'])
    assert.deepEqual(await preferences.autoPreferences().then((auto) => auto.order), ['b/b1', 'a/a2', 'a/a1'])
    assert.deepEqual(
      (await adapter.summaries()).map((model) => model.id),
      ['b/b1', 'a/a2', 'a/a1'],
    )
  })

  test('a switched-out row keeps its place in the rendered order', async () => {
    const a = stubRoute('a', ['a1', 'a2'])
    const { adapter, preferences, route } = await harness([a.route])
    await route.setModelOrder(['a/a2', 'a/a1'])
    await preferences.setAutoEnabled('a/a2', false)
    // Switched out of the chain, but the card still lists it where the user put it.
    assert.deepEqual((await adapter.chain()).map((candidate) => candidate.model), ['a1'])
    assert.deepEqual((await adapter.summaries()).map((model) => model.id), ['a/a2', 'a/a1'])
  })

  test('a switched-out model leaves the chain but stays listed', async () => {
    const a = stubRoute('a', ['a1', 'a2'])
    const { adapter, preferences, route } = await harness([a.route])
    await preferences.setAutoEnabled('a/a1', false)
    assert.deepEqual(
      (await adapter.chain()).map((candidate) => candidate.model),
      ['a2'],
    )
    const listed = (await route.status()).models
    assert.deepEqual(listed.map((model) => model.id), ['a/a1', 'a/a2'])
    // The row stays visible in the list only while it is switched on.
    assert.equal(listed.find((model) => model.id === 'a/a1')?.visible, false)
    assert.equal(listed.find((model) => model.id === 'a/a2')?.visible, true)
  })

  test('offers nothing at all when no candidate is enabled', async () => {
    const a = stubRoute('a', ['a1'])
    const { adapter, preferences } = await harness([a.route])
    await preferences.setAutoEnabled('a/a1', false)
    assert.deepEqual(await adapter.listModels(AUTO_PROVIDER_ID), [])
    await assert.rejects(collect(adapter.stream(call())), /no enabled model/)
  })

  test('delegates to the owning route, in the chain order', async () => {
    const a = stubRoute('a', ['a1'])
    const b = stubRoute('b', ['b1'])
    const { adapter, preferences } = await harness([a.route, b.route])
    await preferences.setAutoOrder(['b/b1'])
    const chunks = await collect(adapter.stream(call()))
    assert.deepEqual(chunks.map((chunk) => chunk.type === 'text-delta' ? chunk.text : chunk.type), ['b:b1'])
    assert.deepEqual(a.calls, [])
    assert.deepEqual(b.calls, ['b1'])
  })

  test('falls through to the next candidate when one refuses', async () => {
    const a = stubRoute('a', ['a1'], 'a1')
    const b = stubRoute('b', ['b1'])
    const warnings: string[] = []
    const preferences = new ModelPreferences(path.join(directory, 'fallback.json'))
    const registry = new SubscriptionRegistry([a.route, b.route])
    const route = createAutoProvider({ preferences, registry, onWarn: (message) => warnings.push(message) })
    registry.register(route)
    const chunks = await collect(route.adapter.stream(call()))
    assert.deepEqual(chunks.map((chunk) => chunk.type === 'text-delta' ? chunk.text : chunk.type), ['b:b1'])
    assert.deepEqual(a.calls, ['a1'])
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /a\/a1 failed.*trying b\/b1/)
  })

  test('reports the last failure when every candidate refuses', async () => {
    const a = stubRoute('a', ['a1'], 'a1')
    const b = stubRoute('b', ['b1'], 'b1')
    const { adapter } = await harness([a.route, b.route])
    await assert.rejects(collect(adapter.stream(call())), /refused/)
    assert.deepEqual(a.calls, ['a1'])
    assert.deepEqual(b.calls, ['b1'])
  })

  test('refuses to serve a model that is not its own entry', async () => {
    const a = stubRoute('a', ['a1'])
    const { adapter } = await harness([a.route])
    await assert.rejects(adapter.resolveModel(AUTO_PROVIDER_ID, 'a1'), /only its own entry/)
    await assert.rejects(collect(adapter.stream(call('a1'))), /only its own entry/)
  })

  test('its card lists the candidates and refuses credential operations', async () => {
    const a = stubRoute('a', ['a1'])
    const { route } = await harness([a.route])
    const status = await route.status()
    assert.equal(status.connectable, false)
    assert.deepEqual(status.models.map((model) => model.source), ['a'])
    await assert.rejects(route.login(), /no account of its own/)
    await assert.rejects(route.logout(), /no account of its own/)
    // A switch and a drop are accepted, and validated as provider/model keys.
    await route.setModelVisible('a/a1', false)
    await assert.rejects(route.setModelVisible('a1', false), /provider\/model keys/)
    await route.setModelOrder(['a/a1'])
    await assert.rejects(route.setModelOrder(['a1']), /provider\/model keys/)
  })

  test('an unreadable route does not empty the chain', async () => {
    const broken = stubRoute('broken', ['x'])
    broken.route.adapter.listModels = async () => { throw new Error('offline') }
    const a = stubRoute('a', ['a1'])
    const warnings: string[] = []
    const preferences = new ModelPreferences(path.join(directory, 'broken.json'))
    const registry = new SubscriptionRegistry([broken.route, a.route])
    const route = createAutoProvider({ preferences, registry, onWarn: (message) => warnings.push(message) })
    registry.register(route)
    const chain = await (route.adapter as AutoAdapter).chain()
    assert.deepEqual(chain.map((candidate) => candidate.model), ['a1'])
    assert.equal(warnings.length, 1)
  })
})

describe('auto across the whole harness roster', () => {
  /**
   * A host port standing in for `ctx.llm`.
   *
   * Its roster is what the harness serves: the built-in providers, whatever the
   * user added, and this plugin's own routes — which is why Auto must read from
   * here rather than from a registry that only knows the last of those.
   */
  function withHost(): {
    route: ProviderRoute
    adapter: AutoAdapter
    preferences: ModelPreferences
    runs: { provider: string, model: string }[]
    warnings: string[]
  } {
    const runs: { provider: string, model: string }[] = []
    const warnings: string[] = []
    const preferences = new ModelPreferences(path.join(directory, `host-${String(Math.random()).slice(2)}.json`))
    const route = createAutoProvider({
      preferences,
      registry: new SubscriptionRegistry([]),
      host: {
        providers: () => [
          { id: AUTO_PROVIDER_ID, name: 'Auto' },
          { id: 'deepseek', name: 'DeepSeek' },
          { id: 'huanling', name: 'huanling' },
          { id: 'offline', name: 'Offline' },
        ],
        models: async (provider) => {
          if (provider === 'offline') throw new Error('unreachable')
          return provider === 'deepseek'
            ? [{ id: 'deepseek-v4', name: 'DeepSeek V4' }]
            : [{ id: 'custom-1', name: 'Custom One' }]
        },
        resolve: async (_provider, model) => ({
          contextWindow: 128_000,
          ...model === 'deepseek-v4' ? { reasoningEfforts: ['low', 'high'] } : {},
        }),
        stream: (options) => {
          runs.push({ provider: options.provider, model: options.model })
          return (async function* (): AsyncIterable<StreamChunk> {
            yield { type: 'text-delta', text: 'ok' } as StreamChunk
          })()
        },
      },
      onWarn: (message) => { warnings.push(message) },
    })
    return { route, adapter: route.adapter as AutoAdapter, preferences, runs, warnings }
  }

  test('the chain spans every provider in the roster, and never itself', async () => {
    const { adapter } = withHost()
    const keys = (await adapter.chain()).map((candidate) => autoKey(candidate.provider, candidate.model))
    assert.deepEqual(keys, ['deepseek/deepseek-v4', 'huanling/custom-1'])
    // A provider Auto cannot read is reported, not fatal.
    assert.ok(!keys.some((key) => key.startsWith('auto/')))
  })

  test('a provider that cannot be read is warned about and skipped', async () => {
    const { adapter, warnings } = withHost()
    await adapter.chain()
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /offline/)
  })

  test('host models keep their declared metadata', async () => {
    const { adapter } = withHost()
    const chain = await adapter.chain()
    const deepseek = chain.find((candidate) => candidate.provider === 'deepseek')
    assert.equal(deepseek?.contextWindow, 128_000)
    assert.deepEqual(deepseek?.reasoningEfforts, ['low', 'high'])
  })

  test('a call for a provider this plugin does not own goes through the harness', async () => {
    const { adapter, runs } = withHost()
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream(call())) chunks.push(chunk)
    assert.deepEqual(chunks.map((chunk) => chunk.type), ['text-delta'])
    // Dispatched to the first candidate of the chain, by the harness.
    assert.deepEqual(runs, [{ provider: 'deepseek', model: 'deepseek-v4' }])
  })

  test('the card lists the host providers rows too', async () => {
    const { adapter } = withHost()
    const ids = (await adapter.summaries()).map((model) => model.id)
    assert.deepEqual(ids, ['deepseek/deepseek-v4', 'huanling/custom-1'])
  })

  test('a route this plugin owns but has not signed in is left out', async () => {
    // The harness answers `listModels` for a registered route whether or not it has
    // an account — it has no notion of one — so Auto has to ask the registry. This
    // is the case a signed-out GLM card produced: its models were still offered.
    const preferences = new ModelPreferences(path.join(directory, `signed-out-${String(Math.random()).slice(2)}.json`))
    const signedOut = {
      ...stubRoute('glm', ['glm-5.3']).route,
      status: async () => ({
        provider: 'glm', displayName: 'GLM', loggedIn: false, busy: false,
        accounts: [], credentialFile: '—', discovery: true, models: [], details: [],
      }),
    } as unknown as ProviderRoute
    const registry = new SubscriptionRegistry([signedOut])
    const route = createAutoProvider({
      preferences,
      registry,
      host: {
        providers: () => [{ id: 'glm', name: 'GLM' }, { id: 'deepseek', name: 'DeepSeek' }],
        // The harness still reports the signed-out route's models.
        models: async (provider) => provider === 'glm' ? [{ id: 'glm-5.3' }] : [{ id: 'deepseek-v4' }],
        resolve: async () => ({ contextWindow: 100_000 }),
        stream: () => (async function* (): AsyncIterable<StreamChunk> { /* unused */ })(),
      },
    })
    registry.register(route)
    const keys = (await (route.adapter as AutoAdapter).chain())
      .map((candidate) => autoKey(candidate.provider, candidate.model))
    assert.deepEqual(keys, ['deepseek/deepseek-v4'])
  })

  test('a signed-in owned route keeps its models in the chain', async () => {
    const preferences = new ModelPreferences(path.join(directory, `signed-in-${String(Math.random()).slice(2)}.json`))
    const signedIn = {
      ...stubRoute('glm', ['glm-5.3']).route,
      status: async () => ({
        provider: 'glm', displayName: 'GLM', loggedIn: true, busy: false,
        accounts: [], credentialFile: '—', discovery: true, models: [], details: [],
      }),
    } as unknown as ProviderRoute
    const registry = new SubscriptionRegistry([signedIn])
    const route = createAutoProvider({
      preferences,
      registry,
      host: {
        providers: () => [{ id: 'glm', name: 'GLM' }],
        models: async () => [{ id: 'glm-5.3' }],
        resolve: async () => ({ contextWindow: 100_000 }),
        stream: () => (async function* (): AsyncIterable<StreamChunk> { /* unused */ })(),
      },
    })
    registry.register(route)
    const keys = (await (route.adapter as AutoAdapter).chain())
      .map((candidate) => autoKey(candidate.provider, candidate.model))
    assert.deepEqual(keys, ['glm/glm-5.3'])
  })
})

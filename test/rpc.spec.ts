/** The node half's RPC dispatch: endpoint coverage and failure classification. */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import os from 'node:os'
import path from 'node:path'

import { LlmAdapter } from '@deepseek-ai/dsh-llm'

import { dispatchRpc } from '../src/auth/rpc.js'
import { SubscriptionRegistry } from '../src/auth/registry.js'
import type { ProviderRoute } from '../src/auth/registry.js'
import { BAD_REQUEST, ProviderError, REAUTH_REQUIRED } from '../src/errors.js'
import { RPC_ENDPOINTS, RPC_PREFIX } from '../src/protocol.js'
import { ModelPreferences } from '../src/settings.js'
import type { ProviderStatus } from '../src/protocol.js'

/** A status payload one fake route answers with. */
function status(provider: string, displayName: string, overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    provider,
    displayName,
    loggedIn: false,
    busy: false,
    accounts: [],
    credentialFile: 'C:/home/.dsh/plugins/kimi-oauth/auth.json',
    discovery: true,
    models: [],
    details: [],
    ...overrides,
  }
}

/** A bare adapter, enough for the registry to hold. */
class StubAdapter extends LlmAdapter {
  override async *stream(): AsyncIterable<never> {}
}

/** One recording fake route. */
interface FakeRoute {
  route: ProviderRoute
  calls: unknown[][]
}

/** Build a recording route. */
function fakeRoute(id: string, overrides: Partial<ProviderRoute> = {}): FakeRoute {
  const calls: unknown[][] = []
  const name = `${id} (test)`
  const base = {
    id,
    displayName: name,
    credentialFile: 'C:/home/.dsh/plugins/kimi-oauth/auth.json',
    adapter: new StubAdapter(),
    status: async () => { calls.push(['status']); return status(id, name) },
    login: async (account?: string) => {
      calls.push(['login', account])
      return {
        prompt: { url: 'https://example.test/authorize', expiresAt: Date.now() + 1000, mode: 'open-url' as const },
        status: status(id, name),
      }
    },
    cancel: async () => { calls.push(['cancel']); return status(id, name) },
    logout: async (account?: string) => { calls.push(['logout', account]); return status(id, name) },
    setDefault: async (account: string) => {
      calls.push(['setDefault', account])
      return status(id, name, { activeAccount: account })
    },
    refresh: async (account?: string) => {
      calls.push(['refresh', account])
      return { account: account ?? 'user-1', expiresAt: Date.now() + 1000, status: status(id, name) }
    },
    discover: async (force = false) => {
      calls.push(['discover', force])
      return status(id, name)
    },
    setModelVisible: async (modelId: string, visible: boolean) => {
      calls.push(['setModelVisible', modelId, visible])
      return status(id, name)
    },
    setModelOrder: async (ids: readonly string[]) => {
      calls.push(['setModelOrder', [...ids]])
      return status(id, name)
    },
    addModel: async (modelId: string) => {
      calls.push(['addModel', modelId])
      return status(id, name)
    },
    removeModel: async (modelId: string) => {
      calls.push(['removeModel', modelId])
      return status(id, name)
    },
    reload: async () => { calls.push(['reload']); return status(id, name) },
    usage: async (force = false) => {
      calls.push(['usage', force])
      return { usage: [], status: status(id, name) }
    },
    checkin: async (account: string) => {
      calls.push(['checkin', account])
      return { credit: 0, streakDays: 1, already: true }
    },
    tasks: async (account: string, claim: boolean) => {
      calls.push(['tasks', account, claim])
      return { tasks: [], claimed: 0, claimable: 0, creditEarned: 0 }
    },
    ...overrides,
  }
  return { route: base as unknown as ProviderRoute, calls }
}

/** A registry over the given fake routes. */
function registryOf(routes: readonly ProviderRoute[]): SubscriptionRegistry {
  return new SubscriptionRegistry(routes, new ModelPreferences(path.join(makeTempDir(), 'prefs.json')))
}
let tempDirSeq = 0
function makeTempDir(): string {
  return path.join(os.tmpdir(), `rpc-test-${process.pid}-${tempDirSeq++}`)
}

/** Read the success value out of one envelope, failing loudly otherwise. */
async function valueOf(
  registry: SubscriptionRegistry,
  endpoint: string,
  payload: unknown,
): Promise<Record<string, unknown>> {
  const result = await dispatchRpc(registry, endpoint, payload)
  assert.equal(result.ok, true, `${endpoint} should succeed: ${JSON.stringify(result)}`)
  return result.ok ? result.value as Record<string, unknown> : {}
}

/** The payload one endpoint needs to be exercised. */
function payloadFor(endpoint: string): unknown {
  if (endpoint === 'status' || endpoint === 'reload') return undefined
  if (endpoint === 'setDefault') return { provider: 'kimi', account: 'user-1' }
  if (endpoint === 'checkin') return { provider: 'kimi', account: 'user-1' }
  if (endpoint === 'tasks') return { provider: 'kimi', account: 'user-1' }
  if (endpoint === 'setModelVisible') return { provider: 'kimi', id: 'k3', visible: false }
  if (endpoint === 'setModelOrder') return { provider: 'kimi', ids: ['k3-256k', 'k3'] }
  if (endpoint === 'addModel' || endpoint === 'removeModel') return { provider: 'kimi', id: 'k3-next' }
  return { provider: 'kimi' }
}

describe('dispatchRpc', () => {
  test('every advertised endpoint is dispatchable', async () => {
    const registry = registryOf([fakeRoute('kimi').route])
    for (const endpoint of RPC_ENDPOINTS) {
      const result = await dispatchRpc(registry, endpoint, payloadFor(endpoint))
      assert.equal(result.ok, true, `${endpoint} should succeed: ${JSON.stringify(result)}`)
    }
  })

  test('status reports every provider in registration order', async () => {
    const registry = registryOf([fakeRoute('kimi').route, fakeRoute('grok').route])
    const value = await valueOf(registry, 'status', undefined)
    assert.deepEqual((value.providers as ProviderStatus[]).map((entry) => entry.provider), ['kimi', 'grok'])
  })

  test('a mutation returns the full provider list, not just the target', async () => {
    const kimi = fakeRoute('kimi')
    const grok = fakeRoute('grok')
    const registry = registryOf([kimi.route, grok.route])
    const value = await valueOf(registry, 'cancel', { provider: 'kimi' })
    assert.equal((value.providers as ProviderStatus[]).length, 2)
    assert.deepEqual(kimi.calls, [['cancel'], ['status']])
    assert.deepEqual(grok.calls, [['status']])
  })

  test('forwards the provider, account, and force arguments', async () => {
    const kimi = fakeRoute('kimi')
    const registry = registryOf([kimi.route])
    await dispatchRpc(registry, 'login', { provider: 'kimi', account: 'user-2' })
    await dispatchRpc(registry, 'logout', { provider: 'kimi', account: 'user-3' })
    await dispatchRpc(registry, 'refresh', { provider: 'kimi', account: 'user-4' })
    await dispatchRpc(registry, 'discover', { provider: 'kimi', force: true })
    assert.deepEqual(kimi.calls, [
      ['login', 'user-2'], ['status'],
      ['logout', 'user-3'], ['status'],
      ['refresh', 'user-4'], ['status'],
      ['discover', true], ['status'],
    ])
  })

  test('treats a blank account as absent', async () => {
    const kimi = fakeRoute('kimi')
    await dispatchRpc(registryOf([kimi.route]), 'logout', { provider: 'kimi', account: '   ' })
    assert.deepEqual(kimi.calls, [['logout', undefined], ['status']])
  })

  test('forwards a model-visibility change in both directions', async () => {
    const kimi = fakeRoute('kimi')
    const registry = registryOf([kimi.route])
    await dispatchRpc(registry, 'setModelVisible', { provider: 'kimi', id: 'k3-256k', visible: false })
    await dispatchRpc(registry, 'setModelVisible', { provider: 'kimi', id: 'k3-256k', visible: true })
    assert.deepEqual(kimi.calls, [
      ['setModelVisible', 'k3-256k', false], ['status'],
      ['setModelVisible', 'k3-256k', true], ['status'],
    ])
  })

  test('status carries the models, accounts, and details the page renders', async () => {
    const { route } = fakeRoute('kimi', {
      status: async () => status('kimi', 'Kimi Code', {
        loggedIn: true,
        accounts: [{ account: 'u', label: 'a@b.c', expiresAt: 1, expired: false, isDefault: true }],
        models: [{ id: 'k3', name: 'Kimi K3', contextWindow: 1, visible: true }],
        details: [{ key: 'oauthHost', value: 'https://auth.kimi.com' }],
      }),
    })
    const value = await valueOf(registryOf([route]), 'status', undefined)
    const provider = (value.providers as ProviderStatus[])[0]
    assert.equal(provider?.displayName, 'Kimi Code')
    assert.deepEqual(provider?.models.map((model) => model.id), ['k3'])
    assert.deepEqual(provider?.details, [{ key: 'oauthHost', value: 'https://auth.kimi.com' }])
  })
})

describe('dispatchRpc failure classification', () => {
  test('an expired login keeps its own code', async () => {
    const { route } = fakeRoute('kimi', {
      refresh: async () => {
        throw new ProviderError('Kimi Code account user-1 is not signed in', REAUTH_REQUIRED)
      },
    })
    const result = await dispatchRpc(registryOf([route]), 'refresh', { provider: 'kimi' })
    assert.deepEqual(result, {
      ok: false,
      error: { code: REAUTH_REQUIRED, message: 'Kimi Code account user-1 is not signed in', details: {} },
    })
  })

  test('an unknown provider names the ones that exist', async () => {
    const registry = registryOf([fakeRoute('kimi').route, fakeRoute('grok').route])
    const result = await dispatchRpc(registry, 'login', { provider: 'nope' })
    assert.equal(result.ok, false)
    assert.equal(result.ok ? undefined : result.error.code, BAD_REQUEST)
    assert.match(result.ok ? '' : result.error.message, /this plugin serves kimi, grok/)
  })

  test('a missing provider is a request error, not an internal failure', async () => {
    const registry = registryOf([fakeRoute('kimi').route])
    const result = await dispatchRpc(registry, 'login', {})
    assert.equal(result.ok, false)
    assert.equal(result.ok ? undefined : result.error.code, BAD_REQUEST)
  })

  test('a model-visibility change must name a model and a state', async () => {
    const registry = registryOf([fakeRoute('kimi').route])
    const missingId = await dispatchRpc(registry, 'setModelVisible', { provider: 'kimi', visible: true })
    assert.equal(missingId.ok, false)
    assert.match(missingId.ok ? '' : missingId.error.message, /requires a model id/)

    // A missing boolean must not be silently read as "hide".
    const missingState = await dispatchRpc(registry, 'setModelVisible', { provider: 'kimi', id: 'k3' })
    assert.equal(missingState.ok, false)
    assert.match(missingState.ok ? '' : missingState.error.message, /visible must be a boolean/)
  })

  test('setDefault without an account is refused', async () => {
    const registry = registryOf([fakeRoute('kimi').route])
    const result = await dispatchRpc(registry, 'setDefault', { provider: 'kimi' })
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.error.message, /requires an account/)
  })

  test('an unknown endpoint is reported instead of throwing', async () => {
    const registry = registryOf([fakeRoute('kimi').route])
    const result = await dispatchRpc(registry, 'nope', undefined)
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.error.message, /unknown endpoint: nope/)
  })
})

describe('protocol constants', () => {
  test('the prefix keeps the endpoint names disjoint from other channels', () => {
    assert.equal(RPC_PREFIX, 'subscription-oauth.')
    assert.equal(RPC_ENDPOINTS.includes('status'), true)
    assert.equal(new Set(RPC_ENDPOINTS).size, RPC_ENDPOINTS.length)
  })
})

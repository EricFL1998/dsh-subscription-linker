/** The per-provider controller: status assembly and the eager token refresh. */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import { REAUTH_REQUIRED, ProviderError } from '../src/errors.js'
import type { AuthAttempt, AuthFlow } from '../src/auth/flow.js'
import { ProviderController } from '../src/auth/provider-controller.js'
import type { ProviderSpec } from '../src/auth/provider-controller.js'
import { TokenStore } from '../src/auth/store.js'
import type { SessionBase } from '../src/auth/store.js'
import { ModelPreferences } from '../src/settings.js'

let directory: string

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'kimi-controller-'))
})

after(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** A session shape the tests can build cheaply. */
interface TestSession extends SessionBase {}

/** A store honoring one parser. */
function makeStore(name: string): TokenStore<TestSession> {
  return new TokenStore<TestSession>(
    path.join(directory, name, 'auth.json'),
    'test',
    (value) => {
      if (typeof value !== 'object' || value === null) return undefined
      const record = value as Record<string, unknown>
      return typeof record.accessToken === 'string' && typeof record.expiresAt === 'number'
        ? {
            accessToken: record.accessToken,
            expiresAt: record.expiresAt,
            ...typeof record.refreshToken === 'string' ? { refreshToken: record.refreshToken } : {},
            ...typeof record.email === 'string' ? { email: record.email } : {},
          }
        : undefined
    },
  )
}

/** A flow that never starts, for the cases that do not log in. */
const idleFlow: AuthFlow<TestSession> = {
  start: async (): Promise<AuthAttempt<TestSession>> => {
    throw new Error('not used')
  },
  pending: () => undefined,
}

/** A spec with a one-entry catalog. */
function spec(overrides: Partial<ProviderSpec<TestSession>> = {}): ProviderSpec<TestSession> {
  return {
    id: 'test',
    displayName: 'Test Provider',
    credentialFile: path.join(directory, 'spec', 'auth.json'),
    discovery: false,
    catalog: () => [{ id: 'model-a', name: 'Model A', contextWindow: 1_000 }],
    discover: async () => undefined,
    details: () => [{ key: 'apiBase', value: 'https://api.test/v1' }],
    ...overrides,
  }
}

/** Build a controller whose token manager records every resolve. */
function controller(options: {
  store: TokenStore<TestSession>
  resolve?: (account?: string, force?: boolean) => Promise<{ account: string, accessToken: string, expiresAt: number }>
  spec?: ProviderSpec<TestSession>
}): { controller: ProviderController<TestSession>, resolves: (string | undefined)[], prefs: ModelPreferences } {
  const resolves: (string | undefined)[] = []
  const tokens = {
    resolve: async (account?: string, force?: boolean) => {
      resolves.push(account)
      return options.resolve === undefined
        ? { account: account ?? 'default', accessToken: 'token', expiresAt: Date.now() + 60_000 }
        : options.resolve(account, force)
    },
    session: async () => undefined,
    accounts: async () => [],
    defaultAccount: async () => undefined,
  }
  const controller = new ProviderController<TestSession>({
    spec: options.spec ?? spec(),
    store: options.store,
    tokens: tokens as never,
    flow: idleFlow,
    preferences: new ModelPreferences(path.join(directory, 'prefs', 'preferences.json')),
  })
  return { controller, resolves, prefs: new ModelPreferences(path.join(directory, 'prefs2', 'preferences.json')) }
}

describe('status assembly', () => {
  test('reports an empty route without touching the token manager', async () => {
    const { controller: subject, resolves } = controller({ store: makeStore('empty') })
    const status = await subject.status()
    assert.equal(status.provider, 'test')
    assert.equal(status.displayName, 'Test Provider')
    assert.equal(status.loggedIn, false)
    assert.deepEqual(status.accounts, [])
    assert.deepEqual(status.models.map((model) => model.id), ['model-a'])
    assert.deepEqual(status.details, [{ key: 'apiBase', value: 'https://api.test/v1' }])
    assert.deepEqual(resolves, [])
  })

  test('lists accounts with their default marker and expiry', async () => {
    const store = makeStore('accounts')
    await store.save('user-1', { accessToken: 'a', expiresAt: Date.now() + 900_000, email: 'a@b.c' })
    const { controller: subject } = controller({ store })
    const status = await subject.status()
    assert.equal(status.loggedIn, true)
    assert.equal(status.activeAccount, 'user-1')
    assert.deepEqual(status.accounts.map((account) => account.label), ['a@b.c'])
    assert.equal(status.accounts[0]?.expired, false)
  })

  test('reports the stored instant when a refresh does not persist a new one', async () => {
    const store = makeStore('past')
    await store.save('user-1', { accessToken: 'a', expiresAt: Date.now() - 1_000, email: 'a@b.c' })
    const { controller: subject } = controller({
      store,
      // A stub that answers without persisting: what the card shows is the store.
      resolve: async () => ({ account: 'user-1', accessToken: 'fresh', expiresAt: Date.now() + 900_000 }),
    })
    const status = await subject.status()
    assert.equal(status.accounts.length, 1)
    assert.equal(status.accounts[0]?.expired, true)
  })
})

describe('eager refresh', () => {
  test('a signed-in route does not refresh on a status read', async () => {
    const store = makeStore('eager')
    await store.save('user-1', { accessToken: 'a', expiresAt: Date.now() + 60_000, refreshToken: 'r' })
    const { controller: subject, resolves } = controller({ store })
    await subject.status()
    assert.deepEqual(resolves, [])
  })

  test('a lapsed token is not refreshed by a status read', async () => {
    const store = makeStore('lapsed')
    await store.save('user-1', { accessToken: 'stale', expiresAt: Date.now() - 1, refreshToken: 'r' })
    const { controller: subject, resolves } = controller({
      store,
      resolve: async (account) => {
        // Emulate the token manager persisting a refreshed session.
        await store.save(account ?? 'user-1', {
          accessToken: 'fresh',
          expiresAt: Date.now() + 900_000,
          refreshToken: 'r',
        }, { makeDefault: false })
        return { account: account ?? 'user-1', accessToken: 'fresh', expiresAt: Date.now() + 900_000 }
      },
    })
    const status = await subject.status()
    // Status does not refresh; the stale expiry is reported as-is.
    assert.equal(status.accounts[0]?.expired, true)
    assert.deepEqual(resolves, [])
  })

  test('a route with no refresh token is left alone', async () => {
    const store = makeStore('no-refresh')
    await store.save('user-1', { accessToken: 'a', expiresAt: Date.now() + 60_000 })
    const { controller: subject, resolves } = controller({ store })
    await subject.status()
    assert.deepEqual(resolves, [])
  })

  test('a permanent refresh failure is surfaced by discover, not status', async () => {
    const store = makeStore('dead')
    await store.save('user-1', { accessToken: 'stale', expiresAt: Date.now() - 1, refreshToken: 'r' })
    const { controller: subject } = controller({
      store,
      spec: spec({ discovery: true }),
      resolve: async () => {
        throw new ProviderError('Test Provider account user-1 is not signed in', REAUTH_REQUIRED)
      },
    })
    // Status does not trigger a refresh, so no error is reported yet.
    const status = await subject.status()
    assert.equal(status.accounts.length, 1)
    assert.equal(status.lastError, undefined)
    // Discover resolves tokens and surfaces the failure.
    await subject.discover(true)
    const after = await subject.status()
    assert.match(after.lastError ?? '', /sign-in has lapsed/)
  })

  test('a transient refresh failure is not reported as a dead account', async () => {
    const store = makeStore('transient')
    await store.save('user-1', { accessToken: 'stale', expiresAt: Date.now() - 1, refreshToken: 'r' })
    const { controller: subject } = controller({
      store,
      resolve: async () => {
        throw new Error('fetch failed')
      },
    })
    const status = await subject.status()
    assert.equal(status.lastError, undefined)
  })
})

describe('model visibility and order', () => {
  /** A unique temp name per call, so cases cannot share a file. */
  let counter = 0
  const unique = (prefix: string): string => path.join(directory, `${prefix}-${String(counter++)}`, 'file.json')

  /** A controller with three models and a real preferences file. */
  function withModels(): { controller: ProviderController<TestSession>, prefs: ModelPreferences } {
    const prefs = new ModelPreferences(unique('visibility'))
    const controller = new ProviderController<TestSession>({
      spec: spec({
        catalog: () => [
          { id: 'model-a', name: 'A', contextWindow: 1_000 },
          { id: 'model-b', name: 'B', contextWindow: 2_000 },
          { id: 'model-c', name: 'C', contextWindow: 3_000 },
        ],
      }),
      store: makeStore(`visibility-store-${String(counter)}`),
      tokens: { resolve: async () => ({ account: 'x', accessToken: 't', expiresAt: Date.now() + 60_000 }) } as never,
      flow: idleFlow,
      preferences: prefs,
    })
    return { controller, prefs }
  }

  test('lists every model of the route, in catalog order', async () => {
    const { controller: subject } = withModels()
    const status = await subject.status()
    assert.deepEqual(status.models.map((model) => model.id), ['model-a', 'model-b', 'model-c'])
    assert.equal(status.models[0]?.visible, true)
    assert.equal(status.models[0]?.contextWindow, 1_000)
  })

  test('a hidden model stays listed, dimmed, and re-enableable', async () => {
    const { controller: subject, prefs } = withModels()
    await subject.setModelVisible('model-b', false)
    assert.deepEqual([...(await prefs.hiddenIds('test'))], ['model-b'])
    const status = await subject.status()
    assert.deepEqual(status.models.map((model) => model.id), ['model-a', 'model-b', 'model-c'])
    assert.equal(status.models.find((model) => model.id === 'model-b')?.visible, false)
  })





  test('a dropped order is stored and reported', async () => {
    const { controller: subject, prefs } = withModels()
    const status = await subject.setModelOrder(['model-c', 'model-a', 'model-b'])
    assert.deepEqual(await prefs.orderOf('test'), ['model-c', 'model-a', 'model-b'])
    assert.deepEqual(status.models.map((model) => model.id), ['model-c', 'model-a', 'model-b'])
  })

  test('an order naming only the enabled models keeps the rest ranked after them', async () => {
    const { controller: subject, prefs } = withModels()
    // `model-b` is hidden, so the page would not have sent it.
    await subject.setModelVisible('model-b', false)
    await subject.setModelOrder(['model-c'])
    assert.deepEqual(await prefs.orderOf('test'), ['model-c', 'model-a', 'model-b'])
  })

  test('an order naming an unknown model is refused', async () => {
    const { controller: subject } = withModels()
    await assert.rejects(subject.setModelOrder(['model-a', 'nope']), /is not in the catalog/)
  })

  test('a model the catalog does not have is refused', async () => {
    const { controller: subject } = withModels()
    await assert.rejects(subject.setModelVisible('nope', false), /is not in the catalog/)
  })

  test('a model added by hand is listed, is idempotent to add, and can be forgotten', async () => {
    const { controller: subject, prefs } = withModels()
    await prefs.addExtra('test', 'model-new')

    const status = await subject.status()
    assert.deepEqual(status.models.map((model) => model.id), ['model-a', 'model-b', 'model-c', 'model-new'])
    const row = status.models.find((model) => model.id === 'model-new')
    assert.equal(row?.userAdded, true)
    assert.equal(row?.visible, true)
    // The route states no window for an id it has never seen, so the neutral
    // default is advertised rather than a window borrowed from another model.
    assert.equal(row?.contextWindow, 262_144)

    // Clicking add again is not an error: the id is already there.
    const again = await subject.addModel('model-new')
    assert.deepEqual(again.models.map((model) => model.id), status.models.map((model) => model.id))
    assert.deepEqual(await prefs.extraIds('test'), ['model-new'])

    const removed = await subject.removeModel('model-new')
    assert.equal(removed.models.some((model) => model.id === 'model-new'), false)
    assert.deepEqual(await prefs.extraIds('test'), [])
    // Forgetting one that was never added is not an error either.
    const twice = await subject.removeModel('model-new')
    assert.equal(twice.models.some((model) => model.id === 'model-new'), false)
  })

  test('an id the route already serves is refused, and a malformed one too', async () => {
    const { controller: subject } = withModels()
    await assert.rejects(subject.addModel('model-a'), /already offers model-a/)
    await assert.rejects(subject.addModel(''), /not a usable model id/)
    await assert.rejects(subject.addModel('has space'), /not a usable model id/)
    // A plausible id keeps its punctuation: model ids carry dots, colons and brackets.
    const added = await subject.addModel('vendor.model:2[1m]')
    assert.equal(added.models.some((model) => model.id === 'vendor.model:2[1m]'), true)
  })

  test('a model discovery finds later stops being a hand-added row', async () => {
    // The route's own catalog starts without the id, then discovery reports it.
    const own: { id: string, name: string, contextWindow: number }[] = []
    const prefs = new ModelPreferences(unique('sync-manual'))
    const controller = new ProviderController<TestSession>({
      spec: {
        id: 'test',
        displayName: 'Test',
        credentialFile: 'x',
        discovery: true,
        catalog: () => [
          { id: 'model-a', name: 'Model A', contextWindow: 1_000 },
          ...own,
        ],
        catalogOwn: () => [
          { id: 'model-a', name: 'Model A', contextWindow: 1_000 },
          ...own,
        ],
        discover: async () => {
          own.length = 0
          own.push({ id: 'model-fresh', name: 'model-fresh', contextWindow: 2_000 })
          return ['model-fresh']
        },
        applyDiscovery: () => {},
        details: () => [],
      },
      store: {
        hasAny: async () => true,
        list: async () => ({ acct: { refreshToken: 'r' } }),
        defaultAccount: async () => 'acct',
        get: async () => ({ refreshToken: 'r' }),
      } as never,
      tokens: {
        resolve: async () => ({ account: 'acct', accessToken: 'token', session: {} }),
      } as never,
      flow: idleFlow,
      preferences: prefs,
    })

    // Added by hand first: it is manual, and it is listed once.
    await controller.addModel('model-fresh')
    const manual = await controller.status()
    assert.equal(manual.models.find((model) => model.id === 'model-fresh')?.userAdded, true)

    // Then sync reports it: the row is the route's own now, listed once, and the
    // manual entry is forgotten so no stale "remove" is offered.
    const synced = await controller.discover(true)
    assert.deepEqual(synced.models.filter((model) => model.id === 'model-fresh').length, 1)
    assert.equal(synced.models.find((model) => model.id === 'model-fresh')?.userAdded, undefined)
    assert.equal(synced.models.find((model) => model.id === 'model-fresh')?.contextWindow, 2_000)
    assert.deepEqual(await prefs.extraIds('test'), [])
  })

  test('a hand-added row honours the visibility switch', async () => {
    const { controller: subject } = withModels()
    await subject.addModel('model-new')
    const hidden = await subject.setModelVisible('model-new', false)
    assert.equal(hidden.models.find((model) => model.id === 'model-new')?.visible, false)
    // Hiding is a picker choice, so the row stays listed and re-enableable.
    assert.equal(hidden.models.some((model) => model.id === 'model-new'), true)
  })
})

describe('usage reads', () => {
  let counter = 0

  /** A controller whose usage read is scripted, with one stored account. */
  async function withUsage(
    read: () => Promise<{ plan?: string, windows: { label: string, usedPercent?: number }[] } | undefined>,
  ): Promise<{ controller: ProviderController<TestSession>, calls: string[] }> {
    counter += 1
    const store = makeStore(`usage-${String(counter)}`)
    await store.save('user-1', { accessToken: 't', expiresAt: Date.now() + 900_000, email: 'a@b.c' })
    const calls: string[] = []
    const controller = new ProviderController<TestSession>({
      spec: spec({
        usage: async (_token, account) => {
          calls.push(account)
          return read()
        },
      }),
      store,
      tokens: { resolve: async () => ({ account: 'user-1', accessToken: 't', expiresAt: Date.now() + 60_000 }) } as never,
      flow: idleFlow,
      preferences: new ModelPreferences(path.join(directory, `usage-prefs-${String(counter)}`, 'preferences.json')),
    })
    return { controller, calls }
  }

  test('reads each account once, then reuses the figures until forced', async () => {
    const { controller: subject, calls } = await withUsage(async () => ({
      plan: 'Pro',
      windows: [{ label: 'weekly', usedPercent: 12 }],
    }))
    const first = await subject.usage()
    assert.deepEqual(calls, ['user-1'])
    assert.equal(first.usage[0]?.plan, 'Pro')
    assert.equal(first.usage[0]?.windows[0]?.usedPercent, 12)
    // Reuse, unless the caller asks for a fresh read.
    await subject.usage()
    assert.deepEqual(calls, ['user-1'])
    await subject.usage(true)
    assert.deepEqual(calls, ['user-1', 'user-1'])
  })

  test('a substitute figure is never reused: the next read asks again', async () => {
    let substitutes = 0
    const { controller: subject, calls } = await withUsage(async () => {
      substitutes += 1
      // The route could not read its own accounting and said so.
      return { windows: [{ label: 'weekly', usedPercent: 0 }], usageError: 'per-model figures (403)' } as never
    })
    const first = await subject.usage()
    assert.equal(first.usage[0]?.substitute, true)
    // Even without `force`, a substitute has to be replaced by a real read: an
    // allowance reported from a fallback must not look like a settled figure.
    await subject.usage()
    assert.deepEqual(calls, ['user-1', 'user-1'])
    assert.equal(substitutes, 2)
  })

  test('a genuine reading is reused inside the coalescing window', async () => {
    const { controller: subject, calls } = await withUsage(async () => ({ windows: [{ label: 'weekly', usedPercent: 5 }] }))
    const first = await subject.usage()
    assert.equal(first.usage[0]?.substitute, undefined)
    await subject.usage()
    assert.deepEqual(calls, ['user-1'])
  })

  test('the figures ride along with the next status', async () => {
    const { controller: subject } = await withUsage(async () => ({ windows: [{ label: '5h', usedPercent: 50 }] }))
    await subject.usage()
    const status = await subject.status()
    assert.equal(status.usage?.[0]?.windows[0]?.usedPercent, 50)
    assert.equal(status.usageError, undefined)
  })

  test('a route whose provider states nothing answers with an empty list', async () => {
    const controller = new ProviderController<TestSession>({
      spec: spec(),
      store: makeStore('usage-none'),
      tokens: { resolve: async () => ({ account: 'x', accessToken: 't', expiresAt: Date.now() + 60_000 }) } as never,
      flow: idleFlow,
      preferences: new ModelPreferences(path.join(directory, 'usage-none-prefs', 'preferences.json')),
    })
    const result = await controller.usage()
    assert.deepEqual(result.usage, [])
    assert.equal(result.error, undefined)
    assert.equal(result.status.provider, 'test')
  })

  test('a failing read is reported without failing the call', async () => {
    const { controller: subject } = await withUsage(async () => { throw new Error('billing offline') })
    const result = await subject.usage()
    assert.equal(result.error, 'billing offline')
    assert.deepEqual(result.usage, [])
    // The failure is recorded, so the card can explain the missing figures.
    assert.equal((await subject.status()).usageError, 'billing offline')
  })

    test('a refused grant is reported as a dead login, not a failed read', async () => {
      const { controller: subject } = await withUsage(async () => {
        throw new Error('Kimi token refresh failed: The provided authorization grant is invalid')
      })
      const result = await subject.usage(true)

      // The message names what the user must do, not the endpoint that refused.
      assert.equal(result.error, 'Test Provider sign-in has expired; connect the account again')
      const status = await subject.status()
      assert.equal(status.usageError, 'Test Provider sign-in has expired; connect the account again')
      assert.equal(status.accounts[0]?.needsLogin, true)

      // The state belongs to the credential that was refused: a controller that
      // never saw the refusal does not inherit it.
      const other = await withUsage(async () => ({ windows: [] }))
      assert.equal((await other.controller.status()).accounts[0]?.needsLogin, undefined)
    })

    test('a transient failure is reported as itself', async () => {
      const { controller: subject } = await withUsage(async () => {
        throw new Error('billing offline')
      })
      const result = await subject.usage(true)
      assert.equal(result.error, 'billing offline')
      assert.equal((await subject.status()).accounts[0]?.needsLogin, undefined)
    })
})


// One-off: a synced model and a hand-added one must merge into one row.
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'test/controller.spec.ts'
let text = readFileSync(file, 'utf8')

const anchor = `  test('a hand-added row honours the visibility switch', async () => {`
if (!text.includes(anchor)) throw new Error('anchor missing')
text = text.replace(anchor, `  test('a model discovery finds later stops being a hand-added row', async () => {
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
        list: async () => ['acct'],
        get: async () => ({ refreshToken: 'r' }),
      } as never,
      tokens: {
        resolve: async () => ({ account: 'acct', accessToken: 'token', session: {} }),
      } as never,
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

  test('a hand-added row honours the visibility switch', async () => {`)

writeFileSync(file, text)
console.log('patched', file)

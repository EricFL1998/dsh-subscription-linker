// One-off: cover hand-added rows in the Settings list and an idempotent re-add.
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'test/controller.spec.ts'
let text = readFileSync(file, 'utf8').trimEnd()

text += `

describe('a model added by hand', () => {
  test('is listed with and without the route catalog carrying it', async () => {
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
  })

  test('is idempotent to add, and can be forgotten again', async () => {
    const { controller: subject, prefs } = withModels()
    const first = await subject.addModel('model-new')
    assert.equal(first.models.some((model) => model.id === 'model-new'), true)

    // Clicking add twice is not an error: the id is already there.
    const again = await subject.addModel('model-new')
    assert.deepEqual(again.models.map((model) => model.id), first.models.map((model) => model.id))
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

  test('a hand-added row honours the visibility switch', async () => {
    const { controller: subject } = withModels()
    await subject.addModel('model-new')
    const hidden = await subject.setModelVisible('model-new', false)
    assert.equal(hidden.models.find((model) => model.id === 'model-new')?.visible, false)
    // Hiding is a picker choice, so the row stays listed and re-enableable.
    assert.equal(hidden.models.some((model) => model.id === 'model-new'), true)
  })
})
`

writeFileSync(file, text)
console.log('patched', file)

// One-off: cover the two new endpoints and the `extra` document section.
import { readFileSync, writeFileSync } from 'node:fs'

{
  const file = 'test/rpc.spec.ts'
  let text = readFileSync(file, 'utf8')
  text = text.replace(`    setModelOrder: async (ids: readonly string[]) => {
      calls.push(['setModelOrder', [...ids]])
      return status(id, name)
    },`, `    setModelOrder: async (ids: readonly string[]) => {
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
    },`)
  text = text.replace("  if (endpoint === 'setModelOrder') return { provider: 'kimi', ids: ['k3-256k', 'k3'] }",
    `  if (endpoint === 'setModelOrder') return { provider: 'kimi', ids: ['k3-256k', 'k3'] }
  if (endpoint === 'addModel' || endpoint === 'removeModel') return { provider: 'kimi', id: 'k3-next' }`)
  writeFileSync(file, text)
  console.log('patched', file)
}

{
  const file = 'test/settings.spec.ts'
  let text = readFileSync(file, 'utf8')
  text = text.split("{ hidden: { kimi: ['k3-256k'] }, order: {}, auto: { order: [], off: [] } }")
    .join("{ hidden: { kimi: ['k3-256k'] }, order: {}, auto: { order: [], off: [] }, extra: {} }")
  text = text.split("{ hidden: {}, order: {}, auto: { order: [], off: [] } }")
    .join("{ hidden: {}, order: {}, auto: { order: [], off: [] }, extra: {} }")
  // A hand-added id is stored, read back, and can be forgotten again.
  text = text.replace(`  test('reload picks up another writer', async () => {`, `  test('a hand-added model id round-trips and can be forgotten', async () => {
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

  test('reload picks up another writer', async () => {`)
  writeFileSync(file, text)
  console.log('patched', file)
}

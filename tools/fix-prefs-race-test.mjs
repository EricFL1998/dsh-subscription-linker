// One-off: cover the preferences race — three sections read at once on a cold
// object must all see the stored document.
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'test/settings.spec.ts'
let text = readFileSync(file, 'utf8')

const anchor = `  test('a hand-added model id round-trips and can be forgotten', async () => {`
if (!text.includes(anchor)) throw new Error('anchor missing')
text = text.replace(anchor, `  test('concurrent first reads all see the stored document', async () => {
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

${anchor}`)

// `mkdir` is needed by the new case.
if (!text.includes('mkdir')) {
  text = text.replace("import { mkdtemp, readFile, rm, writeFile }", "import { mkdir, mkdtemp, readFile, rm, writeFile }")
  if (!text.includes('mkdir,')) {
    text = text.replace(/import \{ ([^}]*?) \} from 'node:fs\/promises'/, (_all, names) => `import { mkdir, ${names} } from 'node:fs/promises'`)
  }
}
writeFileSync(file, text)
console.log('patched', file)

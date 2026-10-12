// One-off: prove a hand-added model id reaches the picker and resolves.
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'test/kimi-adapter.spec.ts'
let text = readFileSync(file, 'utf8')

const anchor = `  test('a concrete model id still dispatches unchanged', async () => {`
if (!text.includes(anchor)) throw new Error('anchor missing')
text = text.replace(anchor, `  test('a hand-added model id joins the catalog and resolves', async () => {
    const adapter = new KimiAdapter(options({ userModels: async () => ['k3-next'] }))
    assert.deepEqual(
      (await adapter.listModels('kimi')).map((model) => model.id),
      ['kimi-for-coding', 'k3', 'k3[1m]', 'k3-256k', 'k3-next'],
    )
    // It has no shipped metadata, so the standard window is advertised.
    const resolved = await adapter.resolveModel('kimi', 'k3-next')
    assert.equal(resolved.id, 'k3-next')
    assert.equal(resolved.context?.contextWindow, KIMI_CONTEXT_WINDOW)

    // One it already ships is not duplicated by a hand-added copy.
    const known = new KimiAdapter(options({ userModels: async () => ['k3'] }))
    assert.deepEqual(
      (await known.listModels('kimi')).map((model) => model.id),
      ['kimi-for-coding', 'k3', 'k3[1m]', 'k3-256k'],
    )
  })

  test('an unreadable hand-added list is reported, not fatal', async () => {
    const warnings: string[] = []
    const adapter = new KimiAdapter(options({
      userModels: async () => { throw new Error('disk offline') },
      onWarn: (message) => warnings.push(message),
    }))
    assert.equal((await adapter.listModels('kimi')).length, 4)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /user-added models unavailable/)
  })

${anchor}`)
writeFileSync(file, text)
console.log('patched', file)

// One-off: the settings spec predates the auto provider and the `auto` document
// section, so its expectations follow both.
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'test/settings.spec.ts'
let text = readFileSync(file, 'utf8')

const pairs = [
  ["{ hidden: { kimi: ['k3-256k'] }, order: {} }", "{ hidden: { kimi: ['k3-256k'] }, order: {}, auto: { order: [], off: [] } }"],
  ["{ hidden: {}, order: {} }", "{ hidden: {}, order: {}, auto: { order: [], off: [] } }"],
  ["      ['auto', 'kimi-for-coding', 'k3', 'k3[1m]', 'k3-256k'],", "      ['kimi-for-coding', 'k3', 'k3[1m]', 'k3-256k'],"],
  ["      ['auto', 'kimi-for-coding', 'k3', 'k3[1m]'],", "      ['kimi-for-coding', 'k3', 'k3[1m]'],"],
  ["      ['auto', 'kimi-for-coding', 'k3[1m]'],", "      ['kimi-for-coding', 'k3[1m]'],"],
  ["assert.equal((await adapter.listModels('kimi')).length, 5)", "assert.equal((await adapter.listModels('kimi')).length, 4)"],
]

for (const [from, to] of pairs) {
  if (!text.includes(from)) console.log('  MISS', from.slice(0, 60))
  text = text.split(from).join(to)
}
writeFileSync(file, text)
console.log('patched', file)

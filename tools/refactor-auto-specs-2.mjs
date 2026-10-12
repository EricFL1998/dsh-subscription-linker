// One-off: strip the synthetic `auto` entry from the per-route expectations.
import { readFileSync, writeFileSync } from 'node:fs'

const pairs = [
  ["['auto', 'kimi-for-coding', 'k3', 'k3[1m]', 'k3-256k', 'k3-next']", "['kimi-for-coding', 'k3', 'k3[1m]', 'k3-256k', 'k3-next']"],
  ["['auto', 'kimi-for-coding', 'k3', 'k3[1m]', 'k3-256k']", "['kimi-for-coding', 'k3', 'k3[1m]', 'k3-256k']"],
  ["['auto', 'grok-4.6', 'grok-4.5', 'grok-5']", "['grok-4.6', 'grok-4.5', 'grok-5']"],
  ["['auto', 'grok-4.6']", "['grok-4.6']"],
]

for (const file of ['test/kimi-adapter.spec.ts', 'test/grok.spec.ts']) {
  let text = readFileSync(file, 'utf8')
  for (const [from, to] of pairs) text = text.split(from).join(to)
  writeFileSync(file, text)
  console.log('patched', file)
}

// One-off: each route reads its hand-added ids from the shared preferences.
import { readFileSync, writeFileSync } from 'node:fs'

const pairs = [
  ['src/providers/kimi-provider.ts', 'KIMI_PROVIDER_ID'],
  ['src/providers/grok.ts', 'GROK_PROVIDER_ID'],
  ['src/providers/antigravity.ts', 'ANTIGRAVITY_PROVIDER_ID'],
]

for (const [file, id] of pairs) {
  let text = readFileSync(file, 'utf8')
  const anchor = `    hiddenModels: () => options.preferences.hiddenIds(${id}),\n`
  if (!text.includes(anchor)) throw new Error(`${file}: hiddenModels wiring missing`)
  text = text.replace(anchor, anchor + `    userModels: () => options.preferences.extraIds(${id}),\n`)
  writeFileSync(file, text)
  console.log('patched', file)
}

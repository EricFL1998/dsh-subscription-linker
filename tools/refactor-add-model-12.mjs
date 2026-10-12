// One-off: give each merged catalog the right element type.
import { readFileSync, writeFileSync } from 'node:fs'

const files = [
  { file: 'src/providers/kimi.ts', type: 'KimiModelEntry' },
  { file: 'src/providers/grok.ts', type: 'CatalogEntry' },
  { file: 'src/providers/antigravity.ts', type: 'CatalogEntry' },
]

for (const { file, type } of files) {
  let text = readFileSync(file, 'utf8')
  const from = "  private catalog(): readonly ReturnType<KimiAdapter['shippedCatalog']> {"
  if (!text.includes(from)) throw new Error(`${file}: merged catalog anchor missing`)
  text = text.replace(from, `  private catalog(): readonly ${type}[] {`)
  writeFileSync(file, text)
  console.log('patched', file)
}

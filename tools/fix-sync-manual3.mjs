// One-off: antigravity's accessor has its own comment, and Kimi's spec wiring sits
// in its façade file.
import { readFileSync, writeFileSync } from 'node:fs'

{
  const file = 'src/providers/antigravity.ts'
  let text = readFileSync(file, 'utf8')
  if (!text.includes('ownCatalogEntries')) {
    const anchor = `  /** The live catalog, for the Settings page's model list. */\n  catalogEntries(): readonly CatalogEntry[] {\n    return this.catalog()\n  }`
    if (!text.includes(anchor)) throw new Error('antigravity accessor missing')
    text = text.replace(anchor, `${anchor}

  /** What this route itself serves, without the ids added by hand. */
  ownCatalogEntries(): readonly CatalogEntry[] {
    return this.shippedCatalog()
  }`)
    writeFileSync(file, text)
    console.log(`patched ${file}`)
  }
}

for (const file of ['src/providers/kimi-provider.ts', 'src/providers/antigravity.ts']) {
  let text = readFileSync(file, 'utf8')
  if (text.includes('catalogOwn')) {
    console.log(`  ${file}: spec already wired`)
    continue
  }
  const anchor = '    catalog: () => adapter.catalogEntries(),'
  if (!text.includes(anchor)) throw new Error(`${file}: spec catalog wiring missing`)
  text = text.replace(anchor, `${anchor}
    catalogOwn: () => adapter.ownCatalogEntries(),`)
  writeFileSync(file, text)
  console.log(`patched ${file}`)
}

// One-off: expose each route's own catalog, and wire it into the provider spec.
import { readFileSync, writeFileSync } from 'node:fs'

/** Add `ownCatalogEntries()` after the Settings-page accessor. */
function addOwn(file, ownType) {
  let text = readFileSync(file, 'utf8')
  const anchor = `  /** The curated catalog, for the Settings page's model list. */\n  catalogEntries(): readonly ${ownType}[] {\n    return this.catalog()\n  }`
  if (text.includes('ownCatalogEntries')) {
    console.log(`  ${file}: already exposes its own catalog`)
    return
  }
  if (!text.includes(anchor)) throw new Error(`${file}: catalogEntries missing`)
  text = text.replace(anchor, `${anchor}

  /** What this route itself serves, without the ids added by hand. */
  ownCatalogEntries(): readonly ${ownType}[] {
    return this.shippedCatalog()
  }`)
  writeFileSync(file, text)
  console.log(`patched ${file}`)
}

/** Wire the pair into the spec the controller reads. */
function wireSpec(file) {
  let text = readFileSync(file, 'utf8')
  const anchor = '    catalog: () => adapter.catalogEntries(),'
  if (!text.includes(anchor)) throw new Error(`${file}: spec catalog wiring missing`)
  if (text.includes('catalogOwn')) {
    console.log(`  ${file}: spec already wired`)
    return
  }
  text = text.replace(anchor, `${anchor}
    catalogOwn: () => adapter.ownCatalogEntries(),`)
  writeFileSync(file, text)
  console.log(`patched ${file}`)
}

addOwn('src/providers/kimi.ts', 'KimiModelEntry')
addOwn('src/providers/grok.ts', 'CatalogEntry')
addOwn('src/providers/antigravity.ts', 'CatalogEntry')

// The spec lives beside the adapter, except for Kimi, whose façade is its own file.
wireSpec('src/providers/kimi-provider.ts')
wireSpec('src/providers/grok.ts')
wireSpec('src/providers/antigravity.ts')

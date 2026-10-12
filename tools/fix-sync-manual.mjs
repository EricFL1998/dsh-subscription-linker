// One-off: distinguish "synced by the route" from "added by hand", so a model
// discovery later finds becomes a normal synced row.
import { readFileSync, writeFileSync } from 'node:fs'

// 1. The spec can state its own catalog, without the hand-added entries.
{
  const file = 'src/auth/provider-controller.ts'
  let text = readFileSync(file, 'utf8')
  const anchor = '  /** Context advertised for a model id the user added by hand. */\n'
  if (!text.includes(anchor)) throw new Error('fallback-context anchor missing')
  text = text.replace(anchor, `  /**
   * What this route itself serves: its shipped and live-discovered models, without
   * the ids the user added by hand.
   *
   * The pair with {@link ProviderSpec.catalog} is what separates a synced model from
   * a manual entry once the adapter merges both into one list.
   */
  readonly catalogOwn?: () => readonly CatalogEntry[]
${anchor}`)

  // The flag means "only exists because the user typed it".
  const from = `    const userAdded = new Set(added)
    const listed = this.resolveOrdered(hidden, order).ranked
    const known = new Set(listed.map((entry) => entry.id))`
  if (!text.includes(from)) throw new Error('modelSummaries head missing')
  text = text.replace(from, `    const own = new Set((this.options.spec.catalogOwn?.() ?? this.options.spec.catalog()).map((entry) => entry.id))
    // A model the route serves is a synced row even while the manual entry that
    // introduced it is still stored, so the marker follows the route, not the file.
    const userAdded = new Set(added.filter((id) => !own.has(id)))
    const listed = this.resolveOrdered(hidden, order).ranked
    const known = new Set(listed.map((entry) => entry.id))`)

  // Rows appended from the file are manual by definition.
  const appendFrom = `    for (const id of added) {
      if (known.has(id)) continue`
  if (!text.includes(appendFrom)) throw new Error('append loop missing')
  text = text.replace(appendFrom, `    for (const id of added) {
      if (known.has(id) || own.has(id)) continue`)

  // Pruning covers ids an earlier sync already found, not only this run's.
  const pruneFrom = `  private async forgetDiscovered(ids: readonly string[]): Promise<void> {
    const served = new Set(ids)`
  if (!text.includes(pruneFrom)) throw new Error('forgetDiscovered missing')
  text = text.replace(pruneFrom, `  private async forgetDiscovered(ids: readonly string[]): Promise<void> {
    // Everything the route itself serves — this run's discovery plus whatever an
    // earlier one already put in the shipped catalog.
    const served = new Set(ids)
    for (const entry of this.options.spec.catalogOwn?.() ?? []) served.add(entry.id)`)

  writeFileSync(file, text)
  console.log('patched', file)
}

// 2. Each route exposes its own catalog.
{
  const pairs = [
    ['src/providers/kimi.ts', 'kimi'],
    ['src/providers/grok.ts', 'grok'],
    ['src/providers/antigravity.ts', 'antigravity'],
  ]
  for (const [file, id] of pairs) {
    let text = readFileSync(file, 'utf8')
    const anchor = `  /** The curated catalog, for the Settings page's model list. */\n  catalogEntries(): readonly CatalogEntry[] {\n    return this.catalog()\n  }`
    const kimiAnchor = `  /** The curated catalog, for the Settings page's model list. */\n  catalogEntries(): readonly KimiModelEntry[] {\n    return this.catalog()\n  }`
    const from = text.includes(anchor) ? anchor : kimiAnchor
    if (!text.includes(from)) throw new Error(`${file}: catalogEntries missing`)
    const ownType = file.endsWith('kimi.ts') ? 'KimiModelEntry' : 'CatalogEntry'
    text = text.replace(from, `${from}

  /** What this route itself serves, without the ids added by hand. */
  ownCatalogEntries(): readonly ${ownType}[] {
    return this.shippedCatalog()
  }`)
    // Wire it into the provider module's spec.
    const catalogAnchor = `    catalog: () => adapter.catalogEntries(),`
    if (!text.includes(catalogAnchor)) throw new Error(`${file}: spec catalog wiring missing`)
    text = text.replace(catalogAnchor, `${catalogAnchor}
    catalogOwn: () => adapter.ownCatalogEntries(),`)
    writeFileSync(file, text)
    console.log('patched', file)
  }
}

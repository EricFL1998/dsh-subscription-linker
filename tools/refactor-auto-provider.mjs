// One-off refactor: `auto` is its own provider now, so the three wire adapters
// serve only their own concrete models.
import { readFileSync, writeFileSync } from 'node:fs'

/** Replace once, failing loudly when the anchor is missing. */
function cut(file, from, to) {
  const text = readFileSync(file, 'utf8')
  const at = text.indexOf(from)
  if (at === -1) throw new Error(`${file}: anchor not found:\n${from.slice(0, 120)}`)
  writeFileSync(file, text.slice(0, at) + to + text.slice(at + from.length))
  console.log(`patched ${file}`)
}

for (const file of ['src/providers/kimi.ts', 'src/providers/grok.ts', 'src/providers/antigravity.ts']) {
  const text = readFileSync(file, 'utf8')
  // The auto entry, its chain and its wire ids all moved to the auto provider.
  let next = text
    .replace(/import \{ AUTO_MODEL_ID, autoEntry, fallbackEntry, findEntry, resolveCatalog, wireModelIds \} from '\.\/catalog\.js'/,
      "import { fallbackEntry, findEntry, resolveCatalog } from './catalog.js'")
    .replace(/import \{ AUTO_MODEL_ID, autoEntry, findEntry, resolveCatalog, wireModelIds \} from '\.\/catalog\.js'/,
      "import { findEntry, resolveCatalog } from './catalog.js'")
    .replace(/const \[hidden, order\] = await Promise\.all\(\[this\.hidden\(\), this\.order\(\)\]\)\n(\s*)return resolveCatalog\(this\.catalog\(\), order, hidden, this\.auto\)\.entries\.map/,
      "const [hidden, order] = await Promise.all([this.hidden(), this.order()])\n$1return resolveCatalog(this.catalog(), order, hidden).entries.map")
  // Drop the auto getter, the autoChain helper and the wire-id chain helper.
  next = next.replace(/\n  \/\*\* The `auto` entry this route publishes\. \*\/\n  private get auto\(\): CatalogEntry \{\n[^}]*\n  \}\n/, '\n')
  next = next.replace(/\n  \/\*\* The (?:models `auto` walks|user's model rank)[^*]*\*\/\n  private async (?:autoChain|order)\(\): Promise<readonly (?:CatalogEntry\[\]|string\[\])> \{\n(?:.*\n)*?  \}\n/, '\n')
  next = next.replace(/\n  \/\*\* The wire models a requested id dispatches over, most preferred first\. \*\/\n  private async wireIds\(model: string\): Promise<readonly string\[\]> \{\n(?:.*\n)*?  \}\n/, '\n')
  // The stream no longer resolves a chain: a concrete id is the whole request.
  next = next.replace(/\n      \/\/ `auto` walks the user's ranked models; a concrete id is itself\.\n      models: \(\) => this\.wireIds\(options\.model\),/, '')
  // resolveModel no longer answers for `auto`.
  next = next.replace(/\n    \/\/ `auto` reports the metadata[\s\S]*?\n    \}\n/, '\n')
  next = next.replace(/\n    \/\/ `auto` reports the metadata[\s\S]*?\n    \}\n/, '\n')
  if (next === text) throw new Error(`${file}: nothing changed`)
  writeFileSync(file, next)
  console.log(`patched ${file}`)
}

// The controller no longer publishes a synthetic entry per route.
{
  const file = 'src/auth/provider-controller.ts'
  let text = readFileSync(file, 'utf8')
  text = text
    .replace("import { AUTO_MODEL_ID, autoEntry, entryMatches, resolveCatalog } from '../providers/catalog.js'",
      "import { entryMatches, resolveCatalog } from '../providers/catalog.js'")
    .replace(/\n  \/\*\* Context advertised for `auto` before a target is known\. \*\/\n  readonly autoContextWindow\?: number\n  \/\*\* What `auto` means for this provider, shown in the picker\. \*\/\n  readonly autoDescription\?: string/, '')
    .replace(/  \/\*\* The catalog as the page lists it[\s\S]*?\n  \}\n\n  \/\*\* This route's catalog after the user's order and visibility are applied\. \*\/\n  private resolveOrdered\(hidden: ReadonlySet<string>, order: readonly string\[\]\): ResolvedCatalog \{\n    return resolveCatalog\(\n      this\.options\.spec\.catalog\(\),\n      order,\n      hidden,\n      autoEntry\(\n        this\.options\.spec\.autoContextWindow \?\? DEFAULT_AUTO_CONTEXT_WINDOW,\n        this.autoDescription,\n      \),\n    \)\n  \}\n\n  \/\*\* What `auto` means for this provider\. \*\/\n  private get autoDescription\(\): string \{\n    return this\.options\.spec\.autoDescription \?\? 'Fall back through the enabled models when one is unavailable'\n  \}\n/,
      `  /** The catalog as the page lists it, in the user's order. */
  private async modelSummaries(): Promise<readonly ModelSummary[]> {
    const [hidden, order] = await Promise.all([
      this.options.preferences.hiddenIds(this.options.spec.id),
      this.options.preferences.orderOf(this.options.spec.id),
    ])
    return this.resolveOrdered(hidden, order).ranked.map((entry) => ({
      id: entry.id,
      name: entry.name,
      ...entry.description === undefined ? {} : { description: entry.description },
      contextWindow: entry.contextWindow,
      ...entry.inputModalities === undefined ? {} : { inputModalities: entry.inputModalities },
      ...entry.defaultEffort === undefined ? {} : { defaultEffort: entry.defaultEffort },
      visible: !hidden.has(entry.id),
    }))
  }

  /** This route's catalog after the user's order and visibility are applied. */
  private resolveOrdered(hidden: ReadonlySet<string>, order: readonly string[]): ResolvedCatalog {
    return resolveCatalog(this.options.spec.catalog(), order, hidden)
  }
`)
    .replace(/  async setModelVisible\(id: string, visible: boolean\): Promise<ProviderStatus> \{\n    \/\/ `auto` is a real entry[\s\S]*?\n    const known = id === AUTO_MODEL_ID\n      \|\| this\.options\.spec\.catalog\(\)\.some\(\(entry\) => entryMatches\(entry, id\)\)/,
      `  async setModelVisible(id: string, visible: boolean): Promise<ProviderStatus> {
    const known = this.options.spec.catalog().some((entry) => entryMatches(entry, id))`)
    .replace(/\n      if \(id === AUTO_MODEL_ID\) continue/, '')
    .replace(/      if \(entry\.id !== AUTO_MODEL_ID && !next\.includes\(entry\.id\)\) next\.push\(entry\.id\)/, '      if (!next.includes(entry.id)) next.push(entry.id)')
    .replace(/\n\/\*\* Context `auto` advertises before a target model is known\. \*\/\nexport const DEFAULT_AUTO_CONTEXT_WINDOW = 262_144\n/, '\n')
  writeFileSync(file, text)
  console.log(`patched ${file}`)
}

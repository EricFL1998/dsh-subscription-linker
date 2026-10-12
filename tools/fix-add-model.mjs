// One-off: the Settings list and the add-check own their hand-added rows instead of
// depending on the adapter's asynchronously warmed cache.
import { readFileSync, writeFileSync } from 'node:fs'

{
  const file = 'src/auth/provider-controller.ts'
  let text = readFileSync(file, 'utf8')

  // The spec states the window a hand-added id is advertised with.
  const specAnchor = '  /** Context advertised for this route before discovery runs. */\n'
  if (text.includes(specAnchor)) throw new Error('unexpected existing anchor')
  const contextAnchor = '  readonly discovery: boolean\n'
  if (!text.includes(contextAnchor)) throw new Error('discovery field anchor missing')
  text = text.replace(contextAnchor, `${contextAnchor}  /** Context advertised for a model id the user added by hand. */
  readonly fallbackContextWindow?: number
`)

  // The list is the route's catalog plus every hand-added id, deduplicated, so a
  // row appears whether or not the adapter's cache happens to be warm.
  const from = `    const userAdded = new Set(added)
    return this.resolveOrdered(hidden, order).ranked.map((entry) => ({
      id: entry.id,
      name: entry.name,
      ...entry.description === undefined ? {} : { description: entry.description },
      contextWindow: entry.contextWindow,
      ...entry.inputModalities === undefined ? {} : { inputModalities: entry.inputModalities },
      ...entry.defaultEffort === undefined ? {} : { defaultEffort: entry.defaultEffort },
      visible: !hidden.has(entry.id),
      ...userAdded.has(entry.id) ? { userAdded: true } : {},
    }))
  }`
  if (!text.includes(from)) throw new Error('modelSummaries anchor missing')
  text = text.replace(from, `    const userAdded = new Set(added)
    const listed = this.resolveOrdered(hidden, order).ranked
    const known = new Set(listed.map((entry) => entry.id))
    // A hand-added id the adapter has not merged yet is appended here, with the
    // conservative metadata this build can honestly state. The adapter carries the
    // same ids for the picker; this list must not depend on its async refresh.
    const rows: ModelSummary[] = listed.map((entry) => ({
      id: entry.id,
      name: entry.name,
      ...entry.description === undefined ? {} : { description: entry.description },
      contextWindow: entry.contextWindow,
      ...entry.inputModalities === undefined ? {} : { inputModalities: entry.inputModalities },
      ...entry.defaultEffort === undefined ? {} : { defaultEffort: entry.defaultEffort },
      visible: !hidden.has(entry.id),
      ...userAdded.has(entry.id) ? { userAdded: true } : {},
    }))
    for (const id of added) {
      if (known.has(id)) continue
      known.add(id)
      rows.push({
        id,
        name: id,
        description: 'Added by hand in Settings',
        contextWindow: this.options.spec.fallbackContextWindow ?? DEFAULT_FALLBACK_CONTEXT_WINDOW,
        visible: !hidden.has(id),
        userAdded: true,
      })
    }
    return rows
  }`)

  // Re-adding a hand-added id is a no-op rather than an error; only an id the
  // route really serves is refused.
  const addFrom = `    if (this.options.spec.catalog().some((entry) => entryMatches(entry, trimmed))) {
      throw new ProviderError(\`\${this.displayName} already offers \${trimmed}\`, BAD_REQUEST)
    }
    if (await this.options.preferences.addExtra(this.options.spec.id, trimmed)) {
      this.options.onCatalogChanged?.()
    }
    return this.status()`
  if (!text.includes(addFrom)) throw new Error('addModel anchor missing')
  text = text.replace(addFrom, `    if (this.options.spec.catalog().some((entry) => entryMatches(entry, trimmed))) {
      throw new ProviderError(\`\${this.displayName} already offers \${trimmed}\`, BAD_REQUEST)
    }
    // Already added by hand: the click is idempotent, not an error.
    const added = await this.options.preferences.extraIds(this.options.spec.id)
    if (added.includes(trimmed)) return this.status()
    if (await this.options.preferences.addExtra(this.options.spec.id, trimmed)) {
      this.options.onCatalogChanged?.()
    }
    return this.status()`)

  // The neutral default, used when a route states none.
  text = text.replace('export class ProviderController<S extends SessionBase> {',
    `/** Context advertised for a hand-added id on a route that states none. */
const DEFAULT_FALLBACK_CONTEXT_WINDOW = 262_144

export class ProviderController<S extends SessionBase> {`)

  writeFileSync(file, text)
  console.log('patched', file)
}

// Each route states the window its own models are advertised with.
{
  const pairs = [
    ['src/providers/kimi-provider.ts', 'KIMI_CONTEXT_WINDOW'],
    ['src/providers/grok.ts', 'GROK_CONTEXT_WINDOW'],
    ['src/providers/antigravity.ts', 'ANTIGRAVITY_CONTEXT_WINDOW'],
  ]
  for (const [file, constant] of pairs) {
    let text = readFileSync(file, 'utf8')
    const anchor = `    catalog: () => adapter.catalogEntries(),`
    if (!text.includes(anchor)) throw new Error(`${file}: catalog anchor missing`)
    text = text.replace(anchor, `${anchor}
    fallbackContextWindow: ${constant},`)
    writeFileSync(file, text)
    console.log('patched', file)
  }
}

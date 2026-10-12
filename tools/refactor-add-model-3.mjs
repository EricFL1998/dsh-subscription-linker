// One-off: finish the hand-added-model merge for grok and antigravity, whose
// catalog tail comment differs from Kimi's.
import { readFileSync, writeFileSync } from 'node:fs'

const files = [
  { file: 'src/providers/grok.ts', window: 'GROK_CONTEXT_WINDOW', type: 'CatalogEntry', anchor: '  /** Record the live catalog for the picker. */\n' },
  { file: 'src/providers/antigravity.ts', window: 'ANTIGRAVITY_CONTEXT_WINDOW', type: 'CatalogEntry', anchor: '  /** Record a live catalog discovered elsewhere. */\n' },
]

for (const { file, window: windowConstant, type, anchor } of files) {
  let text = readFileSync(file, 'utf8')

  if (!text.includes('private userAddedIds')) {
    const cacheAnchor = '  constructor(private readonly options: '
    const cacheAt = text.indexOf(cacheAnchor)
    if (cacheAt === -1) throw new Error(`${file}: constructor anchor missing`)
    text = text.slice(0, cacheAt) + `  /** Ids the user added by hand, cached so the sync catalog can name them. */
  private userAddedIds: readonly string[] = []

` + text.slice(cacheAt)
  }

  for (const method of ['listModels', 'resolveModel']) {
    const methodAnchor = `  override async ${method}(_provider: string`
    const at = text.indexOf(methodAnchor)
    if (at === -1) throw new Error(`${file}: ${method} anchor missing`)
    const end = text.indexOf('\n', at) + 1
    text = text.slice(0, end) + '    await this.syncUserModels()\n' + text.slice(end)
  }

  // The catalog builder must append the extras at its own return site.
  const returnAnchor = file.endsWith('grok.ts')
    ? '    return [...seeded, ...extra]\n'
    : '    return this.live ?? []\n'
  if (!text.includes(returnAnchor)) throw new Error(`${file}: catalog return anchor missing`)
  text = text.replace(returnAnchor, file.endsWith('grok.ts')
    ? '    return [...seeded, ...extra, ...this.addedEntries()]\n'
    : `    const live = this.live ?? []
    return [...live, ...this.addedEntries()]
`)

  if (!text.includes(anchor)) throw new Error(`${file}: tail anchor missing`)
  const helpers = `  /** Re-read the ids the user added by hand. */
  private async syncUserModels(): Promise<void> {
    if (this.options.userModels === undefined) return
    try {
      this.userAddedIds = await this.options.userModels()
    } catch (error: unknown) {
      this.options.onWarn?.(\`user-added models unavailable (\${errorChain(error)})\`)
      this.userAddedIds = []
    }
  }

  /**
   * The entries for ids the user added by hand.
   *
   * Published without shipped metadata: this build has never seen the model, so
   * the endpoint's own defaults are the honest description.
   */
  private addedEntries(): readonly ${type}[] {
    if (this.userAddedIds.length === 0) return []
    const known = new Set(this.catalog().map((entry) => entry.id))
    return this.userAddedIds
      .filter((id) => !known.has(id))
      .map((id) => fallbackEntry(id, 'Added by hand in Settings', ${windowConstant}))
  }

`
  text = text.replace(anchor, helpers + anchor)
  writeFileSync(file, text)
  console.log('patched', file)
}

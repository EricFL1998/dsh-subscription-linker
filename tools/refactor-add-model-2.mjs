// One-off: merge hand-added model ids into each route's catalog.
import { readFileSync, writeFileSync } from 'node:fs'

const files = [
  { file: 'src/providers/kimi.ts', window: 'KIMI_CONTEXT_WINDOW', type: 'KimiModelEntry' },
  { file: 'src/providers/grok.ts', window: 'GROK_CONTEXT_WINDOW', type: 'CatalogEntry' },
  { file: 'src/providers/antigravity.ts', window: 'ANTIGRAVITY_CONTEXT_WINDOW', type: 'CatalogEntry' },
]

for (const { file, window: windowConstant, type } of files) {
  let text = readFileSync(file, 'utf8')

  // 1. A cache the synchronous catalog builder can read.
  const cacheAnchor = '  constructor(private readonly options: '
  const cacheAt = text.indexOf(cacheAnchor)
  if (cacheAt === -1) throw new Error(`${file}: constructor anchor missing`)
  const cacheField = `  /** Ids the user added by hand, cached so the sync catalog can name them. */
  private userAddedIds: readonly string[] = []

`
  text = text.slice(0, cacheAt) + cacheField + text.slice(cacheAt)

  // 2. Refresh it wherever the catalog is consulted asynchronously, and append
  //    the extras to the built catalog.
  const listAnchor = '  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {\n'
  if (!text.includes(listAnchor)) throw new Error(`${file}: listModels anchor missing`)
  text = text.replace(listAnchor, listAnchor + '    await this.syncUserModels()\n')

  const resolveAnchor = '  override async resolveModel(_provider: string, model: string): Promise<LlmResolvedModelInfo> {\n'
  if (!text.includes(resolveAnchor)) throw new Error(`${file}: resolveModel anchor missing`)
  text = text.replace(resolveAnchor, resolveAnchor + '    await this.syncUserModels()\n')

  const catalogAnchor = '  /** Record the live catalog for the picker; failures keep the shipped list. */\n'
  if (!text.includes(catalogAnchor)) throw new Error(`${file}: catalog tail anchor missing`)
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
   * The entries for ids the user added by hand, in the order they added them.
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
  text = text.replace(catalogAnchor, helpers + catalogAnchor)

  writeFileSync(file, text)
  console.log('patched', file)
}

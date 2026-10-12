// One-off: let each route publish the model ids the user added by hand, so a
// model this build's catalog does not know yet is still usable.
import { readFileSync, writeFileSync } from 'node:fs'

/** Insert one option after the hidden-models hook of each adapter. */
const option = `  /**
   * Model ids the user added by hand.
   *
   * Read per catalog query, so the add button takes effect at the picker's next
   * refresh. A hand-added id is published with conservative metadata: the
   * endpoint is the authority on what it serves, not this build.
   */
  userModels?: () => Promise<readonly string[]>
`

const reader = `
  /** The ids the user added by hand, or none when preferences are unreadable. */
  private async userAdded(): Promise<readonly string[]> {
    if (this.options.userModels === undefined) return []
    try {
      return await this.options.userModels()
    } catch (error: unknown) {
      this.options.onWarn?.(\`user-added models unavailable (\${errorChain(error)})\`)
      return []
    }
  }

  /** The user-added entries, published without shipped metadata. */
  private async extraEntries(contextWindow: number): Promise<CatalogEntry[]> {
    const added = await this.userAdded()
    if (added.length === 0) return []
    const known = new Set(this.catalog().map((entry) => entry.id))
    return added
      .filter((id) => !known.has(id))
      .map((id) => fallbackEntry(id, 'Added by hand in Settings', contextWindow))
  }
`

for (const file of ['src/providers/kimi.ts', 'src/providers/grok.ts', 'src/providers/antigravity.ts']) {
  let text = readFileSync(file, 'utf8')
  const anchor = '  hiddenModels?: () => Promise<ReadonlySet<string>>\n'
  if (!text.includes(anchor)) throw new Error(`${file}: hidden-models anchor missing`)
  text = text.replace(anchor, anchor + option)
  writeFileSync(file, text)
  console.log('patched', file)
}

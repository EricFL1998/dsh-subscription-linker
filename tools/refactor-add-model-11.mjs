// One-off: break the cycle between a route's shipped catalog and the ids the
// user added by hand.
import { readFileSync, writeFileSync } from 'node:fs'

const files = ['src/providers/kimi.ts', 'src/providers/grok.ts', 'src/providers/antigravity.ts']

for (const file of files) {
  let text = readFileSync(file, 'utf8')

  // The body that builds the shipped/live catalog becomes its own method.
  const decl = '  private catalog(): readonly '
  const at = text.indexOf(decl)
  if (at === -1) throw new Error(`${file}: catalog declaration missing`)
  const end = text.indexOf('{', at)
  const signature = text.slice(at, end)
  const shippedSignature = signature
    .replace('private catalog()', 'private shippedCatalog()')
  text = text.slice(0, at) + shippedSignature + text.slice(end)

  // The cycle check reads the shipped catalog, never the merged one.
  text = text.replace('    const known = new Set(this.catalog().map((entry) => entry.id))',
    '    const known = new Set(this.shippedCatalog().map((entry) => entry.id))')

  // `catalog()` is now the merged view: shipped entries, then hand-added ones.
  const shippedComment = text.lastIndexOf('  /**', at)
  const insertAt = text.lastIndexOf('\n', shippedComment) + 1
  text = text.slice(0, insertAt) + `  /**
   * The catalog the route serves: its own entries, then the ids the user added
   * by hand. The two are built separately so the hand-added check can look at
   * the shipped list without recursing.
   */
  private catalog(): readonly ReturnType<KimiAdapter['shippedCatalog']> {
    return [...this.shippedCatalog(), ...this.addedEntries()]
  }

` + text.slice(insertAt)

  writeFileSync(file, text)
  console.log('patched', file)
}

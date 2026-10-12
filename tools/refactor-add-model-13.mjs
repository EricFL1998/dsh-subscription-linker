// One-off: the shipped builders must not append the hand-added entries; the
// merged catalog does that.
import { readFileSync, writeFileSync } from 'node:fs'

const kimi = 'src/providers/kimi.ts'
{
  let text = readFileSync(kimi, 'utf8')
  const from = `    const shipped = extra.length === 0 ? KIMI_MODELS : [...KIMI_MODELS, ...extra]
    return [...shipped, ...this.addedEntries().filter((entry) => this.entryFor(entry.id) === undefined)]`
  if (!text.includes(from)) throw new Error('kimi shipped return missing')
  text = text.replace(from, '    return extra.length === 0 ? KIMI_MODELS : [...KIMI_MODELS, ...extra]')
  writeFileSync(kimi, text)
  console.log('patched', kimi)
}

for (const file of ['src/providers/grok.ts', 'src/providers/antigravity.ts']) {
  let text = readFileSync(file, 'utf8')
  const from = '    return [...seeded, ...extra, ...this.addedEntries()]'
  if (text.includes(from)) {
    text = text.replace(from, '    return [...seeded, ...extra]')
    writeFileSync(file, text)
    console.log('patched', file)
    continue
  }
  const liveFrom = `    const live = this.live ?? []
    return [...live, ...this.addedEntries()]`
  if (!text.includes(liveFrom)) throw new Error(`${file}: merged live return missing`)
  text = text.replace(liveFrom, '    return this.live ?? []')
  writeFileSync(file, text)
  console.log('patched', file)
}

// Search one text bundle for OAuth/login strings with surrounding context.
import { readFile } from 'node:fs/promises'

const [file, ...patterns] = process.argv.slice(2)
const text = await readFile(file, 'utf8')

for (const pattern of patterns) {
  const re = new RegExp(pattern, 'gi')
  const seen = new Set()
  let match
  while ((match = re.exec(text)) !== null && seen.size < 12) {
    const at = match.index
    const window = text.slice(Math.max(0, at - 130), Math.min(text.length, at + 170))
      .replace(/\s+/g, ' ')
    if (seen.has(window)) continue
    seen.add(window)
    console.log(`  …${window}…\n`)
  }
  if (seen.size === 0) console.log(`  /${pattern}/ → nothing\n`)
}

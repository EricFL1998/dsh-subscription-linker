// Find OAuth-shaped strings in a compiled binary.
import { readFile } from 'node:fs/promises'

const [file, ...patterns] = process.argv.slice(2)
const buf = await readFile(file)
const text = buf.toString('latin1')

/** Every distinct printable run containing one pattern. */
function runs(pattern, limit) {
  const out = new Set()
  const re = new RegExp(`[\\x20-\\x7e]{6,220}`, 'g')
  let match
  while ((match = re.exec(text)) !== null) {
    if (!pattern.test(match[0])) continue
    out.add(match[0].trim())
    if (out.size >= limit) break
  }
  return [...out]
}

for (const pattern of patterns) {
  const re = new RegExp(pattern, 'i')
  console.log(`\n===== /${pattern}/ =====`)
  const found = runs(re, 25)
  if (found.length === 0) console.log('(nothing)')
  for (const line of found) console.log('  ', line.replace(/[\x00-\x1f]/g, ''))
}

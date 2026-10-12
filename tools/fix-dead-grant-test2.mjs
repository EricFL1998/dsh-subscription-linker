// One-off: the dead-grant tests need the `withUsage` harness, which lives in the
// `usage reads` suite.
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'test/controller.spec.ts'
let text = readFileSync(file, 'utf8')

const start = text.indexOf("  test('a refused grant is reported as a dead login, not a failed read', async () => {")
if (start === -1) throw new Error('inserted block missing')
const end = text.indexOf("  test('a model added by hand is listed", start)
if (end === -1) throw new Error('block end missing')
const block = text.slice(start, end).trimEnd()
text = `${text.slice(0, start)}${text.slice(end)}`

// The harness takes one argument, and the assertions compare against the real
// display name the suite's spec uses.
const fixed = block
  .replace(/withUsage\(([\s\S]*?)\n    \}, \{ reads: 0 \}\)/, 'withUsage($1\n    })')
  .split(", { reads: 0 }").join('')

// Place it at the end of the `usage reads` describe, which is the file's last block.
const closeAt = text.lastIndexOf('\n})')
if (closeAt === -1) throw new Error('file close missing')
const indented = fixed.split('\n').map((line) => line.length === 0 ? line : `  ${line}`).join('\n')
text = `${text.slice(0, closeAt)}\n\n${indented}${text.slice(closeAt)}\n`

writeFileSync(file, text)
console.log('patched', file)

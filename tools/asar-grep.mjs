// Search an Electron app.asar for text patterns, without extracting it.
// Usage: node tools/asar-grep.mjs <asar> <pattern> [maxMatches] [maxFileBytes]
import { open } from 'node:fs/promises'

const [asar, pattern, maxMatchesRaw, maxBytesRaw] = process.argv.slice(2)
if (asar === undefined || pattern === undefined) throw new Error('usage: asar-grep.mjs <asar> <pattern> [maxMatches]')
const maxMatches = Number(maxMatchesRaw ?? 40)
const maxFileBytes = Number(maxBytesRaw ?? 40_000_000)
const needle = Buffer.from(pattern, 'utf8')

const fh = await open(asar, 'r')
const head = Buffer.alloc(16)
await fh.read(head, 0, 16, 0)
const headerSize = head.readUInt32LE(12)
const headerBuf = Buffer.alloc(headerSize)
await fh.read(headerBuf, 0, headerSize, 16)
const header = JSON.parse(headerBuf.toString('utf8').replace(/\0+$/, ''))
const dataBase = 16 + headerSize

/** Walk the asar tree, yielding [path, entry] for real files. */
function* walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix === '' ? name : `${prefix}/${name}`
    if (entry.files !== undefined) yield* walk(entry, path)
    else if (entry.size !== undefined) yield [path, entry]
  }
}

let matches = 0
for (const [path, entry] of walk(header, '')) {
  if (matches >= maxMatches) break
  if (entry.size === 0 || entry.size > maxFileBytes) continue
  if (!/\.(js|mjs|cjs|json|ts)$/.test(path)) continue
  const buf = Buffer.alloc(entry.size)
  await fh.read(buf, 0, entry.size, dataBase + Number(entry.offset))
  let at = buf.indexOf(needle)
  while (at !== -1 && matches < maxMatches) {
    const from = Math.max(0, at - 160)
    const to = Math.min(buf.length, at + 240)
    // Mask anything that looks like a credential before printing.
    const context = buf.subarray(from, to).toString('utf8')
      .replace(/((?:access|refresh|id)_?token|secret|api[_-]?key|client_secret)["'\s:=]{1,6}["']?[A-Za-z0-9._~+/-]{12,}/gi, '$1=<redacted>')
    console.log(`--- ${path} @${at} ---\n${context}\n`)
    matches += 1
    at = buf.indexOf(needle, at + 1)
  }
}
console.log(`matches: ${matches}`)
await fh.close()

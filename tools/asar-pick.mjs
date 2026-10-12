// Minimal asar reader: extract one file (or list a directory) from an app.asar.
// Usage: node tools/asar-pick.mjs <asar> <internal/path> [outFile]
import { open, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const [ASAR, target, out] = process.argv.slice(2)
if (ASAR === undefined) throw new Error('usage: asar-pick.mjs <asar> <path> [outFile]')

const fh = await open(ASAR, 'r')
const head = Buffer.alloc(16)
await fh.read(head, 0, 16, 0)
const headerSize = head.readUInt32LE(12)
const headerBuf = Buffer.alloc(headerSize)
await fh.read(headerBuf, 0, headerSize, 16)
const header = JSON.parse(headerBuf.toString('utf8').replace(/\0+$/, ''))
const dataBase = 16 + headerSize

function resolveEntry(parts) {
  let node = header
  for (const part of parts) {
    if (!node.files || !node.files[part]) return undefined
    node = node.files[part]
  }
  return node
}

const parts = String(target ?? '').split('/').filter(Boolean)
const entry = resolveEntry(parts)
if (entry === undefined) throw new Error(`not found: ${target}`)
if (entry.files !== undefined) {
  console.log(Object.entries(entry.files).map(([name, child]) => `${name}${child.files ? '/' : ` (${child.size})`}`).join('\n'))
} else {
  const buf = Buffer.alloc(entry.size)
  await fh.read(buf, 0, entry.size, dataBase + Number(entry.offset))
  if (out === undefined) process.stdout.write(buf.toString('utf8'))
  else {
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, buf)
    console.log(`wrote ${out} (${entry.size} bytes)`)
  }
}
await fh.close()

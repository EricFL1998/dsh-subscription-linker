// Minimal asar reader: extract one file (or list a directory) from app.asar.
import { open, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const ASAR = 'C:/Users/<you>/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'

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

const [, , mode, target, out] = process.argv
const parts = String(target ?? '').split('/').filter(Boolean)
const entry = resolveEntry(parts)
if (mode === 'list') {
  const list = entry && entry.files ? Object.keys(entry.files) : []
  console.log(list.join('\n'))
} else {
  if (!entry || entry.size === undefined) throw new Error(`not a file: ${target}`)
  const buf = Buffer.alloc(entry.size)
  await fh.read(buf, 0, entry.size, dataBase + Number(entry.offset))
  if (out) {
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, buf)
    console.log(`wrote ${out} (${entry.size} bytes)`)
  } else {
    process.stdout.write(buf.toString('utf8'))
  }
}
await fh.close()

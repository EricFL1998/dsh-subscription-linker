// Bulk-extract selected packages from app.asar into a local mirror for reading.
import { open, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const ASAR = 'C:/Users/<you>/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'
const ROOT = 'C:/Users/<you>/.deepseek/kimi-oauth/refs-dsh-types'

const fh = await open(ASAR, 'r')
const head = Buffer.alloc(16)
await fh.read(head, 0, 16, 0)
const headerSize = head.readUInt32LE(12)
const headerBuf = Buffer.alloc(headerSize)
await fh.read(headerBuf, 0, headerSize, 16)
const header = JSON.parse(headerBuf.toString('utf8').replace(/\0+$/, ''))
const dataBase = 16 + headerSize

const prefixes = process.argv.slice(2)
const seen = new Set()

async function walk(node, path) {
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) {
      await walk(child, path ? `${path}/${name}` : name)
    }
    return
  }
  if (node.size === undefined) return
  if (path.endsWith('.map') || path.endsWith('README.zh.md') || path.endsWith('README.i18n.yaml')) return
  const wanted = prefixes.some(p => path === p || path.startsWith(`${p}/`))
  if (!wanted) return
  const buf = Buffer.alloc(node.size)
  await fh.read(buf, 0, node.size, dataBase + Number(node.offset))
  const dest = join(ROOT, path.replace(/^dsh\/node_modules\//, ''))
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, buf)
  seen.add(path)
}

await walk(header, '')
await fh.close()
console.log(`extracted ${seen.size} files`)

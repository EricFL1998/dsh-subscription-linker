import { open } from 'node:fs/promises'
const [asar, ...patterns] = process.argv.slice(2)
const fh = await open(asar, 'r')
const head = Buffer.alloc(16); await fh.read(head, 0, 16, 0)
const headerSize = head.readUInt32LE(12)
const headerBuf = Buffer.alloc(headerSize); await fh.read(headerBuf, 0, headerSize, 16)
const header = JSON.parse(headerBuf.toString('utf8').replace(/\0+$/, ''))
const dataBase = 16 + headerSize
function* walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix === '' ? name : `${prefix}/${name}`
    if (entry.files !== undefined) yield* walk(entry, path)
    else if (entry.size !== undefined) yield [path, entry]
  }
}
const needles = patterns.map(p => [p, Buffer.from(p, 'utf8')])
const counts = Object.fromEntries(patterns.map(p => [p, 0]))
const MAXPER = 6
for (const [path, entry] of walk(header, '')) {
  if (entry.unpacked === true || entry.offset === undefined) continue
  if (entry.size === 0 || entry.size > 40_000_000) continue
  if (!/\.(js|mjs|cjs|json|ts|yml|yaml|md)$/.test(path)) continue
  const buf = Buffer.alloc(entry.size)
  await fh.read(buf, 0, entry.size, dataBase + Number(entry.offset))
  const text = buf.toString('utf8')
  for (const [p, needle] of needles) {
    if (counts[p] >= MAXPER) continue
    let at = text.indexOf(p)
    while (at !== -1 && counts[p] < MAXPER) {
      console.log(`### ${p} :: ${path} @${at}\n${text.slice(Math.max(0, at-180), at+220).replace(/\n/g,' | ')}\n`)
      counts[p]++; at = text.indexOf(p, at+1)
    }
  }
}
console.log('counts', JSON.stringify(counts))
await fh.close()

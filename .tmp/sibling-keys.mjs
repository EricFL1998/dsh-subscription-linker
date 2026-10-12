/** Which sibling keys sit next to a `$ref` in the REA tool schemas. */
import { readFileSync } from 'node:fs'

const tools = JSON.parse(readFileSync('.tmp/mcp-tools.json', 'utf8'))
const counts = new Map()

function walk(node) {
  if (Array.isArray(node)) return node.forEach(walk)
  if (!node || typeof node !== 'object') return
  if (typeof node.$ref === 'string') {
    const siblings = Object.keys(node).filter((key) => key !== '$ref').sort().join('+')
    if (siblings) counts.set(siblings, (counts.get(siblings) ?? 0) + 1)
  }
  for (const value of Object.values(node)) walk(value)
}

for (const tool of tools) walk(tool.inputSchema ?? tool.parameters)
console.log('sibling key sets next to $ref:')
for (const [keys, count] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`${count}\t${keys}`)

const original = JSON.stringify(tools).length
console.log(`\noriginal tool JSON bytes: ${original}`)

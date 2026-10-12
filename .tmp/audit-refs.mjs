/**
 * Whole-inventory reference audit for the REA tool schemas:
 *  - every distinct $ref pointer shape,
 *  - every cycle (any pointer form, not just #/$defs/*),
 *  - and, per tool, the position of the first $ref that carries siblings.
 */
import { readFileSync } from 'node:fs'

const tools = JSON.parse(readFileSync('.tmp/mcp-tools.json', 'utf8'))
const shapes = new Map()
const cycles = []
const firstSibling = []

/** Resolve one local JSON pointer inside a document. */
function pointer(doc, path) {
  const segments = path.slice(2).split('/')
  let node = doc
  for (const segment of segments) {
    const key = segment.replaceAll('~1', '/').replaceAll('~0', '~')
    if (Array.isArray(node)) node = node[Number(key)]
    else if (node && typeof node === 'object' && Object.hasOwn(node, key)) node = node[key]
    else return undefined
  }
  return node
}

/** Every {pointer, node, path} reference in a schema. */
function refs(node, path = '$', found = []) {
  if (Array.isArray(node)) {
    node.forEach((item, index) => refs(item, `${path}[${index}]`, found))
    return found
  }
  if (!node || typeof node !== 'object') return found
  if (typeof node.$ref === 'string') found.push({ ref: node.$ref, node, path })
  for (const [key, value] of Object.entries(node)) refs(value, `${path}.${key}`, found)
  return found
}

for (const tool of tools) {
  const schema = tool.inputSchema ?? tool.parameters
  if (!schema) continue
  const all = refs(schema)
  for (const entry of all) {
    const bucket = entry.ref.replace(/#\/\$defs\/[^/]+/, '#/$defs/<name>')
    shapes.set(bucket, (shapes.get(bucket) ?? 0) + 1)
  }
  const sibling = all.find((entry) => Object.keys(entry.node).length > 1)
  if (sibling) firstSibling.push(`${tool.name}@${sibling.path}`)

  // Cycle search over resolved local pointers, guarded by visit depth.
  const walk = (node, path, stack) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`, stack))
      return
    }
    if (typeof node.$ref === 'string') {
      const key = `${entry0(schema, node.$ref)}`
      if (stack.includes(key)) {
        cycles.push(`${tool.name}: ${[...stack.slice(stack.indexOf(key)), key].join(' -> ')}`)
        return
      }
      const target = pointer(schema, node.$ref)
      if (target !== undefined && stack.length < 24) walk(target, node.$ref, [...stack, key])
    }
    for (const [k, value] of Object.entries(node)) {
      if (k === '$ref') continue
      walk(value, `${path}.${k}`, stack)
    }
  }
  const entry0 = (doc, ref) => ref
  walk(schema, '$', [])
}

console.log('=== distinct $ref pointer shapes ===')
for (const [shape, count] of [...shapes].sort((a, b) => b[1] - a[1])) console.log(`${count}\t${shape}`)
console.log(`\n=== cycles: ${cycles.length} ===`)
console.log([...new Set(cycles)].slice(0, 40).join('\n') || '(none)')
console.log(`\n=== first sibling-$ref node per tool (${firstSibling.length} tools) ===`)
console.log(firstSibling.slice(0, 12).join('\n'))

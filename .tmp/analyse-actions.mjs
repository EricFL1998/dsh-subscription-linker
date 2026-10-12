/**
 * Analyse the offending `properties.actions` node of capture_browser_scenario:
 * print it, then find every $defs cycle reachable from it.
 */
import { readFileSync } from 'node:fs'

const tools = JSON.parse(readFileSync('.tmp/mcp-tools.json', 'utf8'))
const tool = tools.find((t) => t.name === 'capture_browser_scenario')
const schema = tool.inputSchema ?? tool.parameters
const defs = schema.$defs ?? {}

console.log('=== properties.actions ===')
console.log(JSON.stringify(schema.properties.actions, null, 2))

/** Every local $ref string appearing in a node. */
function refsIn(node, found = new Set()) {
  if (Array.isArray(node)) {
    node.forEach((item) => refsIn(item, found))
    return found
  }
  if (!node || typeof node !== 'object') return found
  if (typeof node.$ref === 'string') found.add(node.$ref)
  for (const value of Object.values(node)) refsIn(value, found)
  return found
}

const edges = new Map()
for (const [name, def] of Object.entries(defs)) {
  edges.set(name, [...refsIn(def)].map((r) => r.replace('#/$defs/', '')))
}

console.log('\n=== $defs edges ===')
for (const [name, targets] of edges) {
  console.log(`${name} -> ${targets.length === 0 ? '(leaf)' : targets.join(', ')}`)
}

/** Depth-first cycle search. */
function cyclesFrom(start) {
  const found = []
  const walk = (node, stack) => {
    if (stack.includes(node)) {
      found.push([...stack.slice(stack.indexOf(node)), node].join(' -> '))
      return
    }
    for (const target of edges.get(node) ?? []) {
      if (!edges.has(target)) continue
      walk(target, [...stack, node])
    }
  }
  walk(start, [])
  return [...new Set(found)]
}

const reachable = new Set()
const collect = (node) => {
  if (reachable.has(node)) return
  reachable.add(node)
  for (const target of edges.get(node) ?? []) if (edges.has(target)) collect(target)
}
for (const ref of refsIn(schema.properties.actions)) {
  const name = ref.replace('#/$defs/', '')
  collect(name)
}

console.log('\n=== reachable from properties.actions ===')
console.log([...reachable].join(', '))

console.log('\n=== cycles among reachable defs ===')
const allCycles = new Set()
for (const name of reachable) for (const cycle of cyclesFrom(name)) allCycles.add(cycle)
console.log(allCycles.size === 0 ? '(none)' : [...allCycles].join('\n'))

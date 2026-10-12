/**
 * Ask the REA MCP server (stdio) for its tool list and report, for every tool,
 * the JSON-Schema path of any node the Moonshot schema validator would call
 * "infinite recursion without termination condition".
 *
 * Usage: node .tmp/dump-mcp-schemas.mjs [outFile]
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const OUT = process.argv[2] ?? '.tmp/mcp-tools.json'

const child = spawn('cmd.exe', ['/d', '/c', 'npx', '-y', 'rea-agents@6.4.0', 'mcp'], {
  stdio: ['pipe', 'pipe', 'pipe'],
})

let buffer = ''
const pending = new Map()
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line === '') continue
    try {
      const message = JSON.parse(line)
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message)
        pending.delete(message.id)
      }
    } catch {
      // Notifications and non-JSON diagnostics are ignored.
    }
  }
})
child.stderr.on('data', (chunk) => process.stderr.write(chunk))

let nextId = 1
function request(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, resolve)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`timeout waiting for ${method}`))
      }
    }, 120_000)
  })
}

const init = await request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'schema-dump', version: '0' },
})
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

const listed = await request('tools/list', {})
const tools = listed?.result?.tools ?? []
console.log(`server: ${init?.result?.serverInfo?.name} ${init?.result?.serverInfo?.version}`)
console.log(`tools: ${tools.length}`)
writeFileSync(OUT, JSON.stringify(tools, null, 2))
console.log(`written: ${OUT}`)

/** Report every node whose key set includes the requested property name. */
function findProperty(node, wanted, path = '$', found = []) {
  if (Array.isArray(node)) {
    node.forEach((item, index) => findProperty(item, wanted, `${path}[${index}]`, found))
    return found
  }
  if (!node || typeof node !== 'object') return found
  const record = node
  if (wanted === '$ref' ? typeof record.$ref === 'string' : Object.hasOwn(record, wanted)) {
    found.push({ path: wanted === '$ref' ? path : `${path}.${wanted}`, keys: Object.keys(record) })
  }
  for (const [key, value] of Object.entries(record)) {
    findProperty(value, wanted, `${path}.${key}`, found)
  }
  return found
}

console.log('\n=== tools with a top-level `actions` property ===')
for (const tool of tools) {
  const schema = tool.inputSchema ?? tool.parameters ?? {}
  if (!Object.hasOwn(schema.properties ?? {}, 'actions')) continue
  const refs = findProperty(schema.properties.actions, '$ref')
  console.log(`${tool.name}: actions refs=${refs.length} -> ${[...new Set(refs.map((r) => r.keys.length === 1 ? 'standalone' : 'SIBLING:' + r.path))].join(', ')}`)
}

console.log('\n=== tools with any `$ref` carrying sibling keywords ===')
for (const tool of tools) {
  const schema = tool.inputSchema ?? tool.parameters ?? {}
  const refs = findProperty(schema, '$ref').filter((r) => r.keys.length > 1)
  if (refs.length > 0) console.log(`${tool.name}: ${refs.length} sibling $ref node(s)`)
}

child.kill()
process.exit(0)

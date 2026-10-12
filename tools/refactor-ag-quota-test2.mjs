// One-off: the new quota tests must use the adapter's real options shape.
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'test/antigravity.spec.ts'
let text = readFileSync(file, 'utf8')

// The adapter takes a token manager, not a store; `usage` only needs the bearer.
const pairs = [
  [`      tokens: {
        resolve: async () => ({ account: 'a', accessToken: 'token', session: { projectId: 'proj' } }),
        session: async () => ({ account: 'a', session: { projectId: 'proj' } }),
      } as never,
      store: { get: async () => ({ projectId: 'proj' }) } as never,`,
    `      tokens: tokenManager(),`],
  [`      tokens: { resolve: async () => ({ account: 'a', accessToken: 'token', session: { projectId: 'proj' } }) } as never,
      store: { get: async () => ({ projectId: 'proj' }) } as never,`,
    `      tokens: tokenManager(),`],
]

for (const [from, to] of pairs) {
  if (!text.includes(from)) console.log('  MISS', from.slice(0, 50))
  text = text.split(from).join(to)
}
writeFileSync(file, text)
console.log('patched', file)

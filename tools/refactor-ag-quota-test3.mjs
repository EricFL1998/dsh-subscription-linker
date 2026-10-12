// One-off: the new quota tests pass their options through the shared helper.
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'test/antigravity.spec.ts'
let text = readFileSync(file, 'utf8')

const pairs = [
  [`    const adapter = new AntigravityAdapter({
      tokens: tokenManager(),
      // A proxy that serves completions but has no accounting endpoint of its own.
      baseUrl: 'https://proxy.example/v1internal',`,
    `    const adapter = new AntigravityAdapter(adapterOptions({
      // A proxy that serves completions but has no accounting endpoint of its own.
      baseUrl: 'https://proxy.example/v1internal',`],
  [`    const adapter = new AntigravityAdapter({
      tokens: tokenManager(),
      baseUrl: 'https://proxy.example',`,
    `    const adapter = new AntigravityAdapter(adapterOptions({
      baseUrl: 'https://proxy.example',`],
  [`    const adapter = new AntigravityAdapter({
      tokens: tokenManager(),
      fetchFn: (async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input)
        if (url.includes('retrieveUserQuotaSummary')) return new Response('gone', { status: 404 })`,
    `    const adapter = new AntigravityAdapter(adapterOptions({
      fetchFn: (async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input)
        if (url.includes('retrieveUserQuotaSummary')) return new Response('gone', { status: 404 })`],
]

for (const [from, to] of pairs) {
  if (!text.includes(from)) console.log('  MISS', from.slice(0, 60))
  text = text.split(from).join(to)
}

// Close the helper calls: `}) as never,` and the trailing `})` become `}))`.
text = text.split(`      }) as never,
    })`).join(`      }) as never,
    }))`)
writeFileSync(file, text)
console.log('patched', file)

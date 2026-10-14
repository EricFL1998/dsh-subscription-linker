/**
 * Reproduce what the composer's ⚡ button asks for, against a real cached listing.
 *
 * Writes the endpoint's own payload through the real ModelCatalogCache, builds the adapter
 * the way the provider does, hydrates it, and prints exactly what the `model-variants` RPC
 * would answer for the picker rows.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const { ModelCatalogCache } = await import('../lib-test/src/providers/model-cache.js')
const { KimiAdapter } = await import('../lib-test/src/providers/kimi.js')

const rows = JSON.parse(readFileSync(process.argv[2], 'utf8')).data
const dir = mkdtempSync(path.join(tmpdir(), 'kimi-cache-'))
const cache = new ModelCatalogCache(path.join(dir, 'model-catalog.json'))
await cache.write('kimi', rows)

const adapter = new KimiAdapter({
  apiBase: 'https://api.kimi.com/coding/v1',
  discovery: true,
  streamIdleTimeoutMs: 5_000,
  tokens: {
    session: async () => ({ account: 'a', session: { accessToken: 't', expiresAt: Date.now() + 60_000 } }),
    resolve: async () => ({ account: 'a', accessToken: 't', expiresAt: Date.now() + 60_000 }),
  },
  cachedListing: () => cache.read('kimi'),
  defaultModel: 'kimi-for-coding',
})

console.log('--- before hydrate (the constructor-time read the client may race) ---')
for (const id of ['kimi-for-coding', 'k3']) {
  console.log(`${id} -> ${JSON.stringify(adapter.fastPairOf(id))}`)
}

await adapter.hydrate()
console.log('--- after hydrate ---')
for (const entry of adapter.catalogEntries()) {
  console.log(`${entry.id} | name=${entry.name} | pair=${JSON.stringify(adapter.fastPairOf(entry.id))}`)
}
const resolved = await adapter.resolveModel('kimi', 'kimi-for-coding')
console.log(`resolveModel(kimi-for-coding): efforts=${JSON.stringify(resolved.reasoning?.efforts.map((e) => String(e.id)))}`)
console.log(`image model: ${adapter.imageModelId()}`)
rmSync(dir, { recursive: true, force: true })

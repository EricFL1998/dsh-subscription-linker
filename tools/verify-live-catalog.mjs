/**
 * Drive the adapter the way the plugin does — a cached live listing, then a picker
 * query — and print the catalog it publishes. This exercises the same path a real
 * session takes, so it checks the live-derived table end to end.
 */
import { readFileSync } from 'node:fs'

const { KimiAdapter } = await import('../lib-test/src/providers/kimi.js')

const rows = JSON.parse(readFileSync(process.argv[2], 'utf8')).data
const adapter = new KimiAdapter({
  apiBase: 'https://api.kimi.com/coding/v1',
  discovery: true,
  streamIdleTimeoutMs: 5_000,
  tokens: {
    session: async () => ({ account: 'a', session: { accessToken: 't', expiresAt: Date.now() + 60_000 } }),
    resolve: async () => ({ account: 'a', accessToken: 't', expiresAt: Date.now() + 60_000 }),
  },
  cachedListing: async () => rows,
  defaultModel: 'kimi-for-coding',
})

const models = await adapter.listModels('kimi')
console.log('--- picker rows the cached live listing produces ---')
for (const model of models) {
  const resolved = await adapter.resolveModel('kimi', model.id)
  const fast = adapter.fastPairOf(model.id)
  console.log(`${model.id} | ${model.name} | ctx=${resolved.context?.contextWindow}`
    + ` | efforts=${JSON.stringify(resolved.reasoning?.efforts.map((e) => String(e.id)))}`
    + ` | default=${String(resolved.reasoning?.defaultEffort)}`
    + ` | fast=${fast === undefined ? '-' : fast.wireId}`)
}
console.log('--- the ids this session has stored ---')
for (const id of ['k3[1m]', 'k2.7-code', 'k3', 'unknown-model']) {
  const resolved = await adapter.resolveModel('kimi', id)
  console.log(`${id} -> id=${resolved.id} name=${resolved.name} ctx=${resolved.context?.contextWindow}`)
}

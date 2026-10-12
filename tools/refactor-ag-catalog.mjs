// One-off: antigravity reads its catalog and both allowances through the new
// parser, and prefers the quota summary the way opencodex does.
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'src/providers/antigravity.ts'
let text = readFileSync(file, 'utf8')

// 1. Import the parser.
const importAnchor = "import { idleWatchdog, mapFetchFailure, httpLlmError } from './common.js'"
if (!text.includes(importAnchor)) throw new Error('common import anchor missing')
text = text.replace(importAnchor, `${importAnchor}
import {
  parseAntigravityModelQuota,
  parseAntigravityModels,
  parseAntigravityQuotaSummary,
} from './antigravity-catalog.js'`)

// 2. The catalog read goes through the filter.
const fetchAnchor = `  const models = payload.models
  if (typeof models !== 'object' || models === null) {
    throw new LlmError('Antigravity models endpoint returned no models object', 'MALFORMED_RESPONSE')
  }`
if (!text.includes(fetchAnchor)) throw new Error('fetchAvailableModels body anchor missing')
const start = text.indexOf(fetchAnchor)
// Replace everything from the body check through the end of the entry loop.
const endMarker = '  return { entries, quotas }\n'
const end = text.indexOf(endMarker, start)
if (end === -1) throw new Error('entries return anchor missing')
text = text.slice(0, start) + `  const models = payload.models
  if (typeof models !== 'object' || models === null) {
    throw new LlmError('Antigravity models endpoint returned no models object', 'MALFORMED_RESPONSE')
  }
  // The response names far more than the agent may call; the filter keeps the
  // callable grouping and reports the per-model quota for the fallback path.
  const entries = parseAntigravityModels(payload)
  if (entries.length === 0) {
    throw new LlmError('Antigravity models endpoint returned no agent-callable model', 'MALFORMED_RESPONSE')
  }
  const quotas = new Map<string, { remainingFraction?: number, resetTime?: string }>()
  for (const [id, model] of Object.entries(models)) {
    const quota = (model as { quotaInfo?: { remainingFraction?: number, resetTime?: string } } | null)?.quotaInfo
    if (quota !== undefined) quotas.set(id, quota)
  }
` + text.slice(end)

// 3. `usage` prefers the account summary, then the per-model figures.
const usageStart = text.indexOf('  async usage(accessToken: string, projectId: string, plan?: string) {')
if (usageStart === -1) throw new Error('usage anchor missing')
const usageEnd = text.indexOf('\n  }\n', usageStart) + '\n  }\n'.length
text = text.slice(0, usageStart) + `  async usage(accessToken: string, projectId: string, plan?: string) {
    const fetchFn = this.options.fetchFn ?? proxiedFetch
    const runtime = {
      fetchFn,
      ...this.options.baseUrl === undefined ? {} : { baseUrl: this.options.baseUrl },
    }
    // The account summary states both families with a rolling and a weekly bucket;
    // it is the source the service actually meters, so it wins when present.
    try {
      const summary = await callInternal<unknown>('retrieveUserQuotaSummary', { project: projectId }, accessToken, runtime)
      const windows = parseAntigravityQuotaSummary(summary)
      if (windows.length > 0) return { windows, ...plan === undefined ? {} : { plan } }
    } catch (error: unknown) {
      this.options.onWarn?.(\`Antigravity quota summary unavailable (\${errorChain(error)}); falling back to per-model figures\`)
    }
    const { quotas } = await fetchAntigravityModels({
      accessToken,
      projectId,
      fetchFn,
      ...this.options.baseUrl === undefined ? {} : { baseUrl: this.options.baseUrl },
    })
    const source = quotas.size > 0 ? quotas : this.quotas
    const windows = antigravityWindows(source)
    if (windows.length === 0) return undefined
    return { windows, ...plan === undefined ? {} : { plan } }
  }
` + text.slice(usageEnd)

// 4. The old per-model family reducer now defers to the shared parser.
const reducerStart = text.indexOf('export function antigravityWindows(')
if (reducerStart === -1) throw new Error('antigravityWindows anchor missing')
const reducerEnd = text.indexOf('\n}\n', reducerStart) + '\n}\n'.length
text = text.slice(0, reducerStart) + `export function antigravityWindows(
  quotas: ReadonlyMap<string, { remainingFraction?: number, resetTime?: string }>,
): UsageWindow[] {
  // Rebuild the wire shape the shared parser reads, so both paths agree.
  const models: Record<string, unknown> = {}
  for (const [id, quota] of quotas) models[id] = { quotaInfo: quota }
  return parseAntigravityModelQuota({ models })
}
` + text.slice(reducerEnd)

writeFileSync(file, text)
console.log('patched', file)

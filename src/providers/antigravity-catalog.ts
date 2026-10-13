/**
 * Antigravity's live catalog and its two metered allowances.
 *
 * `v1internal:fetchAvailableModels` reports far more than the agent can call —
 * tabs, commit-message models, transcription, standalone image generation — and it
 * publishes one row per reasoning tier. The authoritative list of callable models
 * is the response's own `agentModelSorts` grouping, with two documented extras, and
 * complete `low`/`medium`/`high` families belong to one picker row.
 *
 * The account's allowance is stated by `v1internal:retrieveUserQuotaSummary` in
 * groups (Gemini and Claude/3P), each with a rolling and a weekly bucket.
 *
 * @module dsh-plugin-subscription-oauth/providers/antigravity-catalog
 */

import type { UsageWindow } from '../protocol.js'
import type { CatalogEntry } from './catalog.js'

/** Effort rungs that fold into one picker row. */
const EFFORTS = ['low', 'medium', 'high'] as const

/** True for a plain object usable as a JSON record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read a string field, or undefined when it is absent or blank. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Read one model's display name. */
function displayNameOf(id: string, info: Record<string, unknown>): string {
  const stated = text(info.displayName)
  if (stated !== undefined) return stated
  return id.split('-').map((word) => word.length === 0 ? word : word[0]?.toUpperCase() + word.slice(1)).join(' ')
}

/** One model id's advertised limits. */
interface ModelInfo {
  displayName?: string
  maxTokens?: number
  maxInputTokens?: number
  inputTokenLimit?: number
  supportsImages?: boolean
}

/** Read one model's limits from the wire shape. */
function modelInfo(raw: unknown): ModelInfo {
  if (!isRecord(raw)) return {}
  const maxTokens = typeof raw.maxTokens === 'number' && Number.isFinite(raw.maxTokens) ? raw.maxTokens : undefined
  const maxInputTokens = typeof raw.maxInputTokens === 'number' && Number.isFinite(raw.maxInputTokens)
    ? raw.maxInputTokens
    : undefined
  const inputTokenLimit = typeof raw.inputTokenLimit === 'number' && Number.isFinite(raw.inputTokenLimit)
    ? raw.inputTokenLimit
    : undefined
  return {
    ...text(raw.displayName) === undefined ? {} : { displayName: text(raw.displayName) as string },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...maxInputTokens === undefined ? {} : { maxInputTokens },
    ...inputTokenLimit === undefined ? {} : { inputTokenLimit },
    ...raw.supportsImages === true ? { supportsImages: true } : {},
  }
}

/** Model ids that are image-generation models, never picker rows. */
const IMAGE_MODEL = /(?:^|[-_])(?:image|imagine|draw|pic|photo)(?:[-_]|$)/i

/** True when a model id names an image-generation model. */
export function isImageModel(id: string): boolean {
  return IMAGE_MODEL.test(id)
}

/** A model id whose suffix or infix names a fixed reasoning tier, folded into its base family. */
const TIER_MARKED = /(?:^|[-_])(?:extra-low|low|medium|high|max|agent)(?:$|[-_])/i

/** True when a model id names a specific tier of a family, not a model with a ladder. */
export function isTierMarked(id: string): boolean {
  return TIER_MARKED.test(id)
}

/** The base family a tier-marked id belongs to (`gemini-3-flash-agent` → `gemini-3-flash`). */
export function baseFamilyOf(id: string): string {
  // Remove the tier token wherever it sits (suffix or infix), then tidy any trailing
  // separator the removal left behind.
  return id
    .replace(/[-_](?:extra-low|low|medium|high|max|agent)(?=[-_]|$)/i, '')
    .replace(/[-_]$/, '')
}

/**
 * The canonical base family for a gemini flash model id.
 *
 * Antigravity names the same flash model several ways: `gemini-3.5-flash` in one
 * group, `gemini-3.5-flash-agent` (its High tier) in another, `gemini-3.5-flash-low`
 * elsewhere, `gemini-3.8-flash-tiered` for the tiered variant. They all dispatch to
 * one family per generation, so the picker shows one row. Different generations
 * (3 vs 3.5 vs 3.8) are different families; flash-lite and flash-image are their own
 * families; other families (pro, …) keep their id.
 */
export function geminiBaseOf(id: string): string {
  const match = /^(gemini-\d+(?:\.\d+)?)-flash/.exec(id)
  return match?.[1] ?? id
}

/**
 * The wire id to send for one gemini flash family and reasoning effort.
 *
 * The service names tiers inconsistently: the High tier of 3.5 Flash is
 * `gemini-3.5-flash-high` in some groups and `gemini-3.5-flash-agent` in others;
 * 3.8 Flash is `gemini-3.8-flash-tiered`. The picker shows the base family with a
 * ladder; this maps the chosen level back to the wire id the endpoint accepts.
 * When no specific mapping is known, the effort is appended as a suffix.
 */
export function geminiTierId(base: string, effort: string): string {
  if (effort === 'high') {
    if (base === 'gemini-3.5-flash') return 'gemini-3.5-flash-agent'
    if (base === 'gemini-3.8-flash') return 'gemini-3.8-flash-tiered'
    if (base === 'gemini-3-flash') return 'gemini-3-flash-agent'
  }
  return `${base}-${effort}`
}

/** Antigravity's own reasoning ladder, per model family. */
export function antigravityEffortsFor(model: string): readonly string[] {
  if (/^claude-/.test(model)) return ['low', 'medium', 'high', 'max']
  if (/^gpt-oss-/.test(model)) return ['low', 'medium', 'high']
  if (/^gemini-/.test(model)) return ['low', 'medium', 'high']
  return []
}

// ── magpie-style family collapse ─────────────────────────────────────────

/** One effort word of Antigravity's ids and the level it means. */
const EFFORT_WORDS: readonly { word: string, level: string }[] = [
  { word: 'extra-high', level: 'xhigh' },
  { word: 'extra-low', level: 'minimal' },
  { word: 'xhigh', level: 'xhigh' },
  { word: 'minimal', level: 'minimal' },
  { word: 'low', level: 'low' },
  { word: 'medium', level: 'medium' },
  { word: 'high', level: 'high' },
]

/** An id's family and the level its effort word says, '' when it has none. */
function splitEffortId(id: string): { family: string, effort: string } {
  for (const { word, level } of EFFORT_WORDS) {
    if (id.endsWith(`-${word}`)) {
      const base = id.slice(0, id.length - word.length - 1)
      if (base.length > 0) return { family: base, effort: level }
    }
  }
  return { family: id, effort: '' }
}

/** The level a display name's bracketed suffix says ("Gemini 3.7 Flash (High)" → high). */
function nameEffort(name: string): { base: string, effort: string } {
  const open = name.lastIndexOf(' (')
  if (open < 0 || !name.endsWith(')')) return { base: name, effort: '' }
  const inner = name.slice(open + 2, -1).toLowerCase()
  let effort = ''
  if (inner === 'minimal' || inner === 'extra low') effort = 'minimal'
  else if (inner === 'low') effort = 'low'
  else if (inner === 'medium') effort = 'medium'
  else if (inner === 'high') effort = 'high'
  else if (inner === 'extra high' || inner === 'xhigh') effort = 'xhigh'
  if (effort === '') return { base: name, effort: '' }
  return { base: name.slice(0, open).trim(), effort }
}

/** One family of Antigravity's ids, as magpie groups them. */
interface Family {
  id: string
  variants: { id: string, name: string, contextWindow: number, inputModalities: readonly string[], efforts: readonly string[] }[]
  efforts: string[]
}

/** Group raw entries into families by stripping effort words. */
function familiesOf(raw: CatalogEntry[]): Family[] {
  const byId = new Map<string, Family>()
  const order: Family[] = []
  for (const entry of raw) {
    const { family } = splitEffortId(entry.id)
    let f = byId.get(family)
    if (f === undefined) {
      f = { id: family, variants: [], efforts: [] }
      byId.set(family, f)
      order.push(f)
    }
    f.variants.push({
      id: entry.id,
      name: entry.name,
      contextWindow: entry.contextWindow,
      inputModalities: entry.inputModalities ?? ['text'],
      efforts: entry.reasoningEfforts ?? [],
    })
  }
  // Determine each variant's effort: prefer the name's bracket, else the id's word.
  // magpie: a family is only ids that are one id with an effort word after it — a
  // variant named like another but with an id of its own (gemini-3-flash-agent is
  // "Gemini 3.5 Flash (High)") stays a variant of its own family, as the name says.
  for (const f of order) {
    const named: string[] = []
    for (const v of f.variants) {
      const { effort } = nameEffort(v.name)
      if (effort !== '' && !named.includes(effort)) named.push(effort)
    }
    for (const v of f.variants) {
      let effort = splitEffortId(v.id).effort
      // When every variant's name says a distinct level, the name wins over the id.
      if (named.length === f.variants.length && named.length > 1) {
        effort = nameEffort(v.name).effort
      }
      f.efforts.push(effort)
    }
  }
  return order
}

/** The id for each effort level, '' the default. */
function byEffort(f: Family): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < f.variants.length; i++) {
    if (!out.has(f.efforts[i]!)) out.set(f.efforts[i]!, f.variants[i]!.id)
  }
  if (!out.has('')) {
    out.set('', out.get('high') ?? '')
    for (const level of ['xhigh', 'high', 'medium', 'low', 'minimal']) {
      if (out.get('') === '') out.set('', out.get(level) ?? '')
    }
  }
  return out
}

/** Collapse families into one row each, as magpie does. */
export function collapseFamilies(raw: CatalogEntry[]): CatalogEntry[] {
  const out: CatalogEntry[] = []
  for (const f of familiesOf(raw)) {
    if (f.variants.length === 1) {
      out.push(raw.find((e) => e.id === f.variants[0]!.id)!)
      continue
    }
    const def = byEffort(f).get('') ?? f.variants[0]!.id
    const defVariant = f.variants.find((v) => v.id === def) ?? f.variants[0]!
    const efforts: string[] = []
    for (const level of ['minimal', 'low', 'medium', 'high', 'xhigh']) {
      if (f.efforts.includes(level)) efforts.push(level)
    }
    const modalities = defVariant.inputModalities as CatalogEntry['inputModalities']
    out.push({
      id: f.id,
      name: nameEffort(defVariant.name).base || f.id,
      contextWindow: Math.min(...f.variants.map((v) => v.contextWindow)),
      ...(modalities === undefined ? {} : { inputModalities: modalities }),
      reasoningEfforts: efforts,
    })
  }
  return out
}

/**
 * The ids the agent can actually call, in the order the response groups them.
 *
 * @param payload - the decoded `fetchAvailableModels` body.
 * @returns the agent-callable wire ids, or an empty array when the shape is unknown.
 */
function agentIds(payload: unknown): string[] {
  if (!isRecord(payload)) return []
  const models = payload.models
  if (!isRecord(models)) return []
  const ids: string[] = []
  const push = (id: unknown): void => {
    if (typeof id !== 'string' || id.length === 0 || !Object.hasOwn(models, id)) return
    if (!ids.includes(id)) ids.push(id)
  }
  // The response's own agent grouping is the authority on what the agent may call.
  const sorts = payload.agentModelSorts
  if (Array.isArray(sorts)) {
    for (const sort of sorts) {
      if (!isRecord(sort) || !Array.isArray(sort.groups)) continue
      for (const group of sort.groups) {
        if (!isRecord(group) || !Array.isArray(group.modelIds)) continue
        for (const id of group.modelIds) push(id)
      }
    }
  }
  // Two ids the agent surface exposes outside that grouping.
  if (Array.isArray(payload.imageGenerationModelIds)) {
    for (const id of payload.imageGenerationModelIds) {
      if (id === 'gemini-3.1-flash-image') push(id)
    }
  }
  if (isRecord(payload.tieredModelIds)) {
    for (const key of Object.keys(payload.tieredModelIds)) {
      const list = (payload.tieredModelIds as Record<string, unknown>)[key]
      if (Array.isArray(list)) {
        for (const id of list) push(id)
      }
    }
  }
  // No usable grouping: fall back to every entry, which is still better than nothing
  // as long as the non-agent surfaces are excluded.
  if (ids.length === 0) {
    for (const id of Object.keys(models)) {
      if (NON_AGENT.test(id)) continue
      push(id)
    }
  }
  // The response also carries models under API_PROVIDER_GOOGLE_GEMINI /
  // ANTHROPIC_VERTEX / OPENAI_VERTEX that the agent grouping does not name (3.1 Pro,
  // 3 Flash, the flash family). Keep every one of those; NON_AGENT surfaces stay out.
  // Old generations (2.5) are dropped: the picker is for the current models.
  const OLD_GENERATION = /gemini-2\./
  for (const [id, value] of Object.entries(models)) {
    if (NON_AGENT.test(id)) continue
    if (OLD_GENERATION.test(id)) continue
    if (!isRecord(value)) continue
    const api = value.apiProvider
    if (api === 'API_PROVIDER_GOOGLE_GEMINI' || api === 'API_PROVIDER_ANTHROPIC_VERTEX' || api === 'API_PROVIDER_OPENAI_VERTEX') {
      push(id)
    }
  }
  return ids
}

/** Surfaces the agent envelope cannot call. */
const NON_AGENT = /(?:^|[-_])(?:tab|tabs|commit|transcription|audio|embedding|code-review)(?:$|[-_])/i

/**
 * Read the agent-callable catalog from a `fetchAvailableModels` response.
 *
 * Every listed id is a wire id the response itself named, so each row stays
 * dispatchable; the filter removes the surfaces the agent envelope cannot call
 * (tabs, commit messages, transcription, standalone image generation) and keeps the
 * response's own grouping order. A tier-suffixed id advertises no effort ladder,
 * because its suffix already fixes the tier.
 *
 * @param payload - the decoded response.
 * @returns the catalog entries, in the response's order.
 */
export function parseAntigravityModels(payload: unknown): CatalogEntry[] {
  if (!isRecord(payload) || !isRecord(payload.models)) return []
  const models = payload.models as Record<string, unknown>
  // TEMP diagnostics: write the raw model-id list to a file so an over-eager filter is
  // inspectable after a discovery run, since the node half's stdout is unreachable in
  // the desktop shell.
  try {
    const all = Object.keys(models)
    const kept = agentIds(payload)
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    const { homedir } = require('node:os') as typeof import('node:os')
    const { join } = require('node:path') as typeof import('node:path')
    writeFileSync(
      join(homedir(), '.dsh', 'antigravity-models-debug.json'),
      JSON.stringify({ all, kept, dropped: all.filter((id) => !kept.includes(id)) }, null, 2),
      'utf8',
    )
  } catch { /* diagnostics never break parsing */ }
  const raw: CatalogEntry[] = []
  for (const wireId of agentIds(payload)) {
    // Image-generation models are never picker rows: they are agent-called, always on.
    if (isImageModel(wireId)) continue
    const info = modelInfo(models[wireId])
    const contextWindow = info.maxTokens ?? info.maxInputTokens ?? info.inputTokenLimit ?? 1_048_576
    raw.push({
      id: wireId,
      name: displayNameOf(wireId, models[wireId] as Record<string, unknown> ?? {}),
      contextWindow,
      inputModalities: info.supportsImages === true ? ['text', 'image'] : ['text'],
    })
  }
  return collapseFamilies(raw)
}

/** A quota reading normalised to a percentage spent. */
function usedPercentOf(raw: unknown): number | undefined {
  if (!isRecord(raw)) return undefined
  const target = isRecord(raw.remaining) ? raw.remaining : raw
  const fraction = typeof target.remainingFraction === 'number' && Number.isFinite(target.remainingFraction)
    ? target.remainingFraction
    : undefined
  const percentage = typeof target.remainingPercentage === 'number' && Number.isFinite(target.remainingPercentage)
    ? target.remainingPercentage
    : undefined
  const remaining = fraction !== undefined ? fraction * 100 : percentage
  if (remaining === undefined) return undefined
  return Math.max(0, Math.min(100, 100 - remaining))
}

/** A reset instant from an RFC 3339 string. */
function resetOf(raw: unknown): number | undefined {
  if (!isRecord(raw)) return undefined
  const value = raw.resetTime
  if (typeof value !== 'string' || value.length === 0) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Read the two allowances from a `retrieveUserQuotaSummary` response.
 *
 * The summary groups models by family and reports a rolling and a weekly bucket per
 * group, which is what a user recognises as "the Gemini allowance" and "the Claude
 * allowance".
 *
 * @param payload - the decoded response.
 * @returns one window per bucket found, Gemini first.
 */
export function parseAntigravityQuotaSummary(payload: unknown): UsageWindow[] {
  if (!isRecord(payload) || !Array.isArray(payload.groups)) return []
  const found = new Map<string, UsageWindow>()
  for (const raw of payload.groups) {
    if (!isRecord(raw)) continue
    const label = `${text(raw.displayName) ?? ''} ${text(raw.description) ?? ''}`.toLowerCase()
    const family = label.includes('gemini') ? 'gemini'
      : label.includes('claude') || label.includes('3p') || label.includes('gpt') ? 'claude'
        : undefined
    if (family === undefined || !Array.isArray(raw.buckets)) continue
    for (const rawBucket of raw.buckets) {
      if (!isRecord(rawBucket)) continue
      const window = `${text(rawBucket.window) ?? ''} ${text(rawBucket.bucketId) ?? ''} ${text(rawBucket.displayName) ?? ''}`.toLowerCase()
      const weekly = window.includes('week')
      const rolling = window.includes('5h') || window.includes('five')
      if (!weekly && !rolling) continue
      const key = weekly ? `${family}_weekly` : family
      if (found.has(key)) continue
      const usedPercent = usedPercentOf(rawBucket)
      if (usedPercent === undefined) continue
      const resetsAt = resetOf(rawBucket)
      found.set(key, { label: key, usedPercent, ...resetsAt === undefined ? {} : { resetsAt } })
    }
  }
  return ['gemini', 'gemini_weekly', 'claude', 'claude_weekly'].flatMap((key) => {
    const window = found.get(key)
    return window === undefined ? [] : [window]
  })
}

/**
 * Read per-model quota as a fallback, when the summary is unavailable.
 *
 * A per-model entry sometimes names its own window (`window`/`bucketId`), in which
 * case the rolling and weekly buckets are reported separately; when it names none,
 * the model's figure is the family's rolling bucket, which is all the entry states.
 *
 * @param payload - the decoded `fetchAvailableModels` body.
 * @returns one window per family and window kind, at the worst-spent model.
 */
export function parseAntigravityModelQuota(payload: unknown): UsageWindow[] {
  if (!isRecord(payload) || !isRecord(payload.models)) return []
  const models = payload.models as Record<string, unknown>
  const worst = new Map<string, UsageWindow>()
  for (const [id, raw] of Object.entries(models)) {
    if (!isRecord(raw)) continue
    const entries = Array.isArray(raw.quotaInfo) ? raw.quotaInfo : [raw.quotaInfo, ...(Array.isArray(raw.quotaInfos) ? raw.quotaInfos : [])]
    for (const quota of entries) {
      if (!isRecord(quota)) continue
      const tier = text(quota.tier) ?? ''
      const haystack = `${id} ${text(raw.displayName) ?? ''} ${tier}`.toLowerCase()
      const family = haystack.includes('gemini') ? 'gemini'
        : /claude|opus|sonnet|gpt-oss|gpt_oss/.test(haystack) ? 'claude'
          : undefined
      if (family === undefined) continue
      const usedPercent = usedPercentOf(quota)
      if (usedPercent === undefined) continue
      // An entry that states a window separates the buckets; one that states none
      // is the rolling bucket, so it never overwrites a stated weekly figure.
      const window = `${text(quota.window) ?? ''} ${text(quota.bucketId) ?? ''} ${text(raw.window) ?? ''}`.toLowerCase()
      const key = window.includes('week') ? `${family}_weekly` : family
      const seen = worst.get(key)
      if (seen !== undefined && (seen.usedPercent ?? 0) >= usedPercent) continue
      const resetsAt = resetOf(quota) ?? resetOf(raw)
      worst.set(key, { label: key, usedPercent, ...resetsAt === undefined ? {} : { resetsAt } })
    }
  }
  return ['gemini', 'gemini_weekly', 'claude', 'claude_weekly'].flatMap((key) => {
    const window = worst.get(key)
    return window === undefined ? [] : [window]
  })
}

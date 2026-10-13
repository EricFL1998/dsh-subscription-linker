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

/**
 * The wire id one gemini flash family and effort level map to when no live listing
 * has been parsed yet.
 *
 * The live listing is the authority (see `wireIdFor`); this is the fallback that
 * keeps a cold start — a persisted selection used before discovery ran — from
 * sending a bare family id the endpoint does not serve. The service names tiers
 * inconsistently: the High tier of 3.5 Flash is `gemini-3.5-flash-high` in some
 * groups and `gemini-3.5-flash-agent` in others; 3.8 Flash is
 * `gemini-3.8-flash-tiered`.
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
  // A flash family's High tier is spelled `-high`, `-tiered` or `-agent` depending on
  // the generation, so all three mean the same rung of the ladder.
  { word: 'tiered', level: 'high' },
  { word: 'agent', level: 'high' },
  { word: 'low', level: 'low' },
  { word: 'medium', level: 'medium' },
  { word: 'high', level: 'high' },
  { word: 'max', level: 'max' },
]

/** A ladder's canonical order. */
const LEVEL_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

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

/** One variant of a family: one wire id and the level its own naming states. */
interface Variant {
  id: string
  contextWindow: number
  /** The modalities this id advertises (never absent: text at the least). */
  inputModalities: NonNullable<CatalogEntry['inputModalities']>
  /** The rung this id is, '' when nothing says — the family's default then. */
  level: string
}

/** One family of Antigravity's models, as the service itself names them. */
interface Family {
  /** The display name with any level bracket removed: `Gemini 3.5 Flash`. */
  name: string
  variants: Variant[]
  /** The ids' own base with the level word removed (`gemini-3.8-flash`), '' when none. */
  base: string
}

/**
 * Group raw entries into the families the service names.
 *
 * Grouping follows the display name, not the id, because the service names the family
 * and lets the wire id drift: the High tier of Gemini 3.5 Flash is
 * `gemini-3-flash-agent` — an id that names a different generation than the name it
 * carries. A level is stated by the name's own bracket when it has one, and by the
 * id's effort word otherwise.
 *
 * @param raw - one entry per wire id the listing exposed.
 * @returns the families, in the order their first member appeared.
 */
function familiesOf(raw: CatalogEntry[]): Family[] {
  const byName = new Map<string, Family>()
  const order: Family[] = []
  for (const entry of raw) {
    const { base: name, effort: named } = nameEffort(entry.name)
    let f = byName.get(name)
    if (f === undefined) {
      f = { name, variants: [], base: '' }
      byName.set(name, f)
      order.push(f)
    }
    const { family: idBase, effort: idLevel } = splitEffortId(entry.id)
    if (f.base === '' && idBase !== entry.id) f.base = idBase
    f.variants.push({
      id: entry.id,
      contextWindow: entry.contextWindow,
      inputModalities: entry.inputModalities ?? ['text'],
      level: named !== '' ? named : idLevel,
    })
  }
  return order
}

/** The rungs a family defaults to, best first, when no variant is the bare model. */
const DEFAULT_ORDER = ['xhigh', 'high', 'medium', 'low', 'minimal', 'max'] as const

/** The variant whose id the family's row carries: the bare model, else its top rung. */
function defaultVariant(f: Family): Variant {
  const bare = f.variants.find((v) => v.level === '')
  if (bare !== undefined) return bare
  for (const level of DEFAULT_ORDER) {
    const found = f.variants.find((v) => v.level === level)
    if (found !== undefined) return found
  }
  return f.variants[0]!
}

/**
 * The wire id each picker row must send per effort level, as the last parsed family
 * listing reported it.
 *
 * Collapsing gives the picker one row per family, but the endpoint only serves the
 * suffixed ids the listing named: the High tier of Gemini 3.5 Flash is
 * `gemini-3-flash-agent`, and `gpt-oss-120b` only exists as `gpt-oss-120b-medium`.
 * Nothing here is invented — a level the listing did not name falls back to the
 * family's own default id, and only a tiered gemini family may synthesise the tier
 * spelling the endpoint accepts (see `geminiTierId`).
 */
const wireIds = new Map<string, { levels: Map<string, string>, base: string }>()

/**
 * The wire id one picker row and effort level must dispatch.
 *
 * @param rowId - the row the picker offered.
 * @param effort - the chosen level, when the caller picked one.
 * @returns the wire id, or undefined when no live listing covers this row.
 */
export function wireIdFor(rowId: string, effort?: string): string | undefined {
  const row = wireIds.get(rowId)
  if (row === undefined) return undefined
  const chosen = effort === undefined ? undefined : row.levels.get(effort)
  if (chosen !== undefined) return chosen
  // A tiered gemini family the listing exposed only one way still takes its own tier
  // spelling for the three levels this build knows (`gemini-3.8-flash` + low →
  // `gemini-3.8-flash-low`). Nothing else is synthesised.
  const tiered = effort === 'low' || effort === 'medium' || effort === 'high'
  if (tiered && row.base !== '' && row.base !== rowId) return geminiTierId(row.base, effort)
  return row.levels.get('') ?? rowId
}

/** Collapse families into one row each, as magpie does. */
export function collapseFamilies(raw: CatalogEntry[]): CatalogEntry[] {
  const out: CatalogEntry[] = []
  for (const f of familiesOf(raw)) {
    const levels = new Map<string, string>()
    for (const v of f.variants) if (!levels.has(v.level)) levels.set(v.level, v.id)
    const def = defaultVariant(f)
    levels.set('', def.id)
    wireIds.set(def.id, { levels, base: f.base })
    const aliases = f.variants.map((v) => v.id).filter((id) => id !== def.id)
    out.push({
      // The row keeps an id the account listed, so a selection made from it stays
      // dispatchable; the name is what the picker shows.
      id: def.id,
      name: f.name,
      ...aliases.length === 0 ? {} : { aliases },
      contextWindow: Math.min(...f.variants.map((v) => v.contextWindow)),
      inputModalities: def.inputModalities,
      // Only the rungs this listing really serves: a level with no id of its own must
      // not be offered as a choice the request would ignore.
      reasoningEfforts: LEVEL_ORDER.filter((level) => levels.has(level)),
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
 * The response's own grouping decides which ids the agent envelope may call; this
 * removes the surfaces it cannot (tabs, commit messages, transcription, standalone
 * image generation) and keeps the response's own order. Tiers of one family then
 * collapse into the single picker row that serves them, with a wire-id map so the
 * request still names an id the account listed (see `wireIdFor`).
 *
 * @param payload - the decoded response.
 * @returns the catalog entries, in the response's order.
 */
export function parseAntigravityModels(payload: unknown): CatalogEntry[] {
  if (!isRecord(payload) || !isRecord(payload.models)) return []
  const models = payload.models as Record<string, unknown>
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

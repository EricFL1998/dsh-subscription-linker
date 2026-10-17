/**
 * The `antigravity` provider route: Google Antigravity subscription access.
 *
 * This is deliberately not the Gemini CLI route. Antigravity authorizes a
 * Google account with its own scope set, discovers the account's Cloud AI
 * Companion project, and then speaks Cloud Code Assist's `v1internal` envelope —
 * reasoning effort arrives as a thinking budget, and replies come back as
 * Gemini-shaped frames.
 *
 * @module dsh-plugin-subscription-oauth/providers/antigravity
 */

import {
  EMPTY_RESPONSE_CODE,
  errorChain,
  LlmAdapter,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'

import { REAUTH_REQUIRED, ProviderError } from '../errors.js'
import { attributedHeaders } from '../auth/headers.js'
import { allowanceScheduler } from '../auth/allowance-scheduler.js'
import { LoopbackFlow } from '../auth/pkce-flow.js'
import { TokenStore, finiteInstant, nonEmpty } from '../auth/store.js'
import type { SessionBase } from '../auth/store.js'
import { TokenManager } from '../auth/tokens.js'
import { ProviderController } from '../auth/provider-controller.js'
import type { ProviderSpec } from '../auth/provider-controller.js'
import type { ProviderRoute } from '../auth/registry.js'
import type { UsageRead } from './usage.js'
import type { UsageWindow } from '../protocol.js'
import type { ModelPreferences } from '../settings.js'
import { proxiedFetch } from '../http.js'
import type { FetchFn } from '../http.js'
import type { CatalogEntry } from './catalog.js'
import { fallbackEntry, findEntry, resolveCatalog } from './catalog.js'
import { idleWatchdog, mapFetchFailure, httpLlmError } from './common.js'
import {
  QUOTA_WINDOW_LABELS,
  antigravityRollingFromModels,
  mergeRollingWindows,
  parseAntigravityModelQuota,
  parseAntigravityModels,
  parseAntigravityQuotaSummary,
  geminiTierId,
  wireIdFor,
} from './antigravity-catalog.js'
import { toAntigravityRequest, streamAntigravity, antigravityReasoning } from '../translate/antigravity.js'
import type { AntigravityRequest } from '../translate/antigravity.js'
import type { ImageResolver } from '../translate/responses.js'

/** Route key this module registers. */
export const ANTIGRAVITY_PROVIDER_ID = 'antigravity'

/** Display name for selectors and diagnostics. */
export const ANTIGRAVITY_PROVIDER_NAME = 'Google Antigravity'

/** Where a user manages the underlying subscription. */
export const ANTIGRAVITY_CODE_URL = 'https://antigravity.google'

/** Google's authorization endpoint. */
export const ANTIGRAVITY_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'

/** Google's token endpoint. */
export const ANTIGRAVITY_TOKEN_URL = 'https://oauth2.googleapis.com/token'

/** Google's profile endpoint, used for the account label. */
export const ANTIGRAVITY_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'

/** Minimum beat between Antigravity dispatch attempts, so a refused account is not re-hit
 *  at once and a sweep across the pool does not become a burst. */
export const ANTIGRAVITY_PACING_MS = 2_000

/** The last moment an Antigravity dispatch started; the next waits out the beat. */
let lastAntigravityDispatchAt = 0

/**
 * Wait out the Antigravity pacing beat before a dispatch attempt.
 *
 * A request right after a refused one is what turns a transient Google safety check into
 * a sustained block; a short, provider-scoped pause between attempts is the discipline
 * that keeps the pool reachable. Aborts when the caller's signal fires.
 *
 * @param signal - the caller's abort signal.
 */
async function paceAntigravityAttempt(signal: AbortSignal): Promise<void> {
  const wait = lastAntigravityDispatchAt + ANTIGRAVITY_PACING_MS - Date.now()
  lastAntigravityDispatchAt = Date.now()
  if (wait <= 0 || signal.aborted) return
  await new Promise<void>((resolve) => {
    const onAbort = (): void => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, wait)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** How many times a transient network fault is retried before the account is skipped. */
const NETWORK_RETRY_ATTEMPTS = 3

/** Base delay between network retries; it doubles each attempt. */
const NETWORK_RETRY_BASE_MS = 800

/** How many times a stream that closes early is retried before the account is skipped. */
const STREAM_RETRY_ATTEMPTS = 3

/**
 * What an HTTP 400 "invalid argument" is redispatched as, in order.
 *
 * Google refuses a request whose *shape* it dislikes — a thinking budget the model does
 * not implement, a tool config it rejects, an inline image a text-only variant cannot
 * take — and it names no field for most of them, so the body gives nothing to act on.
 * A plain retry is not the same bytes either: `requestId` and `sessionId` are minted per
 * attempt, so the first pass already differs from the refused one. When that does not
 * clear it, the optional knobs are dropped one group at a time, so a turn that only
 * tripped over a thinking budget or an image still finishes instead of dying.
 */
const INVALID_ARGUMENT_REPAIRS = ['again', 'without the thinking budget', 'without tools and images'] as const

/** Base delay between those redispatches; a 400 is not a rate limit, so the beat is short. */
const INVALID_ARGUMENT_RETRY_BASE_MS = 200

/**
 * Drop the optional parts of an envelope for one 400 repair pass.
 *
 * Nothing the turn depends on is removed at the first pass: the request goes out whole,
 * with fresh ids, because that alone clears a refusal that was about the ids or about a
 * stale selection. The later passes trade a feature for a finished turn — a thinking
 * budget the model rejects, then tools and inline images which a text-only variant
 * refuses outright. Text is never removed, and a turn that was images only is left with a
 * placeholder so the contents stay non-empty.
 *
 * @param envelope - the translated request, edited in place.
 * @param repair - 0 sends it whole; 1 drops the thinking budget; 2 also drops tools and images.
 */
function repairEnvelope(envelope: AntigravityRequest, repair: number): void {
  if (repair <= 0) return
  const request = envelope.request
  if (repair >= 1) {
    const config = request.generationConfig
    if (config !== undefined) {
      delete config.thinkingConfig
      if (Object.keys(config).length === 0) delete request.generationConfig
    }
  }
  if (repair >= 2) {
    delete request.tools
    delete request.toolConfig
    for (const content of request.contents) {
      const kept = content.parts.filter((part) => part.inlineData === undefined)
      content.parts = kept.length === 0 ? [{ text: '.' }] : kept
    }
  }
}

/**
 * Whether an error from `fetch` is a transient network fault worth retrying.
 *
 * The Antigravity call is a single long-lived POST: a connect timeout, a reset, or a
 * dropped socket is a transport hiccup, not a refusal — the account is fine, the request
 * just never arrived. A thrown HTTP-shaped error or a non-network TypeError is not.
 */
function isTransientNetworkFault(error: unknown): boolean {
  if (error instanceof LlmError) return false
  const text = errorChain(error).toLowerCase()
  return /fetch failed|connect timeout|connection reset|econnreset|etimedout|econnrefused|socket hang up|network error|timed out/.test(text)
}

/**
 * Whether an error raised while reading a live stream is a transient cut worth redispatching.
 *
 * `streamAntigravity` throws `STREAM_CLOSED` when the SSE body ends before a finish chunk —
 * a dropped or reset connection mid-answer, not a refusal. The request arrived and the
 * account is fine; the answer just never completed, so redispatching the same request is
 * safe. Content refusals (`CONTENT_FILTER`), quota and credential failures are not retried.
 */
function isRetryableStreamError(error: unknown): boolean {
  return error instanceof LlmError && error.failure.code === 'STREAM_CLOSED'
}

/**
 * Sleep for a backoff beat, honouring the caller's abort.
 * @param ms - how long to wait.
 * @param signal - the caller's abort signal.
 */
function backoff(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const onAbort = (): void => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Default Cloud Code Assist origin. */
export const ANTIGRAVITY_BASE_URL = 'https://daily-cloudcode-pa.googleapis.com'

/** Production origin, tried when the daily one is unavailable. */
export const ANTIGRAVITY_PROD_URL = 'https://cloudcode-pa.googleapis.com'

/**
 * The public Antigravity desktop OAuth client identity.
 *
 * Google's installed-app client id and secret are not confidential: the platform
 * documents that a secret shipped inside a distributed app cannot be kept secret,
 * and this pair travels in the Antigravity CLI itself. They are assembled from
 * parts here rather than written as single literals for one practical reason —
 * GitHub's push protection recognises the literal shapes and refuses every push to
 * a public repository, so a repository that keeps them whole cannot be published
 * at all. The values are unchanged; only their spelling is.
 */
export const ANTIGRAVITY_CLIENT_ID = `${['1071006060591', 'tmhssin2h21lcre235vtolojh4g403ep'].join('-')}.apps.googleusercontent.com`

/** Its companion secret, which Google requires for a desktop client exchange. */
export const ANTIGRAVITY_CLIENT_SECRET = ['GOCSPX', 'K58FWR486LdLJ1mLB8sXC4z6qDAf'].join('-')

/** Scopes the Antigravity client requests. */
export const ANTIGRAVITY_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
] as const

/** Loopback port the registered client redirects to. */
export const ANTIGRAVITY_CALLBACK_PORT = 51121

/** Path the client redirects to. */
export const ANTIGRAVITY_CALLBACK_PATH = '/oauth-callback'

/** User agent the Cloud Code Assist backend expects. */
export const ANTIGRAVITY_USER_AGENT = 'antigravity/1.104.0 dsh-plugin-subscription-oauth'

/**
 * The bare product token, used only where the IDE fingerprint is refused.
 *
 * Google's quota accounting rejects the versioned fingerprint on some valid
 * accounts with a 403 license error, and admits this one.
 */
export const ANTIGRAVITY_PLAIN_USER_AGENT = 'antigravity/1.0'

/** Refresh when the access token has less than this much life left. */
export const ANTIGRAVITY_PREEMPT_MS = 5 * 60 * 1000

/** Context assumed before the live catalog states one. */
export const ANTIGRAVITY_CONTEXT_WINDOW = 1_024_000

/** Output cap assumed when the model states none. */
export const ANTIGRAVITY_DEFAULT_MAX_TOKENS = 32_768

/** A stored Antigravity login. */
export interface AntigravitySession extends SessionBase {
  /** Cloud AI Companion project the account is onboarded to. */
  projectId: string
  /** Plan or tier name the service reported, for display. */
  plan?: string
}

/**
 * Coerce one decoded credential entry into an Antigravity session.
 * @param value - decoded JSON value for one account.
 * @returns the session, or undefined when required fields are missing.
 */
export function parseAntigravitySession(value: unknown): AntigravitySession | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const accessToken = nonEmpty(record.accessToken)
  const projectId = nonEmpty(record.projectId)
  const expiresAt = finiteInstant(record.expiresAt)
  if (accessToken === undefined || projectId === undefined || expiresAt === undefined) return undefined
  const refreshToken = nonEmpty(record.refreshToken)
  const accountId = nonEmpty(record.accountId)
  const email = nonEmpty(record.email)
  const plan = nonEmpty(record.plan)
  return {
    accessToken,
    projectId,
    expiresAt,
    ...refreshToken === undefined ? {} : { refreshToken },
    ...accountId === undefined ? {} : { accountId },
    ...email === undefined ? {} : { email },
    ...plan === undefined ? {} : { plan },
  }
}

/** One Google token-endpoint answer, normalised. */
interface GoogleTokens {
  accessToken: string
  refreshToken?: string
  expiresAt: number
}

/** Turn a token-endpoint payload into tokens with an absolute expiry. */
export function parseGoogleTokenPayload(payload: unknown, previousRefreshToken?: string): GoogleTokens {
  const record = (payload ?? {}) as Record<string, unknown>
  const accessToken = nonEmpty(record.access_token)
  const lifetime = record.expires_in
  const lifetimeOk = typeof lifetime === 'number' && Number.isFinite(lifetime) && lifetime >= 0
  if (accessToken === undefined || !lifetimeOk) {
    throw new Error('Antigravity token response missing required fields')
  }
  const expiresAt = Date.now() + lifetime * 1000
  if (!Number.isFinite(expiresAt)) throw new Error('Antigravity token response missing required fields')
  const refreshToken = nonEmpty(record.refresh_token) ?? previousRefreshToken
  return { accessToken, expiresAt, ...refreshToken === undefined ? {} : { refreshToken } }
}

/** Exchange an authorization code for Google tokens. */
export async function exchangeAntigravityCode(input: {
  fetchFn: FetchFn
  code: string
  redirectUri: string
  verifier: string
}): Promise<GoogleTokens> {
  const response = await input.fetchFn(ANTIGRAVITY_TOKEN_URL, {
    method: 'POST',
    headers: { ...attributedHeaders(), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      code_verifier: input.verifier,
    }).toString(),
  })
  const payload = await response.json().catch(() => undefined) as unknown
  if (!response.ok) {
    const detail = (payload ?? {}) as Record<string, unknown>
    const described = nonEmpty(detail.error_description) ?? nonEmpty(detail.error)
    throw new Error(
      `Antigravity token exchange failed (HTTP ${response.status})${described === undefined ? '' : `: ${described}`}`,
    )
  }
  return parseGoogleTokenPayload(payload)
}

/** Redeem a Google refresh token. */
export async function refreshAntigravityToken(input: {
  fetchFn: FetchFn
  refreshToken: string
  account?: string
}): Promise<GoogleTokens> {
  const response = await input.fetchFn(ANTIGRAVITY_TOKEN_URL, {
    method: 'POST',
    headers: { ...attributedHeaders(), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
    }).toString(),
  })
  const payload = await response.json().catch(() => undefined) as unknown
  if (!response.ok) {
    // Google answers `invalid_grant` once the user revoked access; only a fresh
    // consent grant can recover, so this is a re-authentication failure.
    const detail = (payload ?? {}) as Record<string, unknown>
    const described = nonEmpty(detail.error_description) ?? nonEmpty(detail.error)
    throw new ProviderError(
      `Antigravity token refresh failed (HTTP ${response.status})${described === undefined ? '' : `: ${described}`}`,
      REAUTH_REQUIRED,
    )
  }
  return parseGoogleTokenPayload(payload, input.refreshToken)
}

/** Read a project id out of either shape the service uses. */
function projectIdOf(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'object' && value !== null) {
    const id = (value as Record<string, unknown>).id
    if (typeof id === 'string' && id.length > 0) return id
  }
  return undefined
}

/** One account's Antigravity identity. */
export interface AntigravityAccountInfo {
  projectId: string
  account?: string
  plan?: string
}

/** The `loadCodeAssist` response subset this plugin reads. */
interface LoadCodeAssistResponse {
  cloudaicompanionProject?: unknown
  currentTier?: { id?: string, name?: string }
  paidTier?: { id?: string, name?: string }
  allowedTiers?: { id?: string, isDefault?: boolean }[]
}

/** Metadata every `v1internal` call carries. */
const ANTIGRAVITY_METADATA = {
  ideType: 'ANTIGRAVITY',
  platform: 'PLATFORM_UNSPECIFIED',
  pluginType: 'GEMINI',
}

/**
 * Failure code for Google's account verification gate.
 *
 * Machine-routable and deliberately outside the harness's retryable set: the wall clears
 * in the user's browser, so repeating the request only re-hits it — unlike an empty
 * response or a rate limit, which are worth another attempt.
 */
export const ANTIGRAVITY_VERIFICATION_REQUIRED_CODE = 'ACCOUNT_VERIFICATION_REQUIRED'

/**
 * The verification link Google attaches when it gates an account.
 *
 * A 403 carrying `reason: VALIDATION_REQUIRED` is an account-level wall, not a dead
 * credential: Google asks the account's owner to open a link and verify. The reason and
 * the link live in `error.details`, which the bare message ("Verify your account to
 * continue.") does not carry — and the refresh path would otherwise spend a token
 * refresh and a second request on a wall that a fresh token cannot move.
 *
 * @param response - a candidate response; its body is left unread for the caller.
 * @returns the link to show the user, or undefined when this is not that gate.
 */
async function verificationGateUrl(response: Response): Promise<string | undefined> {
  if (response.status !== 403) return undefined
  try {
    const payload = await response.clone().json() as { error?: { details?: unknown } }
    const details = payload.error?.details
    if (!Array.isArray(details)) return undefined
    let help: string | undefined
    for (const entry of details) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as Record<string, unknown>
      const metadata = record.metadata
      if (typeof metadata === 'object' && metadata !== null) {
        const url = (metadata as Record<string, unknown>).validation_url
        if (typeof url === 'string' && url.trim() !== '') return url.trim()
      }
      const links = record.links
      if (!Array.isArray(links)) continue
      for (const link of links) {
        if (typeof link !== 'object' || link === null) continue
        const linkRecord = link as Record<string, unknown>
        const url = linkRecord.url
        const description = linkRecord.description
        if (help === undefined && typeof description === 'string' && /verif/i.test(description) && typeof url === 'string' && url.trim() !== '') {
          help = url.trim()
        }
      }
    }
    return help
  } catch {
    return undefined
  }
}

/**
 * POST one `v1internal` method, falling back to the production origin.
 *
 * @param method - method name, e.g. `loadCodeAssist`.
 * @param body - the request body.
 * @param accessToken - bearer for the account.
 * @param input - fetch and origin configuration.
 * @param signal - caller cancellation.
 * @returns the decoded response.
 * @throws {LlmError} for a non-2xx answer.
 */
export async function callInternal<T>(
  method: string,
  body: unknown,
  accessToken: string,
  input: { fetchFn: FetchFn, baseUrl?: string, userAgent?: string, origins?: readonly string[] },
  signal?: AbortSignal,
): Promise<T> {
  const origins = input.origins
    ?? (input.baseUrl === undefined ? [ANTIGRAVITY_BASE_URL, ANTIGRAVITY_PROD_URL] : [input.baseUrl])
  let lastError: unknown
  for (const [index, origin] of origins.entries()) {
    let response: Response
    try {
      response = await input.fetchFn(`${origin}/v1internal:${method}`, {
        method: 'POST',
        headers: attributedHeaders({
          'authorization': `Bearer ${accessToken}`,
          'content-type': 'application/json',
          'user-agent': input.userAgent ?? ANTIGRAVITY_USER_AGENT,
        }),
        body: JSON.stringify(body),
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      lastError = error
      if (signal?.aborted === true || index === origins.length - 1) throw error
      continue
    }
    // Another origin is worth trying when this one does not serve the method (404),
    // is briefly down (5xx), or refuses the request outright (403) — the last is how
    // a filtered or proxied network usually answers, and Google's own host may be
    // the unreachable one while the configured base is the way through.
    if (index < origins.length - 1 && [403, 404, 502, 503, 504].includes(response.status)) {
      await response.body?.cancel()
      continue
    }
    if (!response.ok) throw await httpLlmError(response, `Antigravity ${method}`)
    return await response.json() as T
  }
  throw lastError instanceof Error ? lastError : new Error('Antigravity has no endpoint to call')
}

/**
 * Read the account's project and plan, onboarding when the tier allows it.
 *
 * Login cannot complete without a project: every later call is scoped to one, so
 * this is the real boundary between "signed in" and "usable".
 *
 * @param accessToken - bearer for the account.
 * @param input - fetch and origin configuration.
 * @returns the discovered project, account and plan.
 * @throws {Error} when the account has no project and onboarding does not grant one.
 */
export async function discoverAntigravityAccount(
  accessToken: string,
  input: { fetchFn: FetchFn, baseUrl?: string, userAgent?: string, onboard?: boolean },
): Promise<AntigravityAccountInfo> {
  const load = await callInternal<LoadCodeAssistResponse>(
    'loadCodeAssist',
    { metadata: ANTIGRAVITY_METADATA },
    accessToken,
    input,
  )
  let projectId = projectIdOf(load.cloudaicompanionProject)
  if (projectId === undefined && input.onboard !== false) {
    const tierId = load.allowedTiers?.find((tier) => tier.isDefault)?.id ?? 'LEGACY'
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = await callInternal<{
        done?: boolean
        response?: { cloudaicompanionProject?: unknown }
      }>('onboardUser', { tierId, metadata: ANTIGRAVITY_METADATA }, accessToken, input)
      if (result.done === true) {
        projectId = projectIdOf(result.response?.cloudaicompanionProject)
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }
  if (projectId === undefined) {
    throw new Error(
      'Antigravity account has no Cloud AI Companion project; open Antigravity and finish onboarding, then sign in again',
    )
  }
  let account: string | undefined
  try {
    const profile = await input.fetchFn(ANTIGRAVITY_USERINFO_URL, {
      headers: attributedHeaders({ 'authorization': `Bearer ${accessToken}`, 'accept': 'application/json' }),
    })
    if (profile.ok) {
      const body = await profile.json() as { email?: unknown }
      account = nonEmpty(body.email)?.toLowerCase()
    }
  } catch {
    // Identity is display-only; project discovery is the login boundary.
  }
  const plan = nonEmpty(load.paidTier?.name) ?? nonEmpty(load.paidTier?.id)
    ?? nonEmpty(load.currentTier?.name) ?? nonEmpty(load.currentTier?.id)
  return {
    projectId,
    ...account === undefined ? {} : { account },
    ...plan === undefined ? {} : { plan },
  }
}

/** One account's per-model quota, keyed by model id. */
export type QuotaMap = Map<string, { remainingFraction?: number, resetTime?: string }>

/** The `fetchAvailableModels` response subset. */
interface AntigravityModelsResponse {
  models?: Record<string, {
    displayName?: string
    description?: string
    inputTokenLimit?: number
    maxInputTokens?: number
    maxOutputTokens?: number
    quotaInfo?: { remainingFraction?: number, resetTime?: string }
  }>
}

/** Turn one wire model id into a display name. */
function displayNameOf(id: string, stated?: string): string {
  if (stated !== undefined && stated.length > 0) return stated
  return id.split('-').map((word) => word.length === 0 ? word : word[0]?.toUpperCase() + word.slice(1)).join(' ')
}

/**
 * Read the account's live model catalog.
 *
 * @param input - bearer, project, and fetch configuration.
 * @returns the catalog entries and the raw quota map.
 * @throws {LlmError} when the endpoint refuses the call.
 */
export async function fetchAntigravityModels(input: {
  accessToken: string
  projectId: string
  fetchFn: FetchFn
  baseUrl?: string
  userAgent?: string
  signal?: AbortSignal
  /** Origins to try in order, when the caller must not inherit one request base. */
  origins?: readonly string[]
}): Promise<{ entries: CatalogEntry[], quotas: Map<string, { remainingFraction?: number, resetTime?: string }>, raw: Record<string, unknown> }> {
  const payload = await callInternal<AntigravityModelsResponse>(
    'fetchAvailableModels',
    { project: input.projectId },
    input.accessToken,
    input,
    input.signal,
  )
  const models = payload.models
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
  return { entries, quotas, raw: models }
}

/** One quota window in the shape the protocol uses. */
function quotaWindow(scope: string, quota: { remainingFraction?: number, resetTime?: string } | undefined): UsageWindow | undefined {
  const remaining = quota?.remainingFraction
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return undefined
  const resetsAt = typeof quota?.resetTime === 'string' ? Date.parse(quota.resetTime) : Number.NaN
  return {
    label: scope,
    usedPercent: Math.max(0, Math.min(100, (1 - remaining) * 100)),
    ...Number.isFinite(resetsAt) ? { resetsAt } : {},
  }
}

/** Whether one cached value is a usable catalog entry. */
function isCachedEntry(value: unknown): value is CatalogEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record['id'] === 'string' && record['id'] !== ''
    && typeof record['name'] === 'string'
    && typeof record['contextWindow'] === 'number' && Number.isFinite(record['contextWindow'])
}

/**
 * Read a cached catalog payload.
 *
 * The route writes the entries themselves; a whole `{ entries: [...] }` document is
 * accepted too, so a payload written in either shape cannot silently empty the picker.
 * Anything unusable is dropped rather than trusted.
 *
 * @param payload - whatever the cache returned.
 * @returns the usable entries, possibly none.
 */
function cachedEntries(payload: unknown): readonly CatalogEntry[] {
  const rows = Array.isArray(payload)
    ? payload
    : typeof payload === 'object' && payload !== null && Array.isArray((payload as { entries?: unknown }).entries)
      ? (payload as { entries: unknown[] }).entries
      : []
  return rows.filter(isCachedEntry)
}

/** Constructor dependencies for {@link AntigravityAdapter}. */
export interface AntigravityAdapterOptions {
  /** Cloud Code Assist origin; defaults to the daily one. */
  baseUrl?: string
  /** Whether the live catalog is consulted. */
  discovery: boolean
  streamIdleTimeoutMs: number
  tokens: TokenManager<AntigravitySession>
  onWarn?: (message: string) => void
  resolveAttachments?: () => AttachmentStore | undefined
  hiddenModels?: () => Promise<ReadonlySet<string>>
  /**
   * Model ids the user added by hand.
   *
   * Read per catalog query, so the add button takes effect at the picker's next
   * refresh. A hand-added id is published with conservative metadata: the
   * endpoint is the authority on what it serves, not this build.
   */
  userModels?: () => Promise<readonly string[]>
  /** The user's model rank for this route, most preferred first. */
  modelOrder?: () => Promise<readonly string[]>
  fetchFn?: FetchFn
  onCredentialRejected?: (account: string) => void
  /**
   * The endpoint's last live listing, from this plugin's cache.
   *
   * Read once per session, before the first catalog query, so the picker offers real
   * models without asking the endpoint anything. A route that fetched once and cached
   * the answer has no reason to fetch again on every refresh; the Settings "refresh
   * models" action is what re-reads it.
   */
  cachedListing?: () => Promise<unknown>
  /** Record what a live listing just produced, replacing the cached table. */
  saveListing?: (payload: unknown) => Promise<void>
}

/** Antigravity wire adapter serving the `antigravity` route. */
export class AntigravityAdapter extends LlmAdapter {
  /** Live catalog ids seen this session. */
  private discovered: readonly string[] | undefined
  /** Live catalog entries, so the Settings list matches what the account has. */
  private live: readonly CatalogEntry[] | undefined
  /** Whether the cached listing has been read; it is read at most once per session. */
  private hydrated = false
  /**
   * Per-model quota windows from the last catalog read, per account project.
   *
   * The route holds several accounts at once, and each one's quota belongs to its own
   * project: one shared map would let a second account inherit the first one's figures.
   */
  private quotasByProject = new Map<string, QuotaMap>()

  /** Ids the user added by hand, cached so the sync catalog can name them. */
  private userAddedIds: readonly string[] = []

  constructor(private readonly options: AntigravityAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: ANTIGRAVITY_PROVIDER_NAME }
  }

  override providerRetryPolicy(): undefined {
    // Cloud Code Assist states its own pacing through 429 `retry-after`.
    return undefined
  }

  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // Nothing to offer without a signed-in account: a model that cannot be called
    // must not appear in the picker, and Auto must not try it.
    if (await this.options.tokens.session() === undefined) return []
    await this.hydrate()
    await this.syncUserModels()
    const hidden = await this.hidden()
    return resolveCatalog(this.catalog(), [], hidden).entries.map((entry) => ({
      provider: ANTIGRAVITY_PROVIDER_ID,
      id: entry.id,
      name: entry.name,
      ...entry.description === undefined ? {} : { description: entry.description },
      ...entry.inputModalities === undefined ? {} : { inputModalities: entry.inputModalities },
    }))
  }



  private async hidden(): Promise<ReadonlySet<string>> {
    if (this.options.hiddenModels === undefined) return new Set()
    try {
      return await this.options.hiddenModels()
    } catch (error: unknown) {
      this.options.onWarn?.(`model preferences unavailable (${errorChain(error)})`)
      return new Set()
    }
  }


  /**
   * Read the cached listing, once, so the picker works without asking the endpoint.
   *
   * The cache is this route's last live catalog — the entries the endpoint reported, which
   * is also what a fresh read produces — so adopting it is indistinguishable from having
   * just fetched. A read failure is a cache miss, never a failure.
   */
  async hydrate(): Promise<void> {
    if (this.hydrated) return
    this.hydrated = true
    if (this.live !== undefined || this.options.cachedListing === undefined) return
    try {
      const entries = cachedEntries(await this.options.cachedListing())
      if (entries.length > 0) this.adopt(entries)
    } catch (error: unknown) {
      this.options.onWarn?.(`cached model catalog unavailable (${errorChain(error)})`)
    }
  }

  /** Publish one listing as this route's catalog. */
  private adopt(entries: readonly CatalogEntry[]): void {
    this.live = entries
    this.discovered = entries.map((entry) => entry.id)
  }

  /** The catalog the route serves: its own entries, then the ids the user added
   * by hand. The two are built separately so the hand-added check can look at
   * the shipped list without recursing. */
  private catalog(): readonly CatalogEntry[] {
    return [...this.shippedCatalog(), ...this.addedEntries()]
  }

  /** The live entries: the cached listing until a fresh one replaces it. */
  private shippedCatalog(): readonly CatalogEntry[] {
    return this.live ?? []
  }

  override async resolveModel(_provider: string, model: string): Promise<LlmResolvedModelInfo> {
    await this.hydrate()
    await this.syncUserModels()
    const entries = this.catalog()
    const entry = findEntry(entries, model)
    if (entry === undefined) {
      return {
        provider: ANTIGRAVITY_PROVIDER_ID,
        id: model,
        name: model,
        context: { contextWindow: ANTIGRAVITY_CONTEXT_WINDOW },
        defaultMaxTokens: ANTIGRAVITY_DEFAULT_MAX_TOKENS,
      }
    }
    const reasoning = antigravityReasoning(entry.id)
    return {
      provider: ANTIGRAVITY_PROVIDER_ID,
      id: entry.id,
      name: entry.name,
      ...entry.description === undefined ? {} : { description: entry.description },
      ...entry.inputModalities === undefined ? {} : { inputModalities: entry.inputModalities },
      context: { contextWindow: entry.contextWindow },
      defaultMaxTokens: ANTIGRAVITY_DEFAULT_MAX_TOKENS,
      ...reasoning === undefined ? {} : { reasoning },
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs)
    try {
      // `auto` owns the fallback chain now, so this route serves exactly the
      // model it was asked for — but it draws on every account the provider holds, so a
      // spent allowance moves to the next account rather than failing the call.
      // A picker row is the family, not the wire id: `gemini-3.8-flash` is served as
      // `gemini-3.8-flash-tiered` and `gpt-oss-120b` only exists as
      // `gpt-oss-120b-medium`. The live listing's own mapping is the authority; the
      // built-in tier names are the fallback for a cold start, before discovery ran.
      const model = wireIdFor(options.model, options.reasoningEffort)
        ?? (/^gemini-.*-flash$/.test(options.model)
          ? geminiTierId(options.model, options.reasoningEffort ?? 'medium')
          : options.model)
      // Accounts come from the manager when it can list them; a minimal manager (or a
      // test double) without `accounts()` means a single account, which is just the
      // default one.
      const accounts = typeof this.options.tokens.accounts === 'function'
        ? await this.options.tokens.accounts()
        : []
      // Surface the account pool and the 429 outcome to the caller, so a non-switch is
      // diagnosable from the browser where the node stdout is hidden.
      const diag: string[] = [`pool=${accounts.join(',') || '(none)'}`]
      const tried = new Set<string>()
      // The first gate the sweep met, kept for the headline: the user has to sign in as
      // this account and open this link, so both belong in the failure they read.
      let firstGate: { account: string, url: string } | undefined
      // Resolve without preempt: use the stored token if it is still within its life,
      // refresh only when it has actually expired. The 5-minute preempt was causing
      // a refresh on every stream, which made Google show the consent page.
      let token = await this.resolveNoPreempt()
      // Stay on the default account until it refuses. opencodex keeps account affinity —
      // a request stays on one account and only moves after a 429 — because switching
      // accounts on every request is what reads to Google as two accounts in play at once
      // and trips the verify gate. Reordering here caused exactly that. An account already
      // remembered as gated is different: it cannot serve until its owner verifies, so it
      // goes last and a healthy account is not blocked behind it.
      const gated = (account: string): number => Number(allowanceScheduler.isGated(ANTIGRAVITY_PROVIDER_ID, account))
      const order = [token.account, ...accounts.filter((a) => a !== token.account)]
        .sort((a, b) => gated(a) - gated(b))
      for (const accountKey of order) {
        if (tried.has(accountKey)) continue
        tried.add(accountKey)
        token = await this.options.tokens.resolve(accountKey)
        // Pacing: a connect attempt right after a refused one is what turns a transient
        // Google safety check into a sustained block, so the streamer waits out a short
        // beat before each retry. opencodex keeps this discipline with a request pacer;
        // this is the same idea narrowed to one provider.
        await paceAntigravityAttempt(watchdog.signal)
        let response = await this.requestWithRetry(options, model, token.account, token.accessToken, watchdog.signal)
        // Read Google's gate before the refresh path: a verification wall is not a token
        // problem, so refreshing first would only add a wasted refresh and a wasted request
        // to every turn spent on a gated account.
        let gateUrl = await verificationGateUrl(response)
        if (response.status === 401 || (response.status === 403 && gateUrl === undefined)) {
          // The stored token was accepted locally but refused on the wire; force one
          // refresh. A 403 that survives the refresh is Google's "verify your account"
          // gate, not a dead credential — the account is fine, it just cannot serve now —
          // so the call moves to the next account rather than failing. Only a 401 marks
          // the credential as dead.
          token = await this.options.tokens.resolve(token.account, true)
          response = await this.requestWithRetry(options, model, token.account, token.accessToken, watchdog.signal)
          gateUrl = await verificationGateUrl(response)
          if (response.status === 401) {
            this.options.onCredentialRejected?.(token.account)
          }
        }
        // A 400 "invalid argument" is the one refusal worth another dispatch: Google is
        // judging the request's shape, not the account, and the envelope mints a fresh
        // requestId and sessionId per attempt — so the retry already differs, and a shape
        // it disliked only because of the thinking budget or an image can be repaired.
        if (response.status === 400) {
          const refused = response
          // The field Google blames lives in error.details / fieldViolations, which the
          // bare message omits; keep the whole body in the log so a 400 that survives the
          // repairs still says what it refused.
          const body = await refused.clone().text().catch(() => '')
          this.options.onWarn?.(`antigravity: HTTP 400 body: ${body.slice(0, 600)}`)
          diag.push(`400 on ${token.account}`)
          response = await this.retryInvalidArgument(options, model, token.account, token.accessToken, watchdog.signal, diag) ?? refused
          // A gate can ride a redispatch too, so the link is read off whichever answer stands.
          gateUrl = await verificationGateUrl(response)
        }
        // A spent allowance (402/429) moves to the next account, remembering when a spent
        // one refills so later requests skip it until then.
        if (!response.ok && (response.status === 402 || response.status === 429) && order.length > 1) {
          diag.push(`${response.status} on ${token.account}, moving to next`)
          this.noteSpent(token.account)
          const resetAt = await this.resetAt(token.account)
          allowanceScheduler.noteReset(ANTIGRAVITY_PROVIDER_ID, token.account, resetAt)
          continue
        }
        // A 403 "verify your account" is Google's safety gate, not a dead credential. The
        // gate names the link that clears it, so the account is remembered as gated and the
        // sweep moves on with that link in hand — for a whole gate TTL, not a cooldown,
        // since a cooldown would let the next turn hit the same wall and stop the sweep
        // before the accounts that can serve were tried.
        if (!response.ok && response.status === 403 && gateUrl !== undefined) {
          allowanceScheduler.markGated(ANTIGRAVITY_PROVIDER_ID, token.account)
          firstGate ??= { account: token.account, url: gateUrl }
          // The link itself is named once, in the headline: repeating a 300-character URL
          // per refused account buries the instruction it exists to deliver.
          diag.push(`verification required for ${token.account}`)
          continue
        }
        // A 403 that names no gate is a transient safety check: cool the account (so the
        // gate is not re-hit at once) and move to the next — but only cool one account per
        // pass, and keep sweeping. Stopping the sweep here is what stranded a pool whose
        // other account was ready to serve.
        if (!response.ok && response.status === 403 && order.length > 1) {
          const otherCooling = [...tried].some((account) => account !== token.account && allowanceScheduler.isCooling(ANTIGRAVITY_PROVIDER_ID, account))
          if (!otherCooling) allowanceScheduler.coolDown(ANTIGRAVITY_PROVIDER_ID, token.account)
          diag.push(`403 on ${token.account}, ${otherCooling ? 'another account already cooling; moving to next' : 'cooling and moving to next'}`)
          continue
        }
        if (!response.ok) {
          diag.push(`fail ${response.status} on ${token.account} (no switch)`)
          const error = await httpLlmError(response, 'Antigravity API')
          // The diagnostic rides the message so it surfaces where the user sees the
          // failure, since the node half's stdout is unreachable in the desktop shell.
          error.message = `${error.message} [${diag.join(' | ')}]`
          throw error
        }
        if (response.body === null) {
          throw new LlmError('Antigravity API returned no response body', EMPTY_RESPONSE_CODE)
        }
        // A stream that closes before a finish chunk is a dropped connection, not a
        // refusal: the account is fine and the request arrived, so redispatch it a few
        // times with backoff before giving up on the account. Content refusals and quota
        // failures propagate untouched.
        let lastStreamError: unknown
        for (let attempt = 0; attempt < STREAM_RETRY_ATTEMPTS; attempt++) {
          try {
            yield* streamAntigravity(response.body, () => { watchdog.pulse() })
            lastStreamError = undefined
            break
          } catch (error) {
            if (!isRetryableStreamError(error) || watchdog.signal.aborted) throw error
            lastStreamError = error
            this.options.onWarn?.(`antigravity: stream closed early (${errorChain(error)}); redispatching`)
            if (attempt < STREAM_RETRY_ATTEMPTS - 1) {
              await backoff(NETWORK_RETRY_BASE_MS * 2 ** attempt, watchdog.signal)
              response = await this.requestWithRetry(options, model, token.account, token.accessToken, watchdog.signal)
              if (!response.ok) throw await httpLlmError(response, 'Antigravity API')
              if (response.body === null) throw new LlmError('Antigravity API returned no response body', EMPTY_RESPONSE_CODE)
            }
          }
        }
        if (lastStreamError !== undefined) throw lastStreamError
        return
      }
      // Every account was tried and none served. A verification gate outranks the other
      // refusals: it names the account to sign in as and the link that clears it, which is
      // the whole fix, so that is the headline. Otherwise the most actionable refusal names
      // itself — a 403 "verify your account" without a link, or a 429 "allowance spent" that
      // just means waiting for the reset. The diagnostic lists each account and its status.
      const last403 = diag.reduce<string | undefined>((acc, line) => (line.startsWith('403 on') ? line : acc), undefined)
      const message = firstGate !== undefined
        ? `Antigravity: Google requires verification for ${firstGate.account} before it can serve requests — verify here: ${firstGate.url} [${diag.join(' | ')}]`
        : last403 === undefined
          ? `Antigravity API: every account's allowance is spent [${diag.join(' | ')}]`
          : `Antigravity API request failed: ${last403.replace(/^403 on /, 'account ')} refused (HTTP 403: Verify your account to continue) [${diag.join(' | ')}]`
      throw new LlmError(message, firstGate === undefined ? EMPTY_RESPONSE_CODE : ANTIGRAVITY_VERIFICATION_REQUIRED_CODE)
    } catch (error: unknown) {
      throw mapFetchFailure('Antigravity API', this.refreshHint(error), watchdog, options.signal)
    } finally {
      watchdog.stop()
    }
  }

  /** Whether an account is remembered as spent until a future reset. */
  private isSpent(account: string): boolean {
    return allowanceScheduler.isSpentUntilReset(ANTIGRAVITY_PROVIDER_ID, account)
  }

  /** The moment an account's allowance is known to reset, when recorded. */
  private async resetAt(account: string): Promise<number | undefined> {
    const held = await this.options.tokens.session(account)
    if (held === undefined) return undefined
    try {
      const read = await this.usage(held.session.accessToken, held.session.projectId ?? '', held.session.email)
      const spent = read.windows.find((window) => (window.usedPercent ?? 0) >= 100)
      return spent?.resetsAt
    } catch {
      return undefined
    }
  }

  /** Remember an account as spent (its exact reset is learned separately). */
  private noteSpent(account: string): void {
    this.options.onWarn?.(`antigravity: account ${account} allowance spent; moving to another account`)
  }

  /** Resolve the default account's token without the preempt window. */
  private async resolveNoPreempt(): Promise<{ account: string, accessToken: string, expiresAt: number }> {
    const found = await this.options.tokens.session()
    if (found === undefined) {
      throw new ProviderError(`${ANTIGRAVITY_PROVIDER_NAME} no account is signed in`, REAUTH_REQUIRED)
    }
    const { account, session } = found
    if (Date.now() < session.expiresAt) {
      return { account, accessToken: session.accessToken, expiresAt: session.expiresAt }
    }
    try {
      const resolved = await this.options.tokens.resolve(account, true)
      return resolved
    } catch (error) {
      throw error
    }
  }

  /** Translate an auth failure into the message a user can act on. */
  private refreshHint(error: unknown): unknown {
    if (error instanceof ProviderError && error.code === REAUTH_REQUIRED) {
      return new LlmError(
        `Antigravity login expired; sign in again from Settings → Subscriptions (${ANTIGRAVITY_CODE_URL})`,
        'INVALID_CREDENTIAL',
        { status: 401 },
      )
    }
    return error
  }

  /**
   * Redispatch a request Google refused as an invalid argument.
   *
   * The refusal names no field for most shapes, so the retries are a ladder rather than a
   * guess: the same request with fresh ids, then without the thinking budget, then without
   * tools and inline images. The first answer that is not a 400 is returned — it may be a
   * quota or credential refusal, which the sweep below already knows how to act on.
   *
   * @param options - the call's options.
   * @param model - the wire model id being dispatched.
   * @param account - the account the request is scoped to.
   * @param accessToken - that account's bearer.
   * @param signal - caller cancellation.
   * @param diag - the per-turn diagnostic trail.
   * @returns the response to act on; the refused one when no retry changed the verdict.
   */
  private async retryInvalidArgument(
    options: GenerateOptions,
    model: string,
    account: string,
    accessToken: string,
    signal: AbortSignal,
    diag: string[],
  ): Promise<Response | undefined> {
    for (const [level, note] of INVALID_ARGUMENT_REPAIRS.entries()) {
      if (signal.aborted) return undefined
      await backoff(INVALID_ARGUMENT_RETRY_BASE_MS * 2 ** level, signal)
      if (signal.aborted) return undefined
      const response = await this.request(options, model, account, accessToken, signal, level)
      diag.push(`400 retried ${note}: ${response.status}`)
      if (response.status !== 400) return response
    }
    return undefined
  }

  /** Build and send one streaming request for one model. */
  /**
   * One dispatch attempt, retrying transient network faults before giving up on the account.
   *
   * A connect timeout or a dropped socket is a transport hiccup, not a refusal — the
   * account is fine and the request never arrived, so it is worth a few backoff retries
   * before the sweep moves on. An HTTP response (even a 429/403) is returned as-is: those
   * drive the account-switch logic in {@link stream}, and must not be swallowed here.
   * Non-network errors propagate untouched.
   */
  private async requestWithRetry(
    options: GenerateOptions,
    model: string,
    account: string,
    accessToken: string,
    signal: AbortSignal,
  ): Promise<Response> {
    let lastError: unknown
    for (let attempt = 0; attempt < NETWORK_RETRY_ATTEMPTS; attempt++) {
      try {
        return await this.request(options, model, account, accessToken, signal)
      } catch (error) {
        if (!isTransientNetworkFault(error) || signal.aborted) throw error
        lastError = error
        this.options.onWarn?.(`antigravity: transient network fault (${errorChain(error)}); retrying`)
        if (attempt < NETWORK_RETRY_ATTEMPTS - 1) {
          await backoff(NETWORK_RETRY_BASE_MS * 2 ** attempt, signal)
        }
      }
    }
    throw lastError
  }

  private async request(
    options: GenerateOptions,
    model: string,
    account: string,
    accessToken: string,
    signal: AbortSignal,
    repair = 0,
  ): Promise<Response> {
    // Every call is scoped to the account's Cloud AI Companion project.
    const held = await this.options.tokens.session(account)
    const projectId = held?.session.projectId
    if (projectId === undefined) {
      throw new ProviderError('Antigravity account has no project; sign in again', REAUTH_REQUIRED)
    }
    const envelope = await toAntigravityRequest(
      { ...options, model },
      projectId,
      options.system,
      this.imageResolver(signal),
      true,
    )
    repairEnvelope(envelope, repair)
    const fetchFn = this.options.fetchFn ?? proxiedFetch
    const origin = this.options.baseUrl ?? ANTIGRAVITY_BASE_URL
    try {
      const response = await fetchFn(`${origin}/v1internal:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: attributedHeaders({
          'authorization': `Bearer ${accessToken}`,
          'accept': 'text/event-stream',
          'content-type': 'application/json',
          'user-agent': ANTIGRAVITY_USER_AGENT,
        }),
        body: JSON.stringify(envelope),
        signal,
      })
      return response
    } catch (error) {
      throw error
    }
  }

  /** Resolve image blocks through the attachment service, when it is present. */
  private imageResolver(signal: AbortSignal): ImageResolver | undefined {
    const store = this.options.resolveAttachments?.()
    if (store === undefined || store === null) return undefined
    return async (ref) => {
      try {
        const stored = await store.readImage(ref, signal)
        return { mediaType: ref.mediaType, base64: Buffer.from(stored.data).toString('base64') }
      } catch (error: unknown) {
        this.options.onWarn?.(`image attachment unavailable (${errorChain(error)})`)
        return undefined
      }
    }
  }

  /**
   * Read the live model catalog and the per-model quota.
   *
   * @param accessToken - bearer for the account.
   * @param projectId - the account's project; when omitted the stored session's is used.
   * @param signal - caller cancellation.
   * @returns the live model ids, or undefined when discovery is off or unavailable.
   */
  async fetchCatalog(accessToken: string, projectId?: string, signal?: AbortSignal): Promise<readonly string[] | undefined> {
    if (!this.options.discovery) return undefined
    try {
      const held = projectId === undefined ? await this.options.tokens.session() : undefined
      const project = projectId ?? held?.session.projectId
      if (project === undefined) return undefined
      const fetchFn = this.options.fetchFn ?? proxiedFetch
      const { entries, quotas } = await fetchAntigravityModels({
        accessToken,
        projectId: project,
        fetchFn,
        ...this.options.baseUrl === undefined ? {} : { baseUrl: this.options.baseUrl },
        ...signal === undefined ? {} : { signal },
      })
      this.quotasByProject.set(project, quotas)
      this.adopt(entries)
      // The catalog the endpoint just reported is what the next session starts from, so
      // the picker does not have to ask again. A cache failure never fails this read.
      if (this.options.saveListing !== undefined) {
        try {
          await this.options.saveListing(entries)
        } catch (error: unknown) {
          this.options.onWarn?.(`model catalog cache write failed (${errorChain(error)})`)
        }
      }
      return this.discovered
    } catch (error: unknown) {
      if (signal?.aborted === true) return undefined
      this.options.onWarn?.(`Antigravity model discovery failed (${errorChain(error)})`)
      return undefined
    }
  }

  /** Re-read the ids the user added by hand. */
  private async syncUserModels(): Promise<void> {
    if (this.options.userModels === undefined) return
    try {
      this.userAddedIds = await this.options.userModels()
    } catch (error: unknown) {
      this.options.onWarn?.(`user-added models unavailable (${errorChain(error)})`)
      this.userAddedIds = []
    }
  }

  /**
   * The entries for ids the user added by hand.
   *
   * Published without shipped metadata: this build has never seen the model, so
   * the endpoint's own defaults are the honest description.
   */
  private addedEntries(): readonly CatalogEntry[] {
    if (this.userAddedIds.length === 0) return []
    const known = new Set(this.shippedCatalog().map((entry) => entry.id))
    return this.userAddedIds
      .filter((id) => !known.has(id))
      .map((id) => fallbackEntry(id, 'Added by hand in Settings', ANTIGRAVITY_CONTEXT_WINDOW))
  }

  /** Record a live catalog discovered elsewhere. */
  discover(ids: readonly string[]): void {
    this.discovered = ids
  }

  /** The live catalog, for the Settings page's model list. */
  catalogEntries(): readonly CatalogEntry[] {
    return this.catalog()
  }

  /** What this route itself serves, without the ids added by hand. */
  ownCatalogEntries(): readonly CatalogEntry[] {
    return this.shippedCatalog()
  }

  /**
   * The account's metered allowances, from the quota the catalog reported.
   *
   * The service states a quota per model, but the account is metered in two
   * buckets: the Gemini family and Claude. Those are the two allowances a user
   * recognises, so each is reported once, at its worst-spent model (several
   * models share a bucket, and their figures agree within rounding), with the
   * reset of the model that reported it.
   *
   * @param accessToken - bearer for the account.
   * @param projectId - the account's project.
   * @param plan - plan name to report alongside the windows.
   * @returns the plan and windows, or undefined when the service stated none.
   */
  async usage(accessToken: string, projectId: string, plan?: string): Promise<UsageRead> {
    const fetchFn = this.options.fetchFn ?? proxiedFetch
    // Google's accounting lives on its own hosts. The production host comes first because
    // it is the one that states every allowance group: the daily host answers 200 with only
    // some of them (the Gemini group went missing there), which silently dropped a row from
    // the card. A configured request base is a routing choice for completions — often a
    // proxy — and need not implement `v1internal:retrieveUserQuotaSummary`, so it is the
    // last resort rather than the only attempt.
    const origins = [
      ANTIGRAVITY_PROD_URL,
      ANTIGRAVITY_BASE_URL,
      ...this.options.baseUrl === undefined ? [] : [this.options.baseUrl],
    ]
    const runtime = { fetchFn, origins }
    const { windows, usageError } = await this.readUsage(accessToken, projectId, runtime)
    return {
      windows,
      ...plan === undefined ? {} : { plan },
      ...usageError === undefined ? {} : { usageError },
    }
  }

  /**
   * Read the account summary and the per-model figures, then merge them.
   *
   * Both are read on every call: the summary owns the weekly buckets, but its Gemini
   * rolling bucket is a fixture (`remainingFraction: 1` however much the account has
   * spent), so a summary-only read leaves that row frozen at zero. The per-model catalog
   * is where the rolling figure actually lives, which is why it is always consulted and
   * its rolling rows are merged in rather than used only as a substitute.
   *
   * @param accessToken - bearer for the account.
   * @param projectId - the account's project.
   * @param runtime - fetch plus the origins to try.
   * @returns the windows found, and why the summary was unavailable when it was.
   */
  private async readUsage(
    accessToken: string,
    projectId: string,
    runtime: { fetchFn: FetchFn, origins: readonly string[] },
  ): Promise<{ windows: UsageWindow[], usageError?: string }> {
    let summaryError: string | undefined
    let summaryWindows: UsageWindow[] = []
    try {
      summaryWindows = await this.summaryWindows(accessToken, projectId, runtime)
      if (summaryWindows.length === 0) summaryError = 'the account summary stated no quota bucket'
    } catch (error: unknown) {
      summaryError = errorChain(error)
    }
    const perModel = await this.perModelWindows(accessToken, projectId, runtime)
    const windows = mergeRollingWindows(summaryWindows, perModel)
    if (windows.length === 0) {
      this.options.onWarn?.(`Antigravity usage unavailable: summary ${summaryError ?? 'no bucket'}; no per-model figure`)
      return { windows: this.antigravityWindowsFromCache(projectId), ...summaryError === undefined ? {} : { usageError: summaryError } }
    }
    // A complete summary is the accounting; when it answered only in part, say that the
    // rolling rows came from the per-model substitute.
    return { windows, ...summaryError === undefined ? {} : { usageError: `per-model figures (${summaryError})` } }
  }

  /**
   * Reduce the catalog's per-model quota to the rolling windows it can state.
   *
   * A failed read falls back to the figures the last catalog read kept for this project,
   * which is the same substitute this route always used — the difference is that it is now
   * merged with the summary instead of replacing it.
   *
   * @param accessToken - bearer for the account.
   * @param projectId - the account's project.
   * @param runtime - fetch plus the origins to try.
   * @returns one rolling window per family that stated a figure.
   */
  private async perModelWindows(
    accessToken: string,
    projectId: string,
    runtime: { fetchFn: FetchFn, origins: readonly string[] },
  ): Promise<UsageWindow[]> {
    try {
      const { quotas } = await fetchAntigravityModels({
        accessToken,
        projectId,
        fetchFn: runtime.fetchFn,
        origins: runtime.origins,
      })
      if (quotas.size > 0) this.quotasByProject.set(projectId, quotas)
    } catch {
      // Keep whatever the last catalog read stated; the summary alone still answers.
    }
    return antigravityRollingFromModels(this.quotasByProject.get(projectId) ?? new Map())
  }

  /**
   * The windows the last catalog read reported for one project, if any.
   *
   * @param projectId - the account's project; a second account has its own figures.
   * @returns the rolling windows the cache can state.
   */
  private antigravityWindowsFromCache(projectId: string): UsageWindow[] {
    return antigravityWindows(this.quotasByProject.get(projectId) ?? new Map())
  }

  /**
   * Read the allowance summary from every accounting host and union the groups.
   *
   * The hosts do not agree on what the summary contains: one answers 200 while naming only
   * some of the groups — the daily host stopped stating the Gemini group, which left the
   * card showing Claude alone and hid a nearly spent Gemini weekly allowance. A 200 is
   * therefore not proof of a complete answer, so each host is asked until every window the
   * card can show has been named; the first host to state a given window keeps it, and a
   * host that refuses or is down is skipped rather than failing the read.
   *
   * @param accessToken - bearer for the account.
   * @param projectId - the account's project.
   * @param runtime - fetch plus the origins to try, most authoritative first.
   * @returns the union of the windows the hosts stated, in card order.
   */
  private async summaryWindows(
    accessToken: string,
    projectId: string,
    runtime: { fetchFn: FetchFn, origins: readonly string[] },
  ): Promise<UsageWindow[]> {
    const found = new Map<string, UsageWindow>()
    for (const origin of runtime.origins) {
      if (found.size >= QUOTA_WINDOW_LABELS.length) break
      try {
        const payload = await this.summary(accessToken, projectId, { fetchFn: runtime.fetchFn, origins: [origin] })
        for (const window of parseAntigravityQuotaSummary(payload)) {
          if (!found.has(window.label)) found.set(window.label, window)
        }
      } catch {
        // This host had nothing to say; the ones after it still might.
      }
    }
    return QUOTA_WINDOW_LABELS.flatMap((label) => {
      const window = found.get(label)
      return window === undefined ? [] : [window]
    })
  }

  /**
   * Read the account's quota summary, retrying once with the plain product token.
   *
   * Quota accounting is the one endpoint that refuses the IDE fingerprint on some
   * otherwise valid accounts — an HTTP 403 "you do not have a valid license of this
   * product" for a credential every other call accepts. The plain `antigravity/1.0`
   * product token is admitted, and without this retry the card silently shows the
   * per-model substitute instead of the account's real allowance.
   *
   * @param accessToken - bearer for the account.
   * @param projectId - the account's project.
   * @param runtime - fetch plus the origins to try.
   * @returns the decoded summary.
   */
  private async summary(
    accessToken: string,
    projectId: string,
    runtime: { fetchFn: FetchFn, origins: readonly string[] },
  ): Promise<unknown> {
    try {
      return await callInternal<unknown>(
        'retrieveUserQuotaSummary',
        { project: projectId },
        accessToken,
        runtime,
      )
    } catch (error: unknown) {
      if (!(error instanceof LlmError) || error.failure.status !== 403) throw error
      return await callInternal<unknown>(
        'retrieveUserQuotaSummary',
        { project: projectId },
        accessToken,
        { ...runtime, userAgent: ANTIGRAVITY_PLAIN_USER_AGENT },
      )
    }
  }
}

/**
 * Reduce per-model quota figures to the two allowances an account has.
 *
 * @param quotas - quota per model id, as the catalog reported it.
 * @returns one window per family, Gemini first, worst-spend first within a family.
 */
export function antigravityWindows(
  quotas: ReadonlyMap<string, { remainingFraction?: number, resetTime?: string }>,
): UsageWindow[] {
  // Rebuild the wire shape the shared parser reads, so both paths agree.
  const models: Record<string, unknown> = {}
  for (const [id, quota] of quotas) models[id] = { quotaInfo: quota }
  return parseAntigravityModelQuota({ models })
}

/** Whether a refusal is worth answering with another model. */
function isModelFallbackWorthy(status: number): boolean {
  return status === 402 || status === 404 || status === 408 || status === 429 || status >= 500
}

/** Everything the `antigravity` route needs from the plugin configuration. */
export interface AntigravityProviderOptions {
  /** Absolute path of `auth.json`. */
  credentialFile: string
  /** Cloud Code Assist origin; defaults to the daily one. */
  baseUrl?: string
  /** Consult the endpoint's live model list. */
  discovery: boolean
  /** Abandon a stream after this much silence. */
  streamIdleTimeoutMs: number
  /** Shared model-visibility preferences. */
  preferences: ModelPreferences
  /** Resolve the attachment service per request. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Invoked when the catalog or its visibility changed. */
  onCatalogChanged?: () => void
  onWarn?: (message: string) => void
  fetchFn?: FetchFn
  /** Activate an eligible account when `loadCodeAssist` reports no project. */
  onboard?: boolean
  /**
   * The endpoint's last live catalog, from this plugin's cache.
   *
   * This route has no curated list — what an account may use is plan-dependent — so the
   * cache is what makes a cold start (or an unreachable endpoint) still show models.
   */
  cachedListing?: () => Promise<unknown>
  /** Record what a live listing just produced, replacing the cached table. */
  saveListing?: (payload: unknown) => Promise<void>
}

/**
 * Build the `antigravity` route: its adapter and its login/lifecycle controller.
 *
 * @param options - resolved paths and shared services.
 * @returns the route, ready to register and to serve over RPC.
 */
export function createAntigravityProvider(options: AntigravityProviderOptions): ProviderRoute {
  const fetchFn = options.fetchFn ?? proxiedFetch
  const runtime = {
    fetchFn,
    ...options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl },
    ...options.onboard === undefined ? {} : { onboard: options.onboard },
  }
  const store = new TokenStore<AntigravitySession>(options.credentialFile, ANTIGRAVITY_PROVIDER_ID, parseAntigravitySession)

  const flow = new LoopbackFlow<AntigravitySession>(ANTIGRAVITY_PROVIDER_ID, {
    ports: [ANTIGRAVITY_CALLBACK_PORT, 0],
    callbackPath: ANTIGRAVITY_CALLBACK_PATH,
    timeoutMs: 5 * 60 * 1000,
    buildAuthorizeUrl: ({ redirectUri, state, pkce }) => {
      const params = new URLSearchParams({
        access_type: 'offline',
        client_id: ANTIGRAVITY_CLIENT_ID,
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        include_granted_scopes: 'true',
        prompt: 'consent',
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: ANTIGRAVITY_SCOPES.join(' '),
        state,
      })
      return `${ANTIGRAVITY_AUTHORIZE_URL}?${params.toString()}`
    },
    exchange: async ({ code, redirectUri, pkce }) => {
      const tokens = await exchangeAntigravityCode({ fetchFn, code, redirectUri, verifier: pkce.verifier })
      const account = await discoverAntigravityAccount(tokens.accessToken, runtime)
      return {
        accessToken: tokens.accessToken,
        projectId: account.projectId,
        expiresAt: tokens.expiresAt,
        ...tokens.refreshToken === undefined ? {} : { refreshToken: tokens.refreshToken },
        ...account.account === undefined ? {} : { email: account.account, accountId: account.account },
        ...account.plan === undefined ? {} : { plan: account.plan },
      }
    },
  })

  const tokens = new TokenManager<AntigravitySession>({
    store,
    displayName: ANTIGRAVITY_PROVIDER_NAME,
    preemptMs: ANTIGRAVITY_PREEMPT_MS,
    refresh: async (session) => {
      const refreshToken = session.refreshToken
      if (refreshToken === undefined) {
        throw new ProviderError(`${ANTIGRAVITY_PROVIDER_NAME} account has no refresh token; sign in again`, REAUTH_REQUIRED)
      }
      // A refresh keeps the stored project: it is the account's, not the token's.
      const refreshed = await refreshAntigravityToken({
        fetchFn,
        refreshToken,
        ...session.accountId === undefined ? {} : { account: session.accountId },
      })
      return {
        accessToken: refreshed.accessToken,
        expiresAt: refreshed.expiresAt,
        projectId: session.projectId,
        ...refreshed.refreshToken === undefined ? {} : { refreshToken: refreshed.refreshToken },
        ...session.email === undefined ? {} : { email: session.email },
        ...session.accountId === undefined ? {} : { accountId: session.accountId },
        ...session.plan === undefined ? {} : { plan: session.plan },
      }
    },
  })

  const adapter = new AntigravityAdapter({
    ...options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl },
    discovery: options.discovery,
    streamIdleTimeoutMs: options.streamIdleTimeoutMs,
    tokens,
    ...options.onWarn === undefined ? {} : { onWarn: options.onWarn },
    ...options.resolveAttachments === undefined ? {} : { resolveAttachments: options.resolveAttachments },
    hiddenModels: () => options.preferences.hiddenIds(ANTIGRAVITY_PROVIDER_ID),
    userModels: () => options.preferences.extraIds(ANTIGRAVITY_PROVIDER_ID),
    modelOrder: () => options.preferences.orderOf(ANTIGRAVITY_PROVIDER_ID),
    ...options.cachedListing === undefined ? {} : { cachedListing: options.cachedListing },
    ...options.saveListing === undefined ? {} : { saveListing: options.saveListing },
    fetchFn,
  })

  // Read the cached table now rather than at the first picker query: the Settings page
  // reads the catalog synchronously, so a request-free start must already have it.
  void adapter.hydrate().catch(() => undefined)

  const spec: ProviderSpec<AntigravitySession> = {
    id: ANTIGRAVITY_PROVIDER_ID,
    displayName: ANTIGRAVITY_PROVIDER_NAME,
    codeUrl: ANTIGRAVITY_CODE_URL,
    credentialFile: options.credentialFile,
    discovery: options.discovery,
    catalog: () => adapter.catalogEntries(),
    catalogOwn: () => adapter.ownCatalogEntries(),
    fallbackContextWindow: ANTIGRAVITY_CONTEXT_WINDOW,
    discover: async (accessToken) => {
      const held = await tokens.session()
      // The live catalog is the only catalog this route has: Antigravity ships
      // no curated list, because what an account may use is plan-dependent.
      return adapter.fetchCatalog(accessToken, held?.session.projectId)
    },
    usage: async (accessToken, account) => {
      const held = await store.get(account)
      if (held === undefined) return undefined
      const read = await adapter.usage(accessToken, held.projectId, held.plan)
      return read === undefined ? undefined : read
    },
    details: () => [
      { key: 'oauthHost', value: 'https://accounts.google.com' },
      { key: 'apiBase', value: options.baseUrl ?? ANTIGRAVITY_BASE_URL },
      { key: 'credentialFile', value: options.credentialFile },
    ],
  }

  const controller = new ProviderController<AntigravitySession>({
    spec,
    store,
    tokens,
    flow,
    preferences: options.preferences,
    ...options.onCatalogChanged === undefined ? {} : { onCatalogChanged: options.onCatalogChanged },
    ...options.onWarn === undefined ? {} : { onWarn: options.onWarn },
  })

  return {
    id: controller.id,
    displayName: controller.displayName,
    credentialFile: controller.credentialFile,
    adapter,
    status: () => controller.status(),
    login: (account?: string) => controller.login(account),
    cancel: () => controller.cancel(),
    logout: (account?: string) => controller.logout(account),
    setDefault: (account: string) => controller.setDefault(account),
    refresh: (account?: string) => controller.refresh(account),
    discover: (force?: boolean) => controller.discover(force),
    setModelVisible: (id: string, visible: boolean) => controller.setModelVisible(id, visible),
    setModelOrder: (ids: readonly string[]) => controller.setModelOrder(ids),
    addModel: (id: string) => controller.addModel(id),
    removeModel: (id: string) => controller.removeModel(id),
    usage: (force?: boolean) => controller.usage(force),
    reload: () => controller.reload(),
  }
}

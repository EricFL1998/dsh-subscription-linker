/**
 * The `grok` provider route: xAI / X Premium (SuperGrok) subscription access.
 *
 * Login is an OIDC authorization-code flow with PKCE against `auth.x.ai`,
 * discovered from the issuer's well-known document and completed on a loopback
 * callback the CLI's registered client allows. Requests then go over xAI's
 * Responses endpoint, which the shared Responses translator already speaks.
 *
 * @module dsh-plugin-subscription-oauth/providers/grok
 */

import {
  errorChain,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ModelModality,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'

import { REAUTH_REQUIRED, ProviderError } from '../errors.js'
import { attributedHeaders } from '../auth/headers.js'
import { LoopbackFlow } from '../auth/pkce-flow.js'
import type { PkcePair } from '../auth/pkce-flow.js'
import { TokenStore, finiteInstant, nonEmpty } from '../auth/store.js'
import type { SessionBase } from '../auth/store.js'
import { TokenManager } from '../auth/tokens.js'
import { ProviderController } from '../auth/provider-controller.js'
import type { ProviderSpec } from '../auth/provider-controller.js'
import type { ProviderRoute } from '../auth/registry.js'
import type { ModelPreferences } from '../settings.js'
import { proxiedFetch } from '../http.js'
import type { FetchFn } from '../http.js'
import type { CatalogEntry } from './catalog.js'
import { fallbackEntry, findEntry, resolveCatalog } from './catalog.js'
import { isMissingOrInvalidCredential } from './common.js'
import { streamProviderResponses, accountPoolHooks } from './responses-stream.js'
import type { UsageWindow } from '../protocol.js'
import { readGrokUsage } from './usage.js'
import { toResponsesInput, toResponsesTools } from '../translate/responses.js'
import type { ImageResolver } from '../translate/responses.js'

/** Route key this module registers. */
export const GROK_PROVIDER_ID = 'grok'

/** Display name for selectors and diagnostics. */
export const GROK_PROVIDER_NAME = 'Grok (X Premium)'

/** Where a user manages the underlying subscription. */
export const GROK_CODE_URL = 'https://x.ai/grok'

/** OIDC issuer whose well-known document names the endpoints. */
export const GROK_ISSUER = 'https://auth.x.ai'

/** Discovery document URL. */
export const GROK_DISCOVERY_URL = `${GROK_ISSUER}/.well-known/openid-configuration`

/** The Grok CLI's registered client id. */
export const GROK_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'

/** Scopes the CLI requests; `grok-cli:access` is what admits subscription traffic. */
export const GROK_SCOPE = 'openid profile email offline_access grok-cli:access api:access'

/** The one loopback port the registered client redirects to. */
export const GROK_CALLBACK_PORT = 56121

/** Path the client redirects to. */
export const GROK_CALLBACK_PATH = '/callback'

/** API base; `<base>/responses` streams and `<base>/models` lists. */
export const GROK_API_BASE = 'https://api.x.ai/v1'

/** Optional CLI catalog that discloses per-model context and reasoning levels. */
export const GROK_CLI_MODELS_URL = 'https://cli-chat-proxy.grok.com/v1/models'

/** Context window assumed when neither the CLI catalog nor a seed states one. */
export const GROK_CONTEXT_WINDOW = 256_000

/** Default per-request output cap. */
export const GROK_DEFAULT_MAX_TOKENS = 32_000

/** Refresh when the access token has less than this much life left. */
export const GROK_PREEMPT_MS = 2 * 60 * 1000

/** Hosts an authorization server endpoint may live on. */
const TRUSTED_AUTH_HOSTS = new Set(['auth.x.ai', 'accounts.x.ai'])

/** The rung id the composer's quick-mode button selects. */
const FAST_RUNG = 'lightspeed'

/** Display metadata for the reasoning ladder xAI documents. */
const EFFORT_LABELS: Record<string, { name: string, description: string }> = {
  none: { name: 'Off', description: 'Answer without spending thinking tokens' },
  low: { name: 'Low', description: 'Short chain of thought' },
  medium: { name: 'Medium', description: 'Balanced thinking budget' },
  high: { name: 'High', description: 'Deep chain of thought' },
  // Not a thinking budget: this rung is the model's fast/lightspeed variant, which the
  // composer's quick-mode button selects. It rides the effort channel so the row keeps
  // its own id — a swapped model id would leave the picker with no way back. xAI's own
  // word for it is "lightspeed", which is what the rung is named here.
  [FAST_RUNG]: { name: 'Lightspeed', description: 'xAI lightspeed variant of this model' },
}

/**
 * Curated catalog entries.
 *
 * Seeds only what the provider's own documentation names; everything else the
 * account is entitled to arrives through live discovery, so a new model does not
 * need a plugin release.
 */
export const GROK_MODELS: readonly CatalogEntry[] = [
  {
    id: 'grok-4.6',
    name: 'Grok 4.6',
    description: 'Current flagship, reasoning levels from the live catalog',
    contextWindow: GROK_CONTEXT_WINDOW,
    inputModalities: ['text', 'image'],
  },
  {
    id: 'grok-4.5',
    name: 'Grok 4.5',
    description: 'Previous flagship',
    contextWindow: GROK_CONTEXT_WINDOW,
    inputModalities: ['text', 'image'],
  },
  {
    id: 'grok-4.7',
    name: 'Grok 4.7',
    description: 'Latest flagship with extended context',
    contextWindow: 500_000,
    inputModalities: ['text', 'image'],
  },
]

/** A stored Grok (X Premium) login. */
export interface GrokSession extends SessionBase {
  /** Token endpoint discovered at login time; used for later refresh. */
  tokenEndpoint: string
  /** Issuer the session was created against. */
  issuer: string
  /** Scopes the tokens were issued with, echoed on refresh. */
  scopes?: string
}

/**
 * Coerce one decoded credential entry into a Grok session.
 * @param value - decoded JSON value for one account.
 * @returns the session, or undefined when required fields are missing.
 */
export function parseGrokSession(value: unknown): GrokSession | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const accessToken = nonEmpty(record.accessToken)
  const tokenEndpoint = nonEmpty(record.tokenEndpoint)
  const expiresAt = finiteInstant(record.expiresAt)
  if (accessToken === undefined || tokenEndpoint === undefined || expiresAt === undefined) return undefined
  const refreshToken = nonEmpty(record.refreshToken)
  const issuer = nonEmpty(record.issuer)
  const scopes = nonEmpty(record.scopes)
  const accountId = nonEmpty(record.accountId)
  const email = nonEmpty(record.email)
  return {
    accessToken,
    expiresAt,
    tokenEndpoint,
    issuer: issuer ?? GROK_ISSUER,
    ...refreshToken === undefined ? {} : { refreshToken },
    ...scopes === undefined ? {} : { scopes },
    ...accountId === undefined ? {} : { accountId },
    ...email === undefined ? {} : { email },
  }
}

/** The discovered authorization-server endpoints. */
interface GrokEndpoints {
  authorizationEndpoint: string
  tokenEndpoint: string
}

/** One `reasoning.efforts` entry. */
function effortInfo(effort: string) {
  const label = EFFORT_LABELS[effort] ?? { name: effort, description: '' }
  return { id: ReasoningEffortId(effort), name: label.name, description: label.description }
}

/**
 * The reasoning block for a catalog entry, or undefined when it supports none.
 *
 * @param entry - the catalog row.
 * @param fast - add the `fast` rung when this row has a fast variant.
 */
function reasoningInfo(entry: CatalogEntry, fast = false) {
  const efforts = entry.reasoningEfforts
  const ids = fast ? [...efforts ?? [], FAST_RUNG] : efforts
  if (ids === undefined || ids.length === 0) return undefined
  return {
    efforts: ids.map(effortInfo),
    ...entry.defaultEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(entry.defaultEffort) },
  }
}

/** Reject an endpoint that is not an xAI HTTPS URL. */
function assertTrustedEndpoint(raw: string, field: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`xAI discovery returned an unparseable ${field}`)
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== ''
    || !TRUSTED_AUTH_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(`xAI discovery returned an untrusted ${field} (${url.hostname})`)
  }
  return url.toString()
}

/** Read one JWT payload, or undefined for an opaque token. */
function decodeJwt(token: string | undefined): Record<string, unknown> | undefined {
  if (token === undefined) return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1] as string, 'base64url').toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** Account identity from the id token, falling back to the access token. */
export function identityFromGrokTokens(
  accessToken: string,
  idToken?: string,
): { accountId?: string, email?: string } {
  const payload = decodeJwt(idToken) ?? decodeJwt(accessToken)
  const accountId = nonEmpty(payload?.sub)
  const email = nonEmpty(payload?.email)?.toLowerCase()
  return {
    ...accountId === undefined ? {} : { accountId },
    ...email === undefined ? {} : { email },
  }
}

/** One token-endpoint answer, normalised. */
interface GrokTokens {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  idToken?: string
}

/** Turn a token-endpoint payload into tokens with an absolute expiry. */
export function parseGrokTokenPayload(payload: unknown, previousRefreshToken?: string): GrokTokens {
  const record = (payload ?? {}) as Record<string, unknown>
  const accessToken = nonEmpty(record.access_token)
  const lifetime = record.expires_in
  const lifetimeOk = typeof lifetime === 'number' && Number.isFinite(lifetime) && lifetime >= 0
  if (accessToken === undefined || !lifetimeOk) {
    throw new Error('xAI token response missing required fields')
  }
  const expiresAt = Date.now() + lifetime * 1000
  if (!Number.isFinite(expiresAt)) throw new Error('xAI token response missing required fields')
  const refreshToken = nonEmpty(record.refresh_token) ?? previousRefreshToken
  const idToken = nonEmpty(record.id_token)
  return {
    accessToken,
    expiresAt,
    ...refreshToken === undefined ? {} : { refreshToken },
    ...idToken === undefined ? {} : { idToken },
  }
}

/** OIDC discovery, cached for the process. */
export function createGrokDiscovery(fetchFn: FetchFn, onWarn?: (message: string) => void): () => Promise<GrokEndpoints> {
  let cached: GrokEndpoints | undefined
  return async function discover(): Promise<GrokEndpoints> {
    if (cached !== undefined) return cached
    const response = await fetchFn(GROK_DISCOVERY_URL, { headers: { accept: 'application/json' } })
    if (!response.ok) {
      throw new Error(`xAI OIDC discovery failed (HTTP ${response.status})`)
    }
    const payload = await response.json() as { authorization_endpoint?: unknown, token_endpoint?: unknown }
    if (typeof payload.authorization_endpoint !== 'string' || typeof payload.token_endpoint !== 'string') {
      throw new Error('xAI OIDC discovery response is missing authorization/token endpoints')
    }
    const endpoints: GrokEndpoints = {
      authorizationEndpoint: assertTrustedEndpoint(payload.authorization_endpoint, 'authorization_endpoint'),
      tokenEndpoint: assertTrustedEndpoint(payload.token_endpoint, 'token_endpoint'),
    }
    onWarn?.(`xAI endpoints discovered (${new URL(endpoints.tokenEndpoint).host})`)
    cached = endpoints
    return endpoints
  }
}

/** Exchange an authorization code for tokens. */
export async function exchangeGrokCode(input: {
  fetchFn: FetchFn
  tokenEndpoint: string
  code: string
  redirectUri: string
  pkce: PkcePair
  signal: AbortSignal
}): Promise<GrokTokens> {
  const response = await input.fetchFn(input.tokenEndpoint, {
    method: 'POST',
    headers: { ...attributedHeaders(), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: GROK_CLIENT_ID,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.pkce.verifier,
      code_challenge: input.pkce.challenge,
      code_challenge_method: 'S256',
    }).toString(),
    signal: input.signal,
  })
  const payload = await response.json().catch(() => undefined) as unknown
  if (!response.ok) {
    const detail = (payload ?? {}) as Record<string, unknown>
    const described = nonEmpty(detail.error_description) ?? nonEmpty(detail.error)
    throw new Error(`xAI token exchange failed (HTTP ${response.status})${described === undefined ? '' : `: ${described}`}`)
  }
  return parseGrokTokenPayload(payload)
}

/** Redeem a refresh token. */
export async function refreshGrokToken(input: {
  fetchFn: FetchFn
  tokenEndpoint: string
  refreshToken: string
}): Promise<GrokTokens> {
  const response = await input.fetchFn(input.tokenEndpoint, {
    method: 'POST',
    headers: { ...attributedHeaders(), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: GROK_CLIENT_ID,
      refresh_token: input.refreshToken,
    }).toString(),
  })
  const payload = await response.json().catch(() => undefined) as unknown
  if (!response.ok) {
    const detail = (payload ?? {}) as Record<string, unknown>
    const described = nonEmpty(detail.error_description) ?? nonEmpty(detail.error)
    throw new ProviderError(
      `xAI token refresh failed (HTTP ${response.status})${described === undefined ? '' : `: ${described}`}`,
      REAUTH_REQUIRED,
    )
  }
  return parseGrokTokenPayload(payload, input.refreshToken)
}

/** One CLI-catalog entry's capability metadata. */
interface GrokCliMetadata {
  contextWindow?: number
  reasoningEfforts?: readonly string[]
  defaultEffort?: string
}

/** Model ids that are clearly not chat models. */
const NON_CHAT_ID = /(?:^|[-_/])(?:image|video|imagine|embed|embedding|whisper|tts|vision-only)/i

/** Model ids that are image-generation models, matched per provider's naming. */
const IMAGE_MODEL = /(?:^|[-_/])(?:image|imagine|draw|pic|photo)(?:[-_/]|$)/i

/** True when a model id names an image-generation model. */
export function isImageModel(id: string): boolean {
  return IMAGE_MODEL.test(id)
}

/**
 * Model ids that are the fast/lightspeed variant of a base model, matched per base.
 *
 * The vocabulary is the providers' own: xAI says `fast` (`grok-4.7-build-fast`), the
 * Claude/Codex world says `lightspeed` or `turbo`, and Kimi says `highspeed`
 * (`kimi-for-coding-highspeed`). A word has to stand on its own, so `highspeed` never
 * matches inside another word.
 */
const FAST_VARIANT = /(?:^|[-_@])(?:fast|lightspeed|turbo|quick|highspeed)(?=[-_@]|$)/i

/** True when a model id names a fast/lightspeed variant of a base model. */
export function isFastVariant(id: string): boolean {
  return FAST_VARIANT.test(id)
}

/**
 * Every prefix of one model id, longest first, down to its first token.
 *
 * `grok-4.7-build-fast` → [`grok-4.7-build`, `grok-4.7`, `grok`]. A fast variant pairs
 * with the longest prefix that is itself a listed model id, which is how
 * `grok-4.7-build-fast` lands on `grok-4.7` (its own prefix `grok-4.7-build` is not a
 * model) instead of inventing a base that no catalog row serves.
 *
 * @param id - model id.
 * @returns the candidate bases, longest first.
 */
export function baseCandidatesOf(id: string): readonly string[] {
  const out: string[] = []
  let at = id.length
  while (at > 0) {
    at = id.lastIndexOf('-', at - 1)
    if (at <= 0) break
    out.push(id.slice(0, at))
  }
  return out
}

/**
 * The base model id a fast variant belongs to, derived only from its own name.
 *
 * The fast token is removed, then any trailing generation qualifier (`build`, `beta`,
 * `rc`, …) left behind by that removal, then any `@Nk` context suffix. What remains is
 * the base (`grok-4.7-build-fast@500k` → `grok-4.7`, `kimi-for-coding-highspeed` →
 * `kimi-for-coding`). Whether the base is a real catalog row is the index's job, not
 * this function's.
 */
export function baseModelOf(id: string): string {
  return id
    .replace(FAST_VARIANT, '')
    .replace(/@\d+k$/i, '')
    .replace(/[-_]$/, '')
    .replace(/-(?:build|beta|alpha|rc|stable)$/i, '')
    .replace(/[-_]$/, '')
}

/**
 * The fast variant of one picker row, from either side of the pair.
 *
 * Shared by every route that discovers fast ids, so the composer's quick-mode button
 * behaves the same wherever a fast model is identifiable: it finds the pair when asked
 * about the base row, and when asked about the fast id itself — which is what the
 * selection becomes once the mode is on — so it can switch back off again.
 */
export class FastVariantIndex {
  private readonly byBase = new Map<string, string>()
  private readonly rowOfVariant = new Map<string, string>()
  private readonly knownIds = new Set<string>()

  /** Forget every pair and every known id, before re-reading a catalog. */
  clear(): void {
    this.byBase.clear()
    this.rowOfVariant.clear()
    this.knownIds.clear()
  }

  /**
   * Record one id the catalog listed.
   *
   * Listed ids are what a variant may pair with: the pair is the longest listed prefix
   * of the variant's own name, so nothing is invented that no row actually serves.
   *
   * @param id - a wire id from a catalog.
   */
  noteListed(id: string): void {
    this.knownIds.add(id)
  }

  /**
   * Pair one fast id with its base, purely from its own name.
   *
   * Every listed prefix of the id is a candidate base, longest first; the first one
   * that is itself a listed model wins. No curated alias or hardcoded map is needed:
   * a provider that names its variants after the base model pairs them automatically.
   *
   * @param id - a wire id the catalog named.
   * @returns the base id, or undefined when no listed prefix names one.
   */
  pair(id: string): string | undefined {
    if (!isFastVariant(id)) return undefined
    for (const base of baseCandidatesOf(id)) {
      if (this.knownIds.has(base)) return base
    }
    return undefined
  }

  /**
   * Record one id, if it names a fast variant.
   *
   * The first variant named for a row wins: a catalog that lists two spellings of the
   * same variant (`kimi-for-coding-highspeed` and `kimi-k2.7-code-highspeed`) offers
   * one button, and the earlier entry is the more specific one.
   *
   * @param id - a wire id from a catalog.
   * @param rowOf - maps a base id to the picker row that serves it, when the catalog
   *   spells the base differently from the variant's own prefix.
   */
  note(id: string, rowOf?: (base: string) => string | undefined): void {
    if (!isFastVariant(id)) return
    const base = baseModelOf(id)
    if (base.length === 0) return
    const row = rowOf?.(base) ?? base
    if (!this.byBase.has(row)) this.byBase.set(row, id)
    if (!this.rowOfVariant.has(id)) this.rowOfVariant.set(id, row)
  }

  /** The fast variant's wire id for one picker row, when the catalog named one. */
  variantOf(baseId: string): string | undefined {
    return this.byBase.get(baseId)
  }

  /** The pair one picker id belongs to, from either side. */
  pairOf(id: string): { baseId: string, wireId: string } | undefined {
    const direct = this.byBase.get(id)
    if (direct !== undefined) return { baseId: id, wireId: direct }
    const row = this.rowOfVariant.get(id)
    return row === undefined ? undefined : { baseId: row, wireId: id }
  }
}

/** A context-size suffix like `@500k` on a model id. */
const CONTEXT_SUFFIX = /@(\d+)k$/i

/** Extract the context size from a model id's `@Nk` suffix, or undefined. */
export function contextOf(id: string): number | undefined {
  const match = CONTEXT_SUFFIX.exec(id)
  return match ? parseInt(match[1]!, 10) : undefined
}

/** Strip the `@Nk` context suffix from a model id. */
export function stripContext(id: string): string {
  return id.replace(CONTEXT_SUFFIX, '')
}

/** Constructor dependencies for {@link GrokAdapter}. */
export interface GrokAdapterOptions {
  /** API base; `<base>/responses` and `<base>/models`. */
  apiBase: string
  /** Whether the live catalog is consulted. */
  discovery: boolean
  /** Inactivity budget before a stalled stream is abandoned. */
  streamIdleTimeoutMs: number
  tokens: TokenManager<GrokSession>
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
  /** Read one account's metered windows, so the streamer can steer away from a spent one. */
  readUsage?: ((account: string) => Promise<readonly UsageWindow[]>) | undefined
}

/** Grok wire adapter: one instance serves the `grok` provider route. */
export class GrokAdapter extends LlmAdapter {
  /** Live model ids seen this session. */
  private discovered: readonly string[] | undefined
  /** Capability metadata from the CLI catalog, keyed by model id. */
  private readonly metadata = new Map<string, GrokCliMetadata>()
  /** Fast-variant wire id per base model, for the picker's quick-mode button. */
  private readonly fastVariants = new FastVariantIndex()
  /** Image-generation model id, when discovery reported one. */
  private imageModel: string | undefined

  /** Ids the user added by hand, cached so the sync catalog can name them. */
  private userAddedIds: readonly string[] = []

  constructor(private readonly options: GrokAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: GROK_PROVIDER_NAME }
  }

  override providerRetryPolicy(): undefined {
    // xAI reports its own pacing through 429 `retry-after`.
    return undefined
  }

  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // Nothing to offer without a signed-in account: a model that cannot be called
    // must not appear in the picker, and Auto must not try it.
    if (await this.options.tokens.session() === undefined) return []
    await this.syncUserModels()
    const hidden = await this.hidden()
    // One row per model, always under the model's own id: the host validates every GUI
    // selection against this list, so publishing only the fast variant would leave the
    // picker with no way back to the standard model. Fast mode is the row's `fast`
    // reasoning rung instead (see `stream`).
    const imageless = this.catalog().filter((entry) => !isImageModel(entry.id))
    return resolveCatalog(imageless, [], hidden).entries.map((entry) => ({
      provider: GROK_PROVIDER_ID,
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

  override async resolveModel(_provider: string, model: string): Promise<LlmResolvedModelInfo> {
    await this.syncUserModels()
    // A fast variant is not a catalog row of its own: it answers with its base model's
    // metadata — the same 500k window, name and ladder the picker shows — while the id
    // stays the fast wire id the request must send.
    const pair = this.fastPairOf(model)
    const entry = findEntry(this.catalog(), model)
      ?? (pair === undefined ? undefined : findEntry(this.catalog(), pair.baseId))
    if (entry === undefined) {
      const template = findEntry(GROK_MODELS, 'grok-4.6')
      const reasoning = template === undefined ? undefined : reasoningInfo(template)
      return {
        provider: GROK_PROVIDER_ID,
        id: model,
        name: model,
        context: { contextWindow: GROK_CONTEXT_WINDOW },
        defaultMaxTokens: GROK_DEFAULT_MAX_TOKENS,
        ...reasoning === undefined ? {} : { reasoning },
      }
    }
    // A row with a fast variant offers the `fast` rung; the picker shows the row under
    // its own name and the mode as the effort, which is what the trigger already reads.
    const reasoning = reasoningInfo(entry, this.fastVariants.variantOf(entry.id) !== undefined)
    return {
      provider: GROK_PROVIDER_ID,
      id: model,
      name: entry.name,
      ...entry.description === undefined ? {} : { description: entry.description },
      ...entry.inputModalities === undefined ? {} : { inputModalities: entry.inputModalities },
      context: { contextWindow: entry.contextWindow },
      defaultMaxTokens: GROK_DEFAULT_MAX_TOKENS,
      ...reasoning === undefined ? {} : { reasoning },
    }
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // Resolve @Nk context suffixes to the largest variant the endpoint offers.
    const base = this.resolveModelId(options.model)
    // Fast mode rides the reasoning channel: `fast` is a rung of the row, not a model id
    // of its own, so the row the picker selected stays dispatchable and the user can
    // always select the standard model again. Only the wire id changes.
    const fast = String(options.reasoningEffort ?? '') === FAST_RUNG
    const model = fast ? this.fastVariants.variantOf(base) ?? base : base
    const call = { ...options, model }
    // xAI has no `fast` effort; the variant already carries the behaviour.
    if (fast) delete call.reasoningEffort
    return streamProviderResponses(call, {
      label: 'xAI API',
      tokens: this.options.tokens,
      request: (call, model, accessToken, signal) => this.request(call, model, accessToken, signal),
      streamIdleTimeoutMs: this.options.streamIdleTimeoutMs,
      // A 402/429 means this account's allowance is spent: draw on the next account's.
      isAllowanceExhausted: (status) => status === 402 || status === 429,
      ...accountPoolHooks({ provider: GROK_PROVIDER_ID, tokens: this.options.tokens, readUsage: this.options.readUsage }),
      ...this.options.onCredentialRejected === undefined
        ? {}
        : { onCredentialRejected: this.options.onCredentialRejected },
      onFallback: (from, to, reason) => {
        this.options.onWarn?.(`grok: model ${from} unavailable (${reason}); falling back to ${to}`)
      },
      describeFailure: (error) => (error instanceof ProviderError && error.code === REAUTH_REQUIRED
        ? new LlmError(
            `Grok (X Premium) login expired; sign in again from Settings → Subscriptions (${GROK_CODE_URL})`,
            'INVALID_CREDENTIAL',
            { status: 401 },
          )
        : error),
    })
  }

  /**
   * The catalog the route serves: its own entries, then the ids the user added
   * by hand. The two are built separately so the hand-added check can look at
   * the shipped list without recursing.
   */
  private catalog(): readonly CatalogEntry[] {
    return [...this.shippedCatalog(), ...this.addedEntries()]
  }

  /**
   * The catalog to present: curated seeds with their shipped metadata, then any
   * live id this build does not know, enriched from the CLI catalog when it
   * disclosed that model's context window or reasoning ladder.
   */
  private shippedCatalog(): readonly CatalogEntry[] {
    const extra: CatalogEntry[] = []
    const seen = new Set<string>()
    for (const id of this.discovered ?? []) {
      if (findEntry(GROK_MODELS, id) !== undefined || seen.has(id)) continue
      seen.add(id)
      const meta = this.metadata.get(id)
      extra.push({
        id,
        name: id,
        description: 'Reported by the xAI model list',
        contextWindow: meta?.contextWindow ?? GROK_CONTEXT_WINDOW,
        inputModalities: ['text', 'image'],
        // A ladder is advertised only when the provider's own catalog gave one.
        ...meta?.reasoningEfforts === undefined ? {} : { reasoningEfforts: meta.reasoningEfforts },
        ...meta?.defaultEffort === undefined ? {} : { defaultEffort: meta.defaultEffort },
      })
    }
    // The seeds also pick up live metadata (reasoning ladder, default effort). The
    // curated context window is never narrowed by a live figure: the CLI catalog states
    // 256k for `grok-4.7`, which serves 500k, and a live read may only widen what this
    // build ships.
    const seeded = GROK_MODELS.map((entry) => {
      const meta = this.metadata.get(entry.id)
      if (meta === undefined) return entry
      return {
        ...entry,
        contextWindow: Math.max(entry.contextWindow, meta.contextWindow ?? 0),
        ...meta.reasoningEfforts === undefined ? {} : { reasoningEfforts: meta.reasoningEfforts },
        ...meta.defaultEffort === undefined ? {} : { defaultEffort: meta.defaultEffort },
      }
    })
    return [...seeded, ...extra]
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
      .map((id) => fallbackEntry(id, 'Added by hand in Settings', GROK_CONTEXT_WINDOW))
  }

  /** Record the live catalog for the picker. */
  discover(ids: readonly string[], metadata?: ReadonlyMap<string, GrokCliMetadata>): void {
    this.discovered = ids
    if (metadata === undefined) return
    for (const [id, meta] of metadata) this.metadata.set(id, meta)
  }

  /** The fast/lightspeed variant wire id for a base model, when discovery reported one. */
  fastVariant(baseId: string): string | undefined {
    return this.fastVariants.variantOf(baseId)
  }

  /** The fast pair one picker id belongs to, from either side. */
  fastPairOf(id: string): { baseId: string, wireId: string } | undefined {
    return this.fastVariants.pairOf(id)
  }

  /** The image-generation model id, when discovery reported one. */
  imageModelId(): string | undefined {
    return this.imageModel
  }

  /** The curated catalog, for the Settings page's model list. */
  catalogEntries(): readonly CatalogEntry[] {
    return this.catalog()
  }

  /** What this route itself serves, without the ids added by hand. */
  ownCatalogEntries(): readonly CatalogEntry[] {
    return this.shippedCatalog()
  }

  /** Build and send one request for one model. */
  /** The default context variant per base model, set during discovery. */
  private defaultContext = new Map<string, string>()

  /** Resolve a model id to the wire id the endpoint accepts (largest context). */
  resolveModelId(model: string): string {
    return this.defaultContext.get(model) ?? model
  }

  /** Record one default-context mapping. */
  private noteContextVariant(base: string, context: number, wireId: string): void {
    const existing = this.defaultContext.get(base)
    if (existing !== undefined) {
      const existingCtx = contextOf(existing)
      if (existingCtx !== undefined && existingCtx >= context) return
    }
    this.defaultContext.set(base, wireId)
  }

  private async request(
    options: GenerateOptions,
    model: string,
    accessToken: string,
    signal: AbortSignal,
  ): Promise<Response> {
    const resolved = await toResponsesInput(options.messages, options.system, this.imageResolver(signal))
    const body: Record<string, unknown> = {
      model,
      ...resolved.instructions === undefined ? {} : { instructions: resolved.instructions },
      input: resolved.input,
      ...options.tools === undefined || options.tools.length === 0
        ? {}
        : { tools: toResponsesTools(options.tools), tool_choice: 'auto', parallel_tool_calls: true },
      ...options.maxTokens === undefined ? {} : { max_output_tokens: options.maxTokens },
      ...options.reasoningEffort === undefined
        ? {}
        : { reasoning: { effort: String(options.reasoningEffort) } },
      // Cache-affinity hint: xAI routes a repeated request back to the shard
      // holding its prompt cache only when the same key returns.
      ...options.sessionId === undefined ? {} : { prompt_cache_key: String(options.sessionId) },
      store: false,
      stream: true,
    }
    const fetchFn = this.options.fetchFn ?? proxiedFetch
    return fetchFn(`${this.options.apiBase}/responses`, {
      method: 'POST',
      headers: attributedHeaders({
        'authorization': `Bearer ${accessToken}`,
        'accept': 'text/event-stream',
        'content-type': 'application/json',
      }),
      body: JSON.stringify(body),
      signal,
    })
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
   * Read the live model list, and the CLI catalog's capability metadata.
   * @param accessToken - bearer for the account's models.
   * @returns the model ids, or undefined when discovery is off or unavailable.
   */
  async fetchCatalog(accessToken: string, signal?: AbortSignal): Promise<readonly string[] | undefined> {
    if (!this.options.discovery) return undefined
    const fetchFn = this.options.fetchFn ?? proxiedFetch
    try {
      const response = await fetchFn(`${this.options.apiBase}/models`, {
        headers: attributedHeaders({ 'authorization': `Bearer ${accessToken}` }),
        ...signal === undefined ? {} : { signal },
      })
      if (!response.ok) {
        // A refused credential is reported by the card's account list; only a
        // genuine discovery failure is worth a warning.
        if (response.status !== 401 && response.status !== 403) {
          this.options.onWarn?.(`xAI model discovery failed (HTTP ${response.status}); using the built-in catalog`)
        }
        return undefined
      }
      const payload = await response.json() as { data?: { id?: unknown }[] }
      const allIds = (payload.data ?? [])
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
      // Image models are not chat models; they are picked by an agent, not the picker.
      this.imageModel = allIds.find((id) => isImageModel(id))
      const rawIds = allIds.filter((id) => !NON_CHAT_ID.test(id))
      // Fast/lightspeed variants ride with their base model: they share the base's
      // visibility switch and are reached by a picker button, not a separate row.
      // Context variants (@500k) also fold into the base; the largest context wins.
      this.fastVariants.clear()
      this.defaultContext.clear()
      for (const id of rawIds) {
        this.fastVariants.noteListed(id)
      }
      this.noteWireVariants(rawIds)
      const ids = rawIds
        .map((id) => {
          if (isFastVariant(id)) return this.fastVariants.pair(id) ?? baseModelOf(id)
          const ctx = contextOf(id)
          if (ctx !== undefined) return stripContext(id)
          return id
        })
        .filter((id, index, list) => list.indexOf(id) === index)
      if (ids.length === 0) {
        this.options.onWarn?.('xAI model discovery returned an empty catalog; using the built-in catalog')
        return undefined
      }
      const cli = await this.readCliCatalog(fetchFn, signal, accessToken)
      for (const [id, meta] of cli.metadata) this.metadata.set(id, meta)
      // The account's own CLI catalog is the only surface that names a fast variant:
      // the public `/models` list omits `grok-4.7-build-fast` entirely. Its ids fold
      // into the same base rows, and are never added as picker rows of their own.
      for (const id of cli.ids) {
        this.fastVariants.noteListed(id)
      }
      this.noteWireVariants(cli.ids)
      return ids
    } catch (error: unknown) {
      if (signal?.aborted === true) return undefined
      this.options.onWarn?.(`xAI model discovery failed; using the built-in catalog (${errorChain(error)})`)
      return undefined
    }
  }

  /**
   * Fold the fast and context variants of one id list into their base models.
   *
   * @param ids - wire ids to classify.
   */
  private noteWireVariants(ids: readonly string[]): void {
    for (const id of ids) {
      if (NON_CHAT_ID.test(id) || isImageModel(id)) continue
      if (isFastVariant(id)) {
        // Pair with the longest listed prefix, not a derived string: the prefix is a
        // model the account actually serves, so the button always targets a real row.
        const base = this.fastVariants.pair(id)
        this.fastVariants.note(id, () => base)
        continue
      }
      const ctx = contextOf(id)
      if (ctx !== undefined) this.noteContextVariant(stripContext(id), ctx, id)
    }
  }

  /**
   * Read per-model capabilities from the CLI catalog; failures are silent.
   *
   * The catalog answers only for the signed-in account's own bearer — an anonymous
   * request is refused — and it, unlike the public `/models` list, names the account's
   * fast variant.
   *
   * @param fetchFn - fetch implementation.
   * @param signal - caller cancellation.
   * @param accessToken - the account's bearer.
   * @returns the capability metadata and every id the catalog named.
   */
  private async readCliCatalog(
    fetchFn: FetchFn,
    signal: AbortSignal | undefined,
    accessToken: string,
  ): Promise<{ metadata: Map<string, GrokCliMetadata>, ids: readonly string[] }> {
    const result = new Map<string, GrokCliMetadata>()
    const ids: string[] = []
    try {
      const response = await fetchFn(GROK_CLI_MODELS_URL, {
        headers: attributedHeaders({ 'authorization': `Bearer ${accessToken}` }),
        ...signal === undefined ? {} : { signal },
      })
      if (!response.ok) return { metadata: result, ids }
      const payload = await response.json() as {
        data?: {
          id?: unknown
          context_window?: unknown
          supports_reasoning_effort?: unknown
          reasoning_effort?: unknown
          reasoning_efforts?: { value?: unknown }[]
        }[]
      }
      for (const entry of payload.data ?? []) {
        const id = typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : undefined
        if (id === undefined) continue
        ids.push(id)
        const contextWindow = typeof entry.context_window === 'number' && Number.isFinite(entry.context_window)
          ? entry.context_window
          : undefined
        const supportsEffort = entry.supports_reasoning_effort === true
        const efforts = supportsEffort
          ? (entry.reasoning_efforts ?? [])
              .map((effort) => effort.value)
              .filter((value): value is string => typeof value === 'string' && value.length > 0)
          : []
        const defaultEffort = supportsEffort && typeof entry.reasoning_effort === 'string'
          && efforts.includes(entry.reasoning_effort)
          ? entry.reasoning_effort
          : undefined
        result.set(id, {
          ...contextWindow === undefined ? {} : { contextWindow },
          ...efforts.length === 0 ? {} : { reasoningEfforts: efforts },
          ...defaultEffort === undefined ? {} : { defaultEffort },
        })
      }
    } catch {
      // Capability metadata is a bonus; the id list is what matters.
    }
    return { metadata: result, ids }
  }
}

/** Everything the `grok` route needs from the plugin configuration. */
export interface GrokProviderOptions {
  /** Absolute path of `auth.json`. */
  credentialFile: string
  /** API base; `<base>/responses` and `<base>/models`. */
  apiBase?: string
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
  /** Fetch implementation; defaults to the proxy-aware fetch. */
  fetchFn?: FetchFn
  /** Discovery fetch override, for tests. */
  discoveryFetchFn?: FetchFn
}

/**
 * Build the `grok` route: its adapter and its login/lifecycle controller.
 *
 * @param options - resolved paths and shared services.
 * @returns the route, ready to register and to serve over RPC.
 */
export function createGrokProvider(options: GrokProviderOptions): ProviderRoute {
  const fetchFn = options.fetchFn ?? proxiedFetch
  const apiBase = options.apiBase ?? GROK_API_BASE
  const store = new TokenStore<GrokSession>(options.credentialFile, GROK_PROVIDER_ID, parseGrokSession)
  const discoverEndpoints = createGrokDiscovery(fetchFn, options.onWarn)
  /** Endpoints resolved by `prepare`, read synchronously while building URLs. */
  let endpointsSnapshot: GrokEndpoints | undefined

  const flow = new LoopbackFlow<GrokSession>(GROK_PROVIDER_ID, {
    ports: [GROK_CALLBACK_PORT],
    callbackPath: GROK_CALLBACK_PATH,
    prepare: async () => { endpointsSnapshot = await discoverEndpoints() },
    buildAuthorizeUrl: ({ redirectUri, state, pkce }) => {
      // `prepare` has already resolved and cached the endpoints.
      const endpoints = endpointsSnapshot
      if (endpoints === undefined) throw new Error('xAI endpoints were not discovered')
      const url = new URL(endpoints.authorizationEndpoint)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('client_id', GROK_CLIENT_ID)
      url.searchParams.set('redirect_uri', redirectUri)
      url.searchParams.set('scope', GROK_SCOPE)
      url.searchParams.set('state', state)
      url.searchParams.set('code_challenge', pkce.challenge)
      url.searchParams.set('code_challenge_method', 'S256')
      return url.toString()
    },
    exchange: async ({ code, redirectUri, pkce, signal }) => {
      const endpoints = endpointsSnapshot ?? await discoverEndpoints()
      const tokens = await exchangeGrokCode({
        fetchFn,
        tokenEndpoint: endpoints.tokenEndpoint,
        code,
        redirectUri,
        pkce,
        signal,
      })
      return {
        accessToken: tokens.accessToken,
        ...tokens.refreshToken === undefined ? {} : { refreshToken: tokens.refreshToken },
        expiresAt: tokens.expiresAt,
        tokenEndpoint: endpoints.tokenEndpoint,
        issuer: GROK_ISSUER,
        scopes: GROK_SCOPE,
        ...identityFromGrokTokens(tokens.accessToken, tokens.idToken),
      }
    },
  })

  const tokens = new TokenManager<GrokSession>({
    store,
    displayName: GROK_PROVIDER_NAME,
    preemptMs: GROK_PREEMPT_MS,
    refresh: async (session) => {
      const refreshToken = session.refreshToken
      if (refreshToken === undefined) {
        throw new ProviderError(`${GROK_PROVIDER_NAME} account has no refresh token; sign in again`, REAUTH_REQUIRED)
      }
      const refreshed = await refreshGrokToken({
        fetchFn,
        tokenEndpoint: session.tokenEndpoint,
        refreshToken,
      })
      return {
        accessToken: refreshed.accessToken,
        expiresAt: refreshed.expiresAt,
        ...refreshed.refreshToken === undefined ? {} : { refreshToken: refreshed.refreshToken },
      }
    },
  })

  const adapter = new GrokAdapter({
    apiBase,
    discovery: options.discovery,
    streamIdleTimeoutMs: options.streamIdleTimeoutMs,
    tokens,
    ...options.onWarn === undefined ? {} : { onWarn: options.onWarn },
    ...options.resolveAttachments === undefined ? {} : { resolveAttachments: options.resolveAttachments },
    hiddenModels: () => options.preferences.hiddenIds(GROK_PROVIDER_ID),
    userModels: () => options.preferences.extraIds(GROK_PROVIDER_ID),
    modelOrder: () => options.preferences.orderOf(GROK_PROVIDER_ID),
    readUsage: async (account) => {
      const token = await tokens.resolve(account)
      const read = await readGrokUsage({ accessToken: token.accessToken, fetchFn: options.discoveryFetchFn ?? proxiedFetch })
      return read === undefined ? [] : read.windows
    },
    ...options.discoveryFetchFn === undefined ? {} : { fetchFn: options.discoveryFetchFn },
  })

  const spec: ProviderSpec<GrokSession> = {
    id: GROK_PROVIDER_ID,
    displayName: GROK_PROVIDER_NAME,
    codeUrl: GROK_CODE_URL,
    credentialFile: options.credentialFile,
    discovery: options.discovery,
    defaultModel: 'grok-4.6',
    catalog: () => adapter.catalogEntries(),
    catalogOwn: () => adapter.ownCatalogEntries(),
    fallbackContextWindow: GROK_CONTEXT_WINDOW,
    discover: (accessToken) => adapter.fetchCatalog(accessToken),
    usage: (accessToken) => readGrokUsage({ accessToken, fetchFn: options.discoveryFetchFn ?? fetchFn }),
    details: () => [
      { key: 'oauthHost', value: GROK_ISSUER },
      { key: 'apiBase', value: apiBase },
      { key: 'credentialFile', value: options.credentialFile },
    ],
    applyDiscovery: (ids) => { adapter.discover(ids) },
    fastVariant: (baseId) => adapter.fastVariant(baseId),
  }

  const controller = new ProviderController<GrokSession>({
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
    modelVariants: (id: string) => {
      const pair = adapter.fastPairOf(id)
      const image = adapter.imageModelId()
      return {
        ...pair === undefined ? {} : { fast: pair.wireId, fastBase: pair.baseId, fastRung: 'lightspeed' },
        ...image === undefined ? {} : { image },
      }
    },
  }
}

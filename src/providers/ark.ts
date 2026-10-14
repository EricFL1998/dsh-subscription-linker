/**
 * The `ark` route: Volcengine Ark's Coding Plan over the OpenAI Responses wire.
 *
 * Everything in this module is pinned to what the endpoints themselves said:
 *
 * - `POST /api/coding/v3/responses` exists and wants a credential (401).
 * - It accepts a **bearer Ark API key** and nothing else. An SSO identity token in
 *   the same header is refused with `403 Unsupported zti authentication method`,
 *   and an AK/SK signature with `403 Unsupported aksk authentication method`, while
 *   a UUID-shaped key is looked up (`401 The API key doesn't exist`) and a
 *   malformed one is told so (`401 The API key format is incorrect`). So the
 *   credential is a UUID key, sent as a plain bearer — no request signing.
 * - `/api/coding/v3` is documented by the official CLI as "OpenTOP + CodingPlan
 *   API", and its `/models` listing — read once and kept in this plugin's cache, see
 *   `hydrate` and `fetchCatalog` — is the roster this route publishes. Nothing in this
 *   module decides which models the plan serves, so one released, renamed or retired
 *   server-side reaches the picker without a plugin update.
 *
 * @module dsh-plugin-subscription-oauth/providers/ark
 */

import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'

import { REAUTH_REQUIRED, ProviderError } from '../errors.js'
import { finiteInstant, nonEmpty } from '../auth/store.js'
import type { SessionBase } from '../auth/store.js'
import type { TokenManager } from '../auth/tokens.js'
import { callArkControl, parseArkFreeUsage, parseArkPlanUsage } from '../auth/ark-control.js'
import type { ArkPlanUsage, ArkStsCredentials } from '../auth/ark-control.js'
import { proxiedFetch } from '../http.js'
import type { FetchFn } from '../http.js'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { UsageWindow } from '../protocol.js'
import type { CatalogEntry, LiveModelFacts } from './catalog.js'
import { composeCatalog, fallbackEntry, findEntry, liveEntry, liveModelFacts, resolveCatalog } from './catalog.js'
import { streamProviderResponses, accountPoolHooks } from './responses-stream.js'
import { toResponsesInput, toResponsesTools } from '../translate/responses.js'
import type { ImageResolver } from '../translate/responses.js'
import type { UsageRead } from './usage.js'
import { baseModelOf, FastVariantIndex, isFastVariant, isImageModel } from './grok.js'

/** Model ids that are clearly not chat models. */
const NON_CHAT_ID = /(?:^|[-_/])(?:image|video|imagine|embed|embedding|whisper|tts|vision-only)/i

/** Provider route this module serves. */
export const ARK_PROVIDER_ID = 'ark'

/** Display name for the picker group and the Settings card. */
export const ARK_PROVIDER_NAME = 'Volcengine Ark'

/** Page a user opens to manage the plan. */
export const ARK_CODE_URL = 'https://console.volcengine.com/ark/region:ark+cn-beijing/overview'

/** Coding-plan base; the Responses endpoint is `<base>/responses`. */
export const ARK_API_BASE = 'https://ark.cn-beijing.volces.com/api/coding/v3'

/** Origin the account-level endpoints hang off. */
export const ARK_ORIGIN = 'https://ark.cn-beijing.volces.com'

/** Path appended to the API base for a streaming request. */
export const ARK_RESPONSES_PATH = '/responses'

/** Model the picker preselects: the plan's own alias for its coding model. */
export const ARK_DEFAULT_MODEL = 'ark-code-latest'

/**
 * Context capacity advertised for the plan's models.
 *
 * The plan states no window in this build; the endpoint's own listing supplies one
 * where it names a model, and discovery refines this where it does not.
 */
export const ARK_CONTEXT_WINDOW = 262_144

/** Output budget used when the caller sets no cap. */
export const ARK_DEFAULT_MAX_TOKENS = 32_000

/** One signed-in Ark account. */
export interface ArkSession extends SessionBase {
  /**
   * The plan's API key.
   *
   * The data plane takes this as a plain bearer; the SSO identity token authorises
   * the control plane that mints it, so the key — not the identity token — is what
   * every model request carries.
   */
  apiKey: string
  /**
   * Temporary STS credentials, used to sign control-plane calls.
   *
   * The SSO endpoint returns these in its `access_token`, which is where the plan
   * allowance is read from; without them the route still serves models but states
   * no quota.
   */
  sts?: ArkStsCredentials
  /** Identity token the key was minted under, for the control plane. */
  idToken?: string
  /** API base recorded at login time (diagnostics only). */
  apiBase?: string
}

/**
 * Coerce one decoded credential entry into an Ark session.
 *
 * @param value - decoded JSON value for one account.
 * @returns the session, or undefined when required fields are missing.
 */
export function parseArkSession(value: unknown): ArkSession | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const apiKey = nonEmpty(record.apiKey)
  const expiresAt = finiteInstant(record.expiresAt)
  if (apiKey === undefined || expiresAt === undefined) return undefined
  const idToken = nonEmpty(record.idToken)
  const refreshToken = nonEmpty(record.refreshToken)
  const apiBase = nonEmpty(record.apiBase)
  const accountId = nonEmpty(record.accountId)
  const email = nonEmpty(record.email)
  const sts = stsFromSession(record.sts)
  return {
    // The data plane carries the API key; `accessToken` is the same value so the
    // shared token machinery has one bearer to resolve.
    accessToken: apiKey,
    apiKey,
    expiresAt,
    ...sts === undefined ? {} : { sts },
    ...idToken === undefined ? {} : { idToken },
    ...refreshToken === undefined ? {} : { refreshToken },
    ...apiBase === undefined ? {} : { apiBase },
    ...accountId === undefined ? {} : { accountId },
    ...email === undefined ? {} : { email },
  }
}

/** Read a stored STS credential set, tolerating a partial one. */
function stsFromSession(value: unknown): ArkStsCredentials | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const accessKeyId = nonEmpty(record.accessKeyId)
  const secretAccessKey = nonEmpty(record.secretAccessKey)
  const sessionToken = nonEmpty(record.sessionToken)
  const expiresAt = finiteInstant(record.expiresAt)
  if (accessKeyId === undefined || secretAccessKey === undefined || sessionToken === undefined || expiresAt === undefined) {
    return undefined
  }
  return { accessKeyId, secretAccessKey, sessionToken, expiresAt }
}

/** Everything the adapter needs from the route. */
export interface ArkAdapterOptions {
  apiBase: string
  discovery: boolean
  streamIdleTimeoutMs: number
  tokens: TokenManager<ArkSession>
  hiddenModels?: () => Promise<ReadonlySet<string>> | ReadonlySet<string>
  userModels?: () => Promise<readonly string[]> | readonly string[]
  extraModels?: readonly string[]
  /**
   * Model this route preselects, and therefore always offers.
   *
   * Configuration rather than a shipped fact: the plan re-points its alias at a new
   * release on its own schedule, and the picker must be able to preselect it. Defaults
   * to {@link ARK_DEFAULT_MODEL}.
   */
  defaultModel?: string
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
  resolveAttachments?: () => AttachmentStore | undefined
  onWarn?: (message: string) => void
  onCredentialRejected?: (account: string) => void
  /** Read one account's metered windows, so the streamer can steer away from a spent one. */
  readUsage?: ((account: string) => Promise<readonly UsageWindow[]>) | undefined
  fetchFn?: FetchFn
}

/**
 * The rows of one cached listing.
 *
 * The cache holds the rows this plugin stored; a payload written as the endpoint's own
 * envelope is read too, so a differently shaped cache cannot silently empty the picker.
 *
 * @param payload - whatever `cachedListing` returned.
 * @returns the rows to adopt, or an empty list when the payload names none.
 */
function listingRows(payload: unknown): readonly unknown[] {
  if (Array.isArray(payload)) return payload
  const data = typeof payload === 'object' && payload !== null
    ? (payload as { data?: unknown }).data
    : undefined
  return Array.isArray(data) ? data : []
}

/** The adapter behind the `ark` route. */
export class ArkAdapter extends LlmAdapter {
  /**
   * The catalog this route serves: entries derived from the endpoint's own listing,
   * either the one just read or the one the cache kept from the last read.
   *
   * Undefined means neither source has produced a listing yet, so only the configured
   * default model is offered until one does.
   */
  private live: readonly CatalogEntry[] | undefined
  /** Whether the cached listing has been read; it is read at most once per session. */
  private hydrated = false
  /** Image-generation model id, when the listing reported one. */
  private imageModel: string | undefined
  /**
   * Fast-variant wire id per picker row.
   *
   * Derived from the listing rather than a curated alias map: a row whose name is a
   * listed model plus the provider's own fast word rides that row instead of becoming
   * one of its own.
   */
  private readonly fastVariants = new FastVariantIndex()

  constructor(private readonly options: ArkAdapterOptions) {
    super()
  }

  /**
   * Adopt the rows of one live listing as this route's catalog.
   *
   * Everything the picker shows is derived here from the endpoint's own answer: the
   * rows that become picker entries and the fast variant that pairs with each row.
   * Nothing about which models exist, or what each one is, is decided by this build.
   *
   * @param rows - decoded rows of the endpoint's listing, in the endpoint's order.
   * @returns the entries to publish, in picker order.
   */
  private adoptListing(rows: readonly unknown[]): readonly CatalogEntry[] {
    const facts = rows
      .map((row) => liveModelFacts(row))
      .filter((fact): fact is LiveModelFacts => fact !== undefined)
    // Image models are never picker rows: they are agent-called, always on.
    this.imageModel = facts.find((fact) => isImageModel(fact.id))?.id
    this.fastVariants.clear()
    for (const fact of facts) this.fastVariants.noteListed(fact.id)
    for (const fact of facts) {
      const base = this.fastVariants.pair(fact.id)
      this.fastVariants.note(fact.id, () => base ?? baseModelOf(fact.id))
    }
    // Fold a variant onto its row and drop the ids that are not chat models, keeping the
    // endpoint's order. A row's own facts describe the row; a variant's describe the
    // variant, so a row that is also listed is never overwritten by its variant.
    const byId = new Map<string, LiveModelFacts>()
    for (const fact of facts) {
      if (NON_CHAT_ID.test(fact.id)) continue
      const id = isFastVariant(fact.id) ? this.fastVariants.pair(fact.id) ?? baseModelOf(fact.id) : fact.id
      if (id === fact.id || !byId.has(id)) byId.set(id, { ...fact, id })
    }
    return [...byId.values()].map((fact) =>
      liveEntry(fact, [], ARK_CONTEXT_WINDOW, 'Reported by the Ark model list'))
  }

  /**
   * Read the cached listing, once, so the picker works without asking the endpoint.
   *
   * Called before the first catalog query. A read failure is a cache miss, never a
   * failure: the route simply has no listing until one is fetched.
   */
  async hydrate(): Promise<void> {
    if (this.hydrated) return
    this.hydrated = true
    if (this.live !== undefined || this.options.cachedListing === undefined) return
    try {
      const rows = listingRows(await this.options.cachedListing())
      if (rows.length > 0) this.live = this.adoptListing(rows)
    } catch (error: unknown) {
      this.options.onWarn?.(`cached model catalog unavailable (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: ARK_PROVIDER_NAME }
  }

  override providerRetryPolicy(): undefined {
    return undefined
  }

  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // Nothing to offer without a signed-in account: a model that cannot be called
    // must not appear in the picker, and Auto must not try it.
    if (await this.options.tokens.session() === undefined) return []
    await this.hydrate()
    const hidden = await this.hidden()
    // Image models are never picker rows: they are agent-called, always on.
    const imageless = this.catalog().filter((entry) => !isImageModel(entry.id))
    return resolveCatalog(imageless, [], hidden).entries.map((entry) => ({
      provider: ARK_PROVIDER_ID,
      id: entry.id,
      name: entry.name,
      ...entry.description === undefined ? {} : { description: entry.description },
      ...entry.inputModalities === undefined ? {} : { inputModalities: entry.inputModalities },
    }))
  }

  /** The image-generation model id, when discovery reported one. */
  imageModelId(): string | undefined {
    return this.imageModel
  }

  /**
   * Whether this route has read a model listing yet.
   *
   * The image model is a row of the listing, so until one has been read "there is no image
   * model" and "the listing has not arrived" look identical from outside; a caller that asks
   * once needs to tell them apart.
   */
  hasListing(): boolean {
    return this.live !== undefined
  }

  override async resolveModel(_provider: string, model: string): Promise<LlmResolvedModelInfo> {
    await this.hydrate()
    const entry = findEntry(this.catalog(), model)
    if (entry === undefined) {
      const template = findEntry(this.catalog(), this.defaultModel()) ?? this.catalog()[0]
      return {
        provider: ARK_PROVIDER_ID,
        id: model,
        name: model,
        context: { contextWindow: template?.contextWindow ?? ARK_CONTEXT_WINDOW },
        defaultMaxTokens: ARK_DEFAULT_MAX_TOKENS,
      }
    }
    const reasoning = reasoningInfo(entry)
    return {
      provider: ARK_PROVIDER_ID,
      id: entry.id,
      name: entry.name,
      ...entry.description === undefined ? {} : { description: entry.description },
      ...entry.inputModalities === undefined ? {} : { inputModalities: entry.inputModalities },
      context: { contextWindow: entry.contextWindow },
      defaultMaxTokens: ARK_DEFAULT_MAX_TOKENS,
      ...reasoning === undefined ? {} : { reasoning },
    }
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return streamProviderResponses(options, {
      label: 'Ark API',
      tokens: this.options.tokens,
      request: (call, model, accessToken, signal) => this.request(call, model, accessToken, signal),
      streamIdleTimeoutMs: this.options.streamIdleTimeoutMs,
      // A 402/429 means this account's allowance is spent: draw on the next account's.
      isAllowanceExhausted: (status) => status === 402 || status === 429,
      ...accountPoolHooks({ provider: ARK_PROVIDER_ID, tokens: this.options.tokens, readUsage: this.options.readUsage }),
      ...this.options.onCredentialRejected === undefined
        ? {}
        : { onCredentialRejected: this.options.onCredentialRejected },
      onFallback: (from, to, reason) => {
        this.options.onWarn?.(`ark: model ${from} unavailable (${reason}); falling back to ${to}`)
      },
      describeFailure: (error) => this.refreshHint(error),
    })
  }

  /** Translate an auth failure into the message a user can act on. */
  private refreshHint(error: unknown): unknown {
    if (error instanceof ProviderError && error.code === REAUTH_REQUIRED) {
      return new LlmError(
        `Ark sign-in expired; connect the account again from Settings → Subscriptions (${ARK_CODE_URL})`,
        'INVALID_CREDENTIAL',
        { status: 401 },
      )
    }
    return error
  }

  private catalog(): readonly CatalogEntry[] {
    return [...this.shippedCatalog(), ...this.addedEntries()]
  }

  /**
   * The catalog to present: the models the endpoint's listing named, in its own order,
   * each with the metadata that listing stated, then the configured extras.
   *
   * There is no shipped roster. A listing is read once and cached (see {@link hydrate}
   * and {@link fetchCatalog}), and that cached table is what the picker shows until the
   * next read, so a model released, renamed or retired server-side is reflected without
   * a plugin update. Only the configured default is always offered, because the picker
   * preselects it.
   */
  private shippedCatalog(): readonly CatalogEntry[] {
    return composeCatalog({
      curated: [],
      ...this.live === undefined ? {} : { live: this.live },
      ...this.options.extraModels === undefined ? {} : { extra: this.options.extraModels },
      defaultModel: this.defaultModel(),
      fallbackContextWindow: ARK_CONTEXT_WINDOW,
      liveDescription: 'Reported by the Ark model list',
      extraDescription: 'Extra model from the plugin configuration',
    })
  }

  /** The model the picker preselects, from configuration. */
  private defaultModel(): string {
    return this.options.defaultModel ?? ARK_DEFAULT_MODEL
  }

  private addedEntries(): readonly CatalogEntry[] {
    const own = this.shippedCatalog()
    const added = this.options.userModels?.()
    if (added === undefined) return []
    return (Array.isArray(added) ? added : [])
      .filter((id) => findEntry(own, id) === undefined)
      .map((id) => fallbackEntry(id, 'Added by hand in Settings', ARK_CONTEXT_WINDOW))
  }

  private async hidden(): Promise<ReadonlySet<string>> {
    if (this.options.hiddenModels === undefined) return new Set()
    try {
      return await this.options.hiddenModels()
    } catch {
      return new Set()
    }
  }

  /**
   * Adopt the ids a caller reports as the served set, without a listing.
   *
   * {@link fetchCatalog} already derived the entries from the rows it read, and the
   * controller reports those same ids back here; the entries it recorded are kept. A
   * caller that only has ids (a test, another discovery path) gets conservative entries
   * for them.
   *
   * @param ids - model ids the caller reports.
   */
  discover(ids: readonly string[]): void {
    const known = new Map((this.live ?? []).map((entry) => [entry.id, entry]))
    this.live = ids.map((id) => known.get(id)
      ?? liveEntry({ id }, [], ARK_CONTEXT_WINDOW, 'Reported by the Ark model list'))
  }

  /**
   * Read the plan's live model list and adopt it as this route's catalog.
   *
   * The Coding Plan answers the OpenAI models shape on its own base, so the rows are
   * parsed exactly as the other routes parse theirs: what the listing names is what the
   * picker offers, with the display name, window, modalities and ladder it states. The
   * rows are also handed to {@link ArkAdapterOptions.saveListing}, so the next session
   * starts from this table instead of asking again — the Settings "refresh models"
   * action is what re-reads it.
   *
   * @param apiKey - bearer for the account.
   * @param signal - optional cancellation.
   * @returns the model ids now served, or undefined when the listing is unavailable.
   */
  async fetchCatalog(apiKey: string, signal?: AbortSignal): Promise<readonly string[] | undefined> {
    if (!this.options.discovery) return undefined
    const fetchFn = this.options.fetchFn ?? proxiedFetch
    try {
      const response = await fetchFn(`${this.options.apiBase}/models`, {
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        ...signal === undefined ? {} : { signal },
      })
      if (!response.ok) {
        this.options.onWarn?.(`Ark model list unavailable (HTTP ${response.status}); keeping the last catalog`)
        return undefined
      }
      const payload = await response.json() as { data?: unknown }
      const rows = Array.isArray(payload.data) ? payload.data : []
      const entries = this.adoptListing(rows)
      if (entries.length === 0) {
        this.options.onWarn?.('Ark model discovery returned an empty catalog; keeping the last catalog')
        return undefined
      }
      this.live = entries
      // The cached table is the endpoint's answer, kept so the next session does not ask
      // again. A cache failure never fails the read that produced it.
      await this.saveListing(rows)
      return entries.map((entry) => entry.id)
    } catch (error: unknown) {
      if (signal?.aborted === true) return undefined
      this.options.onWarn?.(`Ark model list unavailable (${error instanceof Error ? error.message : String(error)})`)
      return undefined
    }
  }

  /** Persist one live listing, reporting a cache failure without failing the read. */
  private async saveListing(rows: readonly unknown[]): Promise<void> {
    if (this.options.saveListing === undefined) return
    try {
      await this.options.saveListing(rows)
    } catch (error: unknown) {
      this.options.onWarn?.(`model catalog cache write failed (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  /** Send one streaming request over the Responses wire. */
  private async request(
    options: GenerateOptions,
    model: string,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<Response> {
    const resolveImage = this.imageResolver(signal)
    const resolved = await toResponsesInput(options.messages, options.system, resolveImage)
    const body: Record<string, unknown> = {
      model,
      ...resolved.instructions === undefined ? {} : { instructions: resolved.instructions },
      input: resolved.input,
      ...options.tools === undefined || options.tools.length === 0
        ? {}
        : { tools: toResponsesTools(options.tools), tool_choice: 'auto', parallel_tool_calls: true },
      ...options.maxTokens === undefined ? {} : { max_output_tokens: options.maxTokens },
      ...options.reasoningEffort === undefined ? {} : { reasoning: { effort: String(options.reasoningEffort) } },
      ...options.sessionId === undefined ? {} : { prompt_cache_key: String(options.sessionId) },
      stream: true,
    }
    const fetchFn = this.options.fetchFn ?? proxiedFetch
    return fetchFn(`${this.options.apiBase}${ARK_RESPONSES_PATH}`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'accept': 'text/event-stream',
        'content-type': 'application/json',
      },
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
        this.options.onWarn?.(`image attachment unavailable (${error instanceof Error ? error.message : String(error)})`)
        return undefined
      }
    }
  }

  /** The catalog the controller publishes without hand-added ids. */
  ownCatalogEntries(): readonly CatalogEntry[] {
    return this.shippedCatalog()
  }

  /** The catalog the controller publishes. */
  catalogEntries(): readonly CatalogEntry[] {
    return this.catalog()
  }
}

/** The reasoning block for a catalog entry, or undefined when it supports none. */
function reasoningInfo(entry: CatalogEntry) {
  const efforts = entry.reasoningEfforts
  if (efforts === undefined || efforts.length === 0) return undefined
  return {
    efforts: efforts.map((effort) => ({ id: ReasoningEffortId(effort), name: String(effort), description: '' })),
    ...entry.defaultEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(entry.defaultEffort) },
  }
}

/**
 * Read the plan's allowance.
 *
 * Two allowances exist, and both live on the **control plane** — a different host
 * from the data plane, reached with the STS AK/SK the SSO identity was exchanged
 * for (see `auth/ark-control.ts`) rather than with the plan API key:
 *
 * - the **subscription** periods (`GetCodingPlanUsage` → `coding_usage.periods[]`,
 *   each `{ label, used, total, percent, reset_at }`), which an account without a
 *   plan answers as `Status: Reclaimed`;
 * - the **free inference allowance** per model (`ListModelChargeItems` →
 *   `InferenceFreeUsage { Consumed, Total }`), which exists with no subscription.
 *
 * The free allowance is what a plan-less account actually has, so it is reported
 * even when the subscription is absent — otherwise the card would say "no quota"
 * while the account still had tokens to spend.
 *
 * @param input - the signed control-plane client.
 * @returns the windows the service stated, subscription first.
 */
export async function readArkUsage(input: {
  credentials: ArkStsCredentials
  fetchFn: FetchFn
  signal?: AbortSignal
}): Promise<UsageRead> {
  const windows: UsageWindow[] = []
  let plan: ArkPlanUsage | undefined
  let planError: string | undefined
  try {
    const payload = await callArkControl<unknown>({
      action: 'GetCodingPlanUsage',
      credentials: input.credentials,
      fetchFn: input.fetchFn,
      ...input.signal === undefined ? {} : { signal: input.signal },
    })
    plan = parseArkPlanUsage(payload)
    for (const period of plan.periods) {
      const usedPercent = period.percent
        ?? (period.used !== undefined && period.total !== undefined && period.total > 0
          ? (period.used / period.total) * 100
          : undefined)
      windows.push({
        // The plan's own period names become the window labels the page already
        // knows: `5h`, `weekly`, `monthly`.
        label: period.label,
        ...usedPercent === undefined ? {} : { usedPercent: Math.max(0, Math.min(100, usedPercent)) },
        ...period.used === undefined ? {} : { used: period.used },
        ...period.total === undefined ? {} : { limit: period.total },
        ...period.resetsAt === undefined ? {} : { resetsAt: period.resetsAt },
      })
    }
  } catch (error: unknown) {
    planError = error instanceof Error ? error.message : String(error)
  }

  try {
    const payload = await callArkControl<unknown>({
      action: 'ListModelChargeItems',
      credentials: input.credentials,
      fetchFn: input.fetchFn,
      body: 'Modality=LLM&PageSize=50',
      ...input.signal === undefined ? {} : { signal: input.signal },
    })
    const free = parseArkFreeUsage(payload)
    if (free.length > 0) {
      // One row per model would bury the plan figures; the page shows the free
      // allowance as the pool it is, spent across the models that grant it.
      const consumed = free.reduce((sum, entry) => sum + entry.consumed, 0)
      const total = free.reduce((sum, entry) => sum + entry.total, 0)
      windows.push({
        label: 'free',
        usedPercent: total > 0 ? Math.max(0, Math.min(100, (consumed / total) * 100)) : 0,
        used: consumed,
        limit: total,
      })
    }
  } catch (error: unknown) {
    // The free pool is a bonus, not the subscription: failing to read it must not
    // hide the plan figures that did come back.
    if (plan === undefined || plan.periods.length === 0) {
      return {
        windows,
        usageError: error instanceof Error ? error.message : String(error),
      }
    }
  }

  return {
    windows,
    ...plan === undefined || plan.subscribed
      ? {}
      : {
          // A plan-less account is a state, not a failure: say so, and let the free
          // pool above speak for itself.
          usageError: planError ?? 'no Ark Coding Plan on this account; showing the free inference allowance',
        },
  }
}

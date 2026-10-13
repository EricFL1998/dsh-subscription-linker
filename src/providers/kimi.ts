/**
 * The `kimi` provider route: Kimi Code model catalog, request assembly over
 * the OpenAI Responses wire, and streaming.
 *
 * @module dsh-plugin-subscription-oauth/providers/kimi
 */

import {
  EMPTY_RESPONSE_CODE,
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
  StreamChunk,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import {
  KIMI_CODE_URL,
  KIMI_CONTEXT_WINDOW,
  KIMI_DEFAULT_MAX_TOKENS,
  KIMI_DEFAULT_MODEL,
  KIMI_LONG_CONTEXT_WINDOW,
  KIMI_MODELS_PATH,
  KIMI_PROVIDER_ID,
  KIMI_PROVIDER_NAME,
  KIMI_RESPONSES_PATH,
} from '../constants.js'
import { proxiedFetch } from '../http.js'
import type { FetchFn } from '../http.js'
import { kimiRequestHeaders } from '../auth/headers.js'
import { REAUTH_REQUIRED, ProviderError } from '../errors.js'
import type { TokenManager } from '../auth/tokens.js'
import type { SessionBase } from '../auth/store.js'
import { finiteInstant, nonEmpty } from '../auth/store.js'
import { idleWatchdog, httpLlmError, isMissingOrInvalidCredential, mapFetchFailure } from './common.js'
import { streamProviderResponses, accountPoolHooks } from './responses-stream.js'
import type { UsageWindow } from '../protocol.js'
import type { CatalogEntry } from './catalog.js'
import { fallbackEntry, findEntry, resolveCatalog } from './catalog.js'
import { streamResponses, toResponsesInput, toResponsesTools } from '../translate/responses.js'
import { prepareMoonshotTool } from '../translate/moonshot-schema.js'
import type { ImageResolver } from '../translate/responses.js'
import { isImageModel, isFastVariant, baseModelOf, FastVariantIndex } from './grok.js'

/** Model ids that are clearly not chat models. */
const NON_CHAT_ID = /(?:^|[-_/])(?:image|video|imagine|embed|embedding|whisper|tts|vision-only)/i

/** One catalog entry exposed as a selectable model. */
export type KimiModelEntry = CatalogEntry

/**
 * A stored Kimi Code login.
 *
 * The OAuth host and API base are recorded per account so a later refresh uses
 * the same endpoints the login did, even if the plugin configuration changes.
 */
export interface KimiSession extends SessionBase {
  /** OAuth host the tokens were issued by. */
  oauthHost: string
  /** API base recorded at login time (diagnostics only). */
  apiBase?: string
}

/**
 * Coerce one decoded credential entry into a Kimi session.
 * @param value - decoded JSON value for one account.
 * @returns the session, or undefined when required fields are missing.
 */
export function parseKimiSession(value: unknown): KimiSession | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const accessToken = nonEmpty(record.accessToken)
  const oauthHost = nonEmpty(record.oauthHost)
  const expiresAt = finiteInstant(record.expiresAt)
  if (accessToken === undefined || oauthHost === undefined || expiresAt === undefined) return undefined
  const refreshToken = nonEmpty(record.refreshToken)
  const apiBase = nonEmpty(record.apiBase)
  const accountId = nonEmpty(record.accountId)
  const email = nonEmpty(record.email)
  return {
    accessToken,
    expiresAt,
    oauthHost,
    ...refreshToken === undefined ? {} : { refreshToken },
    ...apiBase === undefined ? {} : { apiBase },
    ...accountId === undefined ? {} : { accountId },
    ...email === undefined ? {} : { email },
  }
}

/** Harness effort ids normalised onto the ladder Kimi's endpoint accepts. */
const EFFORT_WIRE_MAP: Record<string, string> = {
  none: 'none',
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
}

/** Display metadata for the reasoning ladder shared by every live coding model. */
const EFFORT_LABELS: Record<string, { name: string, description: string }> = {
  none: { name: 'Off', description: 'Answer without spending thinking tokens' },
  low: { name: 'Low', description: 'Short chain of thought' },
  medium: { name: 'Medium', description: 'Balanced thinking budget' },
  high: { name: 'High', description: 'Deep chain of thought' },
  xhigh: { name: 'Max', description: 'Highest thinking budget Kimi accepts' },
  max: { name: 'Max', description: 'Highest thinking budget Kimi accepts' },
  // Not a thinking budget: this rung is the model's fast variant, which the composer's
  // quick-mode button selects. It rides the effort channel so the row keeps its own id —
  // a swapped model id would leave the picker with no way back to the standard model.
  fast: { name: 'Fast', description: 'Highspeed variant of this model' },
}

/**
 * Kimi Code's live coding catalog.
 *
 * `kimi-for-coding` is the stable subscription alias Moonshot re-points at each
 * coding release; `k3` is the current flagship, with the `[1m]` suffix selecting
 * its 1M-token window.
 */
export const KIMI_MODELS: readonly KimiModelEntry[] = [
  {
    id: 'kimi-for-coding',
    name: 'Kimi for Coding',
    description: 'Stable subscription alias — 1M-token window',
    aliases: ['kimi-for-coding-highspeed', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6', 'kimi-k2.5'],
    contextWindow: KIMI_LONG_CONTEXT_WINDOW,
    inputModalities: ['text', 'image'],
    reasoningEfforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'max',
  },
  {
    id: 'k3',
    name: 'Kimi K3',
    description: 'Flagship reasoning model',
    aliases: ['kimi-k3'],
    contextWindow: KIMI_CONTEXT_WINDOW,
    inputModalities: ['text', 'image'],
    reasoningEfforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'max',
  },
  {
    id: 'k3[1m]',
    name: 'Kimi K3 (1M)',
    description: 'Flagship reasoning model with the 1M-token window',
    contextWindow: KIMI_LONG_CONTEXT_WINDOW,
    inputModalities: ['text', 'image'],
    reasoningEfforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'max',
  },
  {
    id: 'k3-256k',
    name: 'Kimi K3 (256K)',
    description: 'Flagship reasoning model pinned to the standard window',
    contextWindow: KIMI_CONTEXT_WINDOW,
    inputModalities: ['text', 'image'],
    reasoningEfforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'max',
  },
]

/** One `reasoning.efforts` entry for a resolved model. */
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
function reasoningInfo(entry: KimiModelEntry, fast = false) {
  const efforts = entry.reasoningEfforts
  const ids = fast ? [...efforts ?? [], 'fast'] : efforts
  if (ids === undefined || ids.length === 0) return undefined
  const defaultEffort = entry.defaultEffort ?? ids[ids.length - 1]
  return {
    efforts: ids.map(effortInfo),
    ...defaultEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultEffort) },
  }
}

/** Constructor dependencies for {@link KimiAdapter}. */
export interface KimiAdapterOptions {
  /** Resolved Kimi Code API base (`<base>/responses`). */
  apiBase: string
  /** Whether the live `/models` catalog is consulted when logged in. */
  discovery: boolean
  /** Inactivity budget before a stalled stream is abandoned. */
  streamIdleTimeoutMs: number
  /** OAuth token manager owning refresh and invalidation. */
  tokens: TokenManager<KimiSession>
  /** Warning sink for discovery failures that fall back to the static catalog. */
  onWarn?: (message: string) => void
  /** Resolve the attachment service per request, so a late service start still works. */
  resolveAttachments?: () => AttachmentStore | undefined
  /**
   * Client-identity headers (`X-Msh-*` + `User-Agent`) for this machine.
   * Resolved per request because the device id file is read lazily.
   */
  identityHeaders?: () => Promise<Record<string, string>>
  /** Fetch implementation; defaults to the proxy-aware fetch. */
  fetchFn?: FetchFn
  /** Called when a call proved the stored credential unusable. */
  onCredentialRejected?: (account: string) => void
  /**
   * Read one account's metered windows, so the streamer can steer away from an account
   * whose allowance is spent before it fails there.
   *
   * Resolved per request; absence means the streamer only learns an account is spent by
   * failing against it once.
   */
  readUsage?: (account: string) => Promise<readonly UsageWindow[]>
  /** Extra model ids from the plugin configuration, appended to the catalog. */
  extraModels?: readonly string[]
  /**
   * The user's model rank for this route, most preferred first.
   *
   * Read per catalog query, so a drag-and-drop re-order takes effect at the
   * picker's next refresh without rebuilding the adapter.
   */
  modelOrder?: () => Promise<readonly string[]>
  /**
   * Model ids the session model picker must not offer.
   *
   * Read per catalog query, so a settings change takes effect at the picker's
   * next refresh without rebuilding the adapter. A hidden model stays
   * resolvable: an existing session that already selected it keeps working.
   */
  hiddenModels?: () => Promise<ReadonlySet<string>>
  /**
   * Model ids the user added by hand.
   *
   * Read per catalog query, so the add button takes effect at the picker's next
   * refresh. A hand-added id is published with conservative metadata: the
   * endpoint is the authority on what it serves, not this build.
   */
  userModels?: () => Promise<readonly string[]>
}

/** Kimi Code adapter serving the `kimi` provider route. */
export class KimiAdapter extends LlmAdapter {
  /** Live catalog ids seen this session, used to accept renamed models. */
  private discovered: readonly string[] | undefined
  /** Image-generation model id, when discovery reported one. */
  private imageModel: string | undefined
  /**
   * Fast-variant wire id per picker row, for the composer's quick-mode button.
   *
   * Seeded from the curated aliases — `kimi-for-coding-highspeed` is one — so the button
   * exists before any discovery run, and then updated from the live catalog, which is
   * the authority on what this account actually serves.
   */
  private readonly fastVariants = new FastVariantIndex()

  /** Ids the user added by hand, cached so the sync catalog can name them. */
  private userAddedIds: readonly string[] = []

  /** Tools already reported as flattened, so each is stated once. */
  private readonly flattenedTools = new Set<string>()

  constructor(private readonly options: KimiAdapterOptions) {
    super()
    this.seedCuratedFastVariants()
  }

  /**
   * Record the fast variants the curated catalog already names as aliases.
   *
   * The alias is the recognition: `kimi-for-coding-highspeed` is stated as an accepted
   * id of `kimi-for-coding`, so the route can offer the quick-mode button without
   * waiting for a live list that may never name it. A row a live catalog already paired
   * keeps that pairing, so this only fills the gaps.
   */
  private seedCuratedFastVariants(): void {
    for (const entry of KIMI_MODELS) {
      for (const alias of entry.aliases ?? []) {
        // Every alias of one row maps back to that row, so a variant whose own prefix
        // names another alias (`kimi-k2.7-code-highspeed`) still pairs with the row.
        this.fastVariants.note(alias, (base) => this.entryFor(base)?.id ?? base)
      }
    }
  }

  /** The fast pair one picker id belongs to, from either side. */
  fastPairOf(id: string): { baseId: string, wireId: string } | undefined {
    return this.fastVariants.pairOf(id)
  }

  /**
   * Tool schemas in the shape Moonshot accepts: no `$ref`, and under its size
   * ceiling. A declaration too large to send keeps its arguments, and that is
   * reported once per tool rather than on every turn.
   */
  private moonshotTools(tools: readonly ToolSchema[]): ToolSchema[] {
    return tools.map((tool) => {
      const prepared = prepareMoonshotTool(tool.parameters)
      if (prepared.preparedAs !== 'as-declared' && !this.flattenedTools.has(tool.name)) {
        this.flattenedTools.add(tool.name)
        this.options.onWarn?.(prepared.preparedAs === 'flattened'
          ? `kimi: ${tool.name} declares an argument schema larger than the endpoint accepts; `
            + 'its arguments are described without their nested structure'
          : `kimi: ${tool.name} declares an argument schema larger than the endpoint accepts; `
            + 'it is offered as an unrestricted object')
      }
      return { ...tool, parameters: prepared.parameters }
    })
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: KIMI_PROVIDER_NAME }
  }

  override providerRetryPolicy(): undefined {
    // Kimi reports its own pacing through 429 `retry-after`; a local retry
    // ladder would fight the account-level rate limiter.
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
      provider: KIMI_PROVIDER_ID,
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

  /** The fast/lightspeed variant wire id for a picker row. */
  fastVariant(baseId: string): string | undefined {
    return this.fastVariants.variantOf(baseId)
  }

  /** The ids the picker must currently omit. */
  private async hidden(): Promise<ReadonlySet<string>> {
    if (this.options.hiddenModels === undefined) return new Set()
    try {
      return await this.options.hiddenModels()
    } catch (error: unknown) {
      // A preferences read failure must not empty the picker.
      this.options.onWarn?.(`model preferences unavailable (${errorChain(error)})`)
      return new Set()
    }
  }

  override async resolveModel(_provider: string, model: string): Promise<LlmResolvedModelInfo> {
    await this.syncUserModels()
    const entry = this.entryFor(model)
    if (entry === undefined) {
      // An unknown id is still dispatchable: the endpoint accepts the id it
      // reports, and a model added after this build should not be refused. It
      // inherits the standard window and the shared reasoning ladder.
      const template = this.entryFor(KIMI_DEFAULT_MODEL) ?? this.catalog()[0]
      const reasoning = template === undefined ? undefined : reasoningInfo(template)
      return {
        provider: KIMI_PROVIDER_ID,
        id: model,
        name: model,
        context: { contextWindow: KIMI_CONTEXT_WINDOW },
        defaultMaxTokens: KIMI_DEFAULT_MAX_TOKENS,
        ...reasoning === undefined ? {} : { reasoning },
      }
    }
    // A row with a fast variant offers the `fast` rung; the picker shows the row under
    // its own name and the mode as the effort, which is what the trigger already reads.
    const reasoning = reasoningInfo(entry, this.fastVariants.variantOf(entry.id) !== undefined)
    // An alias is just another spelling of the row, so it resolves onto the row's own id:
    // that is what keeps a selection dispatchable and the picker able to show it.
    return {
      provider: KIMI_PROVIDER_ID,
      id: entry.id,
      name: entry.name,
      ...entry.description === undefined ? {} : { description: entry.description },
      ...entry.inputModalities === undefined ? {} : { inputModalities: entry.inputModalities },
      context: { contextWindow: entry.contextWindow },
      defaultMaxTokens: KIMI_DEFAULT_MAX_TOKENS,
      ...reasoning === undefined ? {} : { reasoning },
    }
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // Fast mode rides the reasoning channel: `fast` is a rung of the row, not a model id
    // of its own, so the row the picker selected stays dispatchable and the user can
    // always select the standard model again. Only the wire id changes.
    const fast = String(options.reasoningEffort ?? '') === 'fast'
    const model = fast ? this.fastVariants.variantOf(options.model) ?? options.model : options.model
    const call = { ...options, model }
    // Kimi has no `fast` effort; the variant already carries the behaviour.
    if (fast) delete call.reasoningEffort
    return streamProviderResponses(call, {
      label: 'Kimi API',
      tokens: this.options.tokens,
      request: (call, model, accessToken, signal) => this.request(call, model, accessToken, signal),
      streamIdleTimeoutMs: this.options.streamIdleTimeoutMs,
      // A 402/429 means this account's allowance is spent: draw on the next account's
      // before giving up, so one model id uses the whole pool's quota.
      isAllowanceExhausted: (status) => status === 402 || status === 429,
      ...accountPoolHooks({ provider: KIMI_PROVIDER_ID, tokens: this.options.tokens, readUsage: this.options.readUsage }),
      onAccountSwitch: (from, to, reason) => {
        this.options.onWarn?.(`kimi: account ${from} allowance spent (${reason}); switching to ${to}`)
      },
      ...this.options.onCredentialRejected === undefined
        ? {}
        : { onCredentialRejected: this.options.onCredentialRejected },
      onFallback: (from, to, reason) => {
        this.options.onWarn?.(`kimi: model ${from} unavailable (${reason}); falling back to ${to}`)
      },
      describeFailure: (error) => this.refreshHint(error),
    })
  }

  /** Translate an auth failure into the message a user can act on. */
  private refreshHint(error: unknown): unknown {
    if (error instanceof ProviderError && error.code === REAUTH_REQUIRED) {
      return new LlmError(
        `Kimi Code login expired; sign in again from Settings → Subscriptions (${KIMI_CODE_URL})`,
        'INVALID_CREDENTIAL',
        { status: 401 },
      )
    }
    return error
  }

  /**
   * The catalog the route serves: its own entries, then the ids the user added
   * by hand. The two are built separately so the hand-added check can look at
   * the shipped list without recursing.
   */
  private catalog(): readonly KimiModelEntry[] {
    return [...this.shippedCatalog(), ...this.addedEntries()]
  }

  /**
   * The catalog to present: the shipped entries in their curated order and with
   * their curated metadata, then any configured extra id, then any live id this
   * build does not know.
   *
   * The live list never removes a shipped entry: the endpoint serves variants
   * such as `k3[1m]` that its own `/models` listing omits, so absence there is
   * not evidence of retirement.
   */
  private shippedCatalog(): readonly KimiModelEntry[] {
    const extra: KimiModelEntry[] = []
    const seen = new Set<string>()
    const append = (id: string, description: string): void => {
      if (seen.has(id) || this.entryFor(id) !== undefined) return
      seen.add(id)
      extra.push(fallbackEntry(id, description, KIMI_CONTEXT_WINDOW))
    }
    for (const id of this.options.extraModels ?? []) append(id, 'Extra model from the plugin configuration')
    for (const id of this.discovered ?? []) append(id, 'Reported by the Kimi Code model list')
    return extra.length === 0 ? KIMI_MODELS : [...KIMI_MODELS, ...extra]
  }

  /** Whether one shipped entry covers a live model id. */
  private entryMatches(entry: KimiModelEntry, id: string): boolean {
    return entry.id === id || entry.aliases?.includes(id) === true
  }

  /** Resolve a requested model id onto its catalog entry. */
  private entryFor(model: string): KimiModelEntry | undefined {
    return findEntry(KIMI_MODELS, model)
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
   * The entries for ids the user added by hand, in the order they added them.
   *
   * Published without shipped metadata: this build has never seen the model, so
   * the endpoint's own defaults are the honest description.
   */
  private addedEntries(): readonly KimiModelEntry[] {
    if (this.userAddedIds.length === 0) return []
    const known = new Set(this.shippedCatalog().map((entry) => entry.id))
    return this.userAddedIds
      .filter((id) => !known.has(id))
      .map((id) => fallbackEntry(id, 'Added by hand in Settings', KIMI_CONTEXT_WINDOW))
  }

  /** Record the live catalog for the picker; failures keep the shipped list. */
  discover(ids: readonly string[]): void {
    this.discovered = ids
  }

  /** The curated catalog, for the Settings page's model list. */
  catalogEntries(): readonly KimiModelEntry[] {
    return this.catalog()
  }

  /** What this route itself serves, without the ids added by hand. */
  ownCatalogEntries(): readonly KimiModelEntry[] {
    return this.shippedCatalog()
  }

  /** Build and send one request. */
  private async request(
    options: GenerateOptions,
    model: string,
    accessToken: string,
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
        : {
            tools: toResponsesTools(this.moonshotTools(options.tools)),
            tool_choice: 'auto',
            parallel_tool_calls: true,
          },
      ...options.maxTokens === undefined ? {} : { max_output_tokens: options.maxTokens },
      ...options.reasoningEffort === undefined
        ? {}
        : { reasoning: { effort: EFFORT_WIRE_MAP[String(options.reasoningEffort)] ?? String(options.reasoningEffort) } },
      ...options.sessionId === undefined ? {} : { prompt_cache_key: String(options.sessionId) },
      // Ask for the encrypted reasoning payload so a later turn can replay the
      // provider's own item rather than reconstructed text.
      include: ['reasoning.encrypted_content'],
      store: false,
      stream: true,
    }
    // Kimi locks temperature and penalties on every subscription coding model,
    // so a caller-supplied value is dropped rather than rejected upstream.
    const fetchFn = this.options.fetchFn ?? proxiedFetch
    return fetchFn(`${this.options.apiBase}${KIMI_RESPONSES_PATH}`, {
      method: 'POST',
      headers: kimiRequestHeaders(await this.identity(), {
        'authorization': `Bearer ${accessToken}`,
        'accept': 'text/event-stream',
        'content-type': 'application/json',
      }),
      body: JSON.stringify(body),
      signal,
    })
  }

  /** Client-identity headers for this machine, when configured. */
  private async identity(): Promise<Record<string, string>> {
    if (this.options.identityHeaders === undefined) return {}
    try {
      return await this.options.identityHeaders()
    } catch (error: unknown) {
      this.options.onWarn?.(`device identity unavailable (${errorChain(error)})`)
      return {}
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

  /** Read the live `/models` catalog, or undefined when unavailable. */
  async fetchCatalog(accessToken: string, signal?: AbortSignal): Promise<readonly string[] | undefined> {
    if (!this.options.discovery) return undefined
    const fetchFn = this.options.fetchFn ?? proxiedFetch
    try {
      const response = await fetchFn(`${this.options.apiBase}${KIMI_MODELS_PATH}`, {
        headers: kimiRequestHeaders(await this.identity(), { 'authorization': `Bearer ${accessToken}` }),
        ...signal === undefined ? {} : { signal },
      })
      if (!response.ok) {
        if (!isMissingOrInvalidCredential(await httpLlmError(response, 'Kimi models'))) {
          this.options.onWarn?.(`Kimi model discovery failed (HTTP ${response.status}); using the built-in catalog`)
        }
        return undefined
      }
      const payload = await response.json() as { data?: { id?: unknown }[] }
      const allIds = (payload.data ?? [])
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
      // Image models are never picker rows: they are agent-called, always on.
      this.imageModel = allIds.find((id) => isImageModel(id))
      // Fast/lightspeed variants ride with their base row: they share the row's
      // visibility switch and are reached by the composer's quick-mode button, not a
      // separate row. The live list is the authority on what this account serves, so
      // it is recorded first, and each variant pairs with the longest listed prefix
      // of its own name — a provider that names its variants after the base model
      // pairs them with no curated map at all.
      this.fastVariants.clear()
      for (const id of allIds) {
        this.fastVariants.noteListed(id)
      }
      for (const id of allIds) {
        const base = this.fastVariants.pair(id)
        this.fastVariants.note(id, () => base ?? this.entryFor(baseModelOf(id))?.id ?? baseModelOf(id))
      }
      this.seedCuratedFastVariants()
      const ids = allIds
        .filter((id) => !NON_CHAT_ID.test(id))
        .map((id) => (isFastVariant(id) ? this.fastVariants.pair(id) ?? baseModelOf(id) : id))
        .filter((id, index, list) => list.indexOf(id) === index)
      if (ids.length === 0) {
        this.options.onWarn?.('Kimi model discovery returned an empty catalog; using the built-in catalog')
        return undefined
      }
      return ids
    } catch (error: unknown) {
      if (signal?.aborted === true) return undefined
      this.options.onWarn?.(`Kimi model discovery failed; using the built-in catalog (${errorChain(error)})`)
      return undefined
    }
  }
}

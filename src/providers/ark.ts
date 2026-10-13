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
 *   API", and the catalogue below is the plan's roster.
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
import type { CatalogEntry } from './catalog.js'
import { findEntry, resolveCatalog } from './catalog.js'
import { streamProviderResponses, accountPoolHooks } from './responses-stream.js'
import { toResponsesInput, toResponsesTools } from '../translate/responses.js'
import type { ImageResolver } from '../translate/responses.js'
import type { UsageRead } from './usage.js'

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
 * The Coding Plan is a curated, text-first roster and states no window per model;
 * discovery refines this where the endpoint reports one.
 */
export const ARK_CONTEXT_WINDOW = 262_144

/** Output budget used when the caller sets no cap. */
export const ARK_DEFAULT_MAX_TOKENS = 32_000

/** The plan's model roster, as the reference registry records it. */
export const ARK_MODELS: readonly CatalogEntry[] = [
  { id: 'ark-code-latest', name: 'Ark Code (latest)', description: 'Plan alias for the current coding model', contextWindow: ARK_CONTEXT_WINDOW, inputModalities: ['text'] },
  { id: 'doubao-seed-2.0-code', name: 'Doubao Seed 2.0 Code', description: 'Coding-tuned Doubao', contextWindow: ARK_CONTEXT_WINDOW, inputModalities: ['text'] },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', description: 'Fast DeepSeek', contextWindow: ARK_CONTEXT_WINDOW, inputModalities: ['text'] },
  { id: 'glm-5.3', name: 'GLM-5.3', description: 'Zhipu flagship', contextWindow: ARK_CONTEXT_WINDOW, inputModalities: ['text'] },
  { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', description: 'Fast GLM, reads images', contextWindow: ARK_CONTEXT_WINDOW, inputModalities: ['text', 'image'] },
  { id: 'glm-5.2', name: 'GLM-5.2', description: 'Previous Zhipu flagship', contextWindow: ARK_CONTEXT_WINDOW, inputModalities: ['text'] },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', description: 'Moonshot model on Ark', contextWindow: ARK_CONTEXT_WINDOW, inputModalities: ['text'] },
  { id: 'minimax-m3', name: 'MiniMax M3', description: 'MiniMax model on Ark', contextWindow: ARK_CONTEXT_WINDOW, inputModalities: ['text', 'image'] },
]

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
  resolveAttachments?: () => AttachmentStore | undefined
  onWarn?: (message: string) => void
  onCredentialRejected?: (account: string) => void
  /** Read one account's metered windows, so the streamer can steer away from a spent one. */
  readUsage?: ((account: string) => Promise<readonly UsageWindow[]>) | undefined
  fetchFn?: FetchFn
}

/** An entry for an id this build ships no metadata for. */
function extraEntry(id: string): CatalogEntry {
  return { id, name: id, contextWindow: ARK_CONTEXT_WINDOW }
}

/** The adapter behind the `ark` route. */
export class ArkAdapter extends LlmAdapter {
  private live: readonly string[] | undefined

  constructor(private readonly options: ArkAdapterOptions) {
    super()
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
    const hidden = await this.hidden()
    return resolveCatalog(this.catalog(), [], hidden).entries.map((entry) => ({
      provider: ARK_PROVIDER_ID,
      id: entry.id,
      name: entry.name,
      ...entry.description === undefined ? {} : { description: entry.description },
      ...entry.inputModalities === undefined ? {} : { inputModalities: entry.inputModalities },
    }))
  }

  override async resolveModel(_provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const entry = findEntry(this.catalog(), model)
    if (entry === undefined) {
      const template = findEntry(this.catalog(), ARK_DEFAULT_MODEL) ?? this.catalog()[0]
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

  private shippedCatalog(): readonly CatalogEntry[] {
    const shipped = this.options.extraModels === undefined
      ? [...ARK_MODELS]
      : [...ARK_MODELS, ...this.options.extraModels.map(extraEntry)]
    const live = this.live
    if (live === undefined) return shipped
    const merged = [...shipped]
    for (const id of live) {
      if (findEntry(merged, id) === undefined) merged.push(extraEntry(id))
    }
    return merged
  }

  private addedEntries(): readonly CatalogEntry[] {
    const own = this.shippedCatalog()
    const added = this.options.userModels?.()
    if (added === undefined) return []
    return (Array.isArray(added) ? added : [])
      .filter((id) => findEntry(own, id) === undefined)
      .map(extraEntry)
  }

  private async hidden(): Promise<ReadonlySet<string>> {
    if (this.options.hiddenModels === undefined) return new Set()
    try {
      return await this.options.hiddenModels()
    } catch {
      return new Set()
    }
  }

  /** Adopt the endpoint's live catalog. */
  discover(ids: readonly string[]): void {
    this.live = [...ids]
  }

  /**
   * Read the plan's live model list.
   *
   * The Coding Plan answers the OpenAI models shape on its own base; an endpoint
   * that does not serve it leaves the shipped roster in place.
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
        this.options.onWarn?.(`Ark model list unavailable (HTTP ${response.status})`)
        return undefined
      }
      const body = await response.json() as { data?: readonly { id?: unknown }[] }
      const ids = (body.data ?? [])
        .map((entry) => (typeof entry?.id === 'string' ? entry.id.trim() : ''))
        .filter((id) => id !== '')
      return ids.length === 0 ? undefined : ids
    } catch (error: unknown) {
      this.options.onWarn?.(`Ark model list unavailable (${error instanceof Error ? error.message : String(error)})`)
      return undefined
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

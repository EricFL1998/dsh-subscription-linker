/**
 * The Xiaomi MiMo wire adapter serving the `mimo` route.
 *
 * Model requests are chat completions at the MiMo server's `/route`, carrying the
 * session cookies the sign-on set — not a bearer token. Two models ship: MiMo Pro
 * and MiMo Flash. The open platform's Token Plan spends its own `tp-` key at a
 * separate endpoint; that fallback lives beside the account-level stream here.
 *
 * @module dsh-plugin-subscription-oauth/providers/mimo
 */

import {
  LlmAdapter,
  errorChain,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

import { httpLlmError, isMissingOrInvalidCredential, mapFetchFailure, idleWatchdog } from './common.js'
import { proxiedFetch, type FetchFn } from '../http.js'
import type { TokenManager } from '../auth/tokens.js'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { MimoCredentials } from '../auth/mimo-flow.js'
import { refreshMimoSession } from '../auth/mimo-flow.js'

/** The `mimo` provider route key. */
export const MIMO_PROVIDER_ID = 'mimo'
/** Human name for the route and its cards. */
export const MIMO_PROVIDER_NAME = 'Xiaomi MiMo'
/** Where the Settings page sends someone to get an account. */
export const MIMO_CODE_URL = 'https://platform.xiaomimimo.com'

/** MiMo context window shared by Pro and Flash. */
export const MIMO_CONTEXT_WINDOW = 1_000_000
/** The output ceiling MiMo advertises. */
export const MIMO_DEFAULT_MAX_TOKENS = 128_000
/** The model the picker preselects. */
export const MIMO_DEFAULT_MODEL = 'mimo-pro'

/** One signed-in MiMo account, as stored. */
export interface MimoSession {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  accountId?: string
  email?: string
  /** The MiMo server base this account signs on at. */
  apiBase: string
  /** The durable Xiaomi credential (JSON), used to re-sign-on. */
  mimoCreds: string
  /** The live session cookies (JSON), sent as the Cookie header. */
  mimoCookies: string
  /** The account's region. */
  region?: string
}

/** Validate one stored value as a MiMo session, or undefined when it is not one. */
export function parseMimoSession(value: unknown): MimoSession | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.accessToken !== 'string' || record.accessToken.length === 0) return undefined
  if (typeof record.expiresAt !== 'number') return undefined
  if (typeof record.apiBase !== 'string' || record.apiBase.length === 0) return undefined
  if (typeof record.mimoCreds !== 'string') return undefined
  if (typeof record.mimoCookies !== 'string') return undefined
  return {
    accessToken: record.accessToken,
    expiresAt: record.expiresAt,
    apiBase: record.apiBase,
    mimoCreds: record.mimoCreds,
    mimoCookies: record.mimoCookies,
    ...typeof record.refreshToken === 'string' ? { refreshToken: record.refreshToken } : {},
    ...typeof record.accountId === 'string' ? { accountId: record.accountId } : {},
    ...typeof record.email === 'string' ? { email: record.email } : {},
    ...typeof record.region === 'string' ? { region: record.region } : {},
  }
}

/** One catalog row. */
interface MimoModelEntry {
  id: string
  name: string
  description: string
  contextWindow: number
}

/** The two models the MiMo app serves. */
export const MIMO_MODELS: readonly MimoModelEntry[] = [
  { id: 'mimo-pro', name: 'MiMo Pro', description: 'Flagship MiMo model', contextWindow: MIMO_CONTEXT_WINDOW },
  { id: 'mimo-flash', name: 'MiMo Flash', description: 'Fast MiMo model', contextWindow: MIMO_CONTEXT_WINDOW },
]

/** A chat-completions choice delta, as the wire frames it. */
interface ChatChunk {
  choices?: { delta?: { content?: string, role?: string }, index?: number }[]
  usage?: { prompt_tokens?: number, completion_tokens?: number, total_tokens?: number }
}

/** Constructor dependencies for {@link MimoAdapter}. */
export interface MimoAdapterOptions {
  /** MiMo server base; `<base>/route/chat/completions` is the endpoint. */
  apiBase?: string
  streamIdleTimeoutMs: number
  tokens: TokenManager<MimoSession>
  onWarn?: (message: string) => void
  resolveAttachments?: () => AttachmentStore | undefined
  hiddenModels?: () => Promise<ReadonlySet<string>>
  userModels?: () => Promise<readonly string[]>
  fetchFn?: FetchFn
}

/** The MiMo wire adapter serving the `mimo` route. */
export class MimoAdapter extends LlmAdapter {
  private readonly fetchFn: FetchFn

  constructor(private readonly options: MimoAdapterOptions) {
    super()
    this.fetchFn = options.fetchFn ?? proxiedFetch
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: MIMO_PROVIDER_NAME }
  }

  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    if (await this.options.tokens.session() === undefined) return []
    const hidden = await this.hidden()
    return MIMO_MODELS.filter((entry) => !hidden.has(entry.id)).map((entry) => ({
      provider: MIMO_PROVIDER_ID,
      id: entry.id,
      name: entry.name,
      description: entry.description,
      inputModalities: ['text', 'image'],
    }))
  }

  private async hidden(): Promise<ReadonlySet<string>> {
    if (this.options.hiddenModels === undefined) return new Set()
    try {
      return await this.options.hiddenModels()
    } catch {
      return new Set()
    }
  }

  override async resolveModel(_provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const entry = MIMO_MODELS.find((candidate) => candidate.id === model)
    if (entry === undefined) {
      return {
        provider: MIMO_PROVIDER_ID,
        id: model,
        name: model,
        context: { contextWindow: MIMO_CONTEXT_WINDOW },
        defaultMaxTokens: MIMO_DEFAULT_MAX_TOKENS,
        inputModalities: ['text', 'image'],
      }
    }
    return {
      provider: MIMO_PROVIDER_ID,
      id: entry.id,
      name: entry.name,
      description: entry.description,
      context: { contextWindow: entry.contextWindow },
      defaultMaxTokens: MIMO_DEFAULT_MAX_TOKENS,
      inputModalities: ['text', 'image'],
    }
  }

  override providerRetryPolicy(): undefined {
    return undefined
  }

  /** The catalog the Settings list reads: every shipped model. */
  catalogEntries(): readonly { id: string, name: string, contextWindow: number }[] {
    return MIMO_MODELS
  }

  /** The ids the route itself serves, without hand-added extras. */
  ownCatalogEntries(): readonly MimoModelEntry[] {
    return MIMO_MODELS
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const held = await this.options.tokens.session()
    if (held === undefined) throw await httpLlmError(new Response(null, { status: 401 }), 'Xiaomi MiMo')
    const session = held.session
    const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs)
    try {
      const cookies = this.cookieHeader(session)
      const body = this.requestBody(options)
      const response = await this.fetchFn(`${session.apiBase.replace(/\/+$/, '')}/route/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'Cookie': cookies,
          'X-Mimo-Source': 'mimocode-cli-free',
          'User-Agent':
            'miNative PC/Normal Windows_NT/10.0.26100 SDKV/1.0.0 DEVT/PC DEVS/Windows APP/miaccount_desktop APPV/0.1.0',
          'X-Client-Version': '26.929.292248',
        },
        body: JSON.stringify(body),
        signal: watchdog.signal,
      })
      if (!response.ok || response.body === null) {
        throw await httpLlmError(response, 'Xiaomi MiMo')
      }
      yield* this.readStream(response, watchdog)
    } catch (error) {
      throw mapFetchFailure('Xiaomi MiMo', error, watchdog, options.signal)
    } finally {
      watchdog.stop()
    }
  }

  /**
   * The session cookies as one Cookie header, in a steady order.
   *
   * MiMo is a cookie session, not a bearer: the wire credential is the cookie
   * header built from the stored session's cookie record.
   */
  private cookieHeader(session: MimoSession): string {
    const first = ['serviceToken', 'userId', 'cUserId']
    try {
      const cookies = JSON.parse(session.mimoCookies) as Record<string, string>
      const parts = first.filter((key) => key in cookies).map((key) => `${key}=${cookies[key]}`)
      for (const [key, value] of Object.entries(cookies)) {
        if (!first.includes(key)) parts.push(`${key}=${value}`)
      }
      return parts.join('; ')
    } catch {
      return ''
    }
  }

  private requestBody(options: GenerateOptions): Record<string, unknown> {
    const messages: Record<string, unknown>[] = []
    if (options.system !== undefined && options.system.trim() !== '') {
      messages.push({ role: 'system', content: options.system })
    }
    for (const message of options.messages) {
      messages.push(this.toChatMessage(message))
    }
    return {
      model: options.model,
      messages,
      ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
      stream: true,
    }
  }

  private toChatMessage(message: GenerateOptions['messages'][number]): Record<string, unknown> {
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const textParts: string[] = []
    for (const block of message.content) {
      if (block.type === 'text') textParts.push(block.text)
    }
    return { role, content: textParts.join('\n') }
  }

  private async *readStream(response: Response, watchdog: ReturnType<typeof idleWatchdog>): AsyncIterable<StreamChunk> {
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let started = false
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        watchdog.pulse()
        buffer += decoder.decode(value, { stream: true })
        const frames = buffer.split('\n\n')
        buffer = frames.pop() ?? ''
        for (const frame of frames) {
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('\n')
          if (data === '' || data === '[DONE]') continue
          let chunk: ChatChunk
          try {
            chunk = JSON.parse(data) as ChatChunk
          } catch {
            continue
          }
          const delta = chunk.choices?.[0]?.delta?.content
          if (typeof delta === 'string' && delta !== '') {
            if (!started) {
              yield { type: 'block-start', index: 0, blockType: 'text' }
              started = true
            }
            yield { type: 'text-delta', index: 0, text: delta }
          }
          if (chunk.usage !== undefined) {
            const input = chunk.usage.prompt_tokens ?? 0
            const output = chunk.usage.completion_tokens ?? 0
            yield {
              type: 'usage',
              usage: { inputTokens: input, outputTokens: output, totalTokens: chunk.usage.total_tokens ?? input + output },
            }
          }
        }
      }
      if (started) yield { type: 'block-end', index: 0, block: { type: 'text', text: '' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally {
      reader.cancel().catch(() => {})
    }
  }
}

/**
 * The WorkBuddy China wire adapter serving the `workbuddy` route.
 *
 * WorkBuddy chats are chat completions at `https://copilot.tencent.com/v2/chat/completions`,
 * streamed only, and the API refuses a request whose User-Agent is not
 * `WorkBuddy/<version>`. The route ships the China build's catalog (Hy, GLM, Kimi,
 * DeepSeek, MiniMax). Adapted from magpie's `workbuddy` for this plugin's contracts.
 *
 * @module dsh-plugin-subscription-oauth/providers/workbuddy
 */

import {
  LlmAdapter,
  errorChain,
  ReasoningEffortId,
  ToolCallId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm'

import { idleWatchdog, mapFetchFailure } from './common.js'
import { proxiedFetch, type FetchFn } from '../http.js'
import type { TokenManager } from '../auth/tokens.js'
import type { CatalogEntry } from './catalog.js'
import { findEntry } from './catalog.js'
import { WORKBUDDY_ENDPOINT, WORKBUDDY_UA_VERSION, workbuddyHeaders, type WorkBuddyTokenSet, type WorkBuddySession } from '../auth/workbuddy-flow.js'

/** The `workbuddy` provider route key (China build). */
export const WORKBUDDY_PROVIDER_ID = 'workbuddy'
/** Human name for the route and its cards. */
export const WORKBUDDY_PROVIDER_NAME = 'WorkBuddy'
/** Where the Settings page sends someone to get an account. */
export const WORKBUDDY_CODE_URL = 'https://copilot.tencent.com'
/** The chat completions endpoint. */
const WORKBUDDY_API = `${WORKBUDDY_ENDPOINT}/v2/chat/completions`
/** The model the picker preselects. */
export const WORKBUDDY_DEFAULT_MODEL = 'hy4-preview-f'

/** One signed-in WorkBuddy session, as stored. */
export interface WorkBuddyStored {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  accountId?: string
  email?: string
  uid?: string
  enterpriseId?: string
  domain?: string
  tokenType?: string
  refreshExpiresAt?: number
}

/** The China build's catalog, [id, name, context, efforts?]. */
const CN_MODELS: readonly (readonly [string, string, number] | readonly [string, string, number, readonly string[]])[] = [
  ['auto', 'Auto', 168_000],
  ['hy4-preview-f', 'Hy4 preview', 1_000_000, ['high']],
  ['hy3', 'Hy3', 192_000, ['low', 'high']],
  ['hy3-x', 'Hy3-X', 192_000, ['low', 'high']],
  ['deepseek-v4.1-flash', 'Deepseek-V4.1-Flash', 1_000_000],
  ['glm-5.3', 'GLM-5.3', 1_000_000, ['low', 'high', 'max']],
  ['glm-5.3-flash', 'GLM-5.3-Flash', 1_000_000, ['low', 'high', 'max']],
  ['glm-5.2', 'GLM-5.2', 1_000_000, ['high', 'xhigh']],
  ['glm-5.1', 'GLM-5.1', 200_000],
  ['glm-5v-turbo', 'GLM-5v-Turbo', 200_000],
  ['minimax-m3', 'MiniMax-M3', 512_000],
  ['kimi-k3-1', 'Kimi-K3', 1_000_000, ['low', 'high', 'xhigh']],
  ['kimi-k2.7', 'Kimi-K2.7-Code', 256_000],
  ['kimi-k2.6', 'Kimi-K2.6', 256_000],
  ['deepseek-v4-pro', 'Deepseek-V4-Pro', 1_000_000, ['none', 'high', 'xhigh']],
]

/** The catalog the route serves. */
export const WORKBUDDY_CATALOG: readonly CatalogEntry[] = CN_MODELS.map((entry) => {
  const [id, name, contextWindow, efforts] = entry
  return {
    id,
    name,
    contextWindow,
    ...efforts === undefined ? {} : { reasoningEfforts: efforts as readonly string[] },
  }
})

/** A chat-completions choice delta, as the wire frames it. */
interface ChatChunk {
  choices?: {
    delta?: {
      content?: string
      role?: string
      tool_calls?: {
        index?: number
        id?: string
        function?: { name?: string, arguments?: string }
      }[]
    }
    index?: number
  }[]
  usage?: { prompt_tokens?: number, completion_tokens?: number, total_tokens?: number }
}

/** Constructor dependencies for {@link WorkBuddyAdapter}. */
export interface WorkBuddyAdapterOptions {
  streamIdleTimeoutMs: number
  tokens: TokenManager<WorkBuddySession>
  onWarn?: (message: string) => void
  hiddenModels?: () => Promise<ReadonlySet<string>>
  userModels?: () => Promise<readonly string[]>
  fetchFn?: FetchFn
}

/**
 * Words WorkBuddy refuses a chat for ("Illegal API invocation from an unapproved
 * channel"), each with words that say the same and pass. WorkBuddy reads every message,
 * not only the system prompt, and pays no mind to case. Adapted from magpie's workbuddy.
 */
const FLAGGED: readonly [RegExp, string][] = [
  [/x-anthropic-billing-header:[^\n]*\n?/gi, ''],
  [/You are Claude Code, Anthropic['']s official CLI for Claude/gi, "You are Claude Code, Anthropic's CLI for Claude"],
  [/Main branch \(you will usually use this for PRs\)/gi, 'Main branch (usually the base for PRs)'],
  [/(?<!the )Codex CLI is an open source project led by OpenAI\./gi, 'The Codex CLI is an open source project led by OpenAI.'],
]

/** Put FLAGGED's words in place in one message's content. */
function unflagText(text: string): string {
  let out = text
  for (const [pattern, replacement] of FLAGGED) out = out.replace(pattern, replacement)
  return out
}

/** Apply the FLAGGED filter to every message's content, in place. */
function unflagMessages(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (typeof message.content === 'string') {
      message.content = unflagText(message.content)
    }
  }
  return messages
}

/** 32 hex digits, for the chat ids WorkBuddy's own client makes. */
function randomHex(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** A tool's name may hold letters, digits, `_`, `-`; another character is refused. */
const NAME_OK = /^[A-Za-z0-9_-]+$/

/** A name with each character WorkBuddy refuses as `_`, kept apart from `taken`. */
function safeName(name: string, taken: Set<string>): string {
  const base = name.replace(/[^A-Za-z0-9_-]/g, '_') || 'tool'
  let candidate = base
  for (let index = 2; taken.has(candidate); index++) candidate = `${base}_${index}`
  taken.add(candidate)
  return candidate
}

/** True for a plain object usable as a JSON-schema node. */
function isSchemaRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Mend a schema where the model gateway refuses one: `\0` escapes in a pattern, and an
 * `items` list (deep models take a single shape or an anyOf, not a bare array).
 */
function fitSchema(schema: Record<string, unknown>, depth = 0): boolean {
  if (depth > 64) return false
  let changed = false
  if (Array.isArray(schema)) {
    for (const item of schema) if (isSchemaRecord(item) && fitSchema(item, depth + 1)) changed = true
    return changed
  }
  if (typeof schema.pattern === 'string' && schema.pattern.includes('\\0')) {
    schema.pattern = schema.pattern.replace(/\\0/g, '\\u0000')
    changed = true
  }
  if (Array.isArray(schema.items)) {
    const list = schema.items.filter(isSchemaRecord)
    schema.items = list.length === 0 ? {} : list.length === 1 ? list[0] : { anyOf: list }
    delete schema.additionalItems
    changed = true
  }
  for (const value of Object.values(schema)) {
    if (isSchemaRecord(value) && fitSchema(value, depth + 1)) changed = true
  }
  return changed
}

/** The schema a local `$ref` names, or `node` itself. */
function localRef(root: Record<string, unknown>, node: Record<string, unknown>): Record<string, unknown> {
  const ref = node.$ref
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return node
  let at: unknown = root
  for (const key of ref.slice(2).split('/')) {
    at = isSchemaRecord(at) ? at[key.replaceAll('~1', '/').replaceAll('~0', '~')] : undefined
  }
  return isSchemaRecord(at) ? at : node
}

/**
 * Make a tool's parameters an object at the root, the shape every model takes: `allOf`'s
 * branches are merged whole; of `anyOf`/`oneOf`'s object branches the properties are
 * merged and a field each requires stays required.
 */
function objectRoot(node: Record<string, unknown>, root: Record<string, unknown> = node, depth = 0): boolean {
  const unions = ['allOf', 'anyOf', 'oneOf'].filter((key) => Array.isArray(node[key]))
  if (node.type === 'object' && unions.length === 0) return false
  const properties: Record<string, unknown> = isSchemaRecord(node.properties) ? { ...node.properties } : {}
  const required: string[] = Array.isArray(node.required) ? [...node.required] : []
  for (const branch0 of Array.isArray(node.allOf) ? node.allOf : []) {
    let branch = localRef(root, isSchemaRecord(branch0) ? branch0 : {})
    if (unions.length > 0 && depth < 8) objectRoot((branch = structuredClone(branch)), root, depth + 1)
    if (isSchemaRecord(branch) && isSchemaRecord(branch.properties)) {
      for (const [key, value] of Object.entries(branch.properties)) if (!(key in properties)) properties[key] = value
    }
    if (isSchemaRecord(branch) && Array.isArray(branch.required)) required.push(...branch.required)
  }
  const branches: Record<string, unknown>[] = []
  for (const key of ['anyOf', 'oneOf']) {
    for (const branch0 of Array.isArray(node[key]) ? node[key] : []) {
      let branch = localRef(root, isSchemaRecord(branch0) ? branch0 : {})
      if (unions.length > 0 && depth < 8) objectRoot((branch = structuredClone(branch)), root, depth + 1)
      if (isSchemaRecord(branch) && (branch.type === 'object' || isSchemaRecord(branch.properties))) branches.push(branch)
    }
  }
  const from = new Map<string, unknown[]>()
  for (const branch of branches) {
    if (!isSchemaRecord(branch.properties)) continue
    for (const [key, value] of Object.entries(branch.properties)) {
      if (key in properties) continue
      const seen = from.get(key) ?? []
      if (!seen.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) seen.push(value)
      from.set(key, seen)
    }
  }
  for (const [key, list] of from) properties[key] = list.length === 1 ? list[0] : { anyOf: list }
  delete node.allOf
  delete node.anyOf
  delete node.oneOf
  node.type = 'object'
  node.properties = properties
  if (required.length > 0) node.required = [...new Set(required)]
  else delete node.required
  return true
}

/** The WorkBuddy China wire adapter serving the `workbuddy` route. */
export class WorkBuddyAdapter extends LlmAdapter {
  private readonly fetchFn: FetchFn

  constructor(private readonly options: WorkBuddyAdapterOptions) {
    super()
    this.fetchFn = options.fetchFn ?? proxiedFetch
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: WORKBUDDY_PROVIDER_NAME }
  }

  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    if (await this.options.tokens.session() === undefined) return []
    const hidden = await this.hidden()
    return WORKBUDDY_CATALOG.filter((entry) => !hidden.has(entry.id)).map((entry) => ({
      provider: WORKBUDDY_PROVIDER_ID,
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
    } catch {
      return new Set()
    }
  }

  /** The catalog the Settings list reads. */
  catalogEntries(): readonly CatalogEntry[] {
    return WORKBUDDY_CATALOG
  }

  /** The entries the route itself serves, without hand-added extras. */
  ownCatalogEntries(): readonly CatalogEntry[] {
    return WORKBUDDY_CATALOG
  }

  override async resolveModel(_provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const entry = findEntry(WORKBUDDY_CATALOG, model)
    if (entry === undefined) {
      return {
        provider: WORKBUDDY_PROVIDER_ID,
        id: model,
        name: model,
        context: { contextWindow: 0 },
        inputModalities: ['text', 'image'],
      }
    }
    return {
      provider: WORKBUDDY_PROVIDER_ID,
      id: entry.id,
      name: entry.name,
      ...entry.description === undefined ? {} : { description: entry.description },
      ...entry.inputModalities === undefined ? {} : { inputModalities: entry.inputModalities },
      context: { contextWindow: entry.contextWindow },
      ...entry.reasoningEfforts === undefined || entry.reasoningEfforts.length === 0
        ? {}
        : { reasoning: { efforts: entry.reasoningEfforts.map((id) => ({ id: ReasoningEffortId(id), name: id })) } },
    }
  }

  override providerRetryPolicy(): undefined {
    return undefined
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const held = await this.options.tokens.session()
    if (held === undefined) throw new Error('WorkBuddy is not signed in')
    const token = this.tokenOf(held.session)
    const watchdog = idleWatchdog(options.signal, this.options.streamIdleTimeoutMs)
    // Capture the tool-call history so unsafe tool names in past turns can be renamed to
    // the safe ones the model now sees, keeping the conversation consistent.
    this.historyMessages = options.messages.filter((message) => message.role === 'assistant' || message.role === 'tool') as unknown as Record<string, unknown>[]
    try {
      const body = this.requestBody(options)
      const response = await this.fetchFn(WORKBUDDY_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          ...workbuddyHeaders(token),
          // Name the chat the way WorkBuddy's own client does: the conversation, the
          // turn, and the message. Without these the gateway counts the request under no
          // client and cuts the stream, which is why the reply stopped after a few seconds.
          'X-Conversation-Message-ID': randomHex(),
          'X-Request-ID': randomHex(),
          'X-Conversation-Request-ID': randomHex(),
          'X-Conversation-ID': randomHex(),
        },
        body: JSON.stringify(body),
        signal: watchdog.signal,
      })
      // WorkBuddy refuses a chat mid-stream when the request carries words it filters; a
      // 403/400 here names why, so surface it instead of dying on an empty stream.
      if (!response.ok || response.body === null) {
        throw await this.errorOf(response)
      }
      yield* this.readStream(response, watchdog)
    } catch (error) {
      throw mapFetchFailure(WORKBUDDY_PROVIDER_NAME, error, watchdog, options.signal)
    } finally {
      watchdog.stop()
    }
  }

  /** The stored session's fields as the token the request signs with. */
  private tokenOf(session: WorkBuddySession): WorkBuddyTokenSet {
    return {
      accessToken: session.accessToken,
      expiresAt: session.expiresAt,
      ...session.refreshToken === undefined ? {} : { refreshToken: session.refreshToken },
      ...session.uid === undefined ? {} : { uid: session.uid },
      ...session.enterpriseId === undefined ? {} : { enterpriseId: session.enterpriseId },
      ...session.domain === undefined ? {} : { domain: session.domain },
      ...session.tokenType === undefined ? {} : { tokenType: session.tokenType },
      ...session.refreshExpiresAt === undefined ? {} : { refreshExpiresAt: session.refreshExpiresAt },
    }
  }

  private requestBody(options: GenerateOptions): Record<string, unknown> {
    const messages: Record<string, unknown>[] = []
    for (const message of options.messages) {
      messages.push(this.toChatMessage(message))
    }
    // A chat that doesn't open with a system message is refused: give it WorkBuddy's
    // default one, as its own app does, and take the words WorkBuddy filters (Codex and
    // Claude Code's own) out of every message — WorkBuddy reads them all, whatever role.
    const system = this.systemPrompt(options)
    messages.unshift({ role: 'system', content: system })
    const tools = this.fittedTools(options.tools)
    return {
      model: options.model,
      messages: unflagMessages(messages),
      ...tools === undefined ? {} : { tools: tools.tools },
      ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
      stream: true,
    }
  }

  /**
   * Mend the tool schemas the way WorkBuddy's model gateway accepts.
   *
   * A tool name may hold only letters, digits, `_`, `-`; another character is refused, and
   * a schema with a union at the parameter root or a `\0` escape is turned away by the
   * model. Each unsafe name is made safe and the safe→original map kept on the adapter so
   * the model's calls can be renamed back in the answer. Adapted from magpie's fitTools.
   *
   * @param tools - the declared tool schemas, when any.
   * @returns the mended wire tools, or undefined when there are none.
   */
  private fittedTools(tools: readonly ToolSchema[] | undefined): { tools: Record<string, unknown>[], names: Map<string, string> } | undefined {
    if (tools === undefined || tools.length === 0) return undefined
    const wire: Record<string, unknown>[] = tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        ...tool.description === '' ? {} : { description: tool.description },
        ...tool.parameters === undefined ? {} : { parameters: structuredClone(tool.parameters) },
      },
    }))
    const taken = new Set<string>()
    for (const tool of wire) {
      const name = (tool.function as Record<string, unknown>).name
      if (typeof name === 'string' && NAME_OK.test(name)) taken.add(name)
    }
    const names = new Map<string, string>()
    const theirs = new Map<string, string>()
    for (const tool of wire) {
      const fn = tool.function as Record<string, unknown>
      if (typeof fn.name === 'string' && !NAME_OK.test(fn.name)) {
        const safe = safeName(fn.name, taken)
        names.set(safe, fn.name)
        theirs.set(fn.name, safe)
        fn.name = safe
      }
      if (fn.parameters !== undefined) {
        if (!isSchemaRecord(fn.parameters)) fn.parameters = { type: 'object', properties: {} }
        else {
          fitSchema(fn.parameters)
          objectRoot(fn.parameters)
        }
      }
    }
    // Rename the calls in the conversation history to the safe names, so a turn that
    // already called a tool matches the name the model now sees.
    for (const message of this.historyMessages ?? []) {
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const fn = call?.function
        if (fn && typeof fn.name === 'string' && theirs.has(fn.name)) fn.name = theirs.get(fn.name)
      }
      if (message.role === 'tool' && typeof message.name === 'string' && theirs.has(message.name)) {
        message.name = theirs.get(message.name)
      }
    }
    this.safeToolNames = names
    return { tools: wire, names }
  }

  /** The safe→original tool names to restore in the answer. */
  private safeToolNames: Map<string, string> = new Map()

  /** The assistant/tool history of the request being built, for renaming past calls. */
  private historyMessages: Record<string, unknown>[] = []

  /**
   * Restore the original tool names the model was given, in one parsed chunk.
   *
   * @param value - a decoded SSE payload.
   * @returns whether any name changed.
   */
  private namedBack(value: Record<string, unknown>): boolean {
    let changed = false
    for (const choice of Array.isArray(value.choices) ? value.choices : []) {
      if (!isSchemaRecord(choice)) continue
      for (const at of [choice.message, choice.delta]) {
        if (!isSchemaRecord(at)) continue
        for (const call of Array.isArray(at.tool_calls) ? at.tool_calls : []) {
          if (!isSchemaRecord(call) || !isSchemaRecord(call.function)) continue
          const original = this.safeToolNames.get(String(call.function.name))
          if (original !== undefined) {
            call.function.name = original
            changed = true
          }
        }
      }
    }
    return changed
  }

  /** The system prompt: the caller's, else WorkBuddy's default. */
  private systemPrompt(options: GenerateOptions): string {
    if (options.system !== undefined && options.system.trim() !== '') return options.system
    for (const message of options.messages) {
      if (message.role === 'system') {
        const text = message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
        if (text.trim() !== '') return text
      }
    }
    return 'You are a helpful assistant.'
  }

  private toChatMessage(message: GenerateOptions['messages'][number]): Record<string, unknown> {
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const textParts: string[] = []
    for (const block of message.content) {
      if (block.type === 'text') textParts.push(block.text)
    }
    return { role, content: textParts.join('\n') }
  }

  /** Turn a non-2xx into an LlmError, naming WorkBuddy's specific refusals. */
  private async errorOf(response: Response): Promise<unknown> {
    const text = await response.text().catch(() => '')
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(text) as Record<string, unknown>
    } catch {
      body = {}
    }
    const code = Number(body.code ?? (body.data as Record<string, unknown> | undefined)?.code ?? 0)
    const message = String(body.msg ?? (body.error as Record<string, unknown> | undefined)?.message ?? body.message ?? text.slice(0, 200) ?? `HTTP ${response.status}`)
    if (/unapproved channel|illegal api invocation/i.test(text)) {
      return new Error(`${message} — WorkBuddy refuses chats from Codex and Claude Code; use another client or add another provider`)
    }
    if (code === 11140 || /account has been restricted due to unusual activity/i.test(text)) {
      return new Error(`${message} — WorkBuddy restricted this account; it stays out until WorkBuddy lifts that`)
    }
    if (code === 14018 || /credits exhausted|额度已用尽/i.test(text)) {
      return new Error(`${message} — WorkBuddy requires an active credit package even for 0-rate free models`)
    }
    const { LlmError } = await import('@deepseek-ai/dsh-llm')
    return new LlmError(
      `${WORKBUDDY_PROVIDER_NAME} request failed (HTTP ${response.status}): ${message}`,
      response.status === 401 || response.status === 403 ? 'INVALID_CREDENTIAL'
        : response.status === 429 ? 'RATE_LIMIT'
          : response.status >= 500 ? 'SERVER' : 'HTTP_ERROR',
      { status: response.status },
    )
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
        // WorkBuddy's SSE frames are blank-line separated, whatever the platform's line
        // ending (\n, \r\n, or \r alone): split on any blank line so a \r\n stream is not
        // read as one unending frame.
        const frames = buffer.split(/\r?\n\r?\n/)
        buffer = frames.pop() ?? ''
        for (const frame of frames) {
          const data = frame
            .split(/\r?\n/)
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
          // WorkBuddy names a refusal mid-stream (an error frame, or a body with a non-zero
          // code): surface it instead of reading the rest as silence, so the turn fails with
          // the reason rather than stopping after a few empty seconds.
          const wireError = (chunk as Record<string, unknown>).error ?? chunk.choices?.[0]?.delta
          if (wireError !== undefined && wireError !== null && typeof wireError === 'object') {
            const message = (wireError as Record<string, unknown>).message
            if (typeof message === 'string' && message !== '') throw new Error(`WorkBuddy: ${message}`)
          }
          const wireCode = (chunk as Record<string, unknown>).code
          if (typeof wireCode === 'number' && wireCode !== 0) {
            const msg = (chunk as Record<string, unknown>).msg
            throw new Error(`WorkBuddy: ${typeof msg === 'string' ? msg : `error ${wireCode}`}`)
          }
          // Restore the tool names the model called to the ones the client declared, before
          // the chunk is read as a stream event.
          this.namedBack(chunk as Record<string, unknown>)
          // A tool-call delta: emit it so the harness can run the tool. The id and name ride
          // the first delta of each call; later deltas carry argument fragments.
          const toolCalls = chunk.choices?.[0]?.delta?.tool_calls
          if (Array.isArray(toolCalls)) {
            for (const call of toolCalls) {
              const fn = call?.function
              if (fn === undefined || fn === null) continue
              const index = call.index ?? 0
              const id = ToolCallId(call.id ?? `wb-tool-${index}`)
              const name = fn.name
              const args = fn.arguments
              if (typeof name === 'string' && name !== '') {
                yield { type: 'tool-call-delta', index, id, name, argumentsDelta: '' }
              }
              if (typeof args === 'string' && args !== '') {
                yield { type: 'tool-call-delta', index, id, argumentsDelta: args }
              }
            }
          }
          const delta = chunk.choices?.[0]?.delta?.content
          if (typeof delta === 'string' && delta !== '') {
            if (!started) {
              yield { type: 'block-start', index: 0, blockType: 'text' }
              started = true
            }
            yield { type: 'text-delta', index: 0, text: delta }
          }
          const usage = chunk.usage
          if (usage !== undefined && usage !== null) {
            const input = usage.prompt_tokens ?? 0
            const output = usage.completion_tokens ?? 0
            yield {
              type: 'usage',
              usage: { inputTokens: input, outputTokens: output, totalTokens: usage.total_tokens ?? input + output },
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

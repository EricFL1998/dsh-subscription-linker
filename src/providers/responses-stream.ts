/**
 * The shared request/stream dance for providers that speak the OpenAI Responses
 * wire (Kimi Code, xAI/Grok).
 *
 * Everything route-specific stays with the route: building the URL, assembling
 * the body, and its headers. What is shared is the part that is easy to get
 * subtly wrong twice — resolving a usable token, retrying exactly once after a
 * rejected credential, walking a model chain when one model is unavailable,
 * mapping transport and HTTP failures, guarding an idle stream, and translating
 * the SSE body into harness chunks.
 *
 * @module dsh-plugin-subscription-oauth/providers/responses-stream
 */

import { EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

import type { SessionBase } from '../auth/store.js'
import type { TokenManager } from '../auth/tokens.js'
import { streamResponses } from '../translate/responses.js'
import { httpLlmError, idleWatchdog, mapFetchFailure } from './common.js'

/** Constructor inputs for {@link streamProviderResponses}. */
export interface ResponsesStreamInput<S extends SessionBase> {
  /** Endpoint name used in failure messages, e.g. `Kimi API`. */
  label: string
  /** Token manager owning refresh. */
  tokens: TokenManager<S>
  /** Send one request for one model with the given access token. */
  request(options: GenerateOptions, model: string, accessToken: string, signal: AbortSignal): Promise<Response>
  /** Inactivity budget before the stream is abandoned. */
  streamIdleTimeoutMs: number
  /**
   * The models to try, most preferred first, resolved lazily.
   *
   * Omitted means "only the requested model". `auto` supplies the user's whole
   * ranked chain here; a concrete id supplies just itself.
   */
  models?: () => Promise<readonly string[]>
  /** Called when a call proved the stored credential unusable. */
  onCredentialRejected?: (account: string) => void
  /** Rewrite a thrown failure before it is mapped, e.g. to name the fix. */
  describeFailure?(error: unknown): unknown
  /** Called when a model in the chain was skipped, with the reason. */
  onFallback?: (from: string, to: string, reason: string) => void
}

/**
 * Whether a refusal says "this model cannot serve you now", as opposed to "this
 * request is wrong".
 *
 * Only the first kind may be answered by another model. A 400 or an unparseable
 * body is a bug in what this plugin sent: silently re-sending it elsewhere would
 * hide the defect and produce an answer from a model the caller did not ask for.
 */
function isModelFallbackWorthy(status: number): boolean {
  // Gone or renamed model, exhausted allowance, rate limit, provider trouble.
  return status === 402 || status === 404 || status === 408 || status === 429 || status >= 500
}

/** One short reason for a log line. */
function reasonOf(error: unknown): string {
  if (error instanceof LlmError) return `${error.failure.code}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run one model call over the Responses wire, walking a model chain.
 *
 * The chain is what `auto` means to a user: request the most preferred model,
 * and — only while nothing has been streamed yet — fall through to the next one
 * when the provider says that model cannot serve this request. Once any chunk has
 * been produced the turn belongs to that model, so a later failure is reported
 * rather than papered over by a second model's text.
 *
 * A 401/403 triggers exactly one forced token refresh and retry of the same
 * model before the chain advances; if the retry is refused too, the credential is
 * reported as dead so the caller can ask the user to sign in again.
 *
 * @param options - the fully assembled request for this call.
 * @param input - the route's transport hooks and budgets.
 * @yields harness stream chunks in contract order.
 */
export async function* streamProviderResponses<S extends SessionBase>(
  options: GenerateOptions,
  input: ResponsesStreamInput<S>,
): AsyncIterable<StreamChunk> {
  const { label, tokens, request } = input
  const watchdog = idleWatchdog(options.signal, input.streamIdleTimeoutMs)
  let lastError: unknown
  try {
    // A chain is resolved once per call, so a settings change can never make the
    // fallbacks disagree with the model the caller asked for.
    const models = input.models === undefined ? [options.model] : await input.models()
    if (models.length === 0) {
      throw new LlmError(`${label} has no enabled model to dispatch to`, EMPTY_RESPONSE_CODE)
    }
    let token = await tokens.resolve()
    for (const [index, model] of models.entries()) {
      try {
        let response = await request(options, model, token.accessToken, watchdog.signal)
        if (response.status === 401 || response.status === 403) {
          token = await tokens.resolve(token.account, true)
          response = await request(options, model, token.accessToken, watchdog.signal)
          if (response.status === 401 || response.status === 403) {
            input.onCredentialRejected?.(token.account)
          }
        }
        if (!response.ok) {
          const error = await httpLlmError(response, label)
          if (models.length > 1 && isModelFallbackWorthy(response.status) && index < models.length - 1) {
            const next = models[index + 1]
            if (next !== undefined) {
              lastError = error
              input.onFallback?.(model, next, reasonOf(error))
              continue
            }
          }
          throw error
        }
        if (response.body === null) {
          throw new LlmError(`${label} returned no response body`, EMPTY_RESPONSE_CODE)
        }
        yield* streamResponses(response.body, () => { watchdog.pulse() })
        return
      } catch (error: unknown) {
        // A transport failure on a chain is also worth another model.
        const transport = error instanceof TypeError || (error as { name?: string }).name === 'AbortError'
        if (transport && options.signal?.aborted !== true && index < models.length - 1) {
          const next = models[index + 1]
          if (next !== undefined) {
            lastError = error
            input.onFallback?.(model, next, reasonOf(error))
            continue
          }
        }
        throw input.describeFailure === undefined ? error : input.describeFailure(error)
      }
    }
    throw lastError ?? new LlmError(`${label} served none of the requested models`, EMPTY_RESPONSE_CODE)
  } catch (error: unknown) {
    const described = input.describeFailure === undefined ? error : input.describeFailure(error)
    throw mapFetchFailure(label, described, watchdog, options.signal)
  } finally {
    watchdog.stop()
  }
}

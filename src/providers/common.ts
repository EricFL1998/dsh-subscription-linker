/**
 * Shared provider plumbing: an idle watchdog for streams, wire-error
 * classification, and transport-failure mapping.
 *
 * @module dsh-plugin-subscription-oauth/providers/common
 */

import { errorChain, LlmError } from '@deepseek-ai/dsh-llm'

/** Watchdog handle used around one streaming request. */
export interface IdleWatchdog {
  /** Abort signal to hand to `fetch`; also fires when the caller's signal does. */
  readonly signal: AbortSignal
  /** Report inbound transport activity, resetting the idle timer. */
  pulse(): void
  /** Stop the timer; safe to call more than once. */
  stop(): void
  /** Whether the idle budget (rather than the caller) aborted the request. */
  readonly timedOut: boolean
}

/**
 * Guard one stream with an inactivity budget.
 *
 * The timer aborts the request when no chunk arrives for `idleMs`, so a dead
 * connection fails the turn instead of hanging it forever.
 *
 * @param signal - the caller's cancellation signal, if any.
 * @param idleMs - inactivity budget in milliseconds; a non-positive value disables it.
 * @returns the watchdog.
 */
export function idleWatchdog(signal: AbortSignal | undefined, idleMs: number): IdleWatchdog {
  const controller = new AbortController()
  let timedOut = false
  let timer: NodeJS.Timeout | undefined
  const onCallerAbort = (): void => controller.abort(signal?.reason)
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onCallerAbort, { once: true })
  }
  const arm = (): void => {
    if (idleMs <= 0) return
    timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error(`Kimi stream idle for more than ${idleMs}ms`))
    }, idleMs)
    timer.unref?.()
  }
  const clear = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const stop = (): void => {
    clear()
    signal?.removeEventListener('abort', onCallerAbort)
  }
  arm()
  return {
    signal: controller.signal,
    pulse: () => {
      clear()
      arm()
    },
    stop,
    get timedOut() {
      return timedOut
    },
  }
}

/** Read a `retry-after` header as an absolute delay in milliseconds. */
function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('retry-after')
  if (raw === null) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const at = Date.parse(raw)
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now())
  return undefined
}

/** Provider-neutral failure code for one HTTP status. */
function statusCode(status: number): string {
  if (status === 401 || status === 403) return 'INVALID_CREDENTIAL'
  if (status === 404) return 'MODEL_NOT_FOUND'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400 || status === 422) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return 'HTTP_ERROR'
}

/** Best-effort provider message out of an error response body. */
async function errorBodyMessage(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text()
    if (text.trim() === '') return undefined
    try {
      const parsed = JSON.parse(text) as unknown
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>
        const error = record.error
        if (typeof error === 'object' && error !== null) {
          const errorRecord = error as Record<string, unknown>
          const message = errorRecord.message
          // Google puts the offending field in details[].fieldViolations, which the bare
          // message omits; surface it so a 400 names what to fix instead of "invalid argument".
          const detail = extractFieldViolations(errorRecord.details)
          if (detail !== undefined) return `${String(message ?? '').trim()} — ${detail}`
          if (typeof message === 'string' && message.trim() !== '') return message.trim()
        }
        if (typeof record.message === 'string' && record.message.trim() !== '') return record.message.trim()
        if (typeof error === 'string' && error.trim() !== '') return error.trim()
      }
    } catch {
      // Not JSON: fall through to the raw body.
    }
    return text.slice(0, 400).trim()
  } catch {
    return undefined
  }
}

/** The offending-field text inside a Google RPC error's `details` list, when present. */
function extractFieldViolations(details: unknown): string | undefined {
  if (!Array.isArray(details)) return undefined
  const out: string[] = []
  for (const entry of details) {
    if (typeof entry !== 'object' || entry === null) continue
    const violations = (entry as Record<string, unknown>).fieldViolations
    if (!Array.isArray(violations)) continue
    for (const violation of violations) {
      if (typeof violation !== 'object' || violation === null) continue
      const field = (violation as Record<string, unknown>).field
      const description = (violation as Record<string, unknown>).description
      if (typeof description === 'string' && description.trim() !== '') {
        out.push(typeof field === 'string' && field.trim() !== '' ? `${field}: ${description.trim()}` : description.trim())
      }
    }
  }
  return out.length === 0 ? undefined : out.join('; ')
}

/**
 * Turn a non-2xx provider response into an LlmError carrying the status and
 * any rate-limit hint the headers disclosed.
 *
 * @param response - the failed response.
 * @param label - human name of the endpoint, used in the message.
 * @returns the error to throw.
 */
export async function httpLlmError(response: Response, label: string): Promise<LlmError> {
  const detail = await errorBodyMessage(response)
  const retryAfter = retryAfterMs(response)
  const message = detail === undefined
    ? `${label} request failed (HTTP ${response.status} ${response.statusText})`.trim()
    : `${label} request failed (HTTP ${response.status}): ${detail}`
  return new LlmError(message, statusCode(response.status), {
    status: response.status,
    ...retryAfter === undefined ? {} : { providerRetryAfterMs: retryAfter },
  })
}

/** Whether a failure means the stored credential no longer works. */
export function isMissingOrInvalidCredential(error: unknown): boolean {
  if (error instanceof LlmError) {
    return error.failure.code === 'INVALID_CREDENTIAL' || error.failure.status === 401 || error.failure.status === 403
  }
  return false
}

/** Body text that says the request named a model the account does not serve. */
const UNKNOWN_MODEL = /model id does not exist|unknown model|model (?:id )?not found|does not exist, recognized as/i

/** Body text that names the model id to use instead. */
const MODEL_REPLACEMENT = /set model id as\s*`?([A-Za-z0-9][A-Za-z0-9._:@[\]/-]*)`?/i

/**
 * The model id a provider's failure names as the one to use instead.
 *
 * A 401/403 is not always about the credential: a provider also answers it when the
 * request names a model id the account does not serve — Kimi says `Your model id does
 * not exist, recognized as other:k3[1m]. Please set model id as \`k3\``. That message
 * is the endpoint's own answer to "which id should I have used", so it is worth acting
 * on rather than reporting: refreshing a healthy token, or marking the account as
 * needing a new login, would both be wrong answers to a model rename.
 *
 * @param message - the failure text.
 * @returns the replacement id, or undefined when the failure is not about the model id.
 */
export function unknownModelReplacement(message: string): string | undefined {
  if (!UNKNOWN_MODEL.test(message)) return undefined
  const replacement = MODEL_REPLACEMENT.exec(message)?.[1]
  return replacement === undefined || replacement === '' ? undefined : replacement
}

/**
 * Map a thrown transport failure onto a harness error, distinguishing caller
 * cancellation from an idle timeout from a genuine network fault.
 *
 * @param label - human name of the endpoint.
 * @param error - the thrown value.
 * @param watchdog - the request's watchdog, when one was installed.
 * @param signal - the caller's signal.
 * @returns the error to throw.
 */
export function mapFetchFailure(
  label: string,
  error: unknown,
  watchdog?: Pick<IdleWatchdog, 'timedOut'>,
  signal?: AbortSignal,
): unknown {
  if (error instanceof LlmError) return error
  if (signal?.aborted === true) return error
  if (watchdog?.timedOut === true) {
    return new LlmError(`${label} stream timed out waiting for data`, 'TIMEOUT')
  }
  const cause = error instanceof Error ? error.cause : undefined
  if (cause !== undefined && cause !== error) {
    return new LlmError(`${label} request failed: ${errorChain(error)}`, 'NETWORK', { cause: error })
  }
  return error instanceof Error
    ? new LlmError(`${label} request failed: ${error.message}`, 'NETWORK', { cause: error })
    : new LlmError(`${label} request failed: ${String(error)}`, 'NETWORK')
}

/**
 * The Ark control plane: STS credentials, request signing, and allowance reads.
 *
 * Ark splits its API in two. The **data plane** (`ark.cn-beijing.volces.com`)
 * takes a plan API key as a plain bearer. The **control plane**
 * (`ark.cn-beijing.volcengineapi.com`) is Volcengine OpenAPI: every call is
 * `POST /?Action=<name>&Version=<date>` signed with the temporary AK/SK the SSO
 * identity was exchanged for, and the plan's allowance lives only there.
 *
 * The signing below was written from the official CLI's own algorithm and then
 * checked against the live service with real credentials, which answered 200 with
 * the same body the CLI reports.
 *
 * @module dsh-plugin-subscription-oauth/auth/ark-control
 */

import { createHash, createHmac } from 'node:crypto'

import { attributedHeaders } from './headers.js'
import type { FetchFn } from '../http.js'

/** Control-plane host: the OpenAPI endpoint, not the data-plane one. */
export const ARK_CONTROL_HOST = 'ark.cn-beijing.volcengineapi.com'

/** Region every Ark OpenAPI action is scoped to. */
export const ARK_CONTROL_REGION = 'cn-beijing'

/** Service name in the signing scope. */
export const ARK_CONTROL_SERVICE = 'ark'

/** Version every Ark OpenAPI action takes. */
export const ARK_CONTROL_VERSION = '2024-01-01'

/** Temporary credentials the SSO identity is exchanged for. */
export interface ArkStsCredentials {
  /** Access key id, `AKT…` for a session credential. */
  readonly accessKeyId: string
  /** Secret access key. */
  readonly secretAccessKey: string
  /** Session token that must accompany the signature. */
  readonly sessionToken: string
  /** Epoch milliseconds the credentials lapse. */
  readonly expiresAt: number
}

/** An RFC 3339 UTC instant in the compact form the signature wants. */
function amzDate(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

/** HMAC-SHA256 of `value` under `key`. */
function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest()
}

/**
 * Sign one OpenAPI request the way Volcengine expects.
 *
 * The canonical request lists `content-type;host;x-content-sha256;x-date`, which is
 * the set the official client signs for these actions.
 *
 * @param input - method, query, body, and the credentials to sign with.
 * @returns the headers to send.
 */
export function signArkRequest(input: {
  method: 'GET' | 'POST'
  query: string
  body: string
  credentials: ArkStsCredentials
  at?: Date
}): Record<string, string> {
  const contentType = 'application/x-www-form-urlencoded'
  const at = input.at ?? new Date()
  const xDate = amzDate(at)
  const contentSha = createHash('sha256').update(input.body).digest('hex')
  const signedHeaders = 'content-type;host;x-content-sha256;x-date'
  const canonical = [
    input.method,
    '/',
    input.query,
    `content-type:${contentType}`,
    `host:${ARK_CONTROL_HOST}`,
    `x-content-sha256:${contentSha}`,
    `x-date:${xDate}`,
    '',
    signedHeaders,
    contentSha,
  ].join('\n')
  const scope = `${xDate.slice(0, 8)}/${ARK_CONTROL_REGION}/${ARK_CONTROL_SERVICE}/request`
  const stringToSign = [
    'HMAC-SHA256',
    xDate,
    scope,
    createHash('sha256').update(canonical).digest('hex'),
  ].join('\n')
  // The derived signing key is a four-step HMAC chain: date, region, service, then
  // the literal "request".
  const kSigning = hmac(hmac(hmac(hmac(input.credentials.secretAccessKey, xDate.slice(0, 8)), ARK_CONTROL_REGION), ARK_CONTROL_SERVICE), 'request')
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')
  return {
    'content-type': contentType,
    'host': ARK_CONTROL_HOST,
    'x-content-sha256': contentSha,
    'x-date': xDate,
    'x-security-token': input.credentials.sessionToken,
    'authorization': `HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}

/** Call one control-plane action. */
export async function callArkControl<T>(input: {
  action: string
  credentials: ArkStsCredentials
  fetchFn: FetchFn
  body?: string
  signal?: AbortSignal
}): Promise<T> {
  const query = `Action=${input.action}&Version=${ARK_CONTROL_VERSION}`
  const body = input.body ?? ''
  const response = await input.fetchFn(`https://${ARK_CONTROL_HOST}/?${query}`, {
    method: 'POST',
    headers: {
      ...attributedHeaders(signArkRequest({ method: 'POST', query, body, credentials: input.credentials })),
    },
    body,
    ...input.signal === undefined ? {} : { signal: input.signal },
  })
  const payload = await response.json().catch(() => undefined) as unknown
  if (!response.ok) {
    throw new Error(`Ark control plane refused ${input.action} (HTTP ${response.status})`)
  }
  return payload as T
}

/** One model's free inference allowance, as `ListModelChargeItems` reports it. */
export interface ArkFreeUsage {
  /** Model id the allowance belongs to. */
  readonly model: string
  /** Tokens already spent. */
  readonly consumed: number
  /** Tokens granted. */
  readonly total: number
}

/** Read a finite number from a wire field. */
function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * Read every model's free inference allowance.
 *
 * This is the allowance that exists without a subscription — the plan quota is a
 * separate action that reports `Status: Reclaimed` for an account with no plan.
 * Free usage is per model, and the free-usage field is omitted for models that have
 * none, so those are skipped rather than reported as zero.
 *
 * @param payload - the decoded `ListModelChargeItems` body.
 * @returns one entry per model that states a free allowance.
 */
export function parseArkFreeUsage(payload: unknown): ArkFreeUsage[] {
  if (typeof payload !== 'object' || payload === null) return []
  const result = (payload as Record<string, unknown>).Result
  if (typeof result !== 'object' || result === null) return []
  const items = (result as Record<string, unknown>).Items
  if (!Array.isArray(items)) return []
  const out: ArkFreeUsage[] = []
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as Record<string, unknown>
    const model = typeof item.FoundationModelName === 'string' ? item.FoundationModelName.trim() : ''
    const usage = item.InferenceFreeUsage
    if (model === '' || typeof usage !== 'object' || usage === null) continue
    const record = usage as Record<string, unknown>
    const total = num(record.Total)
    const consumed = num(record.Consumed) ?? 0
    if (total === undefined || total <= 0) continue
    out.push({ model, consumed, total })
  }
  return out
}

/** One metered period of a paid plan, as the CLI documents it. */
export interface ArkPeriod {
  /** `5h`, `weekly`, `monthly`, or `session` for the team edition. */
  readonly label: string
  /** Units already spent. */
  readonly used?: number
  /** Units granted. */
  readonly total?: number
  /** Percent spent, when the service states it. */
  readonly percent?: number
  /** Epoch milliseconds the period resets. */
  readonly resetsAt?: number
}

/** A plan's state and its metered periods. */
export interface ArkPlanUsage {
  /** Whether the account holds the plan at all. */
  readonly subscribed: boolean
  /** Plan state as the service names it, e.g. `Reclaimed`. */
  readonly status?: string
  /** The metered periods, in the order the service listed them. */
  readonly periods: readonly ArkPeriod[]
}

/** A reset instant from an RFC 3339 string. */
function instant(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Read a plan's allowance out of a `GetCodingPlanUsage` / `GetAFPUsage` body.
 *
 * The service nests the metered periods under `coding_usage` (Coding Plan) or
 * `afp_usage` (Agent Plan); each period is
 * `{ label, used, total, percent, reset_at }`, which the CLI's own help documents
 * with a worked example. An account with no plan answers `Status: Reclaimed` and no
 * periods, which is a state to report rather than an error.
 *
 * @param payload - the decoded control-plane body.
 * @returns the plan state and its periods.
 */
export function parseArkPlanUsage(payload: unknown): ArkPlanUsage {
  if (typeof payload !== 'object' || payload === null) return { subscribed: false, periods: [] }
  const result = (payload as Record<string, unknown>).Result
  if (typeof result !== 'object' || result === null) return { subscribed: false, periods: [] }
  const record = result as Record<string, unknown>
  const status = typeof record.Status === 'string' && record.Status.trim() !== '' ? record.Status.trim() : undefined
  // The two editions name the same structure differently; either may be present.
  const usage = [record.coding_usage, record.afp_usage, record.QuotaUsage]
    .find((candidate) => typeof candidate === 'object' && candidate !== null) as Record<string, unknown> | undefined
  const rawPeriods = usage?.periods ?? record.periods
  const periods: ArkPeriod[] = []
  if (Array.isArray(rawPeriods)) {
    for (const raw of rawPeriods) {
      if (typeof raw !== 'object' || raw === null) continue
      const period = raw as Record<string, unknown>
      const label = typeof period.label === 'string' && period.label.trim() !== '' ? period.label.trim() : undefined
      if (label === undefined) continue
      const resetsAt = instant(period.reset_at)
      const used = num(period.used)
      const total = num(period.total)
      const percent = num(period.percent)
      periods.push({
        label,
        ...used === undefined ? {} : { used },
        ...total === undefined ? {} : { total },
        ...percent === undefined ? {} : { percent },
        ...resetsAt === undefined ? {} : { resetsAt },
      })
    }
  }
  const subscribed = typeof record.subscribed === 'boolean'
    ? record.subscribed
    : periods.length > 0 || (status !== undefined && status.toLowerCase() !== 'reclaimed')
  return { subscribed, ...status === undefined ? {} : { status }, periods }
}

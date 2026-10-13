/**
 * WorkBuddy China's sign-in and token handling.
 *
 * A WorkBuddy account signs in in the browser (Tencent's page, polled for the
 * token as WorkBuddy's desktop app does). Chats are chat completions at
 * `<endpoint>/v2`, streamed only, and the API answers `{code, msg, data}` where a
 * non-zero code is an error. Adapted from magpie's `workbuddy` for this plugin's
 * typed flow/store contracts.
 *
 * @module dsh-plugin-subscription-oauth/auth/workbuddy-flow
 */

/** WorkBuddy China build's endpoints. */
export const WORKBUDDY_ENDPOINT = 'https://copilot.tencent.com'
export const WORKBUDDY_PLATFORM = 'workbuddy'
/** The version the sign-in page is opened with. */
export const WORKBUDDY_APP_VERSION = '2.0.0'
/** The User-Agent version the chat API accepts; another is refused (10085). */
export const WORKBUDDY_UA_VERSION = '5.5.6'
/** A token this close to its end is refreshed before a request. */
export const WORKBUDDY_EARLY_MS = 60_000
/** A sign-in attempt is abandoned after this long. */
export const WORKBUDDY_SIGN_IN_MS = 5 * 60 * 1000
const POLL_MS = 1000

/** One signed-in WorkBuddy session, as stored. */
export interface WorkBuddySession {
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

/** Validate one stored value as a WorkBuddy session, or undefined when it is not one. */
export function parseWorkBuddySession(value: unknown): WorkBuddySession | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.accessToken !== 'string' || record.accessToken.length === 0) return undefined
  if (typeof record.expiresAt !== 'number') return undefined
  return {
    accessToken: record.accessToken,
    expiresAt: record.expiresAt,
    ...typeof record.refreshToken === 'string' ? { refreshToken: record.refreshToken } : {},
    ...typeof record.accountId === 'string' ? { accountId: record.accountId } : {},
    ...typeof record.email === 'string' ? { email: record.email } : {},
    ...typeof record.uid === 'string' ? { uid: record.uid } : {},
    ...typeof record.enterpriseId === 'string' ? { enterpriseId: record.enterpriseId } : {},
    ...typeof record.domain === 'string' ? { domain: record.domain } : {},
    ...typeof record.tokenType === 'string' ? { tokenType: record.tokenType } : {},
    ...typeof record.refreshExpiresAt === 'number' ? { refreshExpiresAt: record.refreshExpiresAt } : {},
  }
}

/** A WorkBuddy API failure, carrying the wire code and magpie's phrasing. */
export class WBError extends Error {
  constructor(
    message: string,
    readonly code: number | string | undefined,
    readonly status: number,
    readonly said: string,
  ) {
    super(message)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The chat completions endpoint for the China build. */
export const workbuddyApi = (endpoint: string): string => `${endpoint}/v2`

/**
 * Make one request of WorkBuddy's plugin API, which answers `{code, msg, data}`.
 * A non-zero `code`, or a non-2xx status, is an error.
 *
 * @param endpoint - the site base, e.g. `https://copilot.tencent.com`.
 * @param method - HTTP method.
 * @param path - path beneath the base.
 * @param headers - extra headers.
 * @param body - JSON body, when present.
 * @param fetchFn - fetch implementation.
 * @returns the response's `data`.
 */
export async function workbuddyCall(
  endpoint: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: unknown,
  fetchFn: typeof fetch,
): Promise<unknown> {
  const response = await fetchFn(endpoint + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': `WorkBuddy/${WORKBUDDY_UA_VERSION}`,
      ...headers,
    },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  let env: Record<string, unknown> = {}
  try {
    env = JSON.parse(text) as Record<string, unknown>
  } catch {
    env = {}
  }
  const code = Number.parseInt(String(env.code ?? ''), 10) || 0
  if (!response.ok) {
    const why = String(env.msg ?? env.message ?? (isRecord(env.error) ? env.error.message : '') ?? '').trim() ||
      text.slice(0, 200) || response.statusText
    const said = code ? String(env.msg ?? `error ${code}`) : String(env.msg ?? `${response.status}`)
    throw new WBError(`WorkBuddy: ${why} (HTTP ${response.status}${env.code ? `, code ${String(env.code)}` : ''})`, env.code as number | string, response.status, said)
  }
  if (code !== 0) {
    throw new WBError(`WorkBuddy: ${String(env.msg ?? 'error')} (${String(env.code)})`, env.code as number | string, response.status, String(env.msg ?? `error ${code}`))
  }
  return env.data
}

/** The state WorkBuddy's sign-in page starts from. */
export interface WorkBuddySignInStart {
  state: string
  url: string
  expiresAt: number
}

/** Start a browser sign-in: the page URL to open, and the state to poll for the token. */
export async function startWorkBuddySignIn(fetchFn: typeof fetch): Promise<WorkBuddySignInStart> {
  const data = await workbuddyCall(
    WORKBUDDY_ENDPOINT,
    'POST',
    `/v2/plugin/auth/state?platform=${encodeURIComponent(WORKBUDDY_PLATFORM)}`,
    {
      'X-No-Authorization': 'true',
      'X-No-User-Id': 'true',
      'X-No-Enterprise-Id': 'true',
      'X-No-Department-Info': 'true',
    },
    {},
    fetchFn,
  )
  if (!isRecord(data) || typeof data.state !== 'string' || typeof data.authUrl !== 'string') {
    throw new Error('WorkBuddy gave no sign-in page')
  }
  const url = new URL(data.authUrl)
  if (url.protocol !== 'https:') throw new Error("WorkBuddy's sign-in page isn't https")
  url.searchParams.set('version', WORKBUDDY_APP_VERSION)
  url.searchParams.set('loginSessionId', randomHex())
  return { state: data.state, url: url.toString(), expiresAt: Date.now() + WORKBUDDY_SIGN_IN_MS }
}

const randomHex = (): string => {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Ask a path until it answers data, retrying the codes that mean "not yet". */
async function workbuddyPoll(
  path: string,
  headers: Record<string, string>,
  retry: number[],
  deadline: number,
  fetchFn: typeof fetch,
): Promise<Record<string, unknown>> {
  for (;;) {
    if (Date.now() > deadline) throw new Error('WorkBuddy sign-in timed out')
    try {
      const data = await workbuddyCall(WORKBUDDY_ENDPOINT, 'GET', path, headers, undefined, fetchFn)
      if (isRecord(data) && Object.keys(data).length > 0) return data
    } catch (error) {
      if (!(error instanceof WBError && (retry.includes(Number(error.code)) || error.status === 408 || error.status === 429))) {
        throw error
      }
    }
    await sleep(POLL_MS)
  }
}

/** One WorkBuddy token's fields, normalised from the sign-in or refresh response. */
export interface WorkBuddyTokenSet {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  refreshExpiresAt?: number
  domain?: string
  tokenType?: string
  uid?: string
  enterpriseId?: string
}

/** Merge a token WorkBuddy gave into the stored sign-in's fields. */
export function mergeWorkBuddyToken(base: WorkBuddyTokenSet, got: Record<string, unknown>): WorkBuddyTokenSet {
  const now = Date.now()
  const out: WorkBuddyTokenSet = { ...base, accessToken: String(got.accessToken ?? '') }
  if (typeof got.refreshToken === 'string' && got.refreshToken !== '') out.refreshToken = got.refreshToken
  if (typeof got.domain === 'string' && got.domain !== '') out.domain = got.domain
  if (typeof got.tokenType === 'string' && got.tokenType !== '') out.tokenType = got.tokenType
  const expiresAt = Number(got.expiresAt)
  const expiresIn = Number(got.expiresIn)
  if (expiresAt > 0) out.expiresAt = expiresAt
  else if (expiresIn > 0) out.expiresAt = now + expiresIn * 1000
  const refreshExpiresAt = Number(got.refreshExpiresAt)
  const refreshExpiresIn = Number(got.refreshExpiresIn)
  if (refreshExpiresAt > 0) out.refreshExpiresAt = refreshExpiresAt
  else if (refreshExpiresIn > 0) out.refreshExpiresAt = now + refreshExpiresIn * 1000
  return out
}

/** Poll for the token a finished browser sign-in produced. */
export async function finishWorkBuddySignIn(
  start: WorkBuddySignInStart,
  fetchFn: typeof fetch,
): Promise<{ token: WorkBuddyTokenSet, name: string }> {
  const deadline = start.expiresAt
  const query = encodeURIComponent(start.state)
  const tokenData = await workbuddyPoll(`/v2/plugin/auth/token?state=${query}`, {}, [11217], deadline, fetchFn)
  if (typeof tokenData.accessToken !== 'string' || tokenData.accessToken === '') {
    throw new Error('WorkBuddy sent back no token')
  }
  const token = mergeWorkBuddyToken({ accessToken: '', expiresAt: 0 }, tokenData)
  const who = await workbuddyPoll(
    `/v2/plugin/login/account?state=${query}`,
    {
      'Authorization': `Bearer ${token.accessToken}`,
      'X-Domain': workbuddyDomain(token),
      'X-No-User-Id': 'true',
      'X-No-Enterprise-Id': 'true',
    },
    [12151],
    deadline,
    fetchFn,
  )
  token.uid = typeof who.uid === 'string' ? who.uid : ''
  token.enterpriseId = await workbuddyEnterprise(token, who, fetchFn)
  const name = String(who.nickname ?? who.phoneNumber ?? who.uid ?? '')
  return { token, name }
}

/** The domain a token names, else the API host. */
export function workbuddyDomain(token: Pick<WorkBuddyTokenSet, 'domain'>): string {
  return token.domain || new URL(workbuddyApi(WORKBUDDY_ENDPOINT)).host
}

/** The enterprise an account signed in as, when it isn't a personal account. */
async function workbuddyEnterprise(
  token: WorkBuddyTokenSet,
  who: Record<string, unknown>,
  fetchFn: typeof fetch,
): Promise<string> {
  const own = typeof who.enterpriseId === 'string' ? who.enterpriseId.trim() : ''
  if (own) return own
  const type = String(who.type ?? '').trim().toLowerCase()
  if (type === '' || type === 'personal') return ''
  let list: unknown
  try {
    list = await workbuddyCall(
      WORKBUDDY_ENDPOINT,
      'GET',
      '/v2/plugin/accounts',
      { 'Authorization': `Bearer ${token.accessToken}`, 'X-Domain': workbuddyDomain(token) },
      undefined,
      fetchFn,
    )
  } catch {
    return ''
  }
  const accounts = isRecord(list) && Array.isArray(list.accounts) ? list.accounts.filter(isRecord) : []
  const mine = accounts.filter(
    (entry) => entry.uid === who.uid && typeof entry.enterpriseId === 'string' && entry.enterpriseId.trim() !== '',
  )
  const same = mine.filter((entry) => String(entry.type ?? '').trim().toLowerCase() === type)
  const last = mine.filter((entry) => entry.lastLogin)
  const pick = same.length === 1 ? same[0] : last.length === 1 ? last[0] : mine.length === 1 ? mine[0] : undefined
  return pick && typeof pick.enterpriseId === 'string' ? pick.enterpriseId.trim() : ''
}

/** The headers WorkBuddy's desktop app sends with a chat and its account. */
export function workbuddyHeaders(token: WorkBuddyTokenSet): Record<string, string> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token.accessToken}`,
    'X-User-Id': token.uid ?? '',
    'X-Domain': workbuddyDomain(token),
    'X-Product': 'SaaS',
    'X-IDE-Type': 'WorkBuddy',
    'User-Agent': `WorkBuddy/${WORKBUDDY_UA_VERSION}`,
    'X-Requested-With': 'XMLHttpRequest',
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': WORKBUDDY_UA_VERSION,
  }
  const enterprise = typeof token.enterpriseId === 'string' ? token.enterpriseId.trim() : ''
  if (enterprise !== '') {
    headers['X-Enterprise-Id'] = enterprise
    headers['X-Tenant-Id'] = enterprise
  }
  return headers
}

/** Whether a token is close enough to its end that a request should refresh it. */
export function workbuddyStale(token: Pick<WorkBuddyTokenSet, 'expiresAt'>): boolean {
  return token.expiresAt > 0 && Date.now() >= token.expiresAt - WORKBUDDY_EARLY_MS
}

/** Whether a token can still be refreshed. */
export function workbuddyRefreshable(token: WorkBuddyTokenSet): boolean {
  if (typeof token.refreshToken !== 'string' || token.refreshToken === '') return false
  return !(token.refreshExpiresAt !== undefined && Date.now() >= token.refreshExpiresAt)
}

/** Spend a refresh token for a new access token. */
export async function refreshWorkBuddyToken(
  token: WorkBuddyTokenSet,
  fetchFn: typeof fetch,
): Promise<WorkBuddyTokenSet> {
  const data = await workbuddyCall(
    WORKBUDDY_ENDPOINT,
    'POST',
    '/v2/plugin/auth/token/refresh',
    {
      'X-Refresh-Token': token.refreshToken ?? '',
      'X-Auth-Refresh-Source': 'plugin',
      'X-Domain': workbuddyDomain(token),
      ...workbuddyEnterpriseHeaders(token),
    },
    {},
    fetchFn,
  )
  if (!isRecord(data) || typeof data.accessToken !== 'string' || data.accessToken === '') {
    throw new Error('WorkBuddy gave no refreshed token')
  }
  return mergeWorkBuddyToken(token, data)
}

function workbuddyEnterpriseHeaders(token: WorkBuddyTokenSet): Record<string, string> {
  const enterprise = typeof token.enterpriseId === 'string' ? token.enterpriseId.trim() : ''
  return enterprise === '' ? {} : { 'X-Enterprise-Id': enterprise, 'X-Tenant-Id': enterprise }
}

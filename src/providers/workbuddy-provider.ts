/**
 * The `workbuddy` provider route's wiring (WorkBuddy China build):
 * credential store, browser sign-in, token refresh, and its Settings card facts.
 *
 * @module dsh-plugin-subscription-oauth/providers/workbuddy-provider
 */

import { REAUTH_REQUIRED, ProviderError } from '../errors.js'
import { TokenStore } from '../auth/store.js'
import { TokenManager } from '../auth/tokens.js'
import type { AuthAttempt, AuthFlow } from '../auth/flow.js'
import { LOGIN_CANCELLED_MESSAGE } from '../auth/device-flow.js'
import {
  finishWorkBuddySignIn,
  parseWorkBuddySession,
  readWorkBuddyUsage,
  refreshWorkBuddyToken,
  startWorkBuddySignIn,
  workbuddyRefreshable,
  workbuddyStale,
  claimWorkBuddyCheckin,
  WORKBUDDY_EARLY_MS,
  type WorkBuddySession,
  type WorkBuddyTokenSet,
} from '../auth/workbuddy-flow.js'
import {
  WorkBuddyAdapter,
  WORKBUDDY_CODE_URL,
  WORKBUDDY_CATALOG,
  WORKBUDDY_DEFAULT_MODEL,
  WORKBUDDY_PROVIDER_ID,
  WORKBUDDY_PROVIDER_NAME,
} from './workbuddy.js'
import type { ProviderSpec } from '../auth/provider-controller.js'
import { ProviderController } from '../auth/provider-controller.js'
import type { ProviderRoute } from '../auth/registry.js'
import type { ModelPreferences } from '../settings.js'
import { proxiedFetch } from '../http.js'
import type { FetchFn } from '../http.js'

/** Everything the WorkBuddy route needs from the plugin configuration. */
export interface WorkBuddyProviderOptions {
  /** Absolute path of `auth.json`. */
  credentialFile: string
  /** Abandon a stream after this much silence. */
  streamIdleTimeoutMs: number
  /** Model the picker preselects. */
  defaultModel?: string
  /** Shared model-visibility preferences. */
  preferences: ModelPreferences
  /** Invoked when the catalog or its visibility changed. */
  onCatalogChanged?: () => void
  onWarn?: (message: string) => void
  /** Fetch implementation; defaults to the proxy-aware fetch. */
  fetchFn?: FetchFn
}

/** Wait, honouring cancellation. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error(LOGIN_CANCELLED_MESSAGE))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(new Error(LOGIN_CANCELLED_MESSAGE))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Build the `workbuddy` route: its adapter and its login/lifecycle controller.
 *
 * @param options - resolved paths and shared services.
 * @returns the route, ready to register and to serve over RPC.
 */
export function createWorkBuddyProvider(options: WorkBuddyProviderOptions): ProviderRoute {
  const fetchFn = options.fetchFn ?? proxiedFetch
  const store = new TokenStore<WorkBuddySession>(options.credentialFile, WORKBUDDY_PROVIDER_ID, parseWorkBuddySession)

  const toSession = (token: WorkBuddyTokenSet, name: string): WorkBuddySession => ({
    accessToken: token.accessToken,
    expiresAt: token.expiresAt,
    ...token.refreshToken === undefined ? {} : { refreshToken: token.refreshToken },
    ...name === '' ? {} : { accountId: name },
    ...token.uid === undefined ? {} : { uid: token.uid },
    ...token.enterpriseId === undefined ? {} : { enterpriseId: token.enterpriseId },
    ...token.domain === undefined ? {} : { domain: token.domain },
    ...token.tokenType === undefined ? {} : { tokenType: token.tokenType },
    ...token.refreshExpiresAt === undefined ? {} : { refreshExpiresAt: token.refreshExpiresAt },
  })

  /** The in-flight attempt, so `pending()` is stable across calls. */
  let current: AuthAttempt<WorkBuddySession> | undefined

  const flow: AuthFlow<WorkBuddySession> = {
    async start(): Promise<AuthAttempt<WorkBuddySession>> {
      const start = await startWorkBuddySignIn(fetchFn)
      const controller = new AbortController()
      const session = (async (): Promise<WorkBuddySession> => {
        while (true) {
          if (controller.signal.aborted) throw new Error(LOGIN_CANCELLED_MESSAGE)
          try {
            const { token, name } = await finishWorkBuddySignIn(start, fetchFn)
            return toSession(token, name)
          } catch (error) {
            if (controller.signal.aborted) throw new Error(LOGIN_CANCELLED_MESSAGE)
            // A "not yet" poll answer is normal; anything else fails the attempt.
            if (error instanceof Error && /timed out/i.test(error.message)) throw error
            throw error
          }
        }
      })()
      const attempt: AuthAttempt<WorkBuddySession> = {
        prompt: {
          url: start.url,
          expiresAt: start.expiresAt,
          mode: 'open-url',
        },
        session,
        cancel: () => { controller.abort() },
      }
      current = attempt
      void session.catch(() => undefined).finally(() => {
        if (current === attempt) current = undefined
      })
      return attempt
    },
    pending(): AuthAttempt<WorkBuddySession> | undefined {
      return current
    },
  }

  const tokens = new TokenManager<WorkBuddySession>({
    store,
    displayName: WORKBUDDY_PROVIDER_NAME,
    // Refresh a minute before the hour runs out, as the app does.
    preemptMs: WORKBUDDY_EARLY_MS,
    refresh: async (session) => {
      const token: WorkBuddyTokenSet = {
        accessToken: session.accessToken,
        expiresAt: session.expiresAt,
        ...session.refreshToken === undefined ? {} : { refreshToken: session.refreshToken },
        ...session.uid === undefined ? {} : { uid: session.uid },
        ...session.enterpriseId === undefined ? {} : { enterpriseId: session.enterpriseId },
        ...session.domain === undefined ? {} : { domain: session.domain },
        ...session.tokenType === undefined ? {} : { tokenType: session.tokenType },
        ...session.refreshExpiresAt === undefined ? {} : { refreshExpiresAt: session.refreshExpiresAt },
      }
      if (!workbuddyRefreshable(token)) {
        throw new ProviderError(`${WORKBUDDY_PROVIDER_NAME} sign-in has expired; connect the account again`, REAUTH_REQUIRED)
      }
      try {
        const renewed = await refreshWorkBuddyToken(token, fetchFn)
        // WorkBuddy rotates the refresh token: keep the new one so the next restart can
        // still refresh, otherwise the stale token signs the account out.
        return {
          accessToken: renewed.accessToken,
          expiresAt: renewed.expiresAt,
          ...renewed.refreshToken === undefined ? {} : { refreshToken: renewed.refreshToken },
          ...renewed.refreshExpiresAt === undefined ? {} : { refreshExpiresAt: renewed.refreshExpiresAt },
        }
      } catch (error) {
        throw new ProviderError(
          `${WORKBUDDY_PROVIDER_NAME} token refresh failed: ${error instanceof Error ? error.message : String(error)}`,
          REAUTH_REQUIRED,
        )
      }
    },
  })

  const adapter = new WorkBuddyAdapter({
    streamIdleTimeoutMs: options.streamIdleTimeoutMs,
    tokens,
    ...options.onWarn === undefined ? {} : { onWarn: options.onWarn },
    hiddenModels: () => options.preferences.hiddenIds(WORKBUDDY_PROVIDER_ID),
    userModels: () => options.preferences.extraIds(WORKBUDDY_PROVIDER_ID),
    fetchFn,
  })

  /** The stored session's fields as the token a request or meter signs with. */
  const tokenOf = (session: WorkBuddySession): WorkBuddyTokenSet => ({
    accessToken: session.accessToken,
    expiresAt: session.expiresAt,
    ...session.refreshToken === undefined ? {} : { refreshToken: session.refreshToken },
    ...session.uid === undefined ? {} : { uid: session.uid },
    ...session.enterpriseId === undefined ? {} : { enterpriseId: session.enterpriseId },
    ...session.domain === undefined ? {} : { domain: session.domain },
    ...session.tokenType === undefined ? {} : { tokenType: session.tokenType },
    ...session.refreshExpiresAt === undefined ? {} : { refreshExpiresAt: session.refreshExpiresAt },
  })

  const spec: ProviderSpec<WorkBuddySession> = {
    id: WORKBUDDY_PROVIDER_ID,
    displayName: WORKBUDDY_PROVIDER_NAME,
    codeUrl: WORKBUDDY_CODE_URL,
    credentialFile: options.credentialFile,
    // WorkBuddy ships a fixed catalog; there is no discovery endpoint.
    discovery: false,
    defaultModel: options.defaultModel ?? WORKBUDDY_DEFAULT_MODEL,
    catalog: () => adapter.catalogEntries(),
    catalogOwn: () => adapter.ownCatalogEntries(),
    fallbackContextWindow: WORKBUDDY_CATALOG[0]?.contextWindow ?? 0,
    discover: () => Promise.resolve(undefined),
    usage: async (_accessToken, account) => {
      const held = await store.get(account)
      if (held === undefined) return undefined
      const read = await readWorkBuddyUsage(tokenOf(held), held.accountId, fetchFn)
      return { plan: read.plan, windows: read.windows, ...read.checkin === undefined ? {} : { checkin: read.checkin } }
    },
    details: () => [
      { key: 'provider', value: WORKBUDDY_PROVIDER_NAME },
      { key: 'endpoint', value: 'https://copilot.tencent.com' },
      { key: 'credentialFile', value: options.credentialFile },
    ],
    applyDiscovery: () => {},
  }

  const controller = new ProviderController<WorkBuddySession>({
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
    checkin: async (account: string) => {
      const held = await store.get(account)
      if (held === undefined) throw new ProviderError('WorkBuddy account not signed in', REAUTH_REQUIRED)
      try {
        const claim = await claimWorkBuddyCheckin(tokenOf(held), fetchFn)
        return { credit: claim.credit, streakDays: claim.streakDays, already: claim.credit === 0 }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // An already-claimed check-in is a normal answer, not a failure.
        if (/already|已签到/i.test(message)) return { credit: 0, streakDays: 0, already: true }
        throw new ProviderError(`WorkBuddy check-in failed: ${message}`, REAUTH_REQUIRED)
      }
    },
  }
}

/**
 * The `glm` provider route's wiring: credential store, ZCode OAuth login, model
 * catalog, and its Settings card facts.
 *
 * @module dsh-plugin-subscription-oauth/providers/glm-provider
 */

import { REAUTH_REQUIRED, ProviderError } from '../errors.js'
import { TokenStore } from '../auth/store.js'
import { TokenManager } from '../auth/tokens.js'
import type { AuthAttempt, AuthFlow } from '../auth/flow.js'
import { LOGIN_CANCELLED_MESSAGE } from '../auth/device-flow.js'
import { startGlmFlow, pollGlmFlow } from '../auth/glm-flow.js'
import type { GlmTokenSet } from '../auth/glm-flow.js'
import { GlmAdapter, GLM_API_BASE, GLM_CODE_URL, GLM_CONTEXT_WINDOW, GLM_DEFAULT_MODEL, GLM_ORIGIN, GLM_PROVIDER_ID, GLM_PROVIDER_NAME, parseGlmSession, readGlmUsage } from './glm.js'
import type { GlmSession } from './glm.js'
import type { ProviderSpec } from '../auth/provider-controller.js'
import { ProviderController } from '../auth/provider-controller.js'
import type { ProviderRoute } from '../auth/registry.js'
import type { ModelPreferences } from '../settings.js'
import { proxiedFetch } from '../http.js'
import type { FetchFn } from '../http.js'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'

/** Everything the GLM route needs from the plugin configuration. */
export interface GlmProviderOptions {
  /** Absolute path of `auth.json`. */
  credentialFile: string
  /** Request base; `<base>/responses` is the endpoint. */
  apiBase?: string
  /** Consult the endpoint's live model list. */
  discovery: boolean
  /** Abandon a stream after this much silence. */
  streamIdleTimeoutMs: number
  /** Model the picker preselects. */
  defaultModel?: string
  /** Extra model ids published without shipped metadata. */
  extraModels?: readonly string[]
  /**
   * The endpoint's last live listing, from this plugin's cache.
   *
   * The cached table is what the picker shows before any request: the endpoint's own
   * answer from the last read, so a release does not need a plugin update and a refresh
   * does not need a request.
   */
  cachedListing?: () => Promise<unknown>
  /** Record what a live listing just produced, replacing the cached table. */
  saveListing?: (payload: unknown) => Promise<void>
  /** Shared model-visibility preferences. */
  preferences: ModelPreferences
  /** Resolve the attachment service per request. */
  resolveAttachments?: () => AttachmentStore | undefined
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
 * Build the `glm` route: its adapter and its login/lifecycle controller.
 *
 * @param options - resolved endpoints, paths, and shared services.
 * @returns the route, ready to register and to serve over RPC.
 */
export function createGlmProvider(options: GlmProviderOptions): ProviderRoute {
  const fetchFn = options.fetchFn ?? proxiedFetch
  const apiBase = options.apiBase ?? GLM_API_BASE
  const store = new TokenStore<GlmSession>(options.credentialFile, GLM_PROVIDER_ID, parseGlmSession)

  const toSession = (tokens: GlmTokenSet): GlmSession => ({
    accessToken: tokens.accessToken,
    zcodeJwt: tokens.zcodeJwt,
    expiresAt: tokens.expiresAt,
    ...tokens.refreshToken === undefined ? {} : { refreshToken: tokens.refreshToken },
    apiBase,
    ...tokens.accountId === undefined ? {} : { accountId: tokens.accountId },
    ...tokens.label === undefined ? {} : { email: tokens.label },
  })

  /** The in-flight attempt, so `pending()` is stable across calls. */
  let current: AuthAttempt<GlmSession> | undefined

  const flow: AuthFlow<GlmSession> = {
    async start(): Promise<AuthAttempt<GlmSession>> {
      const start = await startGlmFlow({ fetchFn })
      const controller = new AbortController()
      const session = (async (): Promise<GlmSession> => {
        // The browser sign-in completes on the broker's own callback, so this side
        // only has to keep asking until the flow is ready or lapses.
        while (true) {
          if (controller.signal.aborted) throw new Error(LOGIN_CANCELLED_MESSAGE)
          const tokens = await pollGlmFlow({ fetchFn }, start, controller.signal)
          if (tokens !== undefined) return toSession(tokens)
          await sleep(start.pollIntervalMs, controller.signal)
        }
      })()
      const attempt: AuthAttempt<GlmSession> = {
        prompt: {
          url: start.authorizeUrl,
          expiresAt: start.expiresAt,
          mode: 'open-url',
        },
        session,
        cancel: () => { controller.abort() },
      }
      current = attempt
      // Drop the record once the attempt settles, so `pending()` cannot report a
      // login that already finished or failed.
      void session.catch(() => undefined).finally(() => {
        if (current === attempt) current = undefined
      })
      return attempt
    },
    pending(): AuthAttempt<GlmSession> | undefined {
      return current
    },
  }

  const tokens = new TokenManager<GlmSession>({
    store,
    displayName: GLM_PROVIDER_NAME,
    // The ZCode flow has no refresh grant, so there is nothing to pre-empt: asking
    // five minutes early would refuse a token that is still perfectly usable and
    // send the user to sign in again for no reason. Renewal happens when the token
    // has actually lapsed, which is also what the official client does.
    preemptMs: 0,
    refresh: () => {
      throw new ProviderError(
        `${GLM_PROVIDER_NAME} sign-in has expired; connect the account again`,
        REAUTH_REQUIRED,
      )
    },
  })

  const adapter = new GlmAdapter({
    apiBase,
    discovery: options.discovery,
    streamIdleTimeoutMs: options.streamIdleTimeoutMs,
    tokens,
    ...options.onWarn === undefined ? {} : { onWarn: options.onWarn },
    ...options.resolveAttachments === undefined ? {} : { resolveAttachments: options.resolveAttachments },
    hiddenModels: () => options.preferences.hiddenIds(GLM_PROVIDER_ID),
    userModels: () => options.preferences.extraIds(GLM_PROVIDER_ID),
    readUsage: async (account) => {
      const token = await tokens.resolve(account)
      const read = await readGlmUsage({ origin: GLM_ORIGIN, accessToken: token.accessToken, fetchFn })
      return read.windows
    },
    ...options.extraModels === undefined ? {} : { extraModels: options.extraModels },
    ...options.defaultModel === undefined ? {} : { defaultModel: options.defaultModel },
    ...options.cachedListing === undefined ? {} : { cachedListing: options.cachedListing },
    ...options.saveListing === undefined ? {} : { saveListing: options.saveListing },
    fetchFn,
  })

  // Read the cached table now rather than at the first picker query: the Settings page
  // reads the catalog synchronously, so a request-free start must already have it.
  void adapter.hydrate().catch(() => undefined)

  const spec: ProviderSpec<GlmSession> = {
    id: GLM_PROVIDER_ID,
    displayName: GLM_PROVIDER_NAME,
    codeUrl: GLM_CODE_URL,
    credentialFile: options.credentialFile,
    discovery: options.discovery,
    defaultModel: options.defaultModel ?? GLM_DEFAULT_MODEL,
    catalog: () => adapter.catalogEntries(),
    catalogOwn: () => adapter.ownCatalogEntries(),
    fallbackContextWindow: GLM_CONTEXT_WINDOW,
    discover: (accessToken) => adapter.fetchCatalog(accessToken),
    usage: (accessToken) => readGlmUsage({ origin: GLM_ORIGIN, accessToken, fetchFn }),
    details: () => [
      { key: 'apiBase', value: apiBase },
      { key: 'oauthBroker', value: 'https://zcode.z.ai' },
      { key: 'credentialFile', value: options.credentialFile },
    ],
    applyDiscovery: (ids) => { adapter.discover(ids) },
  }

  const controller = new ProviderController<GlmSession>({
    spec,
    store,
    tokens,
    flow,
    preferences: options.preferences,
    ...options.onCatalogChanged === undefined ? {} : { onCatalogChanged: options.onCatalogChanged },
    ...options.onWarn === undefined ? {} : { onWarn: options.onWarn },
  })

  // An explicit façade, not a spread: a spread would copy own properties and drop
  // the class prototype, leaving every method undefined.
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
    modelVariants: (id: string) => {
      const image = adapter.imageModelId()
      return image === undefined ? undefined : { image }
    },
  }
}

/**
 * The `kimi` provider route's wiring: credential store, device-flow login,
 * token refresh, model catalog, and its Settings card facts.
 *
 * @module dsh-plugin-subscription-oauth/providers/kimi-provider
 */

import { REAUTH_REQUIRED, ProviderError } from '../errors.js'
import { KIMI_CODE_URL, KIMI_CONTEXT_WINDOW, KIMI_DEFAULT_MODEL, KIMI_PROVIDER_ID, KIMI_PROVIDER_NAME } from '../constants.js'
import { TokenStore } from '../auth/store.js'
import { TokenManager } from '../auth/tokens.js'
import type { AuthAttempt, AuthFlow } from '../auth/flow.js'
import { DeviceFlowManager, identityFromTokens, refreshKimiToken } from '../auth/device-flow.js'
import type { DeviceAttempt, KimiTokenSet } from '../auth/device-flow.js'
import { loadOrCreateDeviceId } from '../auth/device-id.js'
import { kimiIdentityHeaders } from '../auth/headers.js'
import { KimiAdapter, parseKimiSession } from './kimi.js'
import type { KimiSession } from './kimi.js'
import { readKimiUsage } from './usage.js'
import type { ProviderSpec } from '../auth/provider-controller.js'
import { ProviderController } from '../auth/provider-controller.js'
import type { ProviderRoute } from '../auth/registry.js'
import type { ModelPreferences } from '../settings.js'
import { proxiedFetch } from '../http.js'
import type { FetchFn } from '../http.js'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'

/** Everything the Kimi route needs from the plugin configuration. */
export interface KimiProviderOptions {
  /** Directory holding the device id. */
  dataDir: string
  /** Absolute path of `auth.json`. */
  credentialFile: string
  /** OAuth host serving the device flow. */
  oauthHost: string
  /** Request base; `<base>/responses` is the endpoint. */
  apiBase: string
  /** Consult the endpoint's live model list. */
  discovery: boolean
  /** Abandon a stream after this much silence. */
  streamIdleTimeoutMs: number
  /** Model the picker preselects. */
  defaultModel?: string
  /** Extra model ids published without shipped metadata. */
  extraModels?: readonly string[]
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

/**
 * Build the `kimi` route: its adapter and its login/lifecycle controller.
 *
 * @param options - resolved endpoints, paths, and shared services.
 * @returns the route, ready to register and to serve over RPC.
 */
export function createKimiProvider(options: KimiProviderOptions): ProviderRoute {
  const fetchFn = options.fetchFn ?? proxiedFetch
  const store = new TokenStore<KimiSession>(options.credentialFile, KIMI_PROVIDER_ID, parseKimiSession)
  const deviceFlow = new DeviceFlowManager()

  /** The wrapped in-flight attempt, so `pending()` is stable across calls. */
  let current: AuthAttempt<KimiSession> | undefined

  const toSession = (tokens: KimiTokenSet): KimiSession => ({
    accessToken: tokens.accessToken,
    ...tokens.refreshToken === undefined ? {} : { refreshToken: tokens.refreshToken },
    expiresAt: tokens.expiresAt,
    oauthHost: options.oauthHost,
    apiBase: options.apiBase,
    ...identityFromTokens(tokens.accessToken, tokens.refreshToken),
  })

  /** Adapt one device attempt onto the shared login contract. */
  const wrap = (attempt: DeviceAttempt): AuthAttempt<KimiSession> => ({
    prompt: {
      url: attempt.verificationUrl,
      userCode: attempt.userCode,
      expiresAt: attempt.expiresAt,
      mode: 'device-code',
    },
    session: attempt.waitToken().then(toSession),
    cancel: () => { attempt.cancel() },
  })

  const flow: AuthFlow<KimiSession> = {
    async start(): Promise<AuthAttempt<KimiSession>> {
      const attempt = await deviceFlow.start(KIMI_PROVIDER_ID, {
        host: options.oauthHost,
        deviceId: await loadOrCreateDeviceId(options.dataDir),
        fetchFn,
      })
      const wrapped = wrap(attempt)
      current = wrapped
      // The manager drops its own record once the attempt settles; mirror that
      // so `pending()` cannot report a finished login.
      void attempt.waitToken().catch(() => undefined).finally(() => {
        if (current === wrapped) current = undefined
      })
      return wrapped
    },
    pending(): AuthAttempt<KimiSession> | undefined {
      return deviceFlow.pending(KIMI_PROVIDER_ID) === undefined ? undefined : current
    },
  }

  const tokens = new TokenManager<KimiSession>({
    store,
    displayName: KIMI_PROVIDER_NAME,
    refresh: async (session) => {
      const refreshToken = session.refreshToken
      if (refreshToken === undefined) {
        throw new ProviderError(`${KIMI_PROVIDER_NAME} account has no refresh token; sign in again`, REAUTH_REQUIRED)
      }
      return refreshKimiToken({
        host: session.oauthHost,
        deviceId: await loadOrCreateDeviceId(options.dataDir),
        fetchFn,
      }, refreshToken)
    },
  })

  const adapter = new KimiAdapter({
    apiBase: options.apiBase,
    discovery: options.discovery,
    streamIdleTimeoutMs: options.streamIdleTimeoutMs,
    tokens,
    ...options.onWarn === undefined ? {} : { onWarn: options.onWarn },
    ...options.resolveAttachments === undefined ? {} : { resolveAttachments: options.resolveAttachments },
    identityHeaders: async () => kimiIdentityHeaders(await loadOrCreateDeviceId(options.dataDir)),
    readUsage: async (account) => {
      const token = await tokens.resolve(account)
      const read = await readKimiUsage({ apiBase: options.apiBase, accessToken: token.accessToken, fetchFn })
      return read === undefined ? [] : read.windows
    },
    hiddenModels: () => options.preferences.hiddenIds(KIMI_PROVIDER_ID),
    userModels: () => options.preferences.extraIds(KIMI_PROVIDER_ID),
    modelOrder: () => options.preferences.orderOf(KIMI_PROVIDER_ID),
    ...options.extraModels === undefined ? {} : { extraModels: options.extraModels },
    fetchFn,
  })

  const spec: ProviderSpec<KimiSession> = {
    id: KIMI_PROVIDER_ID,
    displayName: KIMI_PROVIDER_NAME,
    codeUrl: KIMI_CODE_URL,
    credentialFile: options.credentialFile,
    discovery: options.discovery,
    defaultModel: KIMI_DEFAULT_MODEL,
    catalog: () => adapter.catalogEntries(),
    catalogOwn: () => adapter.ownCatalogEntries(),
    fallbackContextWindow: KIMI_CONTEXT_WINDOW,
    discover: (accessToken) => adapter.fetchCatalog(accessToken),
    usage: (accessToken) => readKimiUsage({ apiBase: options.apiBase, accessToken, fetchFn }),
    details: () => [
      { key: 'oauthHost', value: options.oauthHost },
      { key: 'apiBase', value: options.apiBase },
      { key: 'credentialFile', value: options.credentialFile },
    ],
    applyDiscovery: (ids) => { adapter.discover(ids) },
  }

  const controller = new ProviderController<KimiSession>({
    spec,
    store,
    tokens,
    flow,
    preferences: options.preferences,
    ...options.onCatalogChanged === undefined ? {} : { onCatalogChanged: options.onCatalogChanged },
    ...options.onWarn === undefined ? {} : { onWarn: options.onWarn },
  })

  // An explicit façade, not a spread: a spread would copy own properties and
  // drop the class prototype, leaving every method undefined.
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
  }
}

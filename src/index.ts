/**
 * Kimi Code, Grok (X Premium) and Google Antigravity subscription access for
 * DeepSeek Harness.
 *
 * Each provider route authorizes once through its own OAuth flow (Settings →
 * Subscriptions) and then streams over the wire that provider's subscription
 * exposes. Tokens live below `~/.dsh/plugins/kimi-oauth/`, one provider section
 * per route.
 *
 * @module dsh-plugin-subscription-oauth
 */

import path from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'

import { registerSubscriptionRpc } from './auth/rpc.js'
import { SubscriptionRegistry } from './auth/registry.js'
import type { ProviderRoute } from './auth/registry.js'
import {
  KIMI_DATA_DIR,
  KIMI_DEFAULT_MODEL,
  KIMI_STREAM_IDLE_TIMEOUT_MS,
  normalizeApiBase,
  normalizeOAuthHost,
  resolveApiBase,
  resolveOAuthHost,
} from './constants.js'
import { proxiedFetch } from './http.js'
import { AUTO_PROVIDER_ID, createAutoProvider } from './providers/auto.js'
import { createAntigravityProvider } from './providers/antigravity.js'
import { createGrokProvider } from './providers/grok.js'
import { createKimiProvider } from './providers/kimi-provider.js'
import { createGlmProvider } from './providers/glm-provider.js'
import { createArkProvider } from './providers/ark-provider.js'
import { ModelPreferences } from './settings.js'

/** Plugin id; also the name every effect label and log line is prefixed with. */
export const name = 'dsh-plugin-subscription-oauth'

/** The provider routes need the LLM runtime; everything else is optional. */
export const inject = ['llm']

/** Every route key this plugin accepts in configuration. */
export const PROVIDER_IDS = ['kimi', 'grok', 'antigravity', 'glm', 'ark'] as const

/** The routes this build can actually register. */
export const IMPLEMENTED_PROVIDER_IDS = ['kimi', 'grok', 'antigravity', 'glm', 'ark'] as const

/** One route key. */
export type ProviderId = typeof PROVIDER_IDS[number]

/** Plugin configuration, as accepted from `cordis.patch.yml`. */
export interface Config {
  /** Routes to register; defaults to every implemented provider. */
  providers?: ProviderId[]
  /** Register the routes at all. Defaults to true. */
  enabled?: boolean
  /** OAuth host serving the Kimi Code device flow. */
  oauthHost?: string
  /** Kimi Code request base; `<base>/responses` is the endpoint. */
  apiBase?: string
  /** Consult each endpoint's live model list. Defaults to true. */
  discovery?: boolean
  /** Abandon a stream after this much silence. Defaults to 300000. */
  streamIdleTimeoutMs?: number
  /** Model the picker preselects on the Kimi Code route. */
  defaultModel?: string
  /** Kimi Code model ids to publish without shipped metadata. */
  extraModels?: string[]
  /**
   * Register the `auto` provider, which stands in for every enabled model across
   * the other routes. Defaults to true.
   */
  auto?: boolean
  /**
   * The credential reference a non-subscription provider's balance query uses, by
   * provider id.
   *
   * A provider that is not a subscription this plugin serves has no usage windows to
   * meter, so the chip shows its balance instead — read by cc-switch's query, which needs
   * the provider's API key. The provider's profile names that key by reference
   * (`apiKeyEnv`), and the host's credential service resolves the name; this map is the
   * one place a provider id is tied to that reference. A provider with no entry, or
   * whose key does not resolve, gets no balance and the chip stays silent.
   */
  balanceCredentialRefs?: Record<string, string>
}

/** Configuration schema, with the config file's own defaults applied. */
export const Config: z<Config> = z.object({
  providers: z.array(z.union([...PROVIDER_IDS])).default([...IMPLEMENTED_PROVIDER_IDS]),
  enabled: z.boolean().default(true),
  oauthHost: z.string(),
  apiBase: z.string(),
  discovery: z.boolean().default(true),
  streamIdleTimeoutMs: z.number().default(KIMI_STREAM_IDLE_TIMEOUT_MS),
  defaultModel: z.string().default(KIMI_DEFAULT_MODEL),
  extraModels: z.array(z.string()).default([]),
  auto: z.boolean().default(true),
})

/**
 * Register every configured provider route, its credential store, and — when
 * the host has a connection service — the Settings page's RPC routes.
 *
 * @param ctx - the plugin's context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  if (config.enabled === false) return
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? KIMI_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0) {
    throw new Error(`${name}: streamIdleTimeoutMs must be a positive finite number`)
  }
  const selected = new Set<string>(config.providers ?? [...IMPLEMENTED_PROVIDER_IDS])
  const onWarn = (message: string): void => {
    ctx.logger.warn(`${name}: ${message}`)
  }

  const dataDir = dshHomePath(...KIMI_DATA_DIR)
  const credentialFile = path.join(dataDir, 'auth.json')
  const preferences = new ModelPreferences(path.join(dataDir, 'preferences.json'))

  /** Registration handles, so a catalog change can re-announce one route. */
  const handles = new Map<string, AdapterRegistrationHandle>()
  const reannounce = (id: string): void => { handles.get(id)?.replace([id]) }

  const routes: ProviderRoute[] = []
  for (const id of selected) {
    switch (id) {
      case 'kimi':
        routes.push(createKimiProvider({
          dataDir,
          credentialFile,
          oauthHost: normalizeOAuthHost(config.oauthHost ?? resolveOAuthHost()),
          apiBase: normalizeApiBase(config.apiBase ?? resolveApiBase()),
          discovery: config.discovery ?? true,
          streamIdleTimeoutMs,
          ...config.defaultModel === undefined ? {} : { defaultModel: config.defaultModel },
          ...config.extraModels === undefined ? {} : { extraModels: config.extraModels },
          preferences,
          // Resolved per request: the attachment service may start after this plugin.
          resolveAttachments: () => ctx.get('attachments') as AttachmentStore | undefined,
          onCatalogChanged: () => { reannounce('kimi') },
          onWarn,
          fetchFn: proxiedFetch,
        }))
        break
      case 'grok':
        routes.push(createGrokProvider({
          credentialFile,
          discovery: config.discovery ?? true,
          streamIdleTimeoutMs,
          preferences,
          resolveAttachments: () => ctx.get('attachments') as AttachmentStore | undefined,
          onCatalogChanged: () => { reannounce('grok') },
          onWarn,
          fetchFn: proxiedFetch,
        }))
        break
      case 'antigravity':
        routes.push(createAntigravityProvider({
          credentialFile,
          discovery: config.discovery ?? true,
          streamIdleTimeoutMs,
          preferences,
          resolveAttachments: () => ctx.get('attachments') as AttachmentStore | undefined,
          onCatalogChanged: () => { reannounce('antigravity') },
          onWarn,
          fetchFn: proxiedFetch,
        }))
        break
      case 'glm':
        routes.push(createGlmProvider({
          credentialFile,
          discovery: config.discovery ?? true,
          streamIdleTimeoutMs,
          preferences,
          resolveAttachments: () => ctx.get('attachments') as AttachmentStore | undefined,
          onCatalogChanged: () => { reannounce('glm') },
          onWarn,
          fetchFn: proxiedFetch,
        }))
        break
      case 'ark':
        routes.push(createArkProvider({
          credentialFile,
          discovery: config.discovery ?? true,
          streamIdleTimeoutMs,
          preferences,
          resolveAttachments: () => ctx.get('attachments') as AttachmentStore | undefined,
          onCatalogChanged: () => { reannounce('ark') },
          onWarn,
          fetchFn: proxiedFetch,
        }))
        break
      default:
        // A configured route with no module yet must not silently disappear.
        onWarn(`provider ${id} is configured but not implemented in this build`)
        break
    }
  }

  const registry = new SubscriptionRegistry(routes)

  // `auto` stands in for the other routes, so it is built after them and added
  // to the same registry it reads. Its list spans routes, which is why it is a
  // provider of its own rather than a model inside each one.
  if (config.auto ?? true) {
    const auto = createAutoProvider({
      preferences,
      registry,
      // Auto spans every provider the harness serves — the built-in DeepSeek
      // routes and any provider the user adds included — so it is enumerated
      // through the runtime rather than through this plugin's own registry. The
      // runtime is read per call, so a provider that registers later (another
      // plugin, a route the user configures) joins the chain without a restart.
      host: {
        providers: () => ctx.llm.listProviders().map((entry) => ({ id: entry.id, name: entry.name })),
        models: (provider) => ctx.llm.listModels(provider),
        resolve: async (provider, model) => {
          const resolved = await ctx.llm.resolveModelInfo(provider, model)
          return {
            ...resolved.context?.contextWindow === undefined ? {} : { contextWindow: resolved.context.contextWindow },
            ...resolved.reasoning === undefined
              ? {}
              : { reasoningEfforts: resolved.reasoning.efforts.map((effort) => String(effort.id)) },
            ...resolved.inputModalities === undefined ? {} : { inputModalities: resolved.inputModalities },
          }
        },
        // Dispatch through the harness, which selects the adapter that owns the
        // provider. Auto's own adapter is never asked to guess.
        stream: (options) => ctx.llm.stream(options),
      },
      onCatalogChanged: () => { reannounce(AUTO_PROVIDER_ID) },
      onWarn,
    })
    registry.register(auto)
    routes.push(auto)
  }

  // Registered in the page's reading order, not construction order: the model
  // picker groups by the order the adapters arrive, and Auto leads it.
  for (const id of registry.ids()) {
    const route = registry.get(id)
    if (route === undefined) continue
    const handle = ctx.llm.registerAdapter([route.id], route.adapter)
    handles.set(route.id, handle)
    ctx.effect(() => () => handle(), `${name}: ${route.id} provider route`)
  }
  // A non-subscription provider's balance is read by cc-switch's query, which needs the
  // provider's API key. The provider's profile names that key by reference (`apiKeyEnv`),
  // and the configured map ties a provider id to that reference; the host's credential
  // service resolves it. The map lives in server config because that is where the rest
  // of the plugin's wiring is, and the client learns a provider's balance by id, never
  // by its credential reference.
  const credentialRefs = config.balanceCredentialRefs ?? {}
  // The DeepSeek account's balance is read on the node half through the host's
  // `deepseekAccount` service; the browser reaches it through the plugin's own RPC, the
  // same channel as the rest of the chip's data. The service is optional — a composition
  // without it still serves everything else, and the balance endpoint answers nothing.
  let deepseekAccount: { getBalance: (client: unknown) => Promise<unknown> } | undefined
  try {
    deepseekAccount = ctx.get('deepseekAccount') as { getBalance: (client: unknown) => Promise<unknown> } | undefined
  } catch {
    deepseekAccount = undefined
  }
  const balanceContext = {
    credentialRefs,
    deepseekAccount,
    resolveCredential: async (ref: string): Promise<string | undefined> => {
      try {
        const credentials = ctx.get('credentials') as
          | { resolve?: (r: string) => Promise<{ value: string } | undefined> }
          | undefined
        return (await credentials?.resolve?.(ref))?.value
      } catch {
        return undefined
      }
    },
  }
  registerSubscriptionRpc(ctx, registry, balanceContext)

  // Warm each route's live catalog for an install that is already signed in.
  for (const id of registry.ids()) {
    void registry.discover(id, false).catch((error: unknown) => {
      onWarn(`${id} startup discovery failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
}

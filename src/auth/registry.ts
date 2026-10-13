/**
 * The provider registry: one erased façade over every route's controller.
 *
 * The RPC layer talks to this object only, so it never has to know how many
 * providers exist, what their routes are called, or which login shape each one
 * uses. Each route's controller is generic over its own session type; this
 * façade is the single place that erasure happens.
 *
 * @module dsh-plugin-subscription-oauth/auth/registry
 */

import { BAD_REQUEST, ProviderError } from '../errors.js'
import type { ModelPreferences } from '../settings.js'
import type {
  LoginStart,
  ModelVariants,
  ProviderStatus,
  RefreshResult,
  SubscriptionStatus,
  UsageResult,
} from '../protocol.js'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'

/**
 * Where a route sits in the page.
 *
 * `auto` is a way to reach every other route, so it leads the list; the routes it
 * stands in for keep the order they were configured in. Registration order is
 * therefore not the reading order, and this is the one place that says so.
 *
 * @param id - the route key.
 * @returns the sort rank; lower reads first.
 */
function displayRank(id: string): number {
  return id === 'auto' ? 0 : 1
}
import type { ProviderLoginStart, ProviderRefreshResult, ProviderUsageResult } from './provider-controller.js'

/** Everything the registry needs from one provider route. */
export interface ProviderRoute {
  readonly id: string
  readonly displayName: string
  readonly credentialFile: string
  /** The wire adapter this route registered with the harness. */
  readonly adapter: LlmAdapter
  status(): Promise<ProviderStatus>
  login(account?: string): Promise<ProviderLoginStart>
  cancel(): Promise<ProviderStatus>
  logout(account?: string): Promise<ProviderStatus>
  setDefault(account: string): Promise<ProviderStatus>
  refresh(account?: string): Promise<ProviderRefreshResult>
  discover(force?: boolean): Promise<ProviderStatus>
  setModelVisible(id: string, visible: boolean): Promise<ProviderStatus>
  setModelOrder(ids: readonly string[]): Promise<ProviderStatus>
  addModel(id: string): Promise<ProviderStatus>
  removeModel(id: string): Promise<ProviderStatus>
  usage(force?: boolean): Promise<ProviderUsageResult>
  reload(): Promise<ProviderStatus>
  /** Claim one account's daily check-in reward, when the route has one. */
  checkin?(account: string): Promise<{ credit: number, streakDays: number, already: boolean }>
  /** Fast and image variants for one model, when the route's discovery reported them. */
  modelVariants?(id: string): Promise<ModelVariants | undefined> | ModelVariants | undefined
}

/**
 * Routes every Settings call to the provider it names.
 *
 * A provider key the plugin does not serve is a request error, not an internal
 * failure: the message names the routes that do exist.
 */
export class SubscriptionRegistry {
  private readonly byId: Map<string, ProviderRoute>

  constructor(
    routes: readonly ProviderRoute[],
    private readonly preferences: ModelPreferences,
  ) {
    this.byId = new Map(routes.map((route) => [route.id, route]))
  }

  /** Route keys this registry serves, in display order. */
  ids(): readonly string[] {
    return [...this.byId.keys()]
  }

  /** Every route, in registration order. */
  all(): readonly ProviderRoute[] {
    return [...this.byId.values()]
  }

  /** One route by key, without the request-error path. */
  get(id: string): ProviderRoute | undefined {
    return this.byId.get(id)
  }

  /**
   * Add one route.
   *
   * `auto` is built last on purpose: it stands in for the others, so it is
   * registered once their catalogs exist, without a circular construction order.
   * That is a construction detail, not a display one — the page shows `auto`
   * first, so the reading order is stated here rather than inherited from the
   * order the routes happened to be built in.
   *
   * @param route - the route to serve from now on.
   * @throws {ProviderError} when the key is already served.
   */
  register(route: ProviderRoute): void {
    if (this.byId.has(route.id)) {
      throw new ProviderError(`provider ${route.id} is already registered`, BAD_REQUEST)
    }
    this.byId.set(route.id, route)
    // Re-insert in display order: a leading route (Auto) is built last but read first.
    const ordered = [...this.byId.entries()].sort(([left], [right]) => displayRank(left) - displayRank(right))
    this.byId.clear()
    for (const [id, entry] of ordered) this.byId.set(id, entry)
  }

  /** One route, or a request error naming the known ones. */
  private route(provider: string): ProviderRoute {
    const found = this.byId.get(provider)
    if (found === undefined) {
      throw new ProviderError(
        `unknown provider ${JSON.stringify(provider)}; this plugin serves ${[...this.byId.keys()].join(', ')}`,
        BAD_REQUEST,
      )
    }
    return found
  }

  /** Every provider's state, in registration order. */
  async status(): Promise<SubscriptionStatus> {
    return { providers: await Promise.all([...this.byId.values()].map((route) => route.status())) }
  }

  /** Start a login on one route. */
  async login(provider: string, account?: string): Promise<LoginStart> {
    const started = await this.route(provider).login(account)
    return { prompt: started.prompt, status: await this.status() }
  }

  /** Abandon one route's pending login. */
  async cancel(provider: string): Promise<SubscriptionStatus> {
    await this.route(provider).cancel()
    return this.status()
  }

  /** Forget one account of one route. */
  async logout(provider: string, account?: string): Promise<SubscriptionStatus> {
    await this.route(provider).logout(account)
    return this.status()
  }

  /** Promote one account to default. */
  async setDefault(provider: string, account: string): Promise<SubscriptionStatus> {
    await this.route(provider).setDefault(account)
    return this.status()
  }

  /** Refresh one account's token now. */
  async refresh(provider: string, account?: string): Promise<RefreshResult> {
    const result = await this.route(provider).refresh(account)
    return { account: result.account, expiresAt: result.expiresAt, status: await this.status() }
  }

  /** Re-read one route's live model list. */
  async discover(provider: string, force = false): Promise<SubscriptionStatus> {
    await this.route(provider).discover(force)
    return this.status()
  }

  /** Set one model's picker visibility. */
  async setModelVisible(provider: string, id: string, visible: boolean): Promise<SubscriptionStatus> {
    await this.route(provider).setModelVisible(id, visible)
    return this.status()
  }

  /** Replace one route's model order with one dropped arrangement. */
  async setModelOrder(provider: string, ids: readonly string[]): Promise<SubscriptionStatus> {
    await this.route(provider).setModelOrder(ids)
    return this.status()
  }

  /** Add one model id by hand to one route. */
  async addModel(provider: string, id: string): Promise<SubscriptionStatus> {
    await this.route(provider).addModel(id)
    return this.status()
  }

  /** Forget one hand-added model id. */
  async removeModel(provider: string, id: string): Promise<SubscriptionStatus> {
    await this.route(provider).removeModel(id)
    return this.status()
  }

  /** Read one route's plan and metered allowances. */
  async usage(provider: string, force = false): Promise<UsageResult> {
    const route = this.route(provider)
    const result = await route.usage(force)
    return {
      provider: route.id,
      usage: result.usage,
      ...result.error === undefined ? {} : { error: result.error },
      status: await this.status(),
    }
  }

  /** Re-read every credential file and the shared preferences. */
  async reload(): Promise<SubscriptionStatus> {
    await Promise.all([...this.byId.values()].map((route) => route.reload()))
    return this.status()
  }

  /** The fast and image variants for one model, as the route's discovery reported them. */
  async modelVariants(provider: string, id: string): Promise<ModelVariants | undefined> {
    const route = this.route(provider)
    return route.modelVariants?.(id)
  }

  /** Whether the `auto` provider is offered; flips it. */
  async autoState(): Promise<{ enabled: boolean }> {
    return { enabled: (await this.preferences.autoPreferences()).enabled }
  }

  async setAutoOn(enabled: boolean): Promise<{ enabled: boolean }> {
    await this.preferences.setAutoOn(enabled)
    return { enabled }
  }

  /** Claim one account's daily check-in reward, when the route supports it. */
  async checkin(provider: string, account: string): Promise<{ credit: number, streakDays: number, already: boolean }> {
    const route = this.route(provider)
    if (route.checkin === undefined) throw new ProviderError(`${provider} has no check-in`, BAD_REQUEST)
    return route.checkin(account)
  }
}

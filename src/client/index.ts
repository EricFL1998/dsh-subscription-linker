/**
 * Subscriptions settings page, browser half.
 *
 * Registers one `settings.section` entry titled 订阅 / Subscriptions. Every
 * connection fact arrives through the node half's `subscription-oauth` RPC
 * endpoints, so this half holds no credential state of its own, and the copy
 * rides the client locale service under the `settings.subscriptions` namespace.
 *
 * @module dsh-plugin-subscription-oauth/client
 */

// Type-only: pulls the `ctx.slots` Context merge and the `settings.section`
// SlotMap entry. These imports are erased; no runtime binding is taken.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'

import { SubscriptionsSection } from './SubscriptionsSection.js'
import type { SubscriptionsSectionInjected } from './SubscriptionsSection.js'
import { FastModeButton } from './FastModeButton.js'
import type { FastModeButtonInjected } from './FastModeButton.js'

import { UsageChip } from './UsageChip.js'
import type { UsageChipInjected } from './UsageChip.js'
import { ProviderCardExtras } from './ProviderCardExtras.js'
import type { ProviderCardExtrasInjected } from './ProviderCardExtras.js'
import { createSubscriptionsCall, createAccountBalanceCall, createCcSwitchBalanceCall } from './subscriptions-rpc.js'
import type { AccountBalanceCall } from './subscriptions-rpc.js'
import { en, zh } from './locales.js'
import type { SubscriptionsKey } from './locales.js'
import { SETTINGS_NS } from '../protocol.js'

export type { SubscriptionsSectionInjected, SubscriptionsSectionProps } from './SubscriptionsSection.js'
export type { FastModeButtonInjected } from './FastModeButton.js'
export type { UsageChipInjected } from './UsageChip.js'
export type { SubscriptionsKey } from './locales.js'
export { createSubscriptionsCall, SubscriptionsRpcError } from './subscriptions-rpc.js'
export type { SubscriptionsCall, AccountBalanceCall } from './subscriptions-rpc.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Subscriptions settings page copy. */
    'settings.subscriptions': SubscriptionsKey
  }
  interface SlotMap {
    /**
     * The composer's bottom bar.
     *
     * Declared here as the shell declares it — a session-scoped list — because the
     * owning package ships no type declarations to a plugin that only consumes it.
     * The shell's own stats pills are one entry in this list; this plugin's usage chip
     * is another.
     */
    'conversation.composer.dock': { kind: 'list', scope: 'session' }
    /**
     * The composer's row of compact controls, rendered immediately before its model seat.
     *
     * The shell declares it as a session-scoped list; this plugin's quick-mode button is
     * one entry, which is what puts it at the model selector's left.
     */
    'conversation.input.right': { kind: 'list', scope: 'session' }
    /**
     * One provider card's adapter extension area on the Models settings page.
     *
     * Declared by the Models section at runtime and dispatched with
     * `entryKey = settingsNs`, so a plugin whose routes share one settings
     * namespace registers once under that namespace and receives every card of
     * the family. The owning package ships no type declarations a plugin can
     * see, so the seat is declared here as the shell declares it — a keyed,
     * root-scoped slot — with the owner share the page passes to each
     * occurrence.
     */
    'settings.models.provider-card': {
      kind: 'keyed'
      scope: 'root'
      owner: {
        /** The card's directory row (route id and display name). */
        provider: { provider: string; displayName: string }
        /** Whether any layer configures this provider. */
        configured: boolean
        /** Whether the row's referenced api-key credential is configured. */
        keyConfigured: boolean
      }
    }
  }

  /**
   * The session standard kit, of which this plugin reads one member.
   *
   * `ui-session` merges the session identity and the projection reader into every
   * session-scoped component's props, and it ships no declarations a plugin can see, so
   * the member is declared here. It reads one session projection, optionally narrowed
   * by a selector, and re-renders the component when that projection changes — which is
   * what lets the usage chip follow the model picker.
   */
  interface SessionStandardProps {
    useProjection<T>(key: string, selector: (value: unknown) => T): T
  }
}

/**
 * Routes this plugin serves.
 *
 * The chip only reports for these; a provider somebody else registered gets no chip,
 * because this plugin has no way to read its allowance.
 */
const OWN_PROVIDER_IDS = new Set(['kimi', 'grok', 'antigravity', 'glm', 'ark', 'mimo', 'workbuddy'])

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.subscriptions'

/** Settings nav position: after the shipped sections, before plugin tooling. */
const SECTION_ORDER = 92

/**
 * Composer-dock position: after the shell's own stats pills, which sit at 0.
 *
 * The shell owns that bar and registers `tok/s` and the cache-hit pill into it, so the
 * chip follows them rather than displacing them.
 */
const CHIP_ORDER = 10

/**
 * Composer-control position: ahead of the shell's own entries in that row, if it ever
 * adds any, so the quick-mode button stays adjacent to the model selector it belongs to.
 */
const FAST_MODE_ORDER = 10

/** The host's per-session model directory resolver, as far as this plugin reads it. */
interface ModelDirectories {
  directoryFor?: (sessionId: string) => {
    select?: (selection: { provider: string, model: string }) => Promise<unknown>
  } | undefined
}

/**
 * Required services: `slots` carries the registration seat, `connection` the
 * RPC caller, and `locale` the copy dictionaries.
 *
 * `modelDirectories` is deliberately NOT in this list: the fiber's `inject` is
 * wait semantics, and the quick-mode button is the only consumer, which reads
 * the resolver lazily with `ctx.get` (below) and renders nothing when the host
 * exposes none. Declaring it would park the whole browser half on a service
 * whose presence is not guaranteed, taking the settings page with it.
 */
export const inject = ['slots', 'connection', 'locale']

/**
 * Register the Subscriptions settings section.
 *
 * Registration goes through `slots.inject`, so the shell's own apply order
 * relative to this one is unconstrained.
 *
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-plugin-subscription-oauth: copy dictionaries')
  // The shell's Context merge types `connection` as the host handle; in the
  // browser the same key holds the full client ConnectionHandle.
  const connection = ctx.get('connection') as unknown as ConnectionHandle
  const t = ctx.locale.bind(NS) as SubscriptionsSectionInjected['t']
  const call = createSubscriptionsCall(connection.rpc)
  // Read once: the resolver is a service, and the per-session directory is resolved at
  // registration time (see `modelDirectoryFor`).
  const modelDirectories = ctx.get('modelDirectories') as ModelDirectories | undefined
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'subscriptions',
    order: SECTION_ORDER,
    // A thunk re-evaluated per read, so the nav label follows the active locale.
    label: () => t('nav'),
    inject: (): SubscriptionsSectionInjected => ({ call, t }),
  }, SubscriptionsSection))

  // The composer's bottom bar is a session-scoped list the shell owns; its own stats
  // pills sit at order 0. This chip rides beside them and shows the allowance of the
  // provider the session is using. The scope hands `inject` the session id, but the chip
  // reads the selection from its own projection prop, so nothing here needs it.
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'subscription-usage',
    order: CHIP_ORDER,
    inject: (): UsageChipInjected => ({
      call,
      t: t as unknown as UsageChipInjected['t'],
      isOwnProvider: (provider: string) => OWN_PROVIDER_IDS.has(provider),
      accountBalance: createAccountBalanceCall(connection.rpc),
      ccSwitchBalance: createCcSwitchBalanceCall(connection.rpc),
    }),
  }, UsageChip))

  // The composer renders this seat immediately before its model selector, so the
  // quick-mode button lands at the picker's left. It renders nothing unless the current
  // model really has a fast variant, so a route without one shows no control at all.
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'subscription-fast-mode',
    order: FAST_MODE_ORDER,
    inject: (sessionId?: string): FastModeButtonInjected => ({
      call,
      isOwnProvider: (provider: string) => OWN_PROVIDER_IDS.has(provider),
      t: t as unknown as FastModeButtonInjected['t'],
      modelDirectory: modelDirectoryFor(modelDirectories, sessionId),
    }),
  }, FastModeButton))

  // The Models settings page declares a keyed card-extension seat per provider
  // row, dispatched with `entryKey = settingsNs`. The node half declares every
  // route under the shared namespace `subscriptions`, so one registration here
  // gives each of them a Connect block beside the section's own editor.
  ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
    name: 'settings.models.provider-card',
    key: SETTINGS_NS,
    inject: (): ProviderCardExtrasInjected => ({
      call,
      t: t as unknown as ProviderCardExtrasInjected['t'],
    }),
  }, ProviderCardExtras))
}

/**
 * The session's model directory, in the shape the quick-mode button writes through.
 *
 * The lookup is lazy: the returned `select` resolves the host's directory on first use,
 * not at inject time. The host's `directoryFor` throws while its own `remote.session`
 * dependency is still starting (observed on desktop), so resolving eagerly at mount hid
 * the button for the whole session even though the directory became ready a moment later.
 *
 * @param modelDirectories - the host's directory resolver, when it has one.
 * @param sessionId - the session whose directory is wanted.
 * @returns the writer, or undefined when there is no resolver or session at all.
 */
function modelDirectoryFor(
  modelDirectories: ModelDirectories | undefined,
  sessionId: string | undefined,
): FastModeButtonInjected['modelDirectory'] {
  if (sessionId === undefined || modelDirectories?.directoryFor === undefined) return undefined
  // A lazily-resolved select: the first call walks the host's directory; a throw there is
  // a transient startup miss, so it is retried once after a short beat before failing.
  return {
    select: async (selection: { provider: string, model: string }) => {
      const resolve = (): { select?: (s: { provider: string, model: string }) => Promise<unknown> } | undefined =>
        modelDirectories.directoryFor?.(sessionId)
      let directory = (() => { try { return resolve() } catch { return undefined } })()
      if (directory?.select === undefined) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 500))
        try {
          directory = resolve()
        } catch {
          directory = undefined
        }
      }
      if (directory?.select === undefined) throw new Error('the model directory is not available yet; try again')
      return directory.select(selection)
    },
  }
}

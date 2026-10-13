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
import { UsageChip } from './UsageChip.js'
import type { UsageChipInjected } from './UsageChip.js'
import { createSubscriptionsCall, createAccountBalanceCall, createCcSwitchBalanceCall } from './subscriptions-rpc.js'
import type { AccountBalanceCall } from './subscriptions-rpc.js'
import { en, zh } from './locales.js'
import type { SubscriptionsKey } from './locales.js'

export type { SubscriptionsSectionInjected, SubscriptionsSectionProps } from './SubscriptionsSection.js'
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
const OWN_PROVIDER_IDS = new Set(['kimi', 'grok', 'antigravity', 'glm', 'ark'])

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
 * Required services: `slots` carries the registration seat, `connection` the
 * RPC caller, `locale` the copy dictionaries, and `modelDirectories` the picker's
 * per-session model directory (read for the current selection, written when the
 * chip's quick-mode button routes to a fast variant).
 */
export const inject = ['slots', 'connection', 'locale', 'modelDirectories']

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
    inject: (sessionId?: string): UsageChipInjected => ({
      call,
      t: t as unknown as UsageChipInjected['t'],
      isOwnProvider: (provider: string) => OWN_PROVIDER_IDS.has(provider),
      accountBalance: createAccountBalanceCall(connection.rpc),
      ccSwitchBalance: createCcSwitchBalanceCall(connection.rpc),
      // The session's model directory: read for the current selection, written when the
      // quick-mode button routes to a fast variant. Absent on a host without it.
      modelDirectory: sessionId === undefined ? undefined : modelDirectoryFor(ctx, sessionId) as UsageChipInjected['modelDirectory'],
    }),
  }, UsageChip))
}

/** One session's model directory, when the host exposes the service. */
function modelDirectoryFor(ctx: ClientContext, sessionId: string): unknown {
  try {
    const directories = (ctx as unknown as { get: (key: string) => unknown }).get('modelDirectories') as
      | { directoryFor?: (id: string) => { store?: unknown, select?: (selection: unknown) => Promise<unknown> } | undefined }
      | undefined
    const directory = directories?.directoryFor?.(sessionId)
    if (directory === undefined) return undefined
    return {
      store: directory.store,
      select: (selection: unknown) => directory.select?.(selection),
    }
  } catch {
    return undefined
  }
}

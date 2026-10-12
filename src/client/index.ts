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
import { createSubscriptionsCall } from './subscriptions-rpc.js'
import { en, zh } from './locales.js'
import type { SubscriptionsKey } from './locales.js'

export type { SubscriptionsSectionInjected, SubscriptionsSectionProps } from './SubscriptionsSection.js'
export type { UsageChipInjected } from './UsageChip.js'
export type { SubscriptionsKey } from './locales.js'
export { createSubscriptionsCall, SubscriptionsRpcError } from './subscriptions-rpc.js'
export type { SubscriptionsCall } from './subscriptions-rpc.js'

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
 * Read the provider a session has selected, from the shell's model-selection service.
 *
 * The service key is `modelDirectories`, and `directoryFor(sessionId).store` holds the
 * selection under `current`. This is read per render rather than subscribed to, because
 * the value lives in a store this plugin does not own.
 *
 * @param ctx - client root context.
 * @param sessionId - the session the slot is being rendered for.
 * @returns the selected provider id, or undefined when the host cannot report one.
 */
function selectedProvider(ctx: ClientContext, sessionId: string): string | undefined {
  try {
    const directories = ctx.get('modelDirectories') as unknown as {
      directoryFor?: (id: string) => { store?: { getSnapshot?: () => { current?: { provider?: string } | null } } }
    } | undefined
    return directories?.directoryFor?.(sessionId).store?.getSnapshot?.().current?.provider
  } catch {
    // A host without the model-selection service simply gets no chip.
    return undefined
  }
}

/**
 * Required services: `slots` carries the registration seat, `connection` the
 * RPC caller, and `locale` the copy dictionaries.
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
  // provider the session is using. The scope hands `inject` the session id, so the chip
  // reads the selection of the conversation it is actually rendered in.
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'subscription-usage',
    order: CHIP_ORDER,
    inject: (sessionId: string): UsageChipInjected => ({
      call,
      t: t as unknown as UsageChipInjected['t'],
      currentProvider: () => selectedProvider(ctx, sessionId),
      isOwnProvider: (provider: string) => OWN_PROVIDER_IDS.has(provider),
    }),
  }, UsageChip))
}

/**
 * The usage chip that rides the composer's bottom bar.
 *
 * The bar itself is a slot the shell owns. `conversation.composer.dock` is a
 * session-scoped `list`, and the shell's own stats pills (`tok/s`, cache hit) and its
 * context meter register into it; this chip joins as the last entry, so it reads to the
 * right of the context meter. It is deliberately compact — an abbreviated route name
 * and the percentage — because the bar is a status line, not a dashboard; the full
 * figure, its reset and the meter appear when the chip is clicked.
 *
 * Two silences are deliberate: a provider this plugin does not own shows nothing rather
 * than a fabricated zero, and switching to a foreign provider keeps the last own reading
 * on screen instead of blanking the bar — the shell's own pills already speak for the
 * foreign one.
 *
 * @module dsh-plugin-subscription-oauth/client/UsageChip
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { SessionStandardProps } from '@deepseek-ai/dsh-client-ui-slots'

import type { SubscriptionsCall, AccountBalanceCall, CcSwitchBalanceCall } from './subscriptions-rpc.js'
import { usageChipCss } from './styles.js'
import type { ProviderUsage, UsageWindow } from '../protocol.js'

/** How often a visible chip refreshes its figures. */
const REFRESH_INTERVAL_MS = 60_000

/**
 * Abbreviations for the routes this plugin serves.
 *
 * The bar is a status line under the composer, where a full product name crowds out the
 * shell's own pills; the full name is one click away. The fallback shortens an unknown
 * route's display name rather than dropping it.
 */
const SHORT_LABELS: Record<string, string> = {
  kimi: 'Kimi',
  grok: 'Grok',
  antigravity: 'Anti',
  glm: 'GLM',
  ark: 'Ark',
}

/**
 * Abbreviations for the window names the providers use.
 *
 * The bar has room for a token or two, so `weekly` becomes `7d` — the same figure in a
 * form that reads at a glance. An unrecognised window keeps its own name, shortened
 * only if it is long.
 */
const SHORT_WINDOWS: Record<string, string> = {
  'weekly': '7d',
  '7d': '7d',
  '5h': '5h',
  'monthly': 'mo',
  'daily': '1d',
  'credits': 'cr',
  'free': 'free',
  'session': 's',
}

/** Injected props the chip is registered with. */
export interface UsageChipInjected {
  /** The plugin's own RPC caller. */
  call: SubscriptionsCall
  /** Copy for the active locale. */
  t: (key: 'usageChipTitle' | 'usageChipFull', values?: Record<string, string | number>) => string
  /** Whether the provider is one this plugin serves. */
  isOwnProvider: (provider: string) => boolean
  /**
   * The DeepSeek account's balance, when the session uses it.
   *
   * The host owns that account's grant and the platform endpoint, so the chip asks the
   * host rather than re-deriving either. It resolves to `undefined` when the account is
   * signed out or the read fails, in which case the chip stays silent.
   */
  accountBalance: AccountBalanceCall
  /**
   * A manually added provider's balance, by cc-switch's query.
   *
   * The caller names the credential reference the provider's profile uses (its
   * `apiKeyEnv`); the host's credential service resolves it, and the node half asks
   * cc-switch's balance endpoint. It resolves to `undefined` when there is no key or
   * the provider did not answer.
   */
  ccSwitchBalance: CcSwitchBalanceCall
}

/** One model choice, as the host records it. */
export interface ModelSelection {
  /** Provider route key. */
  readonly provider: string
  /** Model id. */
  readonly model: string
  /** Reasoning effort, when one was chosen. */
  readonly reasoningEffort?: string
}

/**
 * The session's model-selection projection, as the host wires it.
 *
 * `next` is a selection the user has made but not yet used; `lastUsed` is the one a
 * request actually ran with. Reading `next` first is what makes the chip follow the
 * picker immediately rather than only after the next message.
 */
export interface ModelSelectionProjection {
  /** The last selection a request ran with. */
  readonly lastUsed: ModelSelection | null
  /** The selection in force now. */
  readonly next: ModelSelection | null
}

/** The session's provider, from its model-selection projection. */
export function providerOf(projection: ModelSelectionProjection | null | undefined): string | undefined {
  return (projection?.next ?? projection?.lastUsed)?.provider
}

/** What one route's allowance reduces to for a single line. */
export interface ChipReading {
  /** Route the figures belong to. */
  provider: string
  /** Name to show, as the route states it. */
  label: string
  /** Every window that states a figure, in the order the route stated them. */
  windows: readonly UsageWindow[]
  /** The window worth showing in the compact line: the one closest to its limit. */
  window: UsageWindow
  /** Plan name, when the provider stated one. */
  plan?: string
}

/** One currency's balance, as the host's account controller reports it. */
export interface ChipBalance {
  /** The wallet's currency. */
  currency: string
  /** Remaining balance, as a decimal string. */
  balance: string
  /** Whether this is a bonus / promotional wallet rather than topped-up credit. */
  bonus: boolean
}

/**
 * Reduce the host's account-balance payload to the wallets the chip shows.
 *
 * Bonus wallets are shown after the topped-up ones, so a reader sees their own credit
 * first and any promotional credit as a secondary figure.
 *
 * @param value - the host's ready balance, or undefined when there is none.
 * @returns the wallets, topped-up first then bonus, or undefined when nothing is usable.
 */
export function balanceOf(value: { value?: readonly { currency: string, balance: string }[], bonusWallets?: readonly { currency: string, balance: string }[] } | { status: string } | null | undefined): readonly ChipBalance[] | undefined {
  // A failed read or no account (`{status:'failed'}` or `null`) reduces to nothing, as
  // does a ready payload that names no wallet.
  if (value === null || value === undefined || !('value' in value) || value.value === undefined) return undefined
  const wallets: ChipBalance[] = [
    ...value.value.map((wallet) => ({ currency: wallet.currency, balance: wallet.balance, bonus: false })),
    ...(value.bonusWallets ?? []).map((wallet) => ({ currency: wallet.currency, balance: wallet.balance, bonus: true })),
  ]
  return wallets.length === 0 ? undefined : wallets
}

/**
 * Format one wallet for the chip's compact line.
 *
 * A balance is money, not a percentage, so it renders as `¥6.89` rather than a meter;
 * the currency prefix keeps two currencies from being mistaken for one sum.
 *
 * @param wallet - the wallet to show.
 * @returns the short form, e.g. `¥6.89` or `+¥2` for a bonus wallet.
 */
export function formatBalance(wallet: ChipBalance): string {
  const amount = Number.parseFloat(wallet.balance)
  const trimmed = Number.isFinite(amount) ? String(Math.round(amount * 100) / 100) : wallet.balance
  const symbol = wallet.currency === 'CNY' ? '¥' : wallet.currency === 'USD' ? '$' : `${wallet.currency} `
  return `${wallet.bonus ? '+' : ''}${symbol}${trimmed}`
}

/**
 * The short form of a route's name.
 *
 * @param provider - the route id.
 * @param label - the route's own display name.
 * @returns an abbreviation that still identifies the route.
 */
export function shortLabel(provider: string, label: string): string {
  const known = SHORT_LABELS[provider]
  if (known !== undefined) return known
  // An unknown route keeps its first word, so the chip names something recognisable
  // rather than a generic placeholder.
  const [first] = label.trim().split(/\s+/)
  return first === undefined || first === '' ? provider : first
}

/**
 * The short form of a window's name.
 *
 * @param label - the window's own name, e.g. `weekly`.
 * @returns an abbreviation, or the label itself when it is already short.
 */
export function shortWindow(label: string): string {
  const known = SHORT_WINDOWS[label.toLowerCase()]
  if (known !== undefined) return known
  return label.length <= 4 ? label : label.slice(0, 4)
}

/**
 * Pick the window a single line should show.
 *
 * A plan can meter several windows at once (a rolling five-hour one and a weekly one).
 * The most constrained is the one that will stop work soonest, so it earns the space;
 * ties fall to the earlier window, which is the order the providers state them in.
 *
 * @param windows - the route's metered windows.
 * @returns the window to show, or undefined when none states a figure.
 */
export function pickWindow(windows: readonly UsageWindow[]): UsageWindow | undefined {
  let best: UsageWindow | undefined
  for (const window of windows) {
    if (window.usedPercent === undefined) continue
    if (best?.usedPercent === undefined || window.usedPercent > best.usedPercent) best = window
  }
  return best
}

/**
 * Reduce one route's usage to what the chip renders.
 *
 * @param provider - the route the figures came from.
 * @param label - the route's display name.
 * @param usage - the accounts the route answered for.
 * @returns the reading, or undefined when the route stated no figure.
 */
export function readingOf(
  provider: string,
  label: string,
  usage: readonly ProviderUsage[],
): ChipReading | undefined {
  for (const entry of usage) {
    const window = pickWindow(entry.windows)
    if (window === undefined) continue
    const windows = entry.windows.filter((candidate) => candidate.usedPercent !== undefined)
    return {
      provider,
      label,
      windows,
      window,
      ...entry.plan === undefined ? {} : { plan: entry.plan },
    }
  }
  return undefined
}

/**
 * Format a window's reset the way the settings cards do.
 *
 * The rule is shared with the cards on purpose: a figure reading `6d20h` here and
 * something else there would be two answers to one question.
 *
 * @param at - epoch milliseconds, or undefined when the provider states none.
 * @param now - the instant to measure from.
 * @returns a short phrase, or undefined when there is no reset to show.
 */
export function formatReset(at: number | undefined, now: number): string | undefined {
  if (at === undefined) return undefined
  const remaining = at - now
  if (remaining <= 0) return 'now'
  const hours = remaining / 3_600_000
  if (hours < 1) return `${String(Math.max(1, Math.round(remaining / 60_000)))}m`
  if (hours < 24) return `${String(Math.round(hours))}h`
  const days = Math.floor(hours / 24)
  return `${String(days)}d${String(Math.round(hours - days * 24))}h`
}

/**
 * The composer's usage chip.
 *
 * @param props - injected RPC caller, copy, and the session's provider reader.
 * @returns the chip, or null when there is nothing true to say.
 */
export function UsageChip({ call, t, isOwnProvider, accountBalance, ccSwitchBalance, useProjection }: UsageChipInjected & SessionStandardProps): ReactNode {
  const [reading, setReading] = useState<ChipReading | undefined>(undefined)
  const [balance, setBalance] = useState<readonly ChipBalance[] | undefined>(undefined)
  const [ccBalance, setCcBalance] = useState<{ currency: string, total: string } | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())
  const [open, setOpen] = useState(false)
  // The last route that answered, so a switch to a foreign provider leaves the last own
  // reading up rather than blanking the bar.
  const lastOwn = useRef<string | undefined>(undefined)

  // A projection read, so the chip follows the picker: changing the model re-renders it
  // with the new provider instead of waiting for the next unrelated render.
  const selected = useProjection('modelSelection', (value) => providerOf(value as ModelSelectionProjection))

  // The DeepSeek account is not one of this plugin's routes, but the host owns its grant
  // and the balance endpoint, so the chip shows its balance rather than staying silent.
  // An own route takes the balance read over nothing.
  const isDeepSeek = selected === 'deepseek-account'

  const load = useCallback(async (target: string): Promise<ChipReading | undefined> => {
    try {
      const result = await call('usage', { provider: target })
      const label = result.status.providers.find((entry) => entry.provider === target)?.displayName ?? target
      return readingOf(target, label, result.usage)
    } catch {
      // A failed read is not worth a chip of its own: the settings page is where a user
      // goes to find out why a route cannot report.
      return undefined
    }
  }, [call])

  // Read the DeepSeek account's balance while that provider is in force, on the same
  // cadence as a usage read. It resolves to undefined when the account is signed out or
  // the read fails, which leaves the chip silent.
  useEffect(() => {
    if (!isDeepSeek) {
      setBalance(undefined)
      return
    }
    let live = true
    const refresh = (): void => {
      void accountBalance()
        .then((value) => { if (live) setBalance(balanceOf(value)) })
        .catch(() => { /* a failed balance read stays silent */ })
    }
    refresh()
    const timer = setInterval(refresh, REFRESH_INTERVAL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [isDeepSeek, accountBalance])

  useEffect(() => {
    const target = selected !== undefined && isOwnProvider(selected)
      ? selected
      // Not one of ours (or none selected): keep showing the last own reading.
      : lastOwn.current
    if (target === undefined) {
      setReading(undefined)
      return
    }
    let live = true
    const refresh = (): void => {
      setNow(Date.now())
      void load(target).then((next) => {
        if (!live || next === undefined) return
        lastOwn.current = target
        setReading(next)
      })
    }
    refresh()
    const timer = setInterval(refresh, REFRESH_INTERVAL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [selected, isOwnProvider, load])

  // A click anywhere else puts the detail away, which is what a status chip should do.
  useEffect(() => {
    if (!open) return
    const close = (): void => { setOpen(false) }
    document.addEventListener('click', close)
    return () => { document.removeEventListener('click', close) }
  }, [open])

  // The DeepSeek account reads as money, not as a percentage, so it takes its own line:
  // the route abbreviated, then each wallet. An unknown selection leaves the chip silent.
  if (isDeepSeek) {
    if (balance === undefined) return null
    const short = shortLabel('deepseek-account', 'DeepSeek Account')
    return (
      <span className="dsh-subscription-usage-chip">
        <style>{usageChipCss}</style>
        <button
          type="button"
          className="dsh-subscription-usage-chip-trigger"
          aria-expanded={open}
          title={t('usageChipTitle', { provider: 'DeepSeek Account' })}
          onClick={(event) => {
            event.stopPropagation()
            setOpen((was) => !was)
          }}
        >
          <span className="dsh-subscription-usage-chip-label">{short}</span>
          {balance.map((wallet) => (
            <span className="dsh-subscription-usage-chip-cell" key={`${wallet.currency}${wallet.bonus ? ':bonus' : ''}`}>
              <span className="dsh-subscription-usage-chip-value">{formatBalance(wallet)}</span>
            </span>
          ))}
        </button>
        {open && (
          <span className="dsh-subscription-usage-chip-panel" role="status">
            <span className="dsh-subscription-usage-chip-full">
              {t('usageChipFull', { provider: 'DeepSeek Account' })}
            </span>
            {balance.map((wallet) => (
              <span className="dsh-subscription-usage-chip-meter" key={`${wallet.currency}${wallet.bonus ? ':bonus' : ''}`}>
                <span className="dsh-subscription-usage-chip-meterHead">
                  <span>{`${wallet.bonus ? 'Bonus · ' : ''}${wallet.currency}`}</span>
                  <span className="dsh-subscription-usage-chip-detail">{formatBalance(wallet)}</span>
                </span>
              </span>
            ))}
          </span>
        )}
      </span>
    )
  }

  if (reading === undefined) return null
  const percent = reading.window.usedPercent
  if (percent === undefined) return null
  const reset = formatReset(reading.window.resetsAt, now)
  const clamped = Math.max(0, Math.min(100, percent))
  const short = shortLabel(reading.provider, reading.label)

  return (
    <span className="dsh-subscription-usage-chip">
      {/* An element, so unmounting the chip takes its rules with it. */}
      <style>{usageChipCss}</style>
      <button
        type="button"
        className="dsh-subscription-usage-chip-trigger"
        aria-expanded={open}
        title={t('usageChipTitle', { provider: reading.label })}
        onClick={(event) => {
          // The document listener would otherwise close what this click just opened.
          event.stopPropagation()
          setOpen((was) => !was)
        }}
      >
        <span className="dsh-subscription-usage-chip-label">{short}</span>
        {/* Every metered window, abbreviated: `5h 25% 7d 71%` is one line of tokens
            where the full names would be three times the width. */}
        {reading.windows.map((window) => (
          <span className="dsh-subscription-usage-chip-cell" key={window.label}>
            <span className="dsh-subscription-usage-chip-window">{shortWindow(window.label)}</span>
            <span className="dsh-subscription-usage-chip-value">
              {`${String(Math.round(window.usedPercent ?? 0))}%`}
            </span>
          </span>
        ))}
      </button>
      {open && (
        <span className="dsh-subscription-usage-chip-panel" role="status">
          <span className="dsh-subscription-usage-chip-full">
            {t('usageChipFull', { provider: reading.label })}
          </span>
          {reading.windows.map((window) => {
            const windowReset = formatReset(window.resetsAt, now)
            return (
              <span className="dsh-subscription-usage-chip-meter" key={window.label}>
                <span className="dsh-subscription-usage-chip-meterHead">
                  <span>{window.label}</span>
                  <span className="dsh-subscription-usage-chip-detail">
                    {`${String(Math.round(window.usedPercent ?? 0))}%${windowReset === undefined ? '' : ` · ${windowReset}`}`}
                  </span>
                </span>
                <span className="dsh-subscription-usage-chip-track" aria-hidden="true">
                  <span
                    className="dsh-subscription-usage-chip-fill"
                    style={{ width: `${String(Math.max(0, Math.min(100, window.usedPercent ?? 0)))}%` }}
                  />
                </span>
              </span>
            )
          })}
          {reading.plan === undefined ? null : (
            <span className="dsh-subscription-usage-chip-detail">{reading.plan}</span>
          )}
        </span>
      )}
    </span>
  )
}

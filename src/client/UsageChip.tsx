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

import type { SubscriptionsCall } from './subscriptions-rpc.js'
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
  /**
   * The provider serving this session, or undefined when the shell reports none.
   *
   * A function rather than a value: the selection lives in a store the shell owns, and
   * the chip asks for it on each render instead of subscribing to a store it does not
   * own.
   */
  currentProvider: () => string | undefined
  /** Whether the provider is one this plugin serves. */
  isOwnProvider: (provider: string) => boolean
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
export function UsageChip({ call, t, currentProvider, isOwnProvider }: UsageChipInjected): ReactNode {
  const [reading, setReading] = useState<ChipReading | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())
  const [open, setOpen] = useState(false)
  // The last route that answered, so a switch to a foreign provider leaves the last own
  // reading up rather than blanking the bar.
  const lastOwn = useRef<string | undefined>(undefined)

  const selected = currentProvider()

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

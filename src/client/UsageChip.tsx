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
 * The pure helpers (the reduction from a route's usage to one line, the label and
 * balance formatters) live in `chip-helpers.ts` so the test suite can assert them
 * without evaluating this module's React and popover imports; everything here is
 * re-exported, so the public surface is unchanged.
 *
 * @module dsh-plugin-subscription-oauth/client/UsageChip
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { SessionStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { useAnchoredPosition, useDismissOnOutsidePointer } from './popover-hooks.js'

import { usageChipCss } from './styles.js'

export {
  accountReadingsOf,
  balanceOf,
  formatBalance,
  formatReset,
  mergeAccountWindows,
  pickWindow,
  providerOf,
  readingOf,
  shortLabel,
  shortWindow,
  windowAmount,
  windowName,
} from './chip-helpers.js'
export type {
  AccountReading,
  ChipBalance,
  ChipReading,
  ModelSelection,
  ModelSelectionProjection,
  UsageChipInjected,
} from './chip-helpers.js'

import {
  accountReadingsOf,
  balanceOf,
  formatBalance,
  formatReset,
  mergeAccountWindows,
  providerOf,
  shortLabel,
  shortWindow,
  windowAmount,
  windowName,
} from './chip-helpers.js'
import type { AccountReading, ChipBalance, ChipReading, ModelSelectionProjection, UsageChipInjected } from './chip-helpers.js'

/** How often a visible chip refreshes its figures. */
const REFRESH_INTERVAL_MS = 60_000

/**
 * The panel's placement before its first measurement.
 *
 * `useAnchoredPosition` reports `null` until it has run, and the panel must be
 * mounted for that run to read its real size. It renders at the origin and
 * hidden for that one layout pass instead of not rendering at all, so the
 * measurement and the first paint agree.
 */
const HIDDEN_POSITION = { left: 0, top: 0, visibility: 'hidden' } as const


/**
 * The composer's usage chip.
 *
 * @param props - injected RPC caller, copy, and the session's provider reader.
 * @returns the chip, or null when there is nothing true to say.
 */
export function UsageChip({ call, t, isOwnProvider, accountBalance, ccSwitchBalance, useProjection }: UsageChipInjected & SessionStandardProps): ReactNode {
  const [reading, setReading] = useState<ChipReading | undefined>(undefined)
  const [accountReadings, setAccountReadings] = useState<readonly AccountReading[] | undefined>(undefined)
  const [balance, setBalance] = useState<readonly ChipBalance[] | undefined>(undefined)
  const [ccBalance, setCcBalance] = useState<{ currency: string, total: string } | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())
  const [open, setOpen] = useState(false)
  // The last route that answered, so a switch to a foreign provider leaves the last own
  // reading up rather than blanking the bar.
  const lastOwn = useRef<string | undefined>(undefined)

  // A projection read, so the chip follows the picker: changing the model re-renders it
  // with the new provider instead of waiting for the next unrelated render.
  const selection = useProjection('modelSelection', (value) => (value as ModelSelectionProjection))
  const selected = providerOf(selection)

  // A non-subscription provider has no usage windows to meter, so the chip shows its
  // balance instead, read by cc-switch's query. The host's account (deepseek-account)
  // has its own balance source and takes that over cc-switch; a subscription this plugin
  // serves keeps its usage meter.
  const isDeepSeek = selected === 'deepseek-account'
  const isBalanceProvider = selected !== undefined && !isOwnProvider(selected) && !isDeepSeek

  // Read a non-subscription provider's balance while it is in force, on the same cadence
  // as the other reads. It resolves to undefined when the provider has no balance source
  // or did not answer, which leaves the chip silent.
  useEffect(() => {
    if (!isBalanceProvider || selected === undefined) {
      setCcBalance(undefined)
      return
    }
    let live = true
    const target = selected
    const refresh = (): void => {
      void ccSwitchBalance(target)
        .then((value) => { if (live) setCcBalance(value === undefined ? undefined : { currency: value.currency, total: value.total }) })
        .catch(() => { /* a failed balance read stays silent */ })
    }
    refresh()
    const timer = setInterval(refresh, REFRESH_INTERVAL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [isBalanceProvider, selected, ccSwitchBalance])

  const load = useCallback(async (target: string): Promise<readonly AccountReading[] | undefined> => {
    try {
      const result = await call('usage', { provider: target })
      return accountReadingsOf(result.usage)
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
      setAccountReadings(undefined)
      return
    }
    let live = true
    const refresh = (): void => {
      setNow(Date.now())
      void load(target).then((next) => {
        if (!live || next === undefined) return
        lastOwn.current = target
        setAccountReadings(next)
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
  // See ChipFrame for the popover mechanics (portal, clamp, dismiss, ARIA).
  const rootRef = useRef<HTMLElement | null>(null)
  const panelRef = useRef<HTMLElement | null>(null)
  // The hook contract reads `RefObject<HTMLElement | null>`; React 18's
  // `useRef<T>` types the ref object with a non-null `current` on assignment
  // sites, so the two are bridged with callback refs that only ever write.
  const setRootRef = useCallback((el: HTMLElement | null) => { rootRef.current = el }, [])
  const setPanelRef = useCallback((el: HTMLElement | null) => { panelRef.current = el }, [])

  const title = t('usageChipTitle', { provider: selected ?? '' })
  const panelLabel = t('usageChipFull', { provider: selected ?? '' })

  // A non-subscription provider reads as money, through cc-switch's query. It shows the
  // one currency's total the provider answered with, nothing when there is no usable
  // balance.
  if (isBalanceProvider) {
    if (ccBalance === undefined) return null
    const short = shortLabel(selected ?? '', selected ?? '')
    return (
      <ChipFrame
        open={open}
        setOpen={setOpen}
        rootRef={rootRef}
        panelRef={panelRef}
        setRootRef={setRootRef}
        setPanelRef={setPanelRef}
        title={title}
        panelLabel={panelLabel}
        cells={(
          <span className="dsh-subscription-usage-chip-cell">
            <span className="dsh-subscription-usage-chip-value">
              {`${ccBalance.currency === 'CNY' ? '¥' : ccBalance.currency === 'USD' ? '$' : `${ccBalance.currency} `}${ccBalance.total}`}
            </span>
          </span>
        )}
        panel={(
          <>
            <span className="dsh-subscription-usage-chip-full">{panelLabel}</span>
            <span className="dsh-subscription-usage-chip-meter">
              <span className="dsh-subscription-usage-chip-meterHead">
                <span>{ccBalance.currency}</span>
                <span className="dsh-subscription-usage-chip-detail">{ccBalance.total}</span>
              </span>
            </span>
          </>
        )}
      >
        <span className="dsh-subscription-usage-chip-label">{short}</span>
      </ChipFrame>
    )
  }

  // The DeepSeek account reads as money, not as a percentage, so it takes its own line:
  // the route abbreviated, then each wallet. An unknown selection leaves the chip silent.
  if (isDeepSeek) {
    if (balance === undefined) return null
    const short = shortLabel('deepseek-account', 'DeepSeek Account')
    return (
      <ChipFrame
        open={open}
        setOpen={setOpen}
        rootRef={rootRef}
        panelRef={panelRef}
        setRootRef={setRootRef}
        setPanelRef={setPanelRef}
        title={t('usageChipTitle', { provider: 'DeepSeek Account' })}
        panelLabel={t('usageChipFull', { provider: 'DeepSeek Account' })}
        cells={balance.map((wallet) => (
          <span className="dsh-subscription-usage-chip-cell" key={`${wallet.currency}${wallet.bonus ? ':bonus' : ''}`}>
            <span className="dsh-subscription-usage-chip-value">{formatBalance(wallet)}</span>
          </span>
        ))}
        panel={(
          <>
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
          </>
        )}
      >
        <span className="dsh-subscription-usage-chip-label">{short}</span>
      </ChipFrame>
    )
  }

  if (accountReadings === undefined || accountReadings.length === 0) return null
  const short = shortLabel(selected ?? '', selected ?? '')
  // The compact line integrates the whole pool; the panel shows each account's own
  // figures, so a merged glance hides nothing a per-account look cannot recover.
  const merged = mergeAccountWindows(accountReadings)

  return (
    <ChipFrame
      open={open}
      setOpen={setOpen}
      rootRef={rootRef}
      panelRef={panelRef}
      setRootRef={setRootRef}
      setPanelRef={setPanelRef}
      title={title}
      panelLabel={panelLabel}
      cells={merged.map((window) => (
        <span className="dsh-subscription-usage-chip-cell" key={window.label}>
          <span className="dsh-subscription-usage-chip-window">{shortWindow(window.label)}</span>
          <span className="dsh-subscription-usage-chip-value">{windowAmount(window)}</span>
        </span>
      ))}
      panel={(
        <>
          <span className="dsh-subscription-usage-chip-full">{panelLabel}</span>
          {accountReadings.map((account) => (
            <span key={account.account} className="dsh-subscription-usage-chip-account">
              <span className="dsh-subscription-usage-chip-meterHead">
                <span>{account.plan ?? account.account}</span>
              </span>
              {account.windows.map((window) => {
                const windowReset = formatReset(window.resetsAt, now)
                return (
                  <span className="dsh-subscription-usage-chip-meter" key={window.label}>
                    <span className="dsh-subscription-usage-chip-meterHead">
                      <span>{windowName(t, window.label)}</span>
                      <span className="dsh-subscription-usage-chip-detail">
                        {/* A shift of the allowance is a share spent, which is what the bar
                            fills to; saying so is what keeps "0%" from reading as "none left". */}
                        {`${t('usageSpent', { value: windowAmount(window) })}${windowReset === undefined ? '' : ` · ${windowReset}`}`}
                      </span>
                    </span>
                    {window.usedPercent !== undefined && (
                      <span className="dsh-subscription-usage-chip-track" aria-hidden="true">
                        <span
                          className="dsh-subscription-usage-chip-fill"
                          style={{ width: `${String(Math.max(0, Math.min(100, window.usedPercent ?? 0)))}%` }}
                        />
                      </span>
                    )}
                  </span>
                )
              })}
            </span>
          ))}
        </>
      )}
    >
      <span className="dsh-subscription-usage-chip-label">{short}</span>
    </ChipFrame>
  )
}

/**
 * The chip's shared frame: trigger button plus its detail popover.
 *
 * The popover is a dialog, not a status line: it opens on a user gesture and
 * carries per-account rows a reader can act on, so it renders through a portal
 * anchored to the trigger (viewport-clamped, the same `useAnchoredPosition`
 * the shell's own stat pills use) rather than an absolutely-positioned child
 * of a centered flex row. Outside-pointer dismissal runs in the capture phase
 * and Escape closes, with focus returning to the trigger on close.
 */
function ChipFrame({
  open,
  setOpen,
  rootRef,
  panelRef,
  title,
  panelLabel,
  cells,
  panel,
  children,
  setRootRef,
  setPanelRef,
}: {
  open: boolean
  setOpen: (updater: (was: boolean) => boolean) => void
  rootRef: React.MutableRefObject<HTMLElement | null>
  panelRef: React.MutableRefObject<HTMLElement | null>
  title: string
  panelLabel: string
  /** The compact line's meter cells (route abbreviations and figures). */
  cells: ReactNode
  /** The popover body. */
  panel: ReactNode
  /** The trigger's leading label. */
  children: ReactNode
  setRootRef: (el: HTMLElement | null) => void
  setPanelRef: (el: HTMLElement | null) => void
}): ReactNode {
  const position = useAnchoredPosition({
    open,
    anchorRef: rootRef,
    panelRef,
    side: 'top',
    align: 'end',
    gap: 6,
    margin: 12,
  })
  useDismissOnOutsidePointer(rootRef, open, (next) => setOpen(() => next), panelRef)
  // Escape closes the dialog and returns focus to the trigger.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(() => false)
        rootRef.current?.querySelector('button')?.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('keydown', onKey, true) }
  }, [open, setOpen, rootRef])
  return (
    <span className="dsh-subscription-usage-chip" ref={setRootRef}>
      <style>{usageChipCss}</style>
      <button
        type="button"
        className="dsh-subscription-usage-chip-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title}
        onClick={() => { setOpen((was) => !was) }}
      >
        {children}
        {cells}
      </button>
      {open && createPortal(
        <div
          ref={setPanelRef}
          className="dsh-subscription-usage-chip-panel"
          role="dialog"
          aria-label={panelLabel}
          // The first measurement happens in the layout effect that opened the
          // panel, so it needs the panel mounted to read its real size. Until a
          // position exists the panel is mounted but invisible, which keeps the
          // clamp honest without flashing it at the origin.
          style={position ?? HIDDEN_POSITION}
        >
          {panel}
        </div>,
        document.body,
      )}
    </span>
  )
}

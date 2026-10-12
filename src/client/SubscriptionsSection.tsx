/**
 * Subscriptions settings page.
 *
 * One card per provider route — Kimi Code, Grok (X Premium), Google Antigravity
 * — describing that route's connection, accounts, and model catalog. Every fact
 * arrives from the node half's `subscription-oauth` RPC endpoints, so this
 * component holds no credential state of its own. The status poll runs only
 * while a login is pending, so an idle page performs no requests.
 *
 * Colors resolve through `--dsw-alias-*` design tokens, so the page follows the
 * active theme; every user-visible string goes through the locale-bound `t`.
 *
 * @module dsh-plugin-subscription-oauth/client/SubscriptionsSection
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

import { en } from './locales.js'
import type { SubscriptionsKey } from './locales.js'
import { subscriptionsCss } from './styles.js'
import { SubscriptionsRpcError } from './subscriptions-rpc.js'
import type { SubscriptionsCall } from './subscriptions-rpc.js'
import type {
  AccountStatus,
  DetailRow,
  LoginPrompt,
  ProviderStatus,
  ProviderUsage,
  SubscriptionStatus,
  UsageWindow,
} from '../protocol.js'
/** Poll cadence while a login attempt is pending. */
const POLL_INTERVAL_MS = 2000

/**
 * How often an open page re-reads every signed-in route's allowance.
 *
 * Slow on purpose: it is fast enough that a figure shown on screen is current, and
 * slow enough that leaving the page open costs one small request a minute per
 * signed-in provider.
 */
const USAGE_POLL_INTERVAL_MS = 60_000

/**
 * Disclosures start folded, every time the page is opened.
 *
 * Nothing is remembered between visits on purpose: the section is a list of
 * providers first, and a card left open last time should not decide what this
 * visit looks like. A fold is a gesture within one visit, not a stored setting.
 */

/** Horizontal room the page takes inside the settings panel. */
const SECTION_WIDTH = 560

/** What the node half injects into this section. */
export interface SubscriptionsSectionInjected {
  /** Typed caller for the plugin's RPC endpoints. */
  call: SubscriptionsCall
  /** Translate a key of this plugin's settings namespace. */
  t: (key: SubscriptionsKey, params?: Record<string, unknown>) => string
}

/** Component props: the shell supplies `close`, the plugin supplies the rest. */
export type SubscriptionsSectionProps = Partial<SubscriptionsSectionInjected> & {
  /** Close the settings panel (owned by the settings shell). */
  close?: () => void
}

/** One card's transient message. */
interface CardMessage {
  tone: 'error' | 'success'
  text: string
}

/** Minimal translator used when the locale seat is absent (standalone render). */
function fallbackTranslate(key: SubscriptionsKey, params?: Record<string, unknown>): string {
  const template: string = en[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match)
}

/** Human-readable message for any thrown value. */
function messageOf(error: unknown): string {
  if (error instanceof SubscriptionsRpcError) return error.message
  return error instanceof Error ? error.message : String(error)
}

/** Local time for one epoch-millisecond instant. */
function formatTime(at: number): string {
  try {
    return new Date(at).toLocaleString()
  } catch {
    return String(at)
  }
}

/** How far ahead a reset is still stated as hours rather than a date. */
const RESET_RELATIVE_MS = 24 * 60 * 60 * 1000

/**
 * One allowance reset, in the form a reader acts on.
 *
 * How far off it is decides how it is said: minutes inside the hour, hours inside
 * the day, and the date beyond that — "137 小时后" would be arithmetic rather than
 * information, and a window that comes back in forty minutes is better described in
 * minutes than as "1 小时后". Every route's windows go through here, so all of them
 * read the same way.
 *
 * @param at - epoch milliseconds the window resets.
 * @param t - translator, so the wording follows the page language.
 * @returns the reset text.
 */
function formatReset(
  at: number,
  t: (key: SubscriptionsKey, params?: Record<string, unknown>) => string,
): string {
  const remaining = at - Date.now()
  if (remaining <= 0) return t('usageResetDue')
  if (remaining >= RESET_RELATIVE_MS) return t('usageReset', { time: formatTime(at) })
  // Rounded, and never below one: "0 分钟后重置" would read as a bug rather than as
  // "any moment now".
  if (remaining < 60 * 60 * 1000) {
    return t('usageResetsInMinutes', { minutes: Math.max(1, Math.round(remaining / 60_000)) })
  }
  return t('usageResetsInHours', { hours: Math.max(1, Math.round(remaining / 3_600_000)) })
}

/** Compact token count for a context window. */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${String(Math.round(tokens / 100_000) / 10)}M`
  if (tokens >= 1_000) return `${String(Math.round(tokens / 1_000))}K`
  return String(tokens)
}

/**
 * Routes worth asking for allowances.
 *
 * A route with no account of its own — `auto` — reports itself as signed in so its
 * card reads as usable, but it holds no allowance to read: asking it every minute
 * spends a request to be told nothing. The routes it stands in for are each read
 * on their own.
 *
 * @param providers - the routes in the current status.
 * @returns the route keys to read usage for.
 */
function usageTargets(providers: readonly ProviderStatus[]): string[] {
  return providers
    .filter((provider) => provider.loggedIn && provider.connectable !== false)
    .map((provider) => provider.provider)
}

const styles: Record<string, CSSProperties> = {
  section: {
    display: 'flex', flexDirection: 'column', gap: 12, maxWidth: SECTION_WIDTH,
    color: 'var(--dsw-alias-label-primary)',
  },
  intro: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 14, lineHeight: '22px' },
  card: {
    border: '0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4))',
    borderRadius: 'var(--dsw-radius-xl, 20px)',
    background: 'var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2))',
    padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6,
  },
  cardHeader: { display: 'flex', alignItems: 'center', gap: 8 },
  /** Everything a folded card hides. */
  cardBody: { display: 'flex', flexDirection: 'column', gap: 6 },
  /** The one-line state a folded card shows in place of its body. */
  cardSummary: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  dot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  name: { fontWeight: 500, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' },
  providerId: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-dimmed)' },
  statusLine: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  errorLine: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' },
  successLine: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-success-primary)' },
  actions: { display: 'flex', gap: 8, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' },
  accountRow: {
    display: 'flex', flexDirection: 'column', gap: 6,
    border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-lg, 16px)',
    padding: '8px 10px', marginTop: 4,
  },
  accountHeader: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  starButton: {
    border: 'none', padding: 0, width: 20, background: 'transparent',
    font: 'inherit', fontSize: 14, lineHeight: '20px', cursor: 'pointer',
    color: 'var(--dsw-alias-state-warn-label)',
  },
  accountName: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)', userSelect: 'all' },
  badge: {
    fontSize: 11, lineHeight: '16px', padding: '0 6px', borderRadius: 8,
    background: 'var(--dsw-alias-bg-layer-1)', border: '0.5px solid var(--dsw-alias-border-l2)',
    color: 'var(--dsw-alias-label-secondary)',
  },
  pushRight: { marginLeft: 'auto', flexShrink: 0 },
  catalog: {
    display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4,
    borderTop: '0.5px solid var(--dsw-alias-border-l2)', paddingTop: 8,
  },
  catalogHeader: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  catalogTitle: { fontSize: 12, lineHeight: '18px', fontWeight: 500, color: 'var(--dsw-alias-label-secondary)' },
  catalogMeta: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  /**
   * Button surface geometry lives in the scoped stylesheet; only the layout a
   * rule cannot express stays inline.
   */
  pill: {},
  pillSmall: {},
  /** The catalog heading: a summary-style disclosure, not a bordered control. */
  disclosure: {
    display: 'inline-flex', alignItems: 'center', gap: 4, margin: 0,
  },
  chevron: { fontSize: 10, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  modelList: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 },
  /** One model line: a visibility toggle and the model's own metadata. */
  modelRowGrow: { display: 'flex', alignItems: 'flex-start', gap: 8, flex: '1 1 auto', minWidth: 0 },
  /** The pinned `auto` line: listed, switchable, and never part of its own chain. */
  autoRow: {
    display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer',
    fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)',
  },
  /** The models `auto` will walk, indented under it. */
  chain: {
    display: 'flex', flexDirection: 'column', gap: 3,
    margin: '2px 0 4px 26px', paddingLeft: 8,
    borderLeft: '0.5px solid var(--dsw-alias-border-l2)',
  },
  chainTitle: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' },
  /** The add-a-model-id row: the field, then confirm and cancel. */
  addRow: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 },
  addInput: {},
  /** The remove control on a hand-added row: a bare glyph beside the row. */
  removeButton: { flexShrink: 0, alignSelf: 'center', padding: '0 6px' },
  /** One draggable chain row: the grip, then the remove-from-auto switch. */
  chainRowWrap: { display: 'flex', alignItems: 'center', gap: 4 },
  chainRow: {
    display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', flex: '1 1 auto',
    fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)',
  },
  usage: {
    display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4,
    borderTop: '0.5px solid var(--dsw-alias-border-l2)', paddingTop: 8,
  },
  usageHeader: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  usageRow: { display: 'flex', flexDirection: 'column', gap: 3 },
  usageLine: { display: 'flex', alignItems: 'baseline', gap: 8, justifyContent: 'space-between' },
  usageMeter: {
    height: 6, borderRadius: 999, background: 'var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2))',
    overflow: 'hidden',
  },
  modelRow: {
    display: 'flex', alignItems: 'flex-start', gap: 8,
    cursor: 'pointer', fontSize: 13, lineHeight: '20px',
    color: 'var(--dsw-alias-label-primary)',
  },
  /** A hidden model stays listed and editable, but reads as inactive. */
  modelRowHidden: {
    display: 'flex', alignItems: 'flex-start', gap: 8,
    cursor: 'pointer', fontSize: 13, lineHeight: '20px',
    color: 'var(--dsw-alias-label-dimmed)',
  },
  modelBody: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 },
  modelName: { fontSize: 13, lineHeight: '20px' },
  modelMeta: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)', userSelect: 'all' },
  device: {
    marginTop: 4, display: 'flex', flexDirection: 'column', gap: 6,
    border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-lg, 16px)',
    padding: '10px 12px', background: 'var(--dsw-alias-bg-layer-1)',
  },
  deviceTitle: { fontWeight: 500, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' },
  deviceCode: {
    fontFamily: 'monospace', fontSize: 18, lineHeight: '24px', letterSpacing: 2,
    color: 'var(--dsw-alias-label-primary)', userSelect: 'all',
  },
  details: {
    display: 'flex', flexDirection: 'column', gap: 4,
    fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)',
  },
  detailRow: { display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'baseline' },
  detailValue: { userSelect: 'all', overflowWrap: 'anywhere', textAlign: 'right' },
  /** Dialog layout only: its surface comes from `.dsh-subscription-manager`. */
  modal: {
    width: 440, maxWidth: '100%', maxHeight: '85vh', overflowY: 'auto',
    boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 10,
    padding: '16px 18px', margin: 'auto',
  },
  modalHeader: { display: 'flex', alignItems: 'center', gap: 8 },
  modalTitle: { fontWeight: 500, fontSize: 16, lineHeight: '24px', color: 'var(--dsw-alias-label-primary)' },
  modalActions: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 2 },
  divider: { borderTop: '0.5px solid var(--dsw-alias-border-l2)' },
}

/** Status dot color for one provider's connection state. */
function dotColor(status: ProviderStatus): string {
  if (status.busy) return 'var(--dsw-alias-state-warn-label)'
  if (status.loggedIn) return 'var(--dsw-alias-state-success-primary)'
  return 'var(--dsw-alias-label-dimmed)'
}

/** Localized label for one provider-owned detail row. */
function detailLabel(t: SubscriptionsSectionInjected['t'], row: DetailRow): string {
  const key = `detail_${row.key}` as SubscriptionsKey
  return key in en ? t(key) : row.key
}

/** Localized label for one metered window the provider states. */
function windowLabel(t: SubscriptionsSectionInjected['t'], window: UsageWindow): string {
  const key = `usage_${window.label}` as SubscriptionsKey
  return key in en ? t(key) : window.label
}

/** How much of one window is spent, as a display string. */
function windowAmount(window: UsageWindow): string {
  if (window.usedPercent !== undefined) return `${String(Math.round(window.usedPercent))}%`
  if (window.used !== undefined && window.limit !== undefined) return `${String(window.used)}/${String(window.limit)}`
  return '—'
}

/** One account's plan and metered allowances. */
function UsageBlock(props: {
  usage: readonly ProviderUsage[]
  error?: string
  t: SubscriptionsSectionInjected['t']
  busyAction: boolean
  onRefresh(): void
}) {
  const { usage, error, t, busyAction, onRefresh } = props
  return (
    <div style={styles.usage}>
      <div style={styles.usageHeader}>
        <span style={styles.catalogTitle}>{t('usageTitle')}</span>
        <button
          type="button"
          className="dsh-subscription-quiet"
          style={styles.pushRight}
          disabled={busyAction}
          onClick={onRefresh}
        >
          {busyAction ? t('refreshing') : t('usageRefresh')}
        </button>
      </div>
      {error !== undefined && <p className="dsh-subscription-error">{t('usageError', { message: error })}</p>}
      {usage.length === 0 && error === undefined && <p style={styles.statusLine}>{t('usageNone')}</p>}
      {usage.map((entry) => (
        <div key={entry.account} style={styles.usageRow}>
          <div style={styles.usageLine}>
            <span style={styles.modelMeta}>
              {entry.plan === undefined ? entry.account : t('usagePlan', { plan: entry.plan })}
              {entry.renewsAt === undefined ? '' : ` · ${t('usageRenews', { time: formatTime(entry.renewsAt) })}`}
            </span>
            <span style={styles.modelMeta}>{t('usageFetched', { time: formatTime(entry.fetchedAt) })}</span>
          </div>
          {entry.windows.map((window) => (
            <div key={`${entry.account}-${window.label}`} style={styles.usageRow}>
              <div style={styles.usageLine}>
                <span style={styles.modelName}>
                  {windowLabel(t, window)}
                  {' · '}
                  {windowAmount(window)}
                </span>
                <span style={styles.modelMeta}>
                  {window.resetsAt === undefined ? '' : formatReset(window.resetsAt, t)}
                </span>
              </div>
              {window.usedPercent !== undefined && (
                <div className="dsh-subscription-meter">
                  <span
                    style={{ width: `${String(Math.min(100, Math.max(0, window.usedPercent)))}%` }}
                    data-exhausted={window.usedPercent >= 90 ? 'true' : 'false'}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/** The pending-login block: a device code, or a link to the sign-in page. */
function PendingLogin(props: {
  prompt: LoginPrompt
  t: SubscriptionsSectionInjected['t']
  copied: boolean
  onCopy(code: string): void
}) {
  const { prompt, t, copied, onCopy } = props
  return (
    <div style={styles.device}>
      <span style={styles.deviceTitle}>
        {prompt.mode === 'device-code' ? t('deviceTitle') : t('openLogin')}
      </span>
      <span style={styles.statusLine}>
        {prompt.mode === 'device-code' ? t('devicePrompt') : t('openLoginHint')}
      </span>
      {prompt.userCode !== undefined && <span style={styles.deviceCode}>{prompt.userCode}</span>}
      <span style={styles.statusLine}>{t('deviceExpires', { time: formatTime(prompt.expiresAt) })}</span>
      <div style={styles.actions}>
        <button
          type="button"
          
          onClick={() => { window.open(prompt.url, '_blank', 'noopener') }}
        >
          {prompt.mode === 'device-code' ? t('deviceOpen') : t('openLogin')}
        </button>
        {prompt.userCode !== undefined && (
          <button type="button"  onClick={() => { onCopy(prompt.userCode as string) }}>
            {copied ? t('deviceCopied') : t('deviceCopy')}
          </button>
        )}
      </div>
    </div>
  )
}

/** One provider's card. */
function ProviderCard(props: {
  status: ProviderStatus
  t: SubscriptionsSectionInjected['t']
  busyAction: boolean
  message?: CardMessage
  onLogin(): void
  onCancel(): void
  onLogout(account: string): void
  onSetDefault(account: string): void
  onRefreshToken(account: string): void
  onRefreshModels(): void
  onSetModelVisible(id: string, visible: boolean): void
  /** Persist the chain order the user dropped into place. */
  onSetModelOrder(ids: readonly string[]): void
  /** Publish a model id the catalog does not know yet. */
  onAddModel(id: string): void
  /** Forget a hand-added model id. */
  onRemoveModel(id: string): void
  onRefreshUsage(): void
  onReload(): void
}) {
  const { status, t, busyAction, message } = props
  const [copied, setCopied] = useState(false)
  // Both disclosures open folded, on every visit: the choice is a gesture, not a
  // stored setting. See the note beside the interval constants.
  const [modelsOpen, setModelsOpen] = useState(false)
  /** Whether this provider's whole card is unfolded. */
  const [cardOpen, setCardOpen] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
  const mounted = useRef(true)
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // The dialog is a native modal, so the browser owns focus trapping and Esc.
  useEffect(() => {
    const element = dialog.current
    if (element === null || typeof element.showModal !== 'function') return
    if (manageOpen && !element.open) element.showModal()
    if (!manageOpen && element.open) element.close()
  }, [manageOpen])

  const copyCode = useCallback(async (code: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code)
      if (mounted.current) {
        setCopied(true)
        setTimeout(() => { if (mounted.current) setCopied(false) }, 2000)
      }
    } catch {
      // A clipboard refusal is not worth an error banner: the code is on screen
      // and selectable, which is the fallback the user already has.
    }
  }, [])

  const toggleModelsOpen = useCallback((): void => {
    setModelsOpen((open) => !open)
  }, [])

  /** Fold or unfold this provider's card. */
  const toggleCardOpen = useCallback((): void => {
    setCardOpen((open) => !open)
  }, [])

  const accounts: readonly AccountStatus[] = status.accounts
  const models = status.models
  /** Whether this route signs in at all; the auto provider does not. */
  const connectable = status.connectable !== false
  const hiddenCount = models.filter((model) => !model.visible).length
  /** Whether the add-a-model-id field is open, and what has been typed. */
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  /** The row being dragged, so it can be dimmed while it moves. */
  const [dragFrom, setDragFrom] = useState<number | undefined>(undefined)
  /**
   * The dragged row, mirrored in a ref.
   *
   * The drop is handled by an ancestor whose handler was attached in an earlier
   * render, so it must not depend on state that was set during the drag.
   */
  const dragFromRef = useRef<number | undefined>(undefined)
  /** The row the pointer is currently over, so a drop lands where the user aims. */
  const dropTargetRef = useRef<number | undefined>(undefined)
  /** The same row in state, purely so it can be highlighted while dragging. */
  const [dropTarget, setDropTarget] = useState<number | undefined>(undefined)

  /**
   * Commit one dropped arrangement.
   *
   * The node half takes the full chain in its new order and appends whatever the
   * page left out, so sending just these ids is enough — and a model hidden in
   * another window is never dropped from the stored rank by a stale page.
   */
  const commitOrder = useCallback((ids: readonly string[]): void => {
    props.onSetModelOrder(ids)
  }, [props])

  /** Drag-and-drop plus its keyboard equivalent on the drag handle. */
  const drag = {
    start: (event: React.DragEvent, index: number): void => {
      setDragFrom(index)
      dragFromRef.current = index
      event.dataTransfer.effectAllowed = 'move'
      // Firefox refuses to start a drag without payload.
      event.dataTransfer.setData('text/plain', String(index))
    },
    over: (event: React.DragEvent, _index: number): void => {
      // A drop is only possible on a target that cancels the default.
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      const container = event.currentTarget as HTMLElement
      const to = indexAt(container, event.clientY)
      dropTargetRef.current = to
      if (to !== undefined && to !== dropTarget) setDropTarget(to)
    },
    drop: (event: React.DragEvent, index: number): void => {
      event.preventDefault()
      // The target comes from the last `dragover`, not from this event's own
      // coordinates: `drop` is not guaranteed to carry the pointer position, and a
      // zero there silently collapsed every drop onto the first row.
      const to = dropTargetRef.current ?? indexAt(event.currentTarget as HTMLElement, event.clientY) ?? index
      move(dragFromRef.current, to)
      dragFromRef.current = undefined
      dropTargetRef.current = undefined
      setDropTarget(undefined)
      setDragFrom(undefined)
    },
    /** A drop anywhere in the list lands on the row under the pointer. */
    dropAt: (event: React.DragEvent): void => {
      event.preventDefault()
      const container = event.currentTarget as HTMLElement
      const to = dropTargetRef.current ?? indexAt(container, event.clientY)
      if (to !== undefined) move(dragFromRef.current, to)
      dragFromRef.current = undefined
      dropTargetRef.current = undefined
      setDropTarget(undefined)
      setDragFrom(undefined)
    },
    end: (): void => {
      dragFromRef.current = undefined
      dropTargetRef.current = undefined
      setDropTarget(undefined)
      setDragFrom(undefined)
    },
    key: (event: React.KeyboardEvent, index: number): void => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      event.preventDefault()
      move(index, index + (event.key === 'ArrowUp' ? -1 : 1))
    },
  }

  /** Move one model row to another position and persist the result. */
  function move(from: number | undefined, to: number): void {
    if (from === undefined || from === to) return
    if (from < 0 || to < 0 || from >= models.length || to >= models.length) return
    const ids = models.map((model) => model.id)
    const [moved] = ids.splice(from, 1)
    if (moved === undefined) return
    ids.splice(to, 0, moved)
    commitOrder(ids)
  }

  /**
   * The row index a drop at this pointer position lands on.
   *
   * The drop is handled on the whole list rather than per row: rows are tall and
   * separated by gaps, so a drop between two of them hits no target at all and
   * silently does nothing. Comparing the pointer against each row's midpoint also
   * makes the gesture match what the user sees.
   */
  function indexAt(container: HTMLElement, clientY: number): number | undefined {
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-model-index]'))
    if (rows.length === 0) return undefined
    let closest = 0
    let best = Number.POSITIVE_INFINITY
    for (const row of rows) {
      const box = row.getBoundingClientRect()
      const distance = Math.abs(clientY - (box.top + box.height / 2))
      if (distance >= best) continue
      best = distance
      closest = Number(row.dataset.modelIndex)
    }
    return closest
  }
  const busy = status.busy
  const liveCatalog = (status.discovered?.length ?? 0) > 0
  /**
   * What a folded card says about itself.
   *
   * The connection is the reason to open a card, so the folded row carries it;
   * `auto` has no account and counts the models it will actually try instead.
   */
  const summaryLine = !connectable
    ? t('statusAuto', { count: models.filter((model) => model.visible).length })
    : busy
      ? t('statusBusy')
      : status.loggedIn
        ? t('statusConnected', { count: accounts.length })
        : t('statusSignedOut')

  return (
    <div style={styles.card}>
      {/*
        The header is the disclosure: folded, the page is a list of providers, and
        the whole card is one row with its state and an edit affordance. The
        status dot stays visible either way, so a folded card still reports
        whether the route is signed in.
      */}
      <div style={styles.cardHeader}>
        <span style={{ ...styles.dot, background: dotColor(status) }} aria-hidden="true" />
        <span style={styles.name}>{status.displayName}</span>
        <span style={styles.providerId}>{status.provider}</span>
        {!cardOpen && <span style={styles.cardSummary}>{summaryLine}</span>}
        <button
          type="button"
          className="dsh-subscription-quiet"
          style={styles.pushRight}
          aria-expanded={cardOpen}
          aria-controls={`dsh-subscription-card-${status.provider}`}
          onClick={toggleCardOpen}
        >
          {cardOpen ? t('collapse') : t('edit')}
        </button>
      </div>
      <div
        id={`dsh-subscription-card-${status.provider}`}
        style={cardOpen ? styles.cardBody : { ...styles.cardBody, display: 'none' }}
      >
      <p style={styles.statusLine}>
        {!connectable
          // `auto` has no account: it stands in for the models the other routes
          // signed in for, so it counts the candidates instead.
          ? t('statusAuto', { count: models.filter((model) => model.visible).length })
          : busy
            ? t('statusBusy')
            : status.loggedIn
              ? t('statusConnected', { count: accounts.length })
              : t('statusSignedOut')}
      </p>
      {connectable && !status.loggedIn && !busy && <p style={styles.statusLine}>{t('statusSignIn')}</p>}
      {status.lastError !== undefined && (
        <p className="dsh-subscription-error">{t('lastError', { message: status.lastError })}</p>
      )}
      {message?.tone === 'error' && <p className="dsh-subscription-error">{message.text}</p>}
      {message?.tone === 'success' && <p className="dsh-subscription-success">{message.text}</p>}

      {accounts.map((account) => (
        <div key={account.account} style={styles.accountRow}>
          <div style={styles.accountHeader}>
            <button
              type="button"
              style={styles.starButton}
              title={account.isDefault ? t('defaultBadge') : t('makeDefault')}
              aria-label={account.isDefault ? t('defaultBadge') : t('makeDefault')}
              disabled={busyAction || account.isDefault}
              onClick={() => { props.onSetDefault(account.account) }}
            >
              {account.isDefault ? '★' : '☆'}
            </button>
            <span style={styles.accountName}>{account.label}</span>
            {account.isDefault && <span style={styles.badge}>{t('defaultBadge')}</span>}
            {/* The provider refused this grant: only a new sign-in helps. */}
            {account.needsLogin === true && (
              <span style={styles.badge} title={t('accountNeedsLoginHint')}>{t('accountNeedsLogin')}</span>
            )}
            <span style={styles.statusLine}>
              {account.expired
                ? t('accountExpired')
                : t('accountExpires', { time: formatTime(account.expiresAt) })}
            </span>
            <button
              type="button"
              className="dsh-subscription-quiet"
              style={styles.pushRight}
              disabled={busyAction}
              onClick={() => { props.onLogout(account.account) }}
            >
              {t('logout')}
            </button>
          </div>
        </div>
      ))}

      {/* A signed-out route has nothing to configure here, and listing models it
          cannot call would only invite picker entries that fail. */}
      {status.loggedIn && (
      <div style={styles.catalog}>
        <div style={styles.catalogHeader}>
          <button
            type="button"
            className="dsh-subscription-disclosure"
            style={styles.disclosure}
            aria-expanded={modelsOpen}
            aria-controls={`dsh-subscription-models-${status.provider}`}
            onClick={toggleModelsOpen}
          >
            <span style={styles.chevron} aria-hidden="true">{modelsOpen ? '▾' : '▸'}</span>
            <span style={styles.catalogTitle}>{t('modelsTitle')}</span>
          </button>
          <span style={styles.catalogMeta}>
            {t('modelsCount', { count: models.length })}
            {' · '}
            {liveCatalog ? t('modelsLive') : t('modelsBuiltIn')}
            {hiddenCount === 0 ? '' : ` ${t('modelsHiddenCount', { count: hiddenCount })}`}
          </span>
          <button
            type="button"
            className="dsh-subscription-quiet"
            style={styles.pushRight}
            disabled={busyAction}
            onClick={props.onRefreshModels}
          >
            {busyAction ? t('refreshing') : t('refresh')}
          </button>
          {/* A model the endpoint serves but this build has never heard of: the
              id is published as a plain route, so a new release is usable at once. */}
          <button
            type="button"
            className="dsh-subscription-quiet"
            disabled={busyAction || !connectable}
            title={t('modelsAddHint')}
            onClick={() => { setAdding((open) => !open) }}
          >
            {t('modelsAdd')}
          </button>
        </div>
        {adding && (
          <form
            style={styles.addRow}
            onSubmit={(event) => {
              event.preventDefault()
              const id = draft.trim()
              if (id.length === 0) return
              props.onAddModel(id)
              setDraft('')
              setAdding(false)
            }}
          >
            <input
              type="text"
              className="dsh-subscription-input"
              style={styles.addInput}
              value={draft}
              autoFocus
              spellCheck={false}
              placeholder={t('modelsAddPlaceholder')}
              aria-label={t('modelsAdd')}
              disabled={busyAction}
              onChange={(event) => { setDraft(event.target.value) }}
            />
            <button type="submit" disabled={busyAction || draft.trim().length === 0}>{t('modelsAddConfirm')}</button>
            <button type="button" className="dsh-subscription-quiet" onClick={() => { setAdding(false); setDraft('') }}>
              {t('cancel')}
            </button>
          </form>
        )}
        {modelsOpen && (
          <div
            id={`dsh-subscription-models-${status.provider}`}
            style={styles.modelList}
            // The whole list is the drop target, so a release between two rows still
            // lands somewhere instead of being cancelled unnoticed.
            onDragOver={(event) => { drag.over(event, 0) }}
            onDrop={drag.dropAt}
          >
            {status.provider === 'auto' && <span style={styles.chainTitle}>{t('modelsAutoChain')}</span>}
            {/* Every provider lists its models the same way: a switch in front,
                the model's own metadata, and a grip to drag it in the order both
                the picker list and Auto's fallback follow. */}
            {models.map((model, index) => (
              <div
                key={model.id}
                data-model-index={index}
                draggable={!busyAction}
                style={{
                  ...styles.modelRowWrap,
                  ...dragFrom === index ? { opacity: 0.5 } : {},
                  // The row a drop would land on, so the gesture is visible while it
                  // happens rather than only in its result.
                  ...dropTarget === index && dragFrom !== undefined && dragFrom !== index
                    ? { boxShadow: 'inset 0 2px 0 0 var(--dsw-alias-brand-primary)' }
                    : {},
                }}
                onDragStart={(event) => { drag.start(event, index) }}
                onDragEnd={drag.end}
              >
                {/* The grip is the affordance and the keyboard path; the drag
                    itself starts on the row, because a <button> does not start an
                    HTML5 drag reliably in Chromium. */}
                <button
                  type="button"
                  className="dsh-subscription-handle"
                  disabled={busyAction}
                  title={t('modelsDrag')}
                  aria-label={`${t('modelsDrag')} · ${model.name}`}
                  onKeyDown={(event) => { drag.key(event, index) }}
                >
                  ⠿
                </button>
                <label
                  style={model.visible
                    ? { ...styles.modelRowGrow, cursor: 'pointer' }
                    : { ...styles.modelRowGrow, cursor: 'pointer', color: 'var(--dsw-alias-label-dimmed)' }}
                  title={model.visible ? t('modelsHidden') : t('modelsShow')}
                >
                  <input
                    type="checkbox"
                    className="dsh-subscription-switch"
                    role="switch"
                    checked={model.visible}
                    disabled={busyAction}
                    aria-label={`${t('modelsShow')} · ${model.name}`}
                    onChange={(event) => { props.onSetModelVisible(model.id, event.target.checked) }}
                  />
                  <span style={styles.modelBody}>
                    <span style={styles.modelName}>
                      {model.name}
                      {model.source === undefined ? null : <span style={styles.badge}>{model.source}</span>}
                    </span>
                    <span style={styles.modelMeta}>
                      {model.id}
                      {' · '}
                      {t('modelsContext', { tokens: formatTokens(model.contextWindow) })}
                      {model.defaultEffort === undefined ? '' : ` · ${model.defaultEffort}`}
                      {model.inputModalities === undefined || model.inputModalities.length === 0
                        ? ''
                        : ` · ${model.inputModalities.join('/')}`}
                    </span>
                  </span>
                </label>
                {/* A hand-added id can be removed again, so a typo does not linger. */}
                {model.userAdded === true && (
                  <button
                    type="button"
                    className="dsh-subscription-quiet"
                    style={styles.removeButton}
                    disabled={busyAction}
                    title={t('modelsRemove')}
                    aria-label={`${t('modelsRemove')} · ${model.name}`}
                    onClick={() => { props.onRemoveModel(model.id) }}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            {models.length === 0 && (
              <p style={styles.statusLine}>
                {status.provider === 'auto' ? t('modelsAutoChainEmpty') : t('modelsEmpty')}
              </p>
            )}
          </div>
        )}
      </div>
      )}

      <UsageBlock
        usage={status.usage ?? []}
        {...status.usageError === undefined ? {} : { error: status.usageError }}
        t={t}
        busyAction={busyAction}
        onRefresh={props.onRefreshUsage}
      />

      {/* `auto` owns no account, so it offers no connect, cancel or manage. */}
      {connectable && (
        <div style={styles.actions}>
          {!busy && (
            <button type="button" disabled={busyAction} onClick={props.onLogin}>
              {accounts.length === 0 ? t('connect') : t('addAccount')}
            </button>
          )}
          {!busy && (
            <button type="button" disabled={busyAction} onClick={() => { setManageOpen(true) }}>
              {t('manage')}
            </button>
          )}
          {busy && (
            <button type="button" disabled={busyAction} onClick={props.onCancel}>
              {t('cancel')}
            </button>
          )}
        </div>
      )}
      {connectable && accounts.length > 0 && <p style={styles.statusLine}>{t('hint')}</p>}

      {busy && status.pending !== undefined && (
        <PendingLogin prompt={status.pending} t={t} copied={copied} onCopy={(code) => { void copyCode(code) }} />
      )}
      </div>
      {/* The dialog stays outside the collapsible body: a hidden ancestor would
          keep it out of the top layer even after `showModal()`. */}
      <dialog
        ref={dialog}
        className="dsh-subscription-manager"
        aria-labelledby={`dsh-subscription-manage-${status.provider}`}
        // A closed `<dialog>` is hidden by the user-agent stylesheet, and an
        // inline `display` would override that rule — so the open state has to
        // be restated here rather than left to `showModal()` alone.
        style={manageOpen ? styles.modal : { ...styles.modal, display: 'none' }}
        onClose={() => { setManageOpen(false) }}
        onCancel={() => { setManageOpen(false) }}
      >
        <div style={styles.modalHeader}>
          <span style={styles.modalTitle} id={`dsh-subscription-manage-${status.provider}`}>
            {t('manageTitle', { provider: status.displayName })}
          </span>
        </div>

        <span style={styles.statusLine}>{t('manageAccounts')}</span>
        {accounts.map((account) => (
          <div key={account.account} style={styles.accountRow}>
            <div style={styles.accountHeader}>
              <span style={styles.accountName}>{account.label}</span>
              {account.isDefault && <span style={styles.badge}>{t('defaultBadge')}</span>}
            </div>
            <div style={styles.actions}>
              <button
                type="button"
                
                disabled={busyAction}
                onClick={() => { props.onRefreshToken(account.account) }}
              >
                {t('refreshToken')}
              </button>
              {!account.isDefault && (
                <button
                  type="button"
                  
                  disabled={busyAction}
                  onClick={() => { props.onSetDefault(account.account) }}
                >
                  {t('makeDefault')}
                </button>
              )}
              <button
                type="button"
                
                disabled={busyAction}
                onClick={() => { props.onLogout(account.account) }}
              >
                {t('logout')}
              </button>
            </div>
          </div>
        ))}
        {accounts.length === 0 && <p style={styles.statusLine}>{t('statusSignedOut')}</p>}

        <div style={styles.divider} />
        <div style={styles.actions}>
          <button type="button"  disabled={busyAction} onClick={props.onReload}>
            {t('reload')}
          </button>
        </div>
        <p style={styles.statusLine}>{t('reloadHint')}</p>

        <div style={styles.divider} />
        <div style={styles.details}>
          {status.details.map((row) => (
            <div key={row.key} style={styles.detailRow}>
              <span>{detailLabel(t, row)}</span>
              <span style={styles.detailValue}>{row.value}</span>
            </div>
          ))}
          {status.discovered !== undefined && status.discovered.length > 0 && (
            <div style={styles.detailRow}>
              <span>{t('modelsLive')}</span>
              <span style={styles.detailValue}>{status.discovered.join(', ')}</span>
            </div>
          )}
        </div>

        <div className="dsh-subscription-dialog-actions" style={styles.modalActions}>
          <button type="button" onClick={() => { setManageOpen(false) }}>{t('close')}</button>
        </div>
      </dialog>
    </div>
  )
}

/**
 * The Subscriptions settings section.
 * @param props - section props (inject face plus the shell's `close`).
 * @returns the section content.
 */
export function SubscriptionsSection(props: SubscriptionsSectionProps) {
  const { call } = props
  const t = props.t ?? fallbackTranslate
  const [status, setStatus] = useState<SubscriptionStatus | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [messages, setMessages] = useState<Record<string, CardMessage>>({})
  const [busyAction, setBusyAction] = useState(false)
  const mounted = useRef(true)
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  /** Fetch the current state; a failure is shown rather than swallowed. */
  const refresh = useCallback(async (): Promise<void> => {
    if (call === undefined) return
    try {
      const next = await call('status', undefined)
      if (!mounted.current) return
      setStatus(next)
      setError(undefined)
    } catch (caught: unknown) {
      if (mounted.current) setError(t('actionFailed', { message: messageOf(caught) }))
    }
  }, [call, t])

  const stopPolling = useCallback((): void => {
    if (timer.current !== undefined) {
      clearInterval(timer.current)
      timer.current = undefined
    }
  }, [])

  const startPolling = useCallback((): void => {
    if (timer.current !== undefined) return
    // The node half clears `busy` once the attempt settles; the effect below
    // observes that and stops this interval.
    timer.current = setInterval(() => { void refresh() }, POLL_INTERVAL_MS)
  }, [refresh])

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
      stopPolling()
    }
  }, [refresh, stopPolling])

  /** Every route worth reading, as of the latest render, for the usage poll. */
  const signedInRef = useRef<readonly string[]>([])
  useEffect(() => {
    signedInRef.current = usageTargets(status?.providers ?? [])
  })

  /**
   * Read each named route's plan and allowance, applying every answer.
   *
   * A read is not forced: the node half reuses a figure only for a few seconds and
   * never reuses a substitute, so a steady interval refreshes the figures while
   * collapsing bursts into one request per route.
   */
  const readUsage = useCallback(async (providers: readonly string[]): Promise<void> => {
    if (call === undefined) return
    for (const provider of providers) {
      try {
        const result = await call('usage', { provider })
        if (!mounted.current) return
        setStatus(result.status)
      } catch {
        // An unreadable quota is already surfaced inside the card by the status it
        // carries; the page itself stays usable.
      }
    }
  }, [call])

  // The figures are read as soon as the first status lands...
  const usageRequested = useRef(false)
  useEffect(() => {
    if (call === undefined || status === undefined || usageRequested.current) return
    const signedIn = usageTargets(status.providers)
    if (signedIn.length === 0) return
    usageRequested.current = true
    void readUsage(signedIn)
  }, [call, status, readUsage])

  // ...and then kept current while the page is open. Allowances move as the account
  // is used, so a figure that is only read on mount reports the state of a page that
  // may have been open for hours.
  useEffect(() => {
    if (call === undefined) return
    const tick = (): void => {
      // Nothing is refreshed for a page nobody is looking at.
      if (globalThis.document?.visibilityState === 'hidden') return
      void readUsage(signedInRef.current)
    }
    const interval = setInterval(tick, USAGE_POLL_INTERVAL_MS)
    return () => { clearInterval(interval) }
  }, [call, readUsage])

  // Poll only while some provider is waiting for browser approval.
  const anyBusy = status?.providers.some((provider) => provider.busy) === true
  useEffect(() => {
    if (anyBusy) startPolling()
    else stopPolling()
  }, [anyBusy, startPolling, stopPolling])

  /** Run one action for one provider, reporting its own failure. */
  const act = useCallback(async (provider: string, run: () => Promise<void>): Promise<void> => {
    setBusyAction(true)
    setMessages((current) => {
      const next = { ...current }
      delete next[provider]
      return next
    })
    try {
      await run()
    } catch (caught: unknown) {
      if (mounted.current) {
        setMessages((current) => ({ ...current, [provider]: { tone: 'error', text: t('actionFailed', { message: messageOf(caught) }) } }))
      }
    } finally {
      if (mounted.current) setBusyAction(false)
    }
  }, [t])

  const login = useCallback((provider: string): void => {
    if (call === undefined) return
    void act(provider, async () => {
      const started = await call('login', { provider })
      if (!mounted.current) return
      setStatus(started.status)
      // A loopback flow wants the browser opened; a blocked popup still leaves
      // the link in the card, which is the fallback the user already has.
      if (started.prompt.mode === 'open-url') {
        window.open(started.prompt.url, '_blank', 'noopener')
      }
    })
  }, [act, call])

  const cancel = useCallback((provider: string): void => {
    if (call === undefined) return
    void act(provider, async () => {
      const next = await call('cancel', { provider })
      if (mounted.current) setStatus(next)
    })
  }, [act, call])

  const logout = useCallback((provider: string, account: string): void => {
    if (call === undefined) return
    void act(provider, async () => {
      const next = await call('logout', { provider, account })
      if (mounted.current) setStatus(next)
    })
  }, [act, call])

  const setDefault = useCallback((provider: string, account: string): void => {
    if (call === undefined) return
    void act(provider, async () => {
      const next = await call('setDefault', { provider, account })
      if (mounted.current) setStatus(next)
    })
  }, [act, call])

  const refreshToken = useCallback((provider: string, account: string): void => {
    if (call === undefined) return
    void act(provider, async () => {
      const result = await call('refresh', { provider, account })
      if (!mounted.current) return
      setStatus(result.status)
      setMessages((current) => ({
        ...current,
        [provider]: { tone: 'success', text: t('tokenRefreshed', { time: formatTime(result.expiresAt) }) },
      }))
    })
  }, [act, call, t])

  const refreshModels = useCallback((provider: string): void => {
    if (call === undefined) return
    void act(provider, async () => {
      const next = await call('discover', { provider, force: true })
      if (!mounted.current) return
      setStatus(next)
      setMessages((current) => ({ ...current, [provider]: { tone: 'success', text: t('modelsRefreshed') } }))
    })
  }, [act, call, t])

  const setModelVisible = useCallback((provider: string, id: string, visible: boolean): void => {
    if (call === undefined) return
    void act(provider, async () => {
      const next = await call('setModelVisible', { provider, id, visible })
      if (mounted.current) setStatus(next)
    })
  }, [act, call])

  const refreshUsage = useCallback((provider: string): void => {
    if (call === undefined) return
    void act(provider, async () => {
      const result = await call('usage', { provider, force: true })
      if (mounted.current) setStatus(result.status)
    })
  }, [act, call])

  const setModelOrder = useCallback((provider: string, ids: readonly string[]): void => {
    if (call === undefined) return
    void act(provider, async () => {
      const next = await call('setModelOrder', { provider, ids: [...ids] })
      if (mounted.current) setStatus(next)
    })
  }, [act, call])

  const addModel = useCallback((provider: string, id: string): void => {
    if (call === undefined) return
    void act(provider, async () => {
      const next = await call('addModel', { provider, id })
      if (mounted.current) setStatus(next)
    })
  }, [act, call])

  const removeModel = useCallback((provider: string, id: string): void => {
    if (call === undefined) return
    void act(provider, async () => {
      const next = await call('removeModel', { provider, id })
      if (mounted.current) setStatus(next)
    })
  }, [act, call])

  const reload = useCallback((provider: string): void => {
    if (call === undefined) return
    void act(provider, async () => {
      const next = await call('reload', undefined)
      if (mounted.current) setStatus(next)
    })
  }, [act, call])

  if (call === undefined) return <p style={styles.intro}>{t('unavailable')}</p>

  return (
    <div className="dsh-subscriptions-settings" style={styles.section}>
      <style>{subscriptionsCss}</style>
      <p style={styles.intro}>{t('intro')}</p>
      {error !== undefined && <p className="dsh-subscription-error">{error}</p>}
      {status === undefined && <p style={styles.statusLine}>{t('loading')}</p>}
      {status?.providers.map((provider) => (
        <ProviderCard
          key={provider.provider}
          status={provider}
          t={t}
          busyAction={busyAction}
          {...messages[provider.provider] === undefined ? {} : { message: messages[provider.provider] as CardMessage }}
          onLogin={() => { login(provider.provider) }}
          onCancel={() => { cancel(provider.provider) }}
          onLogout={(account) => { logout(provider.provider, account) }}
          onSetDefault={(account) => { setDefault(provider.provider, account) }}
          onRefreshToken={(account) => { refreshToken(provider.provider, account) }}
          onRefreshModels={() => { refreshModels(provider.provider) }}
          onSetModelVisible={(id, visible) => { setModelVisible(provider.provider, id, visible) }}
          onSetModelOrder={(ids) => { setModelOrder(provider.provider, ids) }}
          onAddModel={(id) => { addModel(provider.provider, id) }}
          onRemoveModel={(id) => { removeModel(provider.provider, id) }}
          onRefreshUsage={() => { refreshUsage(provider.provider) }}
          onReload={() => { reload(provider.provider) }}
        />
      ))}
    </div>
  )
}

/**
 * Throwaway preview entry: mounts the real Subscriptions section with a stubbed
 * RPC caller so the page can be screenshotted without a running host.
 *
 * Query flags: `?grok=1` signs Grok in too, `?busy=1` shows a pending device
 * code, `?hide=1` hides one Kimi model, `?collapse=1` folds a catalog,
 * `?manage=1` opens the first manage dialog.
 */
import { createRoot } from 'react-dom/client'
import { StrictMode } from 'react'

import { SubscriptionsSection } from '../src/client/SubscriptionsSection.js'
import type { SubscriptionsSectionInjected } from '../src/client/SubscriptionsSection.js'
import { UsageChip } from '../src/client/UsageChip.js'
import type { UsageChipInjected } from '../src/client/UsageChip.js'
import { zh } from '../src/client/locales.js'
import type { SubscriptionsKey } from '../src/client/locales.js'
import type { ProviderStatus, SubscriptionStatus } from '../src/protocol.js'

const params = new URLSearchParams(location.search)

/** Translate a key, applying `{name}` placeholders the way the locale service does. */
function t(key: SubscriptionsKey, values?: Record<string, unknown>): string {
  const template: string = zh[key]
  if (values === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match)
}

const kimiExpiry = Date.now() + 21 * 24 * 60 * 60 * 1000

/** The Kimi card, as a signed-in account with a live catalog would render it. */
function kimiStatus(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    provider: 'kimi',
    displayName: 'Kimi Code',
    codeUrl: 'https://www.kimi.com/code',
    loggedIn: true,
    busy: false,
    accounts: [{
      account: 'kimi-user-1',
      label: 'someone@example.com',
      expiresAt: kimiExpiry,
      expired: false,
      isDefault: true,
    }],
    activeAccount: 'kimi-user-1',
    credentialFile: '~/.dsh/plugins/kimi-oauth/auth.json',
    discovery: true,
    discovered: ['kimi-for-coding', 'k3', 'k3-256k'],
    models: [
      { id: 'kimi-for-coding', name: 'Kimi for Coding', contextWindow: 1_048_576, defaultEffort: 'max', inputModalities: ['text', 'image'], visible: true },
      { id: 'k3', name: 'Kimi K3', contextWindow: 262_144, defaultEffort: 'max', inputModalities: ['text', 'image'], visible: true },
      { id: 'k3[1m]', name: 'Kimi K3 (1M)', contextWindow: 1_048_576, defaultEffort: 'max', inputModalities: ['text', 'image'], visible: true },
      { id: 'k3-256k', name: 'Kimi K3 (256K)', contextWindow: 262_144, defaultEffort: 'max', inputModalities: ['text', 'image'], visible: true },
      { id: 'k3-next', name: 'k3-next', description: 'Added by hand in Settings', contextWindow: 262_144, visible: true, userAdded: true },
    ],
    defaultModel: 'kimi-for-coding',
    usage: [{
      account: 'kimi-user-1',
      plan: 'Kimi Code Pro',
      windows: [
        // Under the hour, so the harness shows the minutes form the page uses.
      { label: '5h', usedPercent: 34, resetsAt: Date.now() + 40 * 60 * 1000 },
        { label: 'weekly', usedPercent: 71, resetsAt: Date.now() + 4 * 24 * 60 * 60 * 1000 },
      ],
      fetchedAt: Date.now() - 40_000,
    }],
    details: [
      { key: 'oauthHost', value: 'https://auth.kimi.com' },
      { key: 'apiBase', value: 'https://api.kimi.com/coding/v1' },
      { key: 'credentialFile', value: '~/.dsh/plugins/kimi-oauth/auth.json' },
    ],
    ...overrides,
  }
}

/** The Grok card: signed in when `?grok=1`, otherwise not. */
function grokStatus(): ProviderStatus {
  const connected = params.get('grok') === '1'
  return {
    provider: 'grok',
    displayName: 'Grok (X Premium)',
    codeUrl: 'https://x.ai/grok',
    loggedIn: connected,
    busy: false,
    accounts: connected
      ? [{ account: 'xai-1', label: 'someone@example.com', expiresAt: kimiExpiry, expired: false, isDefault: true }]
      : [],
    ...connected ? { activeAccount: 'xai-1' } : {},
    credentialFile: '~/.dsh/plugins/kimi-oauth/auth.json',
    discovery: true,
    discovered: ['grok-4.6', 'grok-4.5', 'grok-4-1-fast-reasoning'],
    models: [
      { id: 'grok-4.6', name: 'Grok 4.6', contextWindow: 256_000, inputModalities: ['text', 'image'], visible: true },
      { id: 'grok-4.5', name: 'Grok 4.5', contextWindow: 256_000, inputModalities: ['text', 'image'], visible: true },
      { id: 'grok-4-1-fast-reasoning', name: 'grok-4-1-fast-reasoning', contextWindow: 2_000_000, reasoningEfforts: ['low', 'high'], defaultEffort: 'high', inputModalities: ['text', 'image'], visible: true },
    ],
    defaultModel: 'grok-4.6',
    ...connected ? {
      usage: [{
        account: 'xai-1',
        plan: 'SuperGrok',
        windows: [{ label: 'weekly', usedPercent: 62, resetsAt: Date.now() + 2 * 24 * 60 * 60 * 1000 }],
        fetchedAt: Date.now() - 90_000,
      }],
    } : {},
    details: [
      { key: 'oauthHost', value: 'https://auth.x.ai' },
      { key: 'apiBase', value: 'https://api.x.ai/v1' },
      { key: 'credentialFile', value: '~/.dsh/plugins/kimi-oauth/auth.json' },
    ],
  }
}

/** The Antigravity card: signed in when `?ag=1`. */
function antigravityStatus(): ProviderStatus {
  const connected = params.get('ag') === '1'
  return {
    provider: 'antigravity',
    displayName: 'Google Antigravity',
    codeUrl: 'https://antigravity.google',
    loggedIn: connected,
    busy: false,
    accounts: connected
      ? [{ account: 'someone@example.com', label: 'someone@example.com', expiresAt: kimiExpiry, expired: false, isDefault: true }]
      : [],
    ...connected ? { activeAccount: 'someone@example.com' } : {},
    credentialFile: '~/.dsh/plugins/kimi-oauth/auth.json',
    discovery: true,
    discovered: ['gemini-3-pro', 'claude-sonnet-4'],
    models: [
      { id: 'gemini-3-pro', name: 'Gemini 3 Pro', contextWindow: 1_048_576, inputModalities: ['text', 'image', 'pdf'], visible: true },
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', contextWindow: 200_000, defaultEffort: 'high', inputModalities: ['text', 'image'], visible: true },
    ],
    ...connected ? {
      usage: [{
        account: 'someone@example.com',
        plan: 'Antigravity Pro',
        windows: [
          { label: 'gemini', usedPercent: 75, resetsAt: Date.now() + 6 * 60 * 60 * 1000 },
          { label: 'gemini_weekly', usedPercent: 41, resetsAt: Date.now() + 4 * 24 * 60 * 60 * 1000 },
          { label: 'claude', usedPercent: 0, resetsAt: Date.now() + 5 * 60 * 60 * 1000 },
          { label: 'claude_weekly', usedPercent: 18, resetsAt: Date.now() + 4 * 24 * 60 * 60 * 1000 },
        ],
        fetchedAt: Date.now() - 20_000,
      }],
    } : {},
    details: [
      { key: 'oauthHost', value: 'https://accounts.google.com' },
      { key: 'apiBase', value: 'https://daily-cloudcode-pa.googleapis.com' },
      { key: 'credentialFile', value: '~/.dsh/plugins/kimi-oauth/auth.json' },
    ],
  }
}

/** The GLM card: BigModel's coding plan, signed in the way ZCode does. */
function glmStatus(): ProviderStatus {
  return {
    provider: 'glm',
    displayName: 'GLM (BigModel)',
    codeUrl: 'https://bigmodel.cn/coding-plan/personal/overview',
    loggedIn: true,
    busy: false,
    accounts: [
      { account: 'someone@example.com', label: 'someone@example.com', expiresAt: kimiExpiry, expired: false, isDefault: true },
    ],
    credentialFile: '~/.dsh/plugins/kimi-oauth/auth.json',
    discovery: true,
    discovered: ['glm-5.3', 'glm-5.3-flash', 'glm-5.2'],
    models: [
      { id: 'glm-5.3', name: 'GLM-5.3', description: 'Coding plan flagship, text only', contextWindow: 1_048_576, inputModalities: ['text'], defaultEffort: 'high', visible: true },
      { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', description: 'Fast, reads images', contextWindow: 1_048_576, inputModalities: ['text', 'image'], visible: true },
      { id: 'glm-5.2', name: 'GLM-5.2', description: 'Previous flagship', contextWindow: 1_048_576, inputModalities: ['text'], visible: true },
    ],
    usage: [{
      account: 'someone@example.com',
      plan: 'GLM Coding Plan',
      windows: [
        { label: '5h', usedPercent: 27, resetsAt: Date.now() + 4 * 60 * 60 * 1000 },
        { label: 'weekly', usedPercent: 9, resetsAt: Date.now() + 5 * 24 * 60 * 60 * 1000 },
      ],
      fetchedAt: Date.now() - 12_000,
    }],
    details: [
      { key: 'apiBase', value: 'https://open.bigmodel.cn/api/coding/paas/v4' },
      { key: 'oauthBroker', value: 'https://zcode.z.ai' },
      { key: 'credentialFile', value: '~/.dsh/plugins/kimi-oauth/auth.json' },
    ],
  }
}

/** The Auto card: one model that stands in for every other route's models. */
function autoStatus(): ProviderStatus {
  return {
    provider: 'auto',
    displayName: 'Auto',
    loggedIn: true,
    connectable: false,
    busy: false,
    accounts: [],
    credentialFile: '—',
    discovery: true,
    models: [
      // Auto spans the whole harness roster, so a built-in provider's model sits in
      // the same list as this plugin's own routes.
      { id: 'deepseek/deepseek-v4', name: 'DeepSeek V4', description: 'deepseek · deepseek-v4', contextWindow: 131_072, visible: true, source: 'deepseek' },
      { id: 'kimi/kimi-for-coding', name: 'Kimi for Coding', description: 'kimi · kimi-for-coding', contextWindow: 1_048_576, visible: true, source: 'kimi' },
      { id: 'grok/grok-4.6', name: 'Grok 4.6', description: 'grok · grok-4.6', contextWindow: 256_000, visible: true, source: 'grok' },
      { id: 'antigravity/gemini-3-pro', name: 'Gemini 3 Pro', description: 'antigravity · gemini-3-pro', contextWindow: 1_048_576, visible: true, source: 'antigravity' },
      { id: 'antigravity/claude-sonnet-4', name: 'Claude Sonnet 4', description: 'antigravity · claude-sonnet-4', contextWindow: 200_000, visible: false, source: 'antigravity' },
    ],
    details: [],
  }
}

/** The page state every call answers with. */
function currentStatus(): SubscriptionStatus {
  if (params.get('busy') === '1') {
    return {
      providers: [
        kimiStatus({
          busy: true,
          pending: {
            url: 'https://www.kimi.com/code/authorize_device',
            userCode: 'WDJB-MJHT',
            expiresAt: Date.now() + 25 * 60 * 1000,
            mode: 'device-code',
          },
        }),
        grokStatus(),
        antigravityStatus(),
        autoStatus(),
      ],
    }
  }
  // The order the node half serves: `auto` leads the page.
  const providers = [autoStatus(), kimiStatus(), grokStatus(), antigravityStatus(), glmStatus()]
  if (params.get('hide') === '1') {
    const kimi = providers[1]
    if (kimi !== undefined) {
      providers[1] = {
        ...kimi,
        models: kimi.models.map((model) => model.id === 'k3[1m]' ? { ...model, visible: false } : model),
      }
    }
  }
  return { providers }
}

const call = (async (endpoint: string, payload?: unknown) => {
  if (endpoint === 'setModelOrder') {
    const move = payload as { provider: string, ids: readonly string[] }
    const status = currentStatus()
    return {
      providers: status.providers.map((provider) => {
        if (provider.provider !== move.provider) return provider
        const byId = new Map(provider.models.map((model) => [model.id, model]))
        const ordered = move.ids.flatMap((id) => {
          const model = byId.get(id)
          return model === undefined ? [] : [model]
        })
        const rest = provider.models.filter((model) => model.pinned !== true && !move.ids.includes(model.id))
        const auto = provider.models.filter((model) => model.pinned === true)
        return { ...provider, models: [...auto, ...ordered, ...rest] }
      }),
    }
  }
  if (endpoint === 'setModelVisible') {
    const change = payload as { provider: string, id: string, visible: boolean }
    const status = currentStatus()
    return {
      providers: status.providers.map((provider) => provider.provider === change.provider
        ? { ...provider, models: provider.models.map((model) => model.id === change.id ? { ...model, visible: change.visible } : model) }
        : provider),
    }
  }
  if (endpoint === 'moveModel') {
    const move = payload as { provider: string, id: string, direction: 'up' | 'down' }
    const status = currentStatus()
    return {
      providers: status.providers.map((provider) => {
        if (provider.provider !== move.provider) return provider
        const models = [...provider.models]
        const from = models.findIndex((model) => model.id === move.id)
        // `auto` is pinned, so the movable range starts at index 1.
        const to = move.direction === 'up' ? from - 1 : from + 1
        if (from < 1 || to < 1 || to >= models.length) return provider
        const moved = models[from]
        const other = models[to]
        if (moved === undefined || other === undefined) return provider
        models[from] = other
        models[to] = moved
        return { ...provider, models }
      }),
    }
  }
  if (endpoint === 'usage') {
    const provider = (payload as { provider: string }).provider
    // Counted so the harness can prove the page re-reads on its own cadence.
    const seen = (globalThis as { __usageCalls?: string[] }).__usageCalls ?? []
    seen.push(provider)
    ;(globalThis as { __usageCalls?: string[] }).__usageCalls = seen
    const status = currentStatus()
    return {
      provider,
      usage: (status.providers.find((entry) => entry.provider === provider)?.usage ?? []).map((entry) => ({
        ...entry,
        fetchedAt: Date.now(),
      })),
      status,
    }
  }
  if (endpoint === 'login') {
    const provider = (payload as { provider: string }).provider
    const status = currentStatus()
    return {
      prompt: provider === 'kimi'
        ? { url: 'https://www.kimi.com/code/authorize_device', userCode: 'WDJB-MJHT', expiresAt: Date.now() + 25 * 60 * 1000, mode: 'device-code' as const }
        : { url: 'https://auth.x.ai/oauth2/authorize?client_id=…', expiresAt: Date.now() + 3 * 60 * 1000, mode: 'open-url' as const },
      status,
    }
  }
  return currentStatus()
}) as SubscriptionsSectionInjected['call']

const container = document.getElementById('root')
if (container === null) throw new Error('preview root is missing')

// `?chip=<provider>` mounts the composer usage chip in a row that mimics the real bar:
// the shell's pills, then the slot's entries, then the context meter — which is the
// sibling order the shell renders. A report element records the measured positions so
// the layout can be asserted rather than eyeballed.
const chipProvider = params.get('chip')
if (chipProvider !== null) {
  createRoot(container).render(
    <StrictMode>
      <div
        id="bar"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, width: 860, maxWidth: '100%', paddingTop: 4 }}
      >
        <span style={{ fontSize: 12, color: '#8a8f98' }}>241 tok/s</span>
        <span style={{ fontSize: 12, color: '#8a8f98' }}>缓存命中 96%</span>
        <UsageChip
          call={call}
          t={t as unknown as UsageChipInjected['t']}
          isOwnProvider={() => true}
          // Stands in for the session standard kit's projection reader, answering the one
          // key the chip reads.
          useProjection={(key, selector) => selector(
            key === 'modelSelection'
              ? { next: { provider: chipProvider, model: 'demo' }, lastUsed: null }
              : undefined,
          )}
        />
        <span id="meter" style={{ fontSize: 12, color: '#8a8f98' }}>16%</span>
      </div>
      <pre id="report" />
    </StrictMode>,
  )
  setTimeout(() => {
    const chip = document.querySelector('.dsh-subscription-usage-chip')
    const meter = document.getElementById('meter')
    const bar = document.getElementById('bar')
    const report = document.getElementById('report')
    if (chip === null || meter === null || bar === null || report === null) return
    const c = chip.getBoundingClientRect()
    const m = meter.getBoundingClientRect()
    const b = bar.getBoundingClientRect()
    const trigger = chip.querySelector('.dsh-subscription-usage-chip-trigger')
    // Open the detail, then report both the compact line and the meters it draws, so an
    // unspent window's track can be checked the same way as the settings page's.
    if (trigger instanceof HTMLElement) trigger.click()
    setTimeout(() => {
      const tracks = [...document.querySelectorAll('.dsh-subscription-usage-chip-track')].map((track) => {
        const style = getComputedStyle(track)
        const fill = track.firstElementChild
        return {
          fillWidth: Math.round(fill === null ? 0 : Number.parseFloat(getComputedStyle(fill).width)),
          trackPainted: style.backgroundColor !== 'rgba(0, 0, 0, 0)' || style.boxShadow !== 'none',
        }
      })
      report.textContent = JSON.stringify({
        chipText: (trigger?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        chipIsRightOfMeter: c.left >= m.right,
        chipGapFromMeter: Math.round(c.left - m.right),
        tracks,
      })
    }, 250)
  }, 600)
} else {
  createRoot(container).render(
    <StrictMode>
      <SubscriptionsSection call={call} t={t} />
    </StrictMode>,
  )
}

// Drive the states a screenshot has to show. Each is a user action, so it is
// replayed as a click on the real control.
function clickByText(label: string): void {
  for (const button of document.querySelectorAll('button')) {
    if (button.textContent?.trim() === label) {
      button.click()
      return
    }
  }
}

setTimeout(() => {
  if (params.get('hide') === '1') {
    const boxes = document.querySelectorAll('input[type="checkbox"]')
    const target = boxes[2]
    if (target instanceof HTMLInputElement) target.click()
  }
  if (params.get('collapse') === '1') {
    const disclosure = document.querySelector('[aria-controls="dsh-subscription-models-kimi"]')
    if (disclosure instanceof HTMLElement) disclosure.click()
  }
  if (params.get('manage') === '1') clickByText('管理')
}, 60)

// `?meters=1` reports every usage meter the page drew, so "the empty one is missing" can
// be checked against measurements rather than a picture. `painted` is whether anything
// inside the meter actually covers pixels: a 0 % fill covers none, so the track itself has
// to be visible.
if (params.get('meters') === '1') {
  setTimeout(() => {
    const report = document.getElementById('report') ?? document.body.appendChild(document.createElement('pre'))
    report.id = 'report'
    const meters = [...document.querySelectorAll('.dsh-subscription-meter')].map((meter) => {
      const track = getComputedStyle(meter)
      const fill = meter.firstElementChild
      const fillWidth = fill === null ? 0 : Number.parseFloat(getComputedStyle(fill).width)
      const row = meter.previousElementSibling?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
      return {
        row,
        trackBackground: track.backgroundColor,
        trackShadow: track.boxShadow === 'none' ? 'none' : 'ring',
        fillWidth: Math.round(fillWidth),
        trackPainted: track.backgroundColor !== 'rgba(0, 0, 0, 0)' || track.boxShadow !== 'none',
      }
    })
    report.textContent = JSON.stringify(meters, null, 1)
  }, 700)
}

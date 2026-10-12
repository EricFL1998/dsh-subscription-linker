// One-off: the preview fixture still listed `auto` inside each route (the node
// half no longer does) and lacked the auto provider's own card.
import { readFileSync, writeFileSync } from 'node:fs'

{
  const file = 'tools/preview-entry.tsx'
  let text = readFileSync(file, 'utf8')

  // `auto` is its own provider now, so no route lists it.
  text = text.split("      { id: 'auto', name: 'Auto', description: '跟随排序第一的已启用模型', contextWindow: 1_048_576, visible: true, pinned: true },\n").join('')
  text = text.split("      { id: 'auto', name: 'Auto', description: '跟随排序第一的已启用模型', contextWindow: 256_000, visible: true, pinned: true },\n").join('')

  // Its own card, spanning the other routes.
  const anchor = '/** The page state every call answers with. */'
  if (!text.includes(anchor)) throw new Error('state anchor missing')
  text = text.replace(anchor, `/** The Auto card: one model that stands in for every other route's models. */
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
      { id: 'kimi/kimi-for-coding', name: 'Kimi for Coding', description: 'kimi · kimi-for-coding', contextWindow: 1_048_576, visible: true, source: 'kimi' },
      { id: 'grok/grok-4.6', name: 'Grok 4.6', description: 'grok · grok-4.6', contextWindow: 256_000, visible: true, source: 'grok' },
      { id: 'antigravity/gemini-3-pro', name: 'Gemini 3 Pro', description: 'antigravity · gemini-3-pro', contextWindow: 1_048_576, visible: true, source: 'antigravity' },
      { id: 'antigravity/claude-sonnet-4', name: 'Claude Sonnet 4', description: 'antigravity · claude-sonnet-4', contextWindow: 200_000, visible: false, source: 'antigravity' },
    ],
    details: [],
  }
}

${anchor}`)
  text = text.replace('const providers = [kimiStatus(), grokStatus(), antigravityStatus()]',
    'const providers = [kimiStatus(), grokStatus(), antigravityStatus(), autoStatus()]')
  text = text.replace(`        grokStatus(),
        antigravityStatus(),
      ],`, `        grokStatus(),
        antigravityStatus(),
        autoStatus(),
      ],`)
  writeFileSync(file, text)
  console.log('patched', file)
}

{
  const file = 'src/client/SubscriptionsSection.tsx'
  let text = readFileSync(file, 'utf8')
  text = text.replace('  addInput: {},', `  addInput: {},
  /** The remove control on a hand-added row: a bare glyph beside the row. */
  removeButton: { flexShrink: 0, alignSelf: 'center', padding: '0 6px' },`)
  const from = `                    className="dsh-subscription-quiet"
                    disabled={busyAction}
                    title={t('modelsRemove')}`
  if (!text.includes(from)) throw new Error('remove button anchor missing')
  text = text.replace(from, `                    className="dsh-subscription-quiet"
                    style={styles.removeButton}
                    disabled={busyAction}
                    title={t('modelsRemove')}`)
  writeFileSync(file, text)
  console.log('patched', file)
}

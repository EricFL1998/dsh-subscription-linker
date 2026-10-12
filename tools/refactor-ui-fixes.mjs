// One-off: the catalog starts folded, and the drag source is the row rather than
// the grip, because a <button> does not reliably start an HTML5 drag.
import { readFileSync, writeFileSync } from 'node:fs'

{
  const file = 'src/client/SubscriptionsSection.tsx'
  let text = readFileSync(file, 'utf8')

  // 1. Folded by default: only an explicit remembered "open" opens it.
  const openFrom = `function readModelsOpen(provider: string): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(\`\${MODELS_OPEN_KEY}/\${provider}\`)
    return raw !== '0'
  } catch {
    // A blocked storage surface (private mode, denied origin) keeps the default.
    return true
  }
}`
  if (!text.includes(openFrom)) throw new Error('readModelsOpen anchor missing')
  text = text.replace(openFrom, `function readModelsOpen(provider: string): boolean {
  try {
    // Folded by default: the card shows the connection first, and the catalog is
    // one click away. Only a remembered choice opens it.
    return globalThis.localStorage?.getItem(\`\${MODELS_OPEN_KEY}/\${provider}\`) === '1'
  } catch {
    // A blocked storage surface (private mode, denied origin) keeps the default.
    return false
  }
}`)

  // 2. The whole row is draggable; the grip is its affordance.
  const rowFrom = `              <div
                key={model.id}
                style={dragFrom === index
                  ? { ...styles.modelRowWrap, opacity: 0.5 }
                  : styles.modelRowWrap}
                onDragOver={(event) => { drag.over(event, index) }}
                onDrop={(event) => { drag.drop(event, index) }}
              >
                <button
                  type="button"
                  className="dsh-subscription-handle"
                  draggable
                  disabled={busyAction}
                  title={t('modelsDrag')}
                  aria-label={\`\${t('modelsDrag')} · \${model.name}\`}
                  onDragStart={(event) => { drag.start(event, index) }}
                  onDragEnd={drag.end}
                  onKeyDown={(event) => { drag.key(event, index) }}
                >
                  ⠿
                </button>`
  if (!text.includes(rowFrom)) throw new Error('row anchor missing')
  text = text.replace(rowFrom, `              <div
                key={model.id}
                draggable={!busyAction}
                style={dragFrom === index
                  ? { ...styles.modelRowWrap, opacity: 0.5 }
                  : styles.modelRowWrap}
                onDragStart={(event) => { drag.start(event, index) }}
                onDragEnd={drag.end}
                onDragOver={(event) => { drag.over(event, index) }}
                onDrop={(event) => { drag.drop(event, index) }}
              >
                {/* The grip is the affordance and the keyboard path; the drag
                    itself starts on the row, because a <button> does not start an
                    HTML5 drag reliably in Chromium. */}
                <button
                  type="button"
                  className="dsh-subscription-handle"
                  disabled={busyAction}
                  title={t('modelsDrag')}
                  aria-label={\`\${t('modelsDrag')} · \${model.name}\`}
                  onKeyDown={(event) => { drag.key(event, index) }}
                >
                  ⠿
                </button>`)

  // 3. The row is a drag handle, so the grip's cursor belongs to the row.
  text = text.replace("  modelRowWrap: { display: 'flex', alignItems: 'flex-start', gap: 6 },",
    "  modelRowWrap: { display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'grab' },")
  writeFileSync(file, text)
  console.log('patched', file)
}

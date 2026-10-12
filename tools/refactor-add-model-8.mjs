// One-off: the add-model row's layout, and the remove control on hand-added rows.
import { readFileSync, writeFileSync } from 'node:fs'

{
  const file = 'src/client/SubscriptionsSection.tsx'
  let text = readFileSync(file, 'utf8')

  const styleAnchor = '  /** One draggable chain row: the grip, then the remove-from-auto switch. */\n'
  if (!text.includes(styleAnchor)) throw new Error('style anchor missing')
  text = text.replace(styleAnchor, `  /** The add-a-model-id row: the field, then confirm and cancel. */
  addRow: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 },
  addInput: {},
${styleAnchor}`)

  // A hand-added row can be removed again, so a typo does not linger forever.
  const rowAnchor = `                    {model.inputModalities === undefined || model.inputModalities.length === 0
                      ? ''
                      : \` · \${model.inputModalities.join('/')}\`}
                  </span>
                </span>
              </label>
            ))}`
  if (!text.includes(rowAnchor)) throw new Error('row anchor missing')
  text = text.replace(rowAnchor, `                    {model.inputModalities === undefined || model.inputModalities.length === 0
                      ? ''
                      : \` · \${model.inputModalities.join('/')}\`}
                  </span>
                </span>
              </label>
              {model.userAdded === true && (
                <button
                  type="button"
                  className="dsh-subscription-quiet"
                  disabled={busyAction}
                  title={t('modelsRemove')}
                  aria-label={\`\${t('modelsRemove')} · \${model.name}\`}
                  onClick={() => { props.onRemoveModel(model.id) }}
                >
                  ×
                </button>
              )}
            ))}`)

  writeFileSync(file, text)
  console.log('patched', file)
}

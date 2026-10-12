// One-off: copy for the add-a-model control, plus its input styling.
import { readFileSync, writeFileSync } from 'node:fs'

{
  const file = 'src/client/locales.ts'
  let text = readFileSync(file, 'utf8')
  text = text.replace("  modelsEmpty: 'No models reported yet.',",
    `  modelsEmpty: 'No models reported yet.',
  modelsAdd: 'Add model',
  modelsAddHint: 'Publish a model id this build does not know yet',
  modelsAddPlaceholder: 'model id, e.g. k3-next',
  modelsAddConfirm: 'Add',
  modelsRemove: 'Remove this hand-added model',`)
  text = text.replace("  modelsEmpty: '暂未获取到模型。',",
    `  modelsEmpty: '暂未获取到模型。',
  modelsAdd: '添加模型',
  modelsAddHint: '手动添加一个本版本还不认识的模型 ID',
  modelsAddPlaceholder: '模型 ID，例如 k3-next',
  modelsAddConfirm: '添加',
  modelsRemove: '移除这个手动添加的模型',`)
  writeFileSync(file, text)
  console.log('patched', file)
}

{
  const file = 'src/client/styles.ts'
  let text = readFileSync(file, 'utf8')
  const anchor = '/* A drag handle: no border or fill, so it reads as a grip rather than a button. */'
  if (!text.includes(anchor)) throw new Error('style anchor missing')
  text = text.replace(anchor, `/* The free-text field for a hand-added model id. */
\${scope} input.dsh-subscription-input {
  box-sizing: border-box;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 28px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
  border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
}
\${scope} input.dsh-subscription-input::placeholder {
  color: var(--dsw-alias-label-tertiary);
}
\${scope} input.dsh-subscription-input:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
${anchor}`)
  writeFileSync(file, text)
  console.log('patched', file)
}

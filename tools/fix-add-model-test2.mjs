// One-off: the hand-added-model tests belong inside the describe that owns the
// `withModels` harness.
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'test/controller.spec.ts'
let text = readFileSync(file, 'utf8')

const marker = "\ndescribe('a model added by hand', () => {"
const at = text.indexOf(marker)
if (at === -1) throw new Error('appended block missing')
const block = text.slice(at).trimEnd()
text = text.slice(0, at).trimEnd()

// Strip the outer describe wrapper, keeping its tests, and indent nothing: the
// surrounding describe already provides the harness.
const inner = block
  .replace(/^describe\('a model added by hand', \(\) => \{\n/, '')
  .replace(/\n\}\)$/, '')

// Insert before the closing brace of the describe that owns `withModels`.
const closeAt = text.lastIndexOf('\n})')
if (closeAt === -1) throw new Error('describe close missing')
text = `${text.slice(0, closeAt)}\n\n  /** Tests appended by the hand-added-model work. */\n${inner.split('\n').map((line) => line.length === 0 ? line : `  ${line}`).join('\n')}${text.slice(closeAt)}\n`

writeFileSync(file, text)
console.log('patched', file)

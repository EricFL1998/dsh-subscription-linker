// One-off: put the hand-added-model tests inside the describe that owns the
// harness, and remove the stray block left by the previous attempt.
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'test/controller.spec.ts'
let text = readFileSync(file, 'utf8')

// 1. Lift the misplaced block (wrapper describe plus the stray trailing brace).
const start = text.indexOf("\ndescribe('a model added by hand', () => {")
if (start === -1) throw new Error('misplaced block missing')
const blockText = text.slice(start)
text = text.slice(0, start)
// The stray `})` that closed the wrapper is the file's final line.
const trimmedTail = blockText.replace(/\n\}\)\s*$/, '')
const inner = trimmedTail
  .replace(/^\n?describe\('a model added by hand', \(\) => \{\n/, '')
  .trimEnd()

// 2. The previous attempt left the `usage reads` describe closed correctly, so the
//    file now ends inside it; normalise by ensuring exactly one trailing newline.
text = `${text.trimEnd()}\n`

// 3. Splice the tests in before the close of the visibility describe, which is the
//    describe that defines `withModels`.
const anchor = "\n})\n\ndescribe('usage reads', () => {"
if (!text.includes(anchor)) throw new Error('visibility describe close missing')
const indented = inner.split('\n').map((line) => line.length === 0 ? line : `  ${line}`).join('\n')
text = text.replace(anchor, `\n\n${indented}\n})\n\ndescribe('usage reads', () => {`)

writeFileSync(file, text)
console.log('patched', file)

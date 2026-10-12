// One-off: drop the misplaced copy left inside the `usage reads` suite and restore
// that suite's closing brace.
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'test/controller.spec.ts'
let text = readFileSync(file, 'utf8')

const start = text.indexOf('  /** Tests appended by the hand-added-model work. */')
if (start === -1) throw new Error('misplaced copy missing')
// Everything from the stray comment to the end of the file is the misplaced copy
// plus its closing brace; the good copy now lives in the visibility suite.
const head = text.slice(0, start).trimEnd()
writeFileSync(file, `${head}\n})\n`)
console.log('patched', file)

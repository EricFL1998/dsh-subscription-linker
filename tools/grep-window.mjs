// Print windows around needles in a large minified file.
import { readFile } from 'node:fs/promises'

const [file, ...rest] = process.argv.slice(2)
const text = await readFile(file, 'utf8')
// Optional trailing numbers: <window> <maxHits>
const numbers = rest.filter((value) => /^\d+$/.test(value))
const needles = rest.filter((value) => !/^\d+$/.test(value))
const WINDOW = Number(numbers[0] ?? 420)
const MAX_HITS = Number(numbers[1] ?? 4)
for (const needle of needles) {
  let at = text.indexOf(needle)
  let shown = 0
  while (at !== -1 && shown < MAX_HITS) {
    const from = Math.max(0, at - WINDOW)
    const to = Math.min(text.length, at + WINDOW)
    const masked = text.slice(from, to)
      .replace(/((?:access|refresh|id)_?token|secret|api[_-]?key|client_secret)["'\s:=]{1,6}["']?[A-Za-z0-9._~+/-]{12,}/gi, '$1=<redacted>')
    console.log(`\n===== ${needle} @${at} =====\n${masked}`)
    shown += 1
    at = text.indexOf(needle, at + needle.length)
  }
  if (shown === 0) console.log(`\n===== ${needle}: not found =====`)
}

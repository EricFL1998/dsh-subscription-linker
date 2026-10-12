/**
 * Extract the harness theme's design-token blocks from the shipped shell CSS so
 * a local preview can render the plugin's section with real colors.
 *
 * Reads `probe/shell.css` and writes `probe/tokens.css` with every rule whose
 * body declares at least one `--dsw-` custom property.
 */
import { readFile, writeFile } from 'node:fs/promises'

const css = await readFile('probe/shell.css', 'utf8')

/** Split a stylesheet into top-level `selector{body}` rules. */
function* rules(source) {
  let depth = 0
  let start = 0
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') {
      if (depth === 0) start = index
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) yield source.slice(start, index + 1)
    }
  }
}

const kept = []
let darkBlocks = 0
for (const rule of rules(css)) {
  if (!rule.includes('--dsw-')) continue
  if (rule.includes('data-ds-dark-theme')) darkBlocks += 1
  kept.push(rule)
}

await writeFile('probe/tokens.css', `${kept.join('\n')}\n`, 'utf8')
console.log(JSON.stringify({ rules: kept.length, darkBlocks, bytes: kept.join('').length }))

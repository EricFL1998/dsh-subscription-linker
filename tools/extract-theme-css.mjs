/**
 * Extract the harness theme's `design-platform.css` from the shipped theme
 * client bundle, so a local preview renders the plugin's section with the real
 * light and dark design tokens.
 *
 * Reads `probe/theme-client.js` and writes `probe/design-platform.css`.
 */
import { readFile, writeFile } from 'node:fs/promises'

const bundle = await readFile('probe/theme-client.js', 'utf8')
const marker = 'var design_platform_css_default = "'
const start = bundle.indexOf(marker)
if (start < 0) throw new Error('design-platform.css is not inlined in the theme bundle')

const bodyStart = start + marker.length
let end = bodyStart
while (end < bundle.length) {
  const char = bundle[end]
  if (char === '\\') {
    end += 2
    continue
  }
  if (char === '"') break
  end += 1
}

const literal = bundle.slice(bodyStart, end)
const css = literal
  .replace(/\\"/g, '"')
  .replace(/\\n/g, '\n')
  .replace(/\\\\/g, '\\')

await writeFile('probe/design-platform.css', css, 'utf8')
console.log(JSON.stringify({
  bytes: css.length,
  lightTokens: (css.match(/body\{[^}]*\}/)?.[0].match(/--dsw-/g) ?? []).length,
  darkBlocks: (css.match(/body\[data-ds-dark-theme\]/g) ?? []).length,
}))

// One-off: Kimi no longer publishes a credit meter, so the fixture and the README
// drop it too.
import { readFileSync, writeFileSync } from 'node:fs'

{
  const file = 'tools/preview-entry.tsx'
  let text = readFileSync(file, 'utf8')
  const from = "          { label: 'credits', usedPercent: 8, resetsAt: Date.now() + 30 * 24 * 60 * 60 * 1000 },\n"
  if (!text.includes(from)) throw new Error('kimi credits fixture row missing')
  text = text.replace(from, '')
  writeFileSync(file, text)
  console.log('patched', file)
}

{
  const file = 'README.md'
  let text = readFileSync(file, 'utf8')
  const from = `states, with a meter and a reset time: Kimi's rolling 5-hour window, weekly window
and included credit (\`GET /coding/v1/usages\`);`
  if (!text.includes(from)) throw new Error('README kimi usage sentence missing')
  text = text.replace(from, `states, with a meter and a reset time: Kimi's rolling 5-hour and weekly windows
(\`GET /coding/v1/usages\`; its whole-subscription \`totalQuota\` is not published as a
third meter, because what a plan is metered against is the two windows);`)
  writeFileSync(file, text)
  console.log('patched', file)
}

// One-off: README notes for the folded default, the filter and the four buckets.
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'README.md'
let text = readFileSync(file, 'utf8')

const pairs = [
  ['| `ctx.llm` | the `kimi`, `grok` and `antigravity` provider routes (models, reasoning efforts, streaming) |',
    '| `ctx.llm` | the `kimi`, `grok`, `antigravity` and `auto` provider routes (models, reasoning efforts, streaming) |'],
  ['Antigravity lists whatever the account\'s own catalog reports (`fetchAvailableModels`), because what a plan may use differs per account',
    'Antigravity lists the agent-callable subset of what its endpoint reports (`fetchAvailableModels`), filtering out tabs, commit-message and transcription surfaces, and `auto` spans all of them'],
  ['The **Models** heading is a disclosure: click it to fold the catalog away, and\nthe choice is remembered per browser.',
    'The **Models** heading is a disclosure, **folded by default**: click it to open the\ncatalog, and the choice is remembered per browser.'],
  ['**Plan and usage** shows the subscription tier and every allowance the provider',
    '**Plan and usage** shows the subscription tier and every allowance the provider'],
]

for (const [from, to] of pairs) {
  if (!text.includes(from)) console.log('  MISS', from.slice(0, 60))
  text = text.split(from).join(to)
}

const usageFrom = `states, with a meter and a reset time: Kimi's rolling 5-hour window, weekly
window and included credit (\`GET /coding/v1/usages\`); Grok's weekly included
credit (\`cli-chat-proxy.grok.com/v1/billing?format=credits\`, plus the plan tier
from the token's own \`tier\` claim); and Antigravity's two metered allowances —
**Gemini models** and **Claude models** — reduced from the per-model quota the
service reports to the worst-spent model in each family. A provider that states
nothing says so instead of showing an invented figure.`
if (text.includes(usageFrom)) {
  text = text.replace(usageFrom, `states, with a meter and a reset time: Kimi's rolling 5-hour window, weekly window
and included credit (\`GET /coding/v1/usages\`); Grok's weekly included credit
(\`cli-chat-proxy.grok.com/v1/billing?format=credits\`, plus the plan tier from the
token's own \`tier\` claim); and Antigravity's **four** buckets — Gemini and Claude,
each rolling and weekly — read from \`v1internal:retrieveUserQuotaSummary\`, falling
back to the per-model \`quotaInfo\` of \`fetchAvailableModels\` (worst-spent model per
family, classified by id, display name and tier, so an \`Opus\` row counts as
Claude). A provider that states nothing says so instead of inventing a figure.`)
  console.log('usage paragraph updated')
}

writeFileSync(file, text)
console.log('patched', file)

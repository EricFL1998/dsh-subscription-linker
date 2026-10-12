// One-off: the weekly allowance labels were missing from both dictionaries.
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'src/client/locales.ts'
let text = readFileSync(file, 'utf8')

const pairs = [
  ["  usage_gemini: 'Gemini allowance',\n  usage_claude: 'Claude allowance',",
    "  usage_gemini: 'Gemini allowance (rolling)',\n  usage_gemini_weekly: 'Gemini allowance (weekly)',\n  usage_claude: 'Claude allowance (rolling)',\n  usage_claude_weekly: 'Claude allowance (weekly)',"],
  ["  usage_gemini: 'Gemini 模型额度',\n  usage_claude: 'Claude 模型额度',",
    "  usage_gemini: 'Gemini 模型额度（滚动）',\n  usage_gemini_weekly: 'Gemini 模型额度（每周）',\n  usage_claude: 'Claude 模型额度（滚动）',\n  usage_claude_weekly: 'Claude 模型额度（每周）',"],
]

for (const [from, to] of pairs) {
  if (!text.includes(from)) throw new Error(`label anchor missing: ${from.slice(0, 40)}`)
  text = text.replace(from, to)
}
writeFileSync(file, text)
console.log('patched', file)

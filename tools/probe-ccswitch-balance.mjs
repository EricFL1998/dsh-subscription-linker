// Probe: does cc-switch's balance endpoint accept the DeepSeek OAuth token as bearer?
// cc-switch uses GET https://api.deepseek.com/user/balance with `Authorization: Bearer
// <api_key>` — but it always sends an API key, never an OAuth token, so source alone
// cannot say whether the endpoint takes one. Test both shapes without printing secrets.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

const cred = await readFile(path.join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
const token = /deepseek-account-platform\/default:[\s\S]*?token:\s*"?([^"\r\n]+)"?/.exec(cred)?.[1]
if (token === undefined) {
  console.log('no deepseek-account token found')
  process.exit(0)
}

// cc-switch's exact request shape: GET, Authorization Bearer, Accept json, no body.
for (const [label, value] of [
  ['oauth token (64 hex)', token],
  ['api-key env var HUANLING_API_KEY', process.env.HUANLING_API_KEY ?? ''],
]) {
  if (value === '') { console.log(`${label}: (not available)`); continue }
  try {
    const response = await fetch('https://api.deepseek.com/user/balance', {
      headers: { authorization: `Bearer ${value}`, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    const body = (await response.text()).slice(0, 300)
    const shape = /balance_infos|is_available/.test(body) ? 'LOOKS LIKE A BALANCE' : 'not a balance shape'
    console.log(`${label}: HTTP ${response.status} | ${shape} | ${body.replace(/"[^"]{20,}"/g, '"<redacted>"')}`)
  } catch (error) {
    console.log(`${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

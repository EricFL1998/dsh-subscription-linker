// End-to-end through the plugin's own modules: SSO refresh -> STS -> signed quota read.
// Read-only: a token refresh and one GetCodingPlanUsage / ListModelChargeItems call.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { refreshArkToken } from '../lib/auth/ark-flow.js'
import { callArkControl, parseArkFreeUsage, parseArkPlanUsage } from '../lib/auth/ark-control.js'

const env = await readFile(path.join(homedir(), '.arkcli', '.env'), 'utf8')
const refreshToken = new RegExp('^VOLCENGINE_REFRESH_TOKEN="?([^"\\r\\n]+)"?', 'm').exec(env)?.[1]

const tokens = await refreshArkToken({ fetchFn: fetch, refreshToken })
console.log('1. SSO refresh  : id_token', tokens.idToken.length, 'chars | STS', tokens.sts === undefined ? 'MISSING' : `present (${String(tokens.sts.accessKeyId).slice(0, 3)}…)`)
if (tokens.sts === undefined) process.exit(1)

const plan = parseArkPlanUsage(await callArkControl({
  action: 'GetCodingPlanUsage',
  credentials: tokens.sts,
  fetchFn: fetch,
}))
console.log('2. plan quota   : subscribed =', plan.subscribed, '| status =', plan.status ?? '(none)', '| periods =', plan.periods.length)

const free = parseArkFreeUsage(await callArkControl({
  action: 'ListModelChargeItems',
  credentials: tokens.sts,
  fetchFn: fetch,
  body: 'Modality=LLM&PageSize=50',
}))
console.log('3. free quota   :', free.length, 'models with a free allowance')
for (const entry of free.slice(0, 4)) {
  console.log(`     ${entry.model.padEnd(24)} ${entry.consumed} / ${entry.total}`)
}

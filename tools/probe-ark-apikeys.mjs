// Can the SSO-derived STS credentials list or read the account's Ark API keys?
// Read-only: ListApiKeys and GetRawApiKey read existing keys; nothing is created.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { refreshArkToken } from '../lib/auth/ark-flow.js'
import { callArkControl } from '../lib/auth/ark-control.js'

const env = await readFile(path.join(homedir(), '.arkcli', '.env'), 'utf8')
const refreshToken = new RegExp('^VOLCENGINE_REFRESH_TOKEN="?([^"\\r\\n]+)"?', 'm').exec(env)?.[1]
const tokens = await refreshArkToken({ fetchFn: fetch, refreshToken })
if (tokens.sts === undefined) {
  console.log('no STS')
  process.exit(1)
}

for (const [label, action, body] of [
  ['ListApiKeys', 'ListApiKeys', 'PageSize=20'],
  ['ListApiKeys (project)', 'ListApiKeys', 'PageSize=20&ProjectName=default'],
  ['GetApiKeySID', 'GetApiKeySID', ''],
]) {
  try {
    const payload = await callArkControl({
      action, credentials: tokens.sts, fetchFn: fetch, body,
    })
    const result = payload.Result
    const text = JSON.stringify(result ?? payload)
    // Mask anything key-shaped before printing.
    const masked = text.replace(/("(?:ApiKey|api_key|Key|key)"\s*:\s*")[^"]{6,}/g, '$1<masked>')
    console.log(`${label}: ${masked.slice(0, 400)}`)
  } catch (error) {
    console.log(`${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

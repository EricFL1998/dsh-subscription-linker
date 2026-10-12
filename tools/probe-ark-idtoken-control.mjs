// Can the SSO id_token call the control plane directly, without the STS exchange?
// Read-only action (GetCodingPlanUsage), and a fresh token obtained by refreshing the
// CLI's own stored refresh token. Nothing is created or changed.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { refreshArkToken } from '../lib/auth/ark-flow.js'

const env = await readFile(path.join(homedir(), '.arkcli', '.env'), 'utf8')
const read = (key) => new RegExp(`^${key}="?([^"\\r\\n]+)"?`, 'm').exec(env)?.[1]
const refreshToken = read('VOLCENGINE_REFRESH_TOKEN')
if (refreshToken === undefined) {
  console.log('no refresh token stored')
  process.exit(0)
}

let idToken
try {
  const tokens = await refreshArkToken({ fetchFn: fetch, refreshToken })
  idToken = tokens.idToken
  console.log('refresh: ok | new id_token length', idToken.length, '| expires', new Date(tokens.expiresAt).toISOString())
} catch (error) {
  console.log('refresh failed:', error instanceof Error ? error.message : String(error))
  process.exit(0)
}

// Read-only control-plane action, sent with the id_token as a plain bearer.
const query = 'Action=GetCodingPlanUsage&Version=2024-01-01'
const response = await fetch(`https://ark.cn-beijing.volcengineapi.com/?${query}`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${idToken}`,
    'content-type': 'application/x-www-form-urlencoded',
  },
  body: '',
  signal: AbortSignal.timeout(25_000),
})
console.log('bearer id_token -> HTTP', response.status)
console.log((await response.text()).slice(0, 300))

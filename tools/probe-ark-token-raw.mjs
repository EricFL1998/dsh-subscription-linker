// Dump the RAW token-endpoint response: does it carry STS alongside the id_token?
// Long values are masked; this is a read-only refresh.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

const env = await readFile(path.join(homedir(), '.arkcli', '.env'), 'utf8')
const refreshToken = new RegExp('^VOLCENGINE_REFRESH_TOKEN="?([^"\\r\\n]+)"?', 'm').exec(env)?.[1]
if (refreshToken === undefined) {
  console.log('no refresh token')
  process.exit(0)
}

const response = await fetch('https://signin.volcengine.com/authorize/oauth/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
  body: new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: 'trn:signin:::devtools/same-device',
    refresh_token: refreshToken,
  }).toString(),
  signal: AbortSignal.timeout(25_000),
})
console.log('HTTP', response.status)
const raw = await response.text()
let parsed
try {
  parsed = JSON.parse(raw)
} catch {
  console.log('raw:', raw.slice(0, 400))
  process.exit(0)
}
console.log('fields:', Object.keys(parsed).join(', '))
for (const [key, value] of Object.entries(parsed)) {
  const shown = typeof value === 'string' && value.length > 24
    ? `<len=${value.length} ${value.slice(0, 6)}…>`
    : value
  console.log(`  ${key}: ${typeof shown === 'object' ? JSON.stringify(shown) : String(shown)}`)
}

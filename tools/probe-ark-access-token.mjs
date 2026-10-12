// What is inside the access_token the SSO endpoint returns? It looks like JSON.
// Masked: only field names and shapes are printed, never the credential values.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

const env = await readFile(path.join(homedir(), '.arkcli', '.env'), 'utf8')
const refreshToken = new RegExp('^VOLCENGINE_REFRESH_TOKEN="?([^"\\r\\n]+)"?', 'm').exec(env)?.[1]
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
const payload = await response.json()
console.log('token_type:', payload.token_type)

/** Print a value's shape without its content. */
function shape(value, indent = '  ') {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array(${value.length})`
  if (typeof value === 'object') return 'object'
  if (typeof value === 'string') {
    // A JWT or long opaque value: report the length, and the claims if it is a JWT.
    if (value.split('.').length === 3 && value.length > 60) return `<jwt len=${value.length}>`
    return `<string len=${value.length}>`
  }
  return `${typeof value} ${String(value)}`
}

let access
try {
  access = JSON.parse(payload.access_token)
} catch {
  console.log('access_token is not JSON; first 60 chars:', String(payload.access_token).slice(0, 60))
  process.exit(0)
}
console.log('\naccess_token parsed as JSON. Top-level fields:')
for (const [key, value] of Object.entries(access)) {
  console.log(`  ${key}: ${shape(value)}`)
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const [innerKey, innerValue] of Object.entries(value)) {
      console.log(`      ${innerKey}: ${shape(innerValue)}`)
    }
  }
}

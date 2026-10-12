// Read the raw value of the key just created (GetRawApiKey), and list the account's keys.
// The key value is masked here; this is to learn the response shape.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { refreshArkToken } from '../lib/auth/ark-flow.js'
import { signArkRequest } from '../lib/auth/ark-control.js'

const env = await readFile(path.join(homedir(), '.arkcli', '.env'), 'utf8')
const refreshToken = new RegExp('^VOLCENGINE_REFRESH_TOKEN="?([^"\\r\\n]+)"?', 'm').exec(env)?.[1]
const tokens = await refreshArkToken({ fetchFn: fetch, refreshToken })
const sts = tokens.sts
if (sts === undefined) process.exit(1)

const host = 'ark.cn-beijing.volcengineapi.com'
async function call(action, payload) {
  const query = `Action=${action}&Version=2024-01-01`
  const body = JSON.stringify(payload)
  const response = await fetch(`https://${host}/?${query}`, {
    method: 'POST',
    headers: signArkRequest({ method: 'POST', query, body, credentials: sts, contentType: 'application/json' }),
    body,
    signal: AbortSignal.timeout(25_000),
  })
  const text = await response.text()
  console.log(`${action} -> HTTP ${response.status}`)
  if (!response.ok) {
    console.log('  ', text.slice(0, 300))
    return undefined
  }
  return JSON.parse(text)
}

/** Print a result's fields, masking anything key-shaped. */
function describe(result, indent = '  ') {
  for (const [key, value] of Object.entries(result ?? {})) {
    if (typeof value === 'string' && value.length > 12) {
      console.log(`${indent}${key}: <string len=${value.length} ${value.slice(0, 4)}…>`)
    } else if (Array.isArray(value)) {
      console.log(`${indent}${key}: array(${value.length})`)
      for (const item of value.slice(0, 3)) {
        console.log(`${indent}  ${JSON.stringify(item).replace(/("[A-Za-z]*(?:Key|key)"\s*:\s*")[^"]{6,}/g, '$1<masked>').slice(0, 220)}`)
      }
    } else if (typeof value === 'object' && value !== null) {
      console.log(`${indent}${key}:`)
      describe(value, `${indent}  `)
    } else {
      console.log(`${indent}${key}: ${String(value)}`)
    }
  }
}

const listed = await call('ListApiKeys', { PageSize: 20, ProjectName: 'default' })
console.log('ListApiKeys.Result:')
describe(listed?.Result)

const first = listed?.Result?.Items?.[0]
if (first !== undefined) {
  const raw = await call('GetRawApiKey', { Id: first.Id, ProjectName: 'default' })
  console.log('GetRawApiKey.Result:')
  describe(raw?.Result)
}

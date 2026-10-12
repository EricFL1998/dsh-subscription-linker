// CreateApiKey with a JSON body: the service parses nested fields from JSON, which is
// why dotted form keys were ignored. Creates one key (authorised by the user).
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
const query = 'Action=CreateApiKey&Version=2024-01-01'

/** Sign and send one JSON-bodied control-plane call. */
async function call(label, payload) {
  const body = JSON.stringify(payload)
  const response = await fetch(`https://${host}/?${query}`, {
    method: 'POST',
    headers: signArkRequest({ method: 'POST', query, body, credentials: sts, contentType: 'application/json' }),
    body,
    signal: AbortSignal.timeout(25_000),
  })
  const text = await response.text()
  const code = /"Code":"([^"]+)"/.exec(text)?.[1] ?? 'OK'
  const message = /"Message":"([^"]{0,130})/.exec(text)?.[1] ?? ''
  console.log(`${String(response.status).padEnd(4)} ${label.padEnd(34)} ${code} ${message}`)
  if (!response.ok) return undefined
  return JSON.parse(text)
}

// Progressive: learn each missing field, then send the complete shape.
const created = await call('json: one empty instance', {
  Name: 'dsh-ark-key',
  ProjectName: 'default',
  ResourceInstances: [{}],
  AccessControlInfo: { AllowAll: true },
})
if (created === undefined) process.exit(1)

const result = created.Result ?? {}
console.log('\nCREATED — response fields:')
for (const [key, value] of Object.entries(result)) {
  const shown = typeof value === 'string' && value.length > 12 ? `<len=${value.length}>` : value
  console.log(`  ${key}: ${typeof shown === 'object' ? JSON.stringify(shown) : String(shown)}`)
}

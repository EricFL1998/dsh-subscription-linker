// Discover CreateApiKeyResourceInstance's fields from validation errors.
// Each attempt is incomplete on purpose; nothing is created until one succeeds.
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
async function attempt(label, params) {
  const body = new URLSearchParams(params).toString()
  const response = await fetch(`https://${host}/?${query}`, {
    method: 'POST',
    headers: signArkRequest({ method: 'POST', query, body, credentials: sts }),
    body,
    signal: AbortSignal.timeout(20_000),
  })
  const text = await response.text()
  const code = /"Code":"([^"]+)"/.exec(text)?.[1] ?? 'OK'
  const message = /"Message":"([^"]{0,120})/.exec(text)?.[1] ?? ''
  console.log(`${String(response.status).padEnd(4)} ${label.padEnd(42)} ${code} ${message}`)
  if (response.ok) {
    console.log('\nCREATED. Response fields:')
    const result = JSON.parse(text).Result ?? {}
    for (const [key, value] of Object.entries(result)) {
      const shown = typeof value === 'string' && value.length > 10 ? `<len=${value.length}>` : value
      console.log(`  ${key}: ${typeof shown === 'object' ? JSON.stringify(shown) : String(shown)}`)
    }
    return true
  }
  return false
}

// The list API names its items; reuse that vocabulary for the instance.
const common = { Name: 'dsh-ark-key', ProjectName: 'default' }
const attempts = [
  ['empty instances + AllowAll', { ...common, 'ResourceInstances': '[]', 'AccessControlInfo.AllowAll': 'true' }],
  ['AllowAll=false + instances', { ...common, 'ResourceInstances': '[]', 'AccessControlInfo.AllowAll': 'false' }],
  ['AllowAll true lowercase', { ...common, 'ResourceInstances': '[]', 'AccessControlInfo.AllowAll': 'True' }],
  ['JSON AccessControlInfo', { ...common, 'ResourceInstances': '[]', 'AccessControlInfo': '{"AllowAll":true}' }],
]

for (const [label, params] of attempts) {
  if (await attempt(label, params)) process.exit(0)
}
console.log('\nnone succeeded; the instance fields are still unknown')

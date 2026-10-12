// Mint one ordinary Ark API key for this account (the user authorised this).
// Prints only the key's identity, never the key itself.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { refreshArkToken } from '../lib/auth/ark-flow.js'
import { callArkControl } from '../lib/auth/ark-control.js'

const env = await readFile(path.join(homedir(), '.arkcli', '.env'), 'utf8')
const refreshToken = new RegExp('^VOLCENGINE_REFRESH_TOKEN="?([^"\\r\\n]+)"?', 'm').exec(env)?.[1]
const tokens = await refreshArkToken({ fetchFn: fetch, refreshToken })
const sts = tokens.sts
if (sts === undefined) process.exit(1)

const name = `dsh-subscription-oauth-${new Date().toISOString().slice(0, 10)}`
const body = new URLSearchParams({ Name: name, ProjectName: 'default' }).toString()
const { signArkRequest } = await import('../lib/auth/ark-control.js')
const host = 'ark.cn-beijing.volcengineapi.com'
const query = 'Action=CreateApiKey&Version=2024-01-01'
const raw = await fetch(`https://${host}/?${query}`, {
  method: 'POST',
  headers: signArkRequest({ method: 'POST', query, body, credentials: sts }),
  body,
  signal: AbortSignal.timeout(25_000),
})
const text = await raw.text()
console.log('CreateApiKey -> HTTP', raw.status)
if (!raw.ok) {
  console.log(text.slice(0, 400))
  process.exit(1)
}
const payload = JSON.parse(text)
const result = payload.Result ?? {}
console.log('created:', JSON.stringify({
  name: result.Name,
  id: result.Id,
  sid: result.Sid,
  hasKey: typeof result.ApiKey === 'string' && result.ApiKey.length > 0,
  keyLength: typeof result.ApiKey === 'string' ? result.ApiKey.length : 0,
  keyPrefix: typeof result.ApiKey === 'string' ? `${result.ApiKey.slice(0, 8)}…` : undefined,
  fields: Object.keys(result).join(', '),
}))

// Confirm it appears in the account's list.
const listed = await callArkControl({
  action: 'ListApiKeys',
  credentials: sts,
  fetchFn: fetch,
  body: 'PageSize=20&ProjectName=default',
})
console.log('listed total:', listed.Result?.TotalCount)

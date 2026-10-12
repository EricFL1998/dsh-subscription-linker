// Final link: does the minted key authenticate the data plane?
// Prints only the status and error text, never the key.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { refreshArkToken } from '../lib/auth/ark-flow.js'
import { callArkControl } from '../lib/auth/ark-control.js'

const env = await readFile(path.join(homedir(), '.arkcli', '.env'), 'utf8')
const refreshToken = new RegExp('^VOLCENGINE_REFRESH_TOKEN="?([^"\\r\\n]+)"?', 'm').exec(env)?.[1]
const tokens = await refreshArkToken({ fetchFn: fetch, refreshToken })
if (tokens.sts === undefined) process.exit(1)

const listed = await callArkControl({
  action: 'ListApiKeys',
  credentials: tokens.sts,
  fetchFn: fetch,
  body: JSON.stringify({ PageSize: 20, ProjectName: 'default' }),
  contentType: 'application/json',
})
const id = listed.Result.Items[0].Id
const raw = await callArkControl({
  action: 'GetRawApiKey',
  credentials: tokens.sts,
  fetchFn: fetch,
  body: JSON.stringify({ Id: id, ProjectName: 'default' }),
  contentType: 'application/json',
})
const apiKey = raw.Result.ApiKey
console.log('minted key:', apiKey.slice(0, 4) + '…', `(${apiKey.length} chars)`)

// The data plane, with the real key.
const response = await fetch('https://ark.cn-beijing.volces.com/api/coding/v3/responses', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({ model: 'doubao-seed-2-1-lite', input: 'say hi in one word', stream: false }),
  signal: AbortSignal.timeout(40_000),
})
console.log('data plane -> HTTP', response.status)
console.log((await response.text()).slice(0, 400))

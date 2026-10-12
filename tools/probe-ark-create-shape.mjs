// Learn CreateApiKey's required fields from its own validation errors.
// The first calls are deliberately incomplete, so nothing is created.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { refreshArkToken } from '../lib/auth/ark-flow.js'

const env = await readFile(path.join(homedir(), '.arkcli', '.env'), 'utf8')
const refreshToken = new RegExp('^VOLCENGINE_REFRESH_TOKEN="?([^"\\r\\n]+)"?', 'm').exec(env)?.[1]
const tokens = await refreshArkToken({ fetchFn: fetch, refreshToken })
const sts = tokens.sts
if (sts === undefined) process.exit(1)

/** Sign and call one control-plane action, returning the raw body. */
async function call(action, body) {
  const { signArkRequest } = await import('../lib/auth/ark-control.js')
  const host = 'ark.cn-beijing.volcengineapi.com'
  const query = `Action=${action}&Version=2024-01-01`
  const response = await fetch(`https://${host}/?${query}`, {
    method: 'POST',
    headers: signArkRequest({ method: 'POST', query, body, credentials: sts }),
    body,
    signal: AbortSignal.timeout(20_000),
  })
  return { status: response.status, text: await response.text() }
}

// Incomplete on purpose: read the validation message rather than create a key.
for (const body of ['', 'ProjectName=default', 'Name=probe']) {
  const result = await call('CreateApiKey', body)
  console.log(`body=${JSON.stringify(body)} -> HTTP ${result.status}\n  ${result.text.slice(0, 260).replace(/\s+/g, ' ')}\n`)
}

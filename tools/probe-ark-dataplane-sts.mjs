// Can the DATA plane (ark.cn-beijing.volces.com) accept a real STS signature?
// Earlier a fake signature answered 403 "Unsupported aksk authentication method", which
// suggests the method itself is refused — but that was unverified. Test with real STS.
import { readFile } from 'node:fs/promises'
import { createHash, createHmac } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'

import { refreshArkToken } from '../lib/auth/ark-flow.js'

const env = await readFile(path.join(homedir(), '.arkcli', '.env'), 'utf8')
const refreshToken = new RegExp('^VOLCENGINE_REFRESH_TOKEN="?([^"\\r\\n]+)"?', 'm').exec(env)?.[1]
const tokens = await refreshArkToken({ fetchFn: fetch, refreshToken })
const sts = tokens.sts
if (sts === undefined) {
  console.log('no STS')
  process.exit(1)
}

const host = 'ark.cn-beijing.volces.com'
const pathAndQuery = '/api/coding/v3/responses'
const body = JSON.stringify({ model: 'ark-code-latest', input: 'ping' })
const at = new Date()
const xDate = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
const contentSha = createHash('sha256').update(body).digest('hex')
const contentType = 'application/json'
const signedHeaders = 'content-type;host;x-content-sha256;x-date'
const canonical = ['POST', pathAndQuery, '', `content-type:${contentType}`, `host:${host}`, `x-content-sha256:${contentSha}`, `x-date:${xDate}`, '', signedHeaders, contentSha].join('\n')
const scope = `${xDate.slice(0, 8)}/cn-beijing/ark/request`
const stringToSign = ['HMAC-SHA256', xDate, scope, createHash('sha256').update(canonical).digest('hex')].join('\n')
const k = createHmac('sha256', createHmac('sha256', createHmac('sha256', createHmac('sha256', sts.secretAccessKey).update(xDate.slice(0, 8)).digest()).update('cn-beijing').digest()).update('ark').digest()).update('request').digest()
const authorization = `HMAC-SHA256 Credential=${sts.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${createHmac('sha256', k).update(stringToSign).digest('hex')}`

const response = await fetch(`https://${host}${pathAndQuery}`, {
  method: 'POST',
  headers: {
    'content-type': contentType, 'host': host, 'x-content-sha256': contentSha, 'x-date': xDate,
    'x-security-token': sts.sessionToken, authorization,
  },
  body,
  signal: AbortSignal.timeout(25_000),
})
console.log('data plane + real STS signature -> HTTP', response.status)
console.log((await response.text()).slice(0, 320))

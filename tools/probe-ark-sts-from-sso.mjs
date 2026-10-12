// Does the SSO access_token's STS credential sign the control plane?
// Read-only: one GetCodingPlanUsage call.
import { readFile } from 'node:fs/promises'
import { createHash, createHmac } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'

const env = await readFile(path.join(homedir(), '.arkcli', '.env'), 'utf8')
const refreshToken = new RegExp('^VOLCENGINE_REFRESH_TOKEN="?([^"\\r\\n]+)"?', 'm').exec(env)?.[1]
const tokenResponse = await fetch('https://signin.volcengine.com/authorize/oauth/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
  body: new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: 'trn:signin:::devtools/same-device',
    refresh_token: refreshToken,
  }).toString(),
  signal: AbortSignal.timeout(25_000),
})
const payload = await tokenResponse.json()
const sts = JSON.parse(payload.access_token)
console.log('sts keys:', Object.keys(sts).join(', '))
console.log('access_key_id prefix:', String(sts.access_key_id).slice(0, 3))

const host = 'ark.cn-beijing.volcengineapi.com'
const query = 'Action=GetCodingPlanUsage&Version=2024-01-01'
const body = ''
const at = new Date()
const xDate = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
const contentSha = createHash('sha256').update(body).digest('hex')
const contentType = 'application/x-www-form-urlencoded'
const signedHeaders = 'content-type;host;x-content-sha256;x-date'
const canonical = ['POST', '/', query, `content-type:${contentType}`, `host:${host}`, `x-content-sha256:${contentSha}`, `x-date:${xDate}`, '', signedHeaders, contentSha].join('\n')
const scope = `${xDate.slice(0, 8)}/cn-beijing/ark/request`
const stringToSign = ['HMAC-SHA256', xDate, scope, createHash('sha256').update(canonical).digest('hex')].join('\n')
const k = createHmac('sha256', createHmac('sha256', createHmac('sha256', createHmac('sha256', sts.secret_access_key).update(xDate.slice(0, 8)).digest()).update('cn-beijing').digest()).update('ark').digest()).update('request').digest()
const authorization = `HMAC-SHA256 Credential=${sts.access_key_id}/${scope}, SignedHeaders=${signedHeaders}, Signature=${createHmac('sha256', k).update(stringToSign).digest('hex')}`

const response = await fetch(`https://${host}/?${query}`, {
  method: 'POST',
  headers: {
    'content-type': contentType, 'host': host, 'x-content-sha256': contentSha, 'x-date': xDate,
    'x-security-token': sts.session_token, authorization,
  },
  body,
  signal: AbortSignal.timeout(25_000),
})
console.log('\nGetCodingPlanUsage with the SSO access_token -> HTTP', response.status)
console.log((await response.text()).slice(0, 300))

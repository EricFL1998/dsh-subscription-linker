// Can STS credentials sign a control-plane call? Reproduces the CLI's own request.
// Reads the CLI's own .env (its credentials, not the user's typed secrets) and signs
// exactly as the binary describes: HMAC-SHA256 over content-type;host;x-content-sha256;x-date.
import { readFile } from 'node:fs/promises'
import { createHash, createHmac } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'

const env = await readFile(path.join(homedir(), '.arkcli', '.env'), 'utf8')
const read = (key) => {
  const match = new RegExp(`^${key}="?([^"\\r\\n]+)"?`, 'm').exec(env)
  return match?.[1]
}

const ak = read('VOLCENGINE_STS_ACCESS_KEY')
const sk = read('VOLCENGINE_STS_SECRET_KEY')
const sessionToken = read('VOLCENGINE_STS_SESSION_TOKEN')
console.log('ak present:', ak !== undefined, '| starts with AKT:', ak?.startsWith('AKT'))
console.log('session token present:', sessionToken !== undefined)
if (ak === undefined || sk === undefined) {
  console.log('no STS credentials to test with')
  process.exit(0)
}

const host = 'ark.cn-beijing.volcengineapi.com'
const query = 'Action=GetCodingPlanUsage&Version=2024-01-01'
const body = ''
const now = new Date()
const xDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
const contentSha = createHash('sha256').update(body).digest('hex')
const contentType = 'application/x-www-form-urlencoded'

const signedHeaders = 'content-type;host;x-content-sha256;x-date'
const canonical = [
  'POST',
  '/',
  query,
  `content-type:${contentType}`,
  `host:${host}`,
  `x-content-sha256:${contentSha}`,
  `x-date:${xDate}`,
  '',
  signedHeaders,
  contentSha,
].join('\n')

const scope = `${xDate.slice(0, 8)}/cn-beijing/ark/request`
const stringToSign = ['HMAC-SHA256', xDate, scope, createHash('sha256').update(canonical).digest('hex')].join('\n')
const kDate = createHmac('sha256', sk).update(xDate.slice(0, 8)).digest()
const kRegion = createHmac('sha256', kDate).update('cn-beijing').digest()
const kService = createHmac('sha256', kRegion).update('ark').digest()
const kSigning = createHmac('sha256', kService).update('request').digest()
const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')

const authorization = `HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
const response = await fetch(`https://${host}/?${query}`, {
  method: 'POST',
  headers: {
    'content-type': contentType,
    'host': host,
    'x-content-sha256': contentSha,
    'x-date': xDate,
    'authorization': authorization,
    'x-security-token': sessionToken ?? '',
  },
  signal: AbortSignal.timeout(25_000),
})
const text = (await response.text()).slice(0, 400)
console.log('HTTP', response.status)
console.log(text)

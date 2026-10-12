// Last attempt at the STS leg: sign AssumeRoleWithOIDC with the STS AK/SK the CLI
// already stores (which is what the CLI itself would have to do), to see whether the
// id_token can be federated into fresh credentials this way.
// Read-only: AssumeRoleWithOIDC mints temporary credentials and changes nothing.
import { readFile } from 'node:fs/promises'
import { createHash, createHmac } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'

const dir = path.join(homedir(), '.arkcli', 'identities')
const { readdir } = await import('node:fs/promises')
const [identity] = await readdir(dir)
const sts = JSON.parse(await readFile(path.join(dir, identity, 'sts.json'), 'utf8'))
const token = JSON.parse(await readFile(path.join(dir, identity, 'token.json'), 'utf8'))
console.log('sts fields:', Object.keys(sts).join(', '))
console.log('token has id_token:', typeof token.id_token === 'string')

/** Volcengine signature for one OpenAPI request. */
function sign({ host, query, body, ak, sk, region, service, at }) {
  const xDate = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const contentSha = createHash('sha256').update(body).digest('hex')
  const contentType = 'application/x-www-form-urlencoded'
  const signedHeaders = 'content-type;host;x-content-sha256;x-date'
  const canonical = ['POST', '/', query, `content-type:${contentType}`, `host:${host}`, `x-content-sha256:${contentSha}`, `x-date:${xDate}`, '', signedHeaders, contentSha].join('\n')
  const scope = `${xDate.slice(0, 8)}/${region}/${service}/request`
  const stringToSign = ['HMAC-SHA256', xDate, scope, createHash('sha256').update(canonical).digest('hex')].join('\n')
  const k = createHmac('sha256', createHmac('sha256', createHmac('sha256', createHmac('sha256', sk).update(xDate.slice(0, 8)).digest()).update(region).digest()).update(service).digest()).update('request').digest()
  return {
    'content-type': contentType,
    'host': host,
    'x-content-sha256': contentSha,
    'x-date': xDate,
    'x-security-token': sts.session_token,
    authorization: `HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signedHeaders}, Signature=${createHmac('sha256', k).update(stringToSign).digest('hex')}`,
  }
}

const host = 'sts.volcengineapi.com'
const roleTrn = `trn:iam::${JSON.parse(await readFile(path.join(dir, identity, 'metadata.json'), 'utf8')).account_id}:role/arkcli`
const body = new URLSearchParams({
  Action: 'AssumeRoleWithOIDC',
  Version: '2018-01-01',
  RoleTrn: roleTrn,
  OIDCToken: token.id_token,
}).toString()
const query = 'Action=AssumeRoleWithOIDC&Version=2018-01-01'

const response = await fetch(`https://${host}/?${query}`, {
  method: 'POST',
  headers: sign({ host, query, body, ak: sts.ak, sk: sts.sk, region: 'cn-beijing', service: 'sts', at: new Date() }),
  body,
  signal: AbortSignal.timeout(25_000),
})
console.log('signed AssumeRoleWithOIDC -> HTTP', response.status)
console.log((await response.text()).slice(0, 400))

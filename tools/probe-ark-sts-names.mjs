// Probe the RoleSessionName constraint on STS AssumeRoleWithOIDC.
// Read-only: this mints temporary credentials for the caller and nothing else.
import { readFile, readdir } from 'node:fs/promises'
import { createHash, createHmac } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'

const dir = path.join(homedir(), '.arkcli', 'identities')
const [identity] = await readdir(dir)
const base = path.join(dir, identity)
const sts = JSON.parse(await readFile(path.join(base, 'sts.json'), 'utf8'))
const token = JSON.parse(await readFile(path.join(base, 'token.json'), 'utf8'))
const meta = JSON.parse(await readFile(path.join(base, 'metadata.json'), 'utf8'))

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
    'content-type': contentType, 'host': host, 'x-content-sha256': contentSha, 'x-date': xDate,
    'x-security-token': sts.session_token,
    authorization: `HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signedHeaders}, Signature=${createHmac('sha256', k).update(stringToSign).digest('hex')}`,
  }
}

const host = 'sts.volcengineapi.com'
const query = 'Action=AssumeRoleWithOIDC&Version=2018-01-01'
const roles = [
  `trn:iam::${meta.account_id}:role/arkcli`,
  `trn:iam::${meta.account_id}:role/arkcli-devtools`,
  `trn:iam::${meta.account_id}:role/ArkCLI`,
]
const sessionNames = ['arkcli-session', 'arkcli', 'devtools', 'session1', 'arkcli_session', 'a'.repeat(32)]

for (const role of roles) {
  for (const name of sessionNames) {
    const body = new URLSearchParams({
      Action: 'AssumeRoleWithOIDC', Version: '2018-01-01',
      RoleTrn: role, RoleSessionName: name, OIDCToken: token.id_token,
    }).toString()
    const response = await fetch(`https://${host}/?${query}`, {
      method: 'POST',
      headers: sign({ host, query, body, ak: sts.ak, sk: sts.sk, region: 'cn-beijing', service: 'sts', at: new Date() }),
      body,
      signal: AbortSignal.timeout(20_000),
    })
    const text = await response.text()
    const code = /"Code":"([^"]+)"/.exec(text)?.[1] ?? 'OK'
    const message = /"Message":"([^"]{0,90})/.exec(text)?.[1] ?? ''
    console.log(`${String(response.status).padEnd(4)} role=${role.split('/').pop()?.padEnd(14)} name=${name.padEnd(16)} ${code} ${message}`)
    if (response.ok) {
      console.log('\nSUCCESS — full body:')
      console.log(text.slice(0, 700))
      process.exit(0)
    }
  }
}

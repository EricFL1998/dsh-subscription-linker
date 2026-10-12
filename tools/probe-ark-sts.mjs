// Exchange the SSO id_token for STS credentials via OIDC federation.
// AssumeRoleWithOIDC needs no AK/SK — the OIDC token IS the credential — so this is
// read-only with respect to the account: it mints temporary credentials and nothing else.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { refreshArkToken } from '../lib/auth/ark-flow.js'

const env = await readFile(path.join(homedir(), '.arkcli', '.env'), 'utf8')
const read = (key) => new RegExp(`^${key}="?([^"\\r\\n]+)"?`, 'm').exec(env)?.[1]
const tokens = await refreshArkToken({ fetchFn: fetch, refreshToken: read('VOLCENGINE_REFRESH_TOKEN') })
console.log('id_token:', tokens.idToken.length, 'chars')

// The role the CLI assumes; the binary names a role trn pattern for the devtools client.
const roleTrn = 'trn:iam::2132898292:role/arkcli-devtools'
const attempts = [
  ['RoleTrn + OIDCToken', { Action: 'AssumeRoleWithOIDC', Version: '2018-01-01', RoleTrn: roleTrn, OIDCToken: tokens.idToken }],
  ['RoleArn + WebIdentityToken', { Action: 'AssumeRoleWithOIDC', Version: '2018-01-01', RoleArn: roleTrn, WebIdentityToken: tokens.idToken }],
  ['ProviderId + OIDCToken', { Action: 'AssumeRoleWithOIDC', Version: '2018-01-01', ProviderId: 'arkcli', OIDCToken: tokens.idToken }],
]

for (const [label, params] of attempts) {
  const body = new URLSearchParams(params).toString()
  const response = await fetch('https://sts.volcengineapi.com/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(25_000),
  })
  const text = (await response.text()).slice(0, 320).replace(/\s+/g, ' ')
  console.log(`\n${label} -> HTTP ${response.status}\n  ${text}`)
}

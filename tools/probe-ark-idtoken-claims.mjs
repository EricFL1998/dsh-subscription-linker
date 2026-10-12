// Read the id_token's claims to find which OIDC provider the exchange expects.
// Only non-secret claims are printed; the subject is masked.
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

const dir = path.join(homedir(), '.arkcli', 'identities')
const [identity] = await readdir(dir)
const token = JSON.parse(await readFile(path.join(dir, identity, 'token.json'), 'utf8'))
const parts = String(token.id_token).split('.')
console.log('id_token segments:', parts.length)
const claims = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'))
console.log('header:', Buffer.from(parts[0] ?? '', 'base64url').toString('utf8'))

for (const [key, value] of Object.entries(claims)) {
  if (key === 'sub' || key === 'user_id' || key === 'account_id') {
    console.log(`${key}: <masked len=${String(value).length}>`)
    continue
  }
  if (key === 'exp' || key === 'iat' || key === 'nbf') {
    console.log(`${key}: ${new Date(Number(value) * 1000).toISOString()}`)
    continue
  }
  const shown = typeof value === 'string' && value.length > 120 ? `${value.slice(0, 120)}…` : value
  console.log(`${key}: ${typeof shown === 'object' ? JSON.stringify(shown) : String(shown)}`)
}

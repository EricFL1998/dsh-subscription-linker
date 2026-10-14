/**
 * Probe every subscription route's live `/models` payload.
 *
 * Read-only reconnaissance: it reads the stored credential, asks the endpoint the
 * adapter asks, and prints the payload with secrets redacted. It never sends a
 * token to stdout and never mutates stored state.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = process.env.USERPROFILE ?? os.homedir()
const dataDir = path.join(home, '.dsh', 'plugins', 'kimi-oauth')
const auth = JSON.parse(fs.readFileSync(path.join(dataDir, 'auth.json'), 'utf8'))

const route = process.argv[2] ?? 'kimi'
const section = auth[route]
if (section === undefined) {
  console.log(`no stored section for ${route}`)
  process.exit(0)
}
const account = section.default
const session = section.accounts[account]
console.log(`route=${route} account=${account} expiresAt=${new Date(session.expiresAt).toISOString()} expired=${session.expiresAt <= Date.now()}`)

const token = session.accessToken
const redact = (text) => text.split(token).join('<TOKEN>')

function identityHeaders() {
  const version = '0.14.0'
  const platform = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[process.platform] ?? process.platform
  const deviceId = fs.readFileSync(path.join(dataDir, 'kimi-device-id'), 'utf8').trim()
  return {
    'User-Agent': `KimiCLI/${version}`,
    'X-Msh-Platform': 'kimi_code_cli',
    'X-Msh-Version': version,
    'X-Msh-Device-Name': os.hostname(),
    'X-Msh-Device-Model': `${platform} ${os.release()} ${os.arch()}`,
    'X-Msh-Os-Version': os.release(),
    'X-Msh-Device-Id': deviceId,
  }
}

const endpoint = process.argv[3] ?? 'https://api.kimi.com/coding/v1/models'
console.log(`GET ${endpoint}`)
const response = await fetch(endpoint, {
  headers: { ...identityHeaders(), authorization: `Bearer ${token}`, accept: 'application/json' },
})
console.log(`status=${response.status} ${response.statusText}`)
const text = await response.text()
if (process.argv[4] !== undefined) {
  fs.writeFileSync(process.argv[4], text, 'utf8')
  console.log(`saved payload to ${process.argv[4]}`)
}
try {
  const parsed = JSON.parse(text)
  const rows = Array.isArray(parsed?.data) ? parsed.data : []
  console.log(`data.length=${rows.length}`)
  console.log('--- raw payload (redacted) ---')
  console.log(redact(JSON.stringify(parsed, null, 2)))
  if (rows.length > 0) {
    console.log('--- field names seen per row ---')
    const fields = new Map()
    for (const row of rows) {
      const keys = Object.keys(row).sort().join(', ')
      fields.set(keys, (fields.get(keys) ?? 0) + 1)
    }
    for (const [keys, count] of fields) console.log(`  [${count}x] ${keys}`)
  }
} catch {
  console.log(redact(text.slice(0, 4000)))
}

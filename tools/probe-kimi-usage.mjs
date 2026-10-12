// What does Kimi's usage endpoint actually return? Read-only, current token, no refresh.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { proxiedFetch } from '../lib/http.js'

const authFile = path.join(homedir(), '.dsh', 'plugins', 'kimi-oauth', 'auth.json')
const auth = JSON.parse(await readFile(authFile, 'utf8'))
const section = auth.kimi
const id = section?.default ?? Object.keys(section?.accounts ?? {})[0]
const session = section.accounts[id]
console.log('expired:', session.expiresAt < Date.now())

const response = await proxiedFetch('https://api.kimi.com/coding/v1/usages', {
  headers: { authorization: `Bearer ${session.accessToken}`, accept: 'application/json' },
})
console.log('HTTP', response.status)
const text = await response.text()
console.log(text.slice(0, 2500))

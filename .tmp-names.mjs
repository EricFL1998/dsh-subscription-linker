import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { parseAntigravitySession, fetchAntigravityModels, refreshAntigravityToken } from './lib/providers/antigravity.js'
const storePath = path.join(homedir(), '.dsh', 'plugins', 'kimi-oauth', 'auth.json')
const doc = JSON.parse(await readFile(storePath, 'utf8'))
const section = doc.antigravity ?? doc
const accounts = section.accounts ?? {}
const key = Object.keys(accounts)[0]
const parsed = parseAntigravitySession(accounts[key])
let accessToken = parsed.accessToken
if (parsed.expiresAt <= Date.now()) {
  const refreshed = await refreshAntigravityToken({ fetchFn: fetch, refreshToken: accounts[key].refreshToken })
  accessToken = refreshed.accessToken
}
const result = await fetchAntigravityModels({ accessToken, projectId: parsed.projectId ?? '', fetchFn: fetch })
for (const [id, info] of Object.entries(result.raw ?? {})) {
  if (!/gemini-3|claude|gpt-oss/.test(id)) continue
  console.log(id, '|', JSON.stringify(info.displayName ?? info.name ?? null), '|', info.maxTokens ?? info.maxInputTokens ?? '')
}

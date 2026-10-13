// Live connectivity + catalog probe: reads the Antigravity account token from the store,
// calls fetchAvailableModels, and writes the raw model-id list to a debug file. Read-only.
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { parseAntigravitySession, fetchAntigravityModels, refreshAntigravityToken } from '../lib/providers/antigravity.js'

const storePath = path.join(homedir(), '.dsh', 'plugins', 'kimi-oauth', 'auth.json')
const raw = await readFile(storePath, 'utf8')
const doc = JSON.parse(raw)
const section = doc.antigravity ?? doc.antigravity ?? doc
const accounts = section.accounts ?? {}
for (const key of Object.keys(accounts)) {
  const parsed = parseAntigravitySession(accounts[key])
  if (parsed === undefined) {
    console.log('account', key, ': no session parsed')
    continue
  }
  console.log('\n=== account:', key, '===')
  console.log('projectId:', parsed.projectId)
  let accessToken = parsed.accessToken
  if (parsed.expiresAt <= Date.now()) {
    try {
      const refreshed = await refreshAntigravityToken({ fetchFn: fetch, refreshToken: accounts[key].refreshToken })
      accessToken = refreshed.accessToken
      console.log('token refreshed')
    } catch (e) {
      console.log('token refresh failed:', e.message)
      continue
    }
  }
  const result = await fetchAntigravityModels({
    accessToken,
    projectId: parsed.projectId ?? '',
    fetchFn: fetch,
  })
  const rawModels = result.raw ?? {}
  const rawIds = Object.keys(rawModels)
  const ids = result.entries.map((entry) => entry.id)
  console.log('RAW:', rawIds.length, 'KEPT:', ids.length)
  console.log('RAW ids:', rawIds.join(', '))
  console.log('KEPT ids:', ids.join(', '))
  console.log('DROPPED:', rawIds.filter((id) => !ids.includes(id)).join(', ') || '(none)')
  // Dump every model's provider + apiProvider + displayName so the callable grouping is visible.
  console.log('\nper-model provider/apiProvider:')
  for (const id of rawIds) {
    const m = rawModels[id]
    if (m && typeof m === 'object') {
      console.log(`  ${id}: provider=${m.modelProvider} api=${m.apiProvider} name=${m.displayName}`)
    }
  }
  await writeFile(
    path.join(homedir(), '.dsh', `antigravity-live-models-${key.replace(/[^a-z0-9]/gi, '_')}.json`),
    JSON.stringify({ account: key, projectId: parsed.projectId, raw: rawIds, kept: ids, models: rawModels }, null, 2),
    'utf8',
  )
}
console.log('\nwrote ~/.dsh/antigravity-live-models-<account>.json for each account')

// Live connectivity + catalog probe: reads the Antigravity account token from the store,
// calls fetchAvailableModels, and writes the raw model-id list to a debug file. Read-only.
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { parseAntigravitySession, fetchAntigravityModels } from '../lib/providers/antigravity.js'

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
      const { refreshAntigravityToken } = await import('../lib/providers/antigravity.js')
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
  // The picker row is the family; each level must still dispatch an id the account
  // itself listed. Printing the mapping is the check that no row can 404.
  const { wireIdFor } = await import('../lib/providers/antigravity-catalog.js')
  for (const entry of result.entries) {
    const ladder = (entry.reasoningEfforts ?? []).map((level) => `${level}→${wireIdFor(entry.id, level) ?? entry.id}`)
    console.log(`  row ${entry.id} | ${entry.name} | ${ladder.join(' ') || '(no ladder)'}`)
  }
  console.log('KEPT ids:', ids.join(', '))
  console.log('DROPPED:', rawIds.filter((id) => !ids.includes(id)).join(', ') || '(none)')
  // Flag which dropped ids are image / fast variants.
  const IMAGEish = /(?:^|[-_])(?:image|imagine|flash-image|draw|pic|photo)/i
  const FASTish = /(?:^|[-_])(?:fast|lightspeed|turbo|quick)/i
  const imageDropped = rawIds.filter((id) => !ids.includes(id) && IMAGEish.test(id))
  const fastDropped = rawIds.filter((id) => !ids.includes(id) && FASTish.test(id))
  console.log('image-like dropped:', imageDropped.join(', ') || '(none)')
  console.log('fast-like dropped:', fastDropped.join(', ') || '(none)')
  await writeFile(
    path.join(homedir(), '.dsh', `antigravity-live-models-${key.replace(/[^a-z0-9]/gi, '_')}.json`),
    JSON.stringify({ account: key, projectId: parsed.projectId, raw: rawIds, kept: ids, imageDropped, fastDropped }, null, 2),
    'utf8',
  )
}
console.log('\nwrote ~/.dsh/antigravity-live-models-<account>.json for each account')
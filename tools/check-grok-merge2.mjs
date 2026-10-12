// One-off: narrow down why a stored hand-added id is missing from the list.
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createGrokProvider } from '../lib/providers/grok.js'
import { ModelPreferences } from '../lib/settings.js'

const directory = await mkdtemp(path.join(tmpdir(), 'grok-merge-'))
const preferencesFile = path.join(directory, 'preferences.json')
await writeFile(preferencesFile, JSON.stringify({ extra: { grok: ['grok-4.7'] } }), 'utf8')
await writeFile(path.join(directory, 'auth.json'), JSON.stringify({}), 'utf8')

const preferences = new ModelPreferences(preferencesFile)
const route = createGrokProvider({
  credentialFile: path.join(directory, 'auth.json'),
  discovery: false,
  streamIdleTimeoutMs: 5_000,
  preferences,
})

console.log('prefs.extraIds:', JSON.stringify(await preferences.extraIds('grok')))
console.log('adapter own:   ', route.adapter.ownCatalogEntries().map((entry) => entry.id).join(', '))
console.log('adapter merged:', route.adapter.catalogEntries().map((entry) => entry.id).join(', '))
const status = await route.status()
console.log('settings:      ', status.models.map((model) => model.id).join(', '))

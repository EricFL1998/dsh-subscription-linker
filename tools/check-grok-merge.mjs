// One-off check: with `extra.grok = ["grok-4.7"]` stored, the Settings list and the
// picker must both offer it, exactly once, and re-adding must be idempotent.
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createGrokProvider } from '../lib/providers/grok.js'
import { ModelPreferences } from '../lib/settings.js'

const directory = await mkdtemp(path.join(tmpdir(), 'grok-merge-'))
const preferencesFile = path.join(directory, 'preferences.json')
const credentialFile = path.join(directory, 'auth.json')
await writeFile(preferencesFile, JSON.stringify({ extra: { grok: ['grok-4.7'] } }), 'utf8')
await writeFile(credentialFile, JSON.stringify({}), 'utf8')

const preferences = new ModelPreferences(preferencesFile)
const route = createGrokProvider({
  credentialFile,
  discovery: false,
  streamIdleTimeoutMs: 5_000,
  preferences,
})

const status = await route.status()
const settings = status.models.map((model) => model.id)
const picker = (await route.adapter.listModels('grok')).map((model) => model.id)

console.log('settings list:', settings.join(', '))
console.log('picker list:  ', picker.join(', '))
console.log('grok-4.7 in settings:', settings.includes('grok-4.7'), '| in picker:', picker.includes('grok-4.7'))
console.log('listed once:', settings.filter((id) => id === 'grok-4.7').length === 1)
console.log('marked hand-added:', status.models.find((model) => model.id === 'grok-4.7')?.userAdded === true)
console.log('resolves:', (await route.adapter.resolveModel('grok', 'grok-4.7')).id)

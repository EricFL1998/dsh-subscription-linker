// One-off: show a hand-added model row (and its remove control) in the preview.
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'tools/preview-entry.tsx'
let text = readFileSync(file, 'utf8')

const anchor = "      { id: 'k3-256k', name: 'Kimi K3 (256K)', contextWindow: 262_144, defaultEffort: 'max', inputModalities: ['text', 'image'], visible: true },\n"
if (!text.includes(anchor)) throw new Error('kimi model anchor missing')
text = text.replace(anchor, anchor +
  "      { id: 'k3-next', name: 'k3-next', description: 'Added by hand in Settings', contextWindow: 262_144, visible: true, userAdded: true },\n")

writeFileSync(file, text)
console.log('patched', file)

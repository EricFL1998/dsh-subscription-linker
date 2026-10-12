// One-off: repair a comment a shell escape mangled, and add the add-model state.
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'src/client/SubscriptionsSection.tsx'
let text = readFileSync(file, 'utf8')

// The bell character PowerShell's `a escape left in a JSDoc line.
const bell = String.fromCharCode(7)
if (text.includes(bell)) {
  text = text.split(`  /** Whether this route signs in at all; ${bell}uto does not. */`)
    .join('  /** Whether this route signs in at all; the auto provider does not. */')
  console.log('repaired the mangled comment')
}
if (text.includes(bell)) throw new Error('a bell character survives elsewhere')

const anchor = '  const hiddenCount = models.filter((model) => !model.visible).length\n'
if (!text.includes(anchor)) throw new Error('anchor missing')
text = text.replace(anchor, anchor + `  /** Whether the add-a-model-id field is open, and what has been typed. */
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
`)

writeFileSync(file, text)
console.log('patched', file)

// One-off: a refused refresh is a dead login, not a quota hiccup.
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'test/controller.spec.ts'
let text = readFileSync(file, 'utf8')

const anchor = `  test('a model added by hand is listed, is idempotent to add, and can be forgotten', async () => {`
if (!text.includes(anchor)) throw new Error('anchor missing')
text = text.replace(anchor, `  test('a refused grant is reported as a dead login, not a failed read', async () => {
    const { controller: subject } = withUsage(async () => {
      throw new Error('Kimi token refresh failed: The provided authorization grant is invalid')
    }, { reads: 0 })
    const result = await subject.usage(true)

    // The message names what the user must do, not the endpoint that refused.
    assert.equal(result.error, 'Test sign-in has expired; connect the account again')
    const status = await subject.status()
    assert.equal(status.usageError, 'Test sign-in has expired; connect the account again')
    assert.equal(status.accounts[0]?.needsLogin, true)

    // A fresh sign-in lifts the state, so the next read is not pre-judged.
    await subject.login()
    const after = await subject.status()
    assert.equal(after.accounts[0]?.needsLogin, undefined)
  })

  test('a transient failure is reported as itself', async () => {
    const { controller: subject } = withUsage(async () => {
      throw new Error('billing offline')
    }, { reads: 0 })
    const result = await subject.usage(true)
    assert.equal(result.error, 'billing offline')
    assert.equal((await subject.status()).accounts[0]?.needsLogin, undefined)
  })

${anchor}`)
writeFileSync(file, text)
console.log('patched', file)

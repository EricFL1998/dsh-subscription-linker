/**
 * Verify the Kimi fix against the live service.
 *
 * Two tiny streaming requests on the stored account: one for the id the endpoint now
 * wants (`k3`, which carries the 1M window) and one for the retired selector
 * (`k3[1m]`), whose refusal is what the adapter now repairs. Only the status, the SSE
 * head and the server's own error text are printed; the token is redacted.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = process.env.USERPROFILE ?? os.homedir()
const dataDir = path.join(home, '.dsh', 'plugins', 'kimi-oauth')
const auth = JSON.parse(fs.readFileSync(path.join(dataDir, 'auth.json'), 'utf8'))
const session = auth.kimi.accounts[auth.kimi.default]
const token = session.accessToken
const redact = (text) => text.split(token).join('<TOKEN>')

const version = '0.14.0'
const platform = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[process.platform] ?? process.platform
const headers = {
  'User-Agent': `KimiCLI/${version}`,
  'X-Msh-Platform': 'kimi_code_cli',
  'X-Msh-Version': version,
  'X-Msh-Device-Name': os.hostname(),
  'X-Msh-Device-Model': `${platform} ${os.release()} ${os.arch()}`,
  'X-Msh-Os-Version': os.release(),
  'X-Msh-Device-Id': fs.readFileSync(path.join(dataDir, 'kimi-device-id'), 'utf8').trim(),
  'authorization': `Bearer ${token}`,
  'accept': 'text/event-stream',
  'content-type': 'application/json',
}

for (const model of ['k3', 'k3[1m]', 'k3-256k']) {
  const response = await fetch('https://api.kimi.com/coding/v1/responses', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
      max_output_tokens: 16,
      store: false,
      stream: true,
    }),
  })
  const text = await response.text()
  console.log(`\n=== model=${model} -> HTTP ${response.status} ${response.statusText}`)
  if (response.ok) {
    const first = text.split('\n').find((line) => line.startsWith('data: ')) ?? text.slice(0, 200)
    console.log(`stream head: ${redact(first).slice(0, 220)}`)
  } else {
    console.log(redact(text.slice(0, 400)))
  }
}

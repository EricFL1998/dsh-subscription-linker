// Which token authenticates the OAuth poll: the locally generated one the desktop
// app uses, or the `poll_token` the server returns? Creates a throwaway login flow.
import { randomBytes } from 'node:crypto'

const local = randomBytes(32).toString('hex')
const init = await fetch('https://zcode.z.ai/api/v1/oauth/cli/init', {
  method: 'POST',
  headers: { authorization: `Bearer ${local}`, 'content-type': 'application/json' },
  body: JSON.stringify({ provider: 'bigmodel' }),
})
const payload = await init.json()
const data = payload.data ?? {}
const flowId = data.flow_id
const serverToken = data.poll_token
console.log('init:', init.status, 'flow:', flowId, 'authorize:', data.authorize_url)
console.log('local token length:', local.length, '| server poll_token length:', String(serverToken).length)

for (const [name, token] of [['local', local], ['server', serverToken], ['none', undefined]]) {
  const headers = token === undefined ? {} : { authorization: `Bearer ${token}` }
  const response = await fetch(`https://zcode.z.ai/api/v1/oauth/cli/poll/${flowId}`, { headers })
  const text = await response.text()
  console.log(`poll(${name}) -> HTTP ${response.status} ${text.slice(0, 200)}`)
}

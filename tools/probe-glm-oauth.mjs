// Verify ZCode's CLI-style OAuth init endpoint with the China provider.
// Creates a login flow only; it holds no credential and expires on its own.
import { randomBytes } from 'node:crypto'

const state = randomBytes(32).toString('hex')
const response = await fetch('https://zcode.z.ai/api/v1/oauth/cli/init', {
  method: 'POST',
  headers: {
    authorization: `Bearer ${state}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({ provider: 'bigmodel' }),
})
const text = await response.text()
console.log('HTTP', response.status)
console.log('body:', text.slice(0, 900))
try {
  const payload = JSON.parse(text)
  const data = payload?.data ?? {}
  console.log('code:', payload?.code, '| flow_id:', data.flow_id, '| poll_interval_sec:', data.poll_interval_sec, '| expires_at:', data.expires_at)
  if (typeof data.authorize_url === 'string') {
    const url = new URL(data.authorize_url)
    console.log('authorize host+path:', `${url.origin}${url.pathname}`)
    console.log('authorize params:', [...url.searchParams.keys()].join(', '))
    console.log('has state:', url.searchParams.has('state'))
  }
} catch (error) {
  console.log('not json:', error instanceof Error ? error.message : String(error))
}

// Does the Coding Plan accept an SSO/JWT-shaped bearer, or only an Ark API key?
// The error text distinguishes "wrong shape" from "unknown key".
const url = 'https://ark.cn-beijing.volces.com/api/coding/v3/responses'
const body = JSON.stringify({ model: 'ark-code-latest', input: 'ping' })

// A syntactically valid JWT (header.payload.signature), unsigned and fake.
const jwt = [
  Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({ sub: 'probe', iss: 'signin.volcengine.com' })).toString('base64url'),
  'not-a-real-signature',
].join('.')

const candidates = [
  ['JWT-shaped bearer (SSO id_token shape)', `Bearer ${jwt}`],
  ['uuid-shaped bearer (api-key shape)', `Bearer 11111111-2222-3333-4444-555555555555`],
  ['24-hex bearer', 'Bearer 0123456789abcdef01234567'],
]

for (const [label, authorization] of candidates) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
      body,
      signal: AbortSignal.timeout(20_000),
    })
    const text = (await response.text()).slice(0, 180).replace(/\s+/g, ' ')
    console.log(`${String(response.status).padEnd(4)} ${label}\n      ${text}\n`)
  } catch (error) {
    console.log(`ERR  ${label}: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

// Does the Coding Plan data plane accept a bearer API key, or only AK/SK signatures?
// A fake key that is *present* distinguishes "invalid" from "missing".
const url = 'https://ark.cn-beijing.volces.com/api/coding/v3/responses'
const body = JSON.stringify({ model: 'ark-code-latest', input: 'ping', stream: false })

for (const [label, headers] of [
  ['no credential', {}],
  ['fake bearer', { authorization: 'Bearer not-a-real-key' }],
  ['fake bearer + api-key header', { 'api-key': 'not-a-real-key' }],
  ['fake AK/SK-ish signature', {
    authorization: 'HMAC-SHA256 Credential=AKfake/20261012/cn-beijing/ark, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=deadbeef',
    'x-date': '20261012T000000Z',
    'x-content-sha256': 'deadbeef',
  }],
]) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
      signal: AbortSignal.timeout(20_000),
    })
    const text = (await response.text()).slice(0, 200).replace(/\s+/g, ' ')
    console.log(`${String(response.status).padEnd(4)} ${label}\n      ${text}\n`)
  } catch (error) {
    console.log(`ERR  ${label}: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

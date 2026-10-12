// Does Ark expose an OAuth surface at all? Unauthenticated probes: a 401/403 means
// the route exists and wants credentials; 404 means there is nothing there.
const candidates = [
  ['POST', 'https://ark.cn-beijing.volces.com/api/coding/v3/responses'],
  ['POST', 'https://ark.cn-beijing.volces.com/api/v3/chat/completions'],
  ['GET', 'https://ark.cn-beijing.volces.com/api/v3/models'],
  ['POST', 'https://ark.cn-beijing.volces.com/api/v3/oauth/token'],
  ['GET', 'https://ark.cn-beijing.volces.com/api/v3/oauth/authorize'],
  ['POST', 'https://ark.cn-beijing.volces.com/api/v3/device_authorization'],
  ['GET', 'https://ark.cn-beijing.volces.com/.well-known/openid-configuration'],
  ['GET', 'https://ark.cn-beijing.volces.com/.well-known/oauth-authorization-server'],
  ['GET', 'https://www.volcengine.com/.well-known/openid-configuration'],
  ['POST', 'https://iam.volcengineapi.com/oauth/token'],
]

for (const [method, url] of candidates) {
  try {
    const response = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      ...method === 'POST' ? { body: JSON.stringify({ model: 'ark-code-latest', input: [], messages: [] }) } : {},
      signal: AbortSignal.timeout(15_000),
    })
    const body = (await response.text()).slice(0, 150).replace(/\s+/g, ' ')
    console.log(`${String(response.status).padEnd(4)} ${method.padEnd(5)} ${url}\n      ${body}`)
  } catch (error) {
    console.log(`ERR  ${method.padEnd(5)} ${url}\n      ${error instanceof Error ? error.message : String(error)}`)
  }
}

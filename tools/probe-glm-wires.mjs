// Which wires does the China coding-plan host actually serve?
// Unauthenticated on purpose: a 401/403 means the route exists, 404 means it does not.
const candidates = [
  'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
  'https://open.bigmodel.cn/api/coding/paas/v4/responses',
  'https://open.bigmodel.cn/api/coding/paas/v4/messages',
  'https://open.bigmodel.cn/api/v1/responses',
  'https://open.bigmodel.cn/api/anthropic/v1/messages',
  'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  'https://api.z.ai/api/v1/responses',
  'https://api.z.ai/api/coding/paas/v4/chat/completions',
]

for (const url of candidates) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'glm-5.3', messages: [], input: [] }),
      signal: AbortSignal.timeout(15_000),
    })
    const body = (await response.text()).slice(0, 160).replace(/\s+/g, ' ')
    console.log(`${String(response.status).padEnd(4)} ${url}\n      ${body}`)
  } catch (error) {
    console.log(`ERR  ${url}\n      ${error instanceof Error ? error.message : String(error)}`)
  }
}

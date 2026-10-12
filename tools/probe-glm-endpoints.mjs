// Which model-list and quota endpoints exist on the China coding host?
// Unauthenticated: 401/403 = the route exists, 404 = it does not.
const candidates = [
  ['GET', 'https://open.bigmodel.cn/api/coding/paas/v4/models'],
  ['GET', 'https://open.bigmodel.cn/api/monitor/usage/quota/limit'],
  ['GET', 'https://open.bigmodel.cn/api/coding/paas/v4/usage'],
  ['GET', 'https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.14.5'],
  ['GET', 'https://zcode.z.ai/api/biz/customer/getCustomerInfo'],
  ['GET', 'https://open.bigmodel.cn/api/paas/v4/models'],
]

for (const [method, url] of candidates) {
  try {
    const response = await fetch(url, { method, signal: AbortSignal.timeout(15_000) })
    const body = (await response.text()).slice(0, 200).replace(/\s+/g, ' ')
    console.log(`${String(response.status).padEnd(4)} ${method} ${url}\n      ${body}`)
  } catch (error) {
    console.log(`ERR  ${method} ${url}\n      ${error instanceof Error ? error.message : String(error)}`)
  }
}

// One-off: cover the quota-probe origin order and weekly buckets in the fallback.
import { readFileSync, writeFileSync } from 'node:fs'

{
  const file = 'test/antigravity.spec.ts'
  let text = readFileSync(file, 'utf8')
  const anchor = text.trimEnd().endsWith('})') ? text.trimEnd() : text
  // Append a suite for the quota origins.
  text = `${anchor}

describe('the quota probe', () => {
  test('asks Google before the configured request base', async () => {
    const urls: string[] = []
    const adapter = new AntigravityAdapter({
      tokens: {
        resolve: async () => ({ account: 'a', accessToken: 'token', session: { projectId: 'proj' } }),
        session: async () => ({ account: 'a', session: { projectId: 'proj' } }),
      } as never,
      store: { get: async () => ({ projectId: 'proj' }) } as never,
      // A proxy that serves completions but has no accounting endpoint of its own.
      baseUrl: 'https://proxy.example/v1internal',
      fetchFn: (async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input)
        urls.push(url)
        if (url.startsWith('https://proxy.example')) return new Response('not found', { status: 404 })
        if (url.includes('retrieveUserQuotaSummary')) {
          return new Response(JSON.stringify({
            groups: [
              { displayName: 'Gemini Models', buckets: [
                { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.25 },
                { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.4 },
              ] },
              { displayName: 'Claude and GPT models', buckets: [
                { bucketId: '3p-5h', window: '5h', remainingFraction: 0.7 },
                { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.9 },
              ] },
            ],
          }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response('nope', { status: 404 })
      }) as never,
    })

    const read = await adapter.usage('token', 'proj')
    // Google's own host answers, so the proxy is never even asked.
    assert.equal(urls.every((url) => url.startsWith('https://daily-cloudcode-pa.googleapis.com')), true)
    assert.deepEqual(read.windows.map((window) => window.label), ['gemini', 'gemini_weekly', 'claude', 'claude_weekly'])
    assert.equal(read.windows[0]?.usedPercent, 75)
    assert.equal(read.windows[1]?.usedPercent, 60)
    assert.equal(read.usageError, undefined)
  })

  test('falls back to the configured base for the summary when Google is unreachable', async () => {
    const urls: string[] = []
    const adapter = new AntigravityAdapter({
      tokens: { resolve: async () => ({ account: 'a', accessToken: 'token', session: { projectId: 'proj' } }) } as never,
      store: { get: async () => ({ projectId: 'proj' }) } as never,
      baseUrl: 'https://proxy.example',
      fetchFn: (async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input)
        urls.push(url)
        if (url.startsWith('https://proxy.example') && url.includes('retrieveUserQuotaSummary')) {
          return new Response(JSON.stringify({
            groups: [{ displayName: 'Gemini Models', buckets: [{ window: 'weekly', remainingFraction: 0.5 }] }],
          }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response('blocked', { status: 403 })
      }) as never,
    })

    const read = await adapter.usage('token', 'proj')
    // Google was tried first and refused, then the configured base answered.
    assert.equal(urls[0]?.startsWith('https://daily-cloudcode-pa.googleapis.com'), true)
    assert.equal(urls.some((url) => url.startsWith('https://proxy.example')), true)
    assert.deepEqual(read.windows.map((window) => window.label), ['gemini_weekly'])
  })

  test('per-model figures stand in when the summary is gone, and say so', async () => {
    const adapter = new AntigravityAdapter({
      tokens: { resolve: async () => ({ account: 'a', accessToken: 'token', session: { projectId: 'proj' } }) } as never,
      store: { get: async () => ({ projectId: 'proj' }) } as never,
      fetchFn: (async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input)
        if (url.includes('retrieveUserQuotaSummary')) return new Response('gone', { status: 404 })
        return new Response(JSON.stringify({
          models: {
            'gemini-3.1-pro-low': { displayName: 'Gemini 3.1 Pro (Low)', quotaInfo: { remainingFraction: 0.3 } },
            'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6', quotaInfo: { remainingFraction: 0.1 } },
          },
          agentModelSorts: [{ groups: [{ modelIds: ['gemini-3.1-pro-low', 'claude-sonnet-4-6'] }] }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as never,
    })

    const read = await adapter.usage('token', 'proj')
    assert.deepEqual(read.windows.map((window) => window.label), ['gemini', 'claude'])
    assert.equal(read.windows[0]?.usedPercent, 70)
    assert.equal(read.windows[1]?.usedPercent, 90)
    // The substitute is labelled as one, so the page can say why.
    assert.match(read.usageError ?? '', /per-model figures/)
  })
})
`
  writeFileSync(file, text)
  console.log('patched', file)
}

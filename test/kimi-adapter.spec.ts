/** The kimi adapter: catalog resolution, wire request assembly, and streaming. */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createUserMessage, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

import { KimiAdapter } from '../src/providers/kimi.js'
import type { KimiAdapterOptions, KimiSession } from '../src/providers/kimi.js'
import { REAUTH_REQUIRED, ProviderError } from '../src/errors.js'
import type { TokenManager } from '../src/auth/tokens.js'
import { KIMI_CONTEXT_WINDOW, KIMI_LONG_CONTEXT_WINDOW } from '../src/constants.js'

/** A token manager that always answers with one usable token. */
function tokenManager(resolve?: TokenManager<KimiSession>['resolve']): TokenManager<KimiSession> {
  const manager = {
    resolve: resolve ?? (async () => ({ account: 'user-1', accessToken: 'token', expiresAt: Date.now() + 60_000 })),
    session: async () => ({ account: 'user-1', session: { accessToken: 'token', expiresAt: Date.now() + 60_000 } }),
    accounts: async () => ['user-1'],
    defaultAccount: async () => 'user-1',
  }
  return manager as unknown as TokenManager<KimiSession>
}

/** Adapter options with a recording fetch. */
function options(overrides: Partial<KimiAdapterOptions> = {}): KimiAdapterOptions {
  return {
    apiBase: 'https://api.kimi.com/coding/v1',
    discovery: false,
    streamIdleTimeoutMs: 5_000,
    tokens: tokenManager(),
    ...overrides,
  }
}

/** A minimal one-turn request. */
function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'kimi',
    model: 'kimi-for-coding',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })],
    ...overrides,
  }
}

/** Collect every chunk an adapter stream produces. */
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** An SSE response body for the given event objects. */
function sseResponse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

describe('KimiAdapter catalog', () => {
  test('describes the route it serves', () => {
    const adapter = new KimiAdapter(options())
    assert.deepEqual(adapter.providerInfo('kimi'), { id: 'kimi', name: 'Kimi Code' })
    assert.equal(adapter.providerRetryPolicy(), undefined)
  })

  test('lists the curated models in order', async () => {
    const adapter = new KimiAdapter(options())
    const models = await adapter.listModels('kimi')
    // The fast variant rides beside its row in the host-facing list: the host validates
    // a GUI selection against that list and refuses an unknown id, so the variant must
    // be present even though the picker's model seat shows only the row.
    assert.deepEqual(models.map((model) => model.id), ['kimi-for-coding', 'kimi-for-coding-highspeed', 'k3', 'k3[1m]', 'k3-256k'])
    assert.equal(models[0]?.provider, 'kimi')
    assert.deepEqual(models[0]?.inputModalities, ['text', 'image'])
  })

  test('resolves a model alias onto its curated entry', async () => {
    const adapter = new KimiAdapter(options())
    const resolved = await adapter.resolveModel('kimi', 'kimi-k2.7-code')
    assert.equal(resolved.id, 'kimi-for-coding')
    assert.equal(resolved.context?.contextWindow, KIMI_LONG_CONTEXT_WINDOW)
  })

  test('pairs the fast variant its own aliases name', async () => {
    const adapter = new KimiAdapter(options())
    // `kimi-for-coding-highspeed` is listed as an accepted id of the row, which is the
    // recognition the composer's quick-mode button needs — no discovery run required.
    assert.deepEqual(adapter.fastPairOf('kimi-for-coding'), {
      baseId: 'kimi-for-coding',
      wireId: 'kimi-for-coding-highspeed',
    })
    // Asked about the fast id itself — which is what the selection becomes — the pair
    // still names the row to switch back to.
    assert.deepEqual(adapter.fastPairOf('kimi-for-coding-highspeed'), {
      baseId: 'kimi-for-coding',
      wireId: 'kimi-for-coding-highspeed',
    })
    assert.equal(adapter.fastPairOf('k3'), undefined)
    // The fast id is present in the host-facing list — the host validates a selection
    // against that list — and it resolves under its own id so a fast selection is never
    // rewritten onto its base.
    const models = await adapter.listModels('kimi')
    assert.equal(models.some((model) => model.id === 'kimi-for-coding-highspeed'), true)
    const variant = models.find((model) => model.id === 'kimi-for-coding-highspeed') as { id: string, group?: string } | undefined
    assert.equal(variant?.group, 'kimi-for-coding')
    const resolved = await adapter.resolveModel('kimi', 'kimi-for-coding-highspeed')
    assert.equal(resolved.id, 'kimi-for-coding-highspeed')
    assert.equal(resolved.name, 'Kimi for Coding')
    assert.equal(resolved.context?.contextWindow, KIMI_LONG_CONTEXT_WINDOW)
  })

  test('folds a live fast id into the row it belongs to', async () => {
    const fetchFn: typeof fetch = async () =>
      Response.json({ data: [{ id: 'kimi-for-coding' }, { id: 'kimi-for-coding-turbo' }, { id: 'k3' }] })
    const adapter = new KimiAdapter(options({ discovery: true, fetchFn }))
    // The live variant is not a row of its own; it rides its row, and being live it
    // replaces the curated alias for that row.
    assert.deepEqual(await adapter.fetchCatalog('token'), ['kimi-for-coding', 'k3'])
    assert.deepEqual(adapter.fastPairOf('kimi-for-coding'), {
      baseId: 'kimi-for-coding',
      wireId: 'kimi-for-coding-turbo',
    })
  })

  test('exposes the reasoning ladder with its default', async () => {
    const adapter = new KimiAdapter(options())
    const resolved = await adapter.resolveModel('kimi', 'k3')
    assert.deepEqual(resolved.reasoning?.efforts.map((effort) => String(effort.id)), ['low', 'medium', 'high', 'max'])
    assert.equal(String(resolved.reasoning?.defaultEffort), 'max')
    assert.equal(resolved.context?.contextWindow, KIMI_CONTEXT_WINDOW)
    assert.equal(resolved.defaultMaxTokens, 32_000)
  })

  test('resolves an unknown model with the standard window and shared ladder', async () => {
    const adapter = new KimiAdapter(options())
    const resolved = await adapter.resolveModel('kimi', 'k3-next')
    assert.equal(resolved.id, 'k3-next')
    assert.equal(resolved.name, 'k3-next')
    assert.equal(resolved.context?.contextWindow, KIMI_CONTEXT_WINDOW)
    assert.equal(resolved.reasoning?.efforts.length, 4)
  })

  test('keeps every shipped model when the live list is narrower', async () => {
    const adapter = new KimiAdapter(options())
    adapter.discover(['kimi-for-coding', 'k3', 'k3-256k'])
    const models = await adapter.listModels('kimi')
    assert.deepEqual(models.map((model) => model.id), ['kimi-for-coding', 'kimi-for-coding-highspeed', 'k3', 'k3[1m]', 'k3-256k'])
  })

  test('appends live ids this build does not know', async () => {
    const adapter = new KimiAdapter(options())
    adapter.discover(['k3', 'k3-next', 'k3-next', 'kimi-k3'])
    const models = await adapter.listModels('kimi')
    assert.deepEqual(models.map((model) => model.id), ['kimi-for-coding', 'kimi-for-coding-highspeed', 'k3', 'k3[1m]', 'k3-256k', 'k3-next'])
    assert.match(models.at(-1)?.description ?? '', /model list/)
  })

  test('appends configured extra models', async () => {
    const adapter = new KimiAdapter(options({ extraModels: ['k3-next', 'k3'], discovery: true }))
    const models = await adapter.listModels('kimi')
    assert.deepEqual(models.map((model) => model.id), ['kimi-for-coding', 'kimi-for-coding-highspeed', 'k3', 'k3[1m]', 'k3-256k', 'k3-next'])
    assert.match(models.at(-1)?.description ?? '', /plugin configuration/)
  })
})

describe('KimiAdapter requests', () => {
  test('posts a Responses request with the expected knobs and headers', async () => {
    let seenUrl = ''
    let seenBody: Record<string, unknown> = {}
    let seenHeaders = new Headers()
    const fetchFn: typeof fetch = async (input, init) => {
      seenUrl = String(input)
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      seenHeaders = new Headers(init?.headers)
      return sseResponse([{ type: 'response.completed', response: {} }])
    }
    const adapter = new KimiAdapter(options({
      fetchFn,
      identityHeaders: async () => ({
        'User-Agent': 'KimiCLI/0.14.0',
        'X-Msh-Device-Id': 'a'.repeat(32),
      }),
    }))

    const chunks = await collect(adapter.stream(request({
      reasoningEffort: ReasoningEffortId('medium'),
      sessionId: 'session-1' as Branded<'SessionId'>,
      tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }],
      temperature: 0.7,
      system: 'be brief',
    })))

    assert.equal(seenUrl, 'https://api.kimi.com/coding/v1/responses')
    assert.equal(seenBody.model, 'kimi-for-coding')
    assert.equal(seenBody.stream, true)
    assert.equal(seenBody.store, false)
    assert.deepEqual(seenBody.include, ['reasoning.encrypted_content'])
    assert.equal(seenBody.prompt_cache_key, 'session-1')
    assert.deepEqual(seenBody.reasoning, { effort: 'high' })
    assert.equal(seenBody.instructions, 'be brief')
    // Kimi locks sampling on subscription coding models, so temperature is dropped.
    assert.equal(Object.hasOwn(seenBody, 'temperature'), false)
    assert.equal(seenBody.max_output_tokens, undefined)
    assert.deepEqual(seenBody.tools, [
      { type: 'function', name: 'read_file', description: 'Read', parameters: { type: 'object' }, strict: false },
    ])
    assert.equal(seenBody.tool_choice, 'auto')
    assert.equal(seenBody.parallel_tool_calls, true)
    assert.equal(seenHeaders.get('authorization'), 'Bearer token')
    assert.equal(seenHeaders.get('accept'), 'text/event-stream')
    assert.equal(seenHeaders.get('x-msh-device-id'), 'a'.repeat(32))
    assert.match(seenHeaders.get('user-agent') ?? '', /^KimiCLI\/0\.14\.0 deepseek-harness\//)
    // The empty completed response becomes a terminal failure chunk.
    assert.deepEqual(chunks.map((chunk) => chunk.type), ['finish'])
  })

  test('prepares a tool schema Moonshot refuses as declared', async () => {
    // Moonshot's reader walks no `$ref`: it stopped at `properties.actions`
    // (a reference carrying a `description` sibling) and, once that node was
    // inlined, one level deeper at `properties.actions.items`.
    let seenBody: Record<string, unknown> = {}
    const fetchFn: typeof fetch = async (_input, init) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return sseResponse([{ type: 'response.completed', response: {} }])
    }
    await collect(new KimiAdapter(options({ fetchFn })).stream(request({
      tools: [{
        name: 'capture_browser_scenario',
        description: 'Run a browser scenario',
        parameters: {
          type: 'object',
          properties: {
            actions: { $ref: '#/$defs/__schema12', description: 'Required sequence of explicit browser actions.' },
          },
          $defs: {
            __schema12: { minItems: 1, type: 'array', items: { $ref: '#/$defs/__schema13' } },
            __schema13: { type: 'object' },
          },
        },
      }],
    })))

    const tools = seenBody.tools as { parameters: Record<string, unknown> }[]
    assert.deepEqual(tools[0]?.parameters, {
      type: 'object',
      properties: {
        actions: {
          minItems: 1,
          type: 'array',
          items: { type: 'object' },
          description: 'Required sequence of explicit browser actions.',
        },
      },
    })
  })

  test('flattens a tool the endpoint cannot take whole, and says so once', async () => {
    // The endpoint refuses an expanded schema over its ceiling, and one refusal
    // fails the whole request, so the oversized tool keeps only its arguments.
    const warnings: string[] = []
    let seenBody: Record<string, unknown> = {}
    const fetchFn: typeof fetch = async (_input, init) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return sseResponse([{ type: 'response.completed', response: {} }])
    }
    const adapter = new KimiAdapter(options({ fetchFn, onWarn: (message) => warnings.push(message) }))
    const tools = [{
      name: 'compare_web_captures',
      description: 'Compare two captures',
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Array.from({ length: 800 }, (_, index) => [`field_${index}`, { type: 'string', description: 'x'.repeat(200) }]),
        ),
        required: ['field_0'],
      },
    }]

    await collect(adapter.stream(request({ tools })))
    await collect(adapter.stream(request({ tools })))

    const sent = (seenBody.tools as { parameters: Record<string, unknown> }[])[0]?.parameters as Record<string, unknown>
    assert.equal(Object.keys(sent.properties as object).length, 800)
    assert.deepEqual((sent.properties as Record<string, unknown>).field_0, { type: 'string' })
    assert.deepEqual(sent.required, ['field_0'])
    assert.ok(Buffer.byteLength(JSON.stringify(sent)) <= 64 * 1024, 'what is sent fits the endpoint')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /compare_web_captures/)
  })

  test('passes a max output cap through when the caller sets one', async () => {
    let seenBody: Record<string, unknown> = {}
    const fetchFn: typeof fetch = async (_input, init) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return sseResponse([{ type: 'response.completed', response: {} }])
    }
    await collect(new KimiAdapter(options({ fetchFn })).stream(request({ maxTokens: 1234 })))
    assert.equal(seenBody.max_output_tokens, 1234)
  })

  test('omits tool controls when the request declares no tools', async () => {
    let seenBody: Record<string, unknown> = {}
    const fetchFn: typeof fetch = async (_input, init) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return sseResponse([{ type: 'response.completed', response: {} }])
    }
    await collect(new KimiAdapter(options({ fetchFn })).stream(request()))
    assert.equal(Object.hasOwn(seenBody, 'tools'), false)
    assert.equal(Object.hasOwn(seenBody, 'tool_choice'), false)
  })

  test('streams a response into harness chunks', async () => {
    const fetchFn: typeof fetch = async () => sseResponse([
      { type: 'response.output_text.delta', item_id: 'i1', content_index: 0, delta: 'Hi' },
      { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 1 } } },
    ])
    const chunks = await collect(new KimiAdapter(options({ fetchFn })).stream(request()))
    assert.deepEqual(chunks.map((chunk) => chunk.type), ['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  })

  test('retries once with a forced refresh after a 401', async () => {
    let calls = 0
    const forced: boolean[] = []
    const fetchFn: typeof fetch = async () => {
      calls += 1
      return calls === 1
        ? new Response('unauthorized', { status: 401 })
        : sseResponse([{ type: 'response.completed', response: {} }])
    }
    const tokens = tokenManager(async (_account?: string, force?: boolean) => {
      forced.push(force === true)
      return { account: 'user-1', accessToken: 'token', expiresAt: Date.now() + 60_000 }
    })
    await collect(new KimiAdapter(options({ fetchFn, tokens })).stream(request()))
    assert.equal(calls, 2)
    assert.deepEqual(forced, [false, true])
  })

  test('reports a still-rejected credential and notifies the controller', async () => {
    const rejected: string[] = []
    const fetchFn: typeof fetch = async () => new Response('nope', { status: 403 })
    const adapter = new KimiAdapter(options({
      fetchFn,
      tokens: tokenManager(),
      onCredentialRejected: (account) => rejected.push(account),
    }))
    await assert.rejects(collect(adapter.stream(request())), (error: unknown) =>
      error instanceof LlmError && error.failure.code === 'INVALID_CREDENTIAL')
    assert.deepEqual(rejected, ['user-1'])
  })

  test('maps a missing login onto an actionable credential failure', async () => {
    const tokens = tokenManager(async () => {
      throw new ProviderError('no Kimi Code account is signed in', REAUTH_REQUIRED)
    })
    await assert.rejects(
      collect(new KimiAdapter(options({ tokens })).stream(request())),
      (error: unknown) => error instanceof LlmError
        && error.failure.code === 'INVALID_CREDENTIAL'
        && /Settings → Subscriptions/.test(error.message),
    )
  })

  test('surfaces a provider error body', async () => {    const fetchFn: typeof fetch = async () => new Response(
      JSON.stringify({ error: { message: 'model not found' } }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    )
    await assert.rejects(collect(new KimiAdapter(options({ fetchFn })).stream(request())), (error: unknown) =>
      error instanceof LlmError && error.failure.code === 'MODEL_NOT_FOUND' && /model not found/.test(error.message))
  })

  test('reports a rate limit with the provider delay', async () => {
    const fetchFn: typeof fetch = async () => new Response('slow down', {
      status: 429,
      headers: { 'retry-after': '30' },
    })
    await assert.rejects(collect(new KimiAdapter(options({ fetchFn })).stream(request())), (error: unknown) =>
      error instanceof LlmError && error.failure.code === 'RATE_LIMIT' && error.failure.providerRetryAfterMs === 30_000)
  })

  test('turns a transport failure into a network error', async () => {    const fetchFn: typeof fetch = async () => {
      throw new TypeError('fetch failed')
    }
    await assert.rejects(collect(new KimiAdapter(options({ fetchFn })).stream(request())), (error: unknown) =>
      error instanceof LlmError && error.failure.code === 'NETWORK')
  })

  test('reads the live catalog through the models endpoint', async () => {
    const seen: string[] = []
    const fetchFn: typeof fetch = async (input, init) => {
      seen.push(String(input))
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer token')
      return Response.json({ data: [{ id: 'k3' }, { id: 'k3-next' }, { id: 42 }] })
    }
    const adapter = new KimiAdapter(options({ discovery: true, fetchFn }))
    assert.deepEqual(await adapter.fetchCatalog('token'), ['k3', 'k3-next'])
    assert.deepEqual(seen, ['https://api.kimi.com/coding/v1/models'])
  })

  test('falls back quietly when discovery fails', async () => {
    const warnings: string[] = []
    const fetchFn: typeof fetch = async () => new Response('boom', { status: 500 })
    const adapter = new KimiAdapter(options({ discovery: true, fetchFn, onWarn: (message) => warnings.push(message) }))
    assert.equal(await adapter.fetchCatalog('token'), undefined)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /using the built-in catalog/)
  })

  test('does not consult the endpoint when discovery is off', async () => {
    let called = false
    const fetchFn: typeof fetch = async () => {
      called = true
      return Response.json({ data: [] })
    }
    const adapter = new KimiAdapter(options({ discovery: false, fetchFn }))
    assert.equal(await adapter.fetchCatalog('token'), undefined)
    assert.equal(called, false)
  })
})

describe('KimiAdapter model order', () => {
  /** Capture the body of the next request. */
  function recorder(): { fetchFn: typeof fetch, body(): Record<string, unknown> } {
    let body: Record<string, unknown> = {}
    const fetchFn: typeof fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return sseResponse([{ type: 'response.completed', response: {} }])
    }
    return { fetchFn, body: () => body }
  }

  test('a bad request is reported, not retried elsewhere', async () => {
    const seen: string[] = []
    const fetchFn: typeof fetch = async (_input, init) => {
      seen.push((JSON.parse(String(init?.body)) as { model: string }).model)
      return new Response('{"error":{"message":"invalid input"}}', { status: 400, headers: { 'content-type': 'application/json' } })
    }
    const adapter = new KimiAdapter(options({ fetchFn }))
    await assert.rejects(collect(adapter.stream(request())), (error: unknown) =>
      error instanceof LlmError && /invalid input/.test(error.message))
    assert.deepEqual(seen, ['kimi-for-coding'])
  })

  test('a refusal is reported rather than answered by another model', async () => {
    const seen: string[] = []
    const fetchFn: typeof fetch = async (_input, init) => {
      seen.push((JSON.parse(String(init?.body)) as { model: string }).model)
      return new Response('slow down', { status: 429 })
    }
    const adapter = new KimiAdapter(options({ fetchFn }))
    await assert.rejects(collect(adapter.stream(request({ model: 'k3' }))))
    assert.deepEqual(seen, ['k3'])
  })

  test('a hand-added model id joins the catalog and resolves', async () => {
    const adapter = new KimiAdapter(options({ userModels: async () => ['k3-next'] }))
    assert.deepEqual(
      (await adapter.listModels('kimi')).map((model) => model.id),
      ['kimi-for-coding', 'kimi-for-coding-highspeed', 'k3', 'k3[1m]', 'k3-256k', 'k3-next'],
    )
    // It has no shipped metadata, so the standard window is advertised.
    const resolved = await adapter.resolveModel('kimi', 'k3-next')
    assert.equal(resolved.id, 'k3-next')
    assert.equal(resolved.context?.contextWindow, KIMI_CONTEXT_WINDOW)

    // One it already ships is not duplicated by a hand-added copy.
    const known = new KimiAdapter(options({ userModels: async () => ['k3'] }))
    assert.deepEqual(
      (await known.listModels('kimi')).map((model) => model.id),
      ['kimi-for-coding', 'kimi-for-coding-highspeed', 'k3', 'k3[1m]', 'k3-256k'],
    )
  })

  test('an unreadable hand-added list is reported, not fatal', async () => {
    const warnings: string[] = []
    const adapter = new KimiAdapter(options({
      userModels: async () => { throw new Error('disk offline') },
      onWarn: (message) => warnings.push(message),
    }))
    assert.equal((await adapter.listModels('kimi')).length, 5)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /user-added models unavailable/)
  })

  test('a concrete model id still dispatches unchanged', async () => {
    const { fetchFn, body } = recorder()
    const adapter = new KimiAdapter(options({ fetchFn }))
    await collect(adapter.stream(request({ model: 'k3[1m]' })))
    assert.equal(body().model, 'k3[1m]')
  })
})

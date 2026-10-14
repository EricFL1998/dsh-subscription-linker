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

/**
 * The listing the Kimi Code endpoint answered with, captured from the live service.
 *
 * The catalog is derived from this and nothing else, so every test that cares what the
 * picker shows states the listing it should be derived from. `k3` carries 1M here, which
 * is the fact the endpoint corrected: it retired the `k3[1m]` selector and folded the
 * window into the plain id.
 */
const LISTING: readonly unknown[] = [
  {
    id: 'kimi-for-coding',
    display_name: 'K2.8 Preview',
    context_length: 1_048_576,
    modalities: { input: ['text', 'image', 'video'], output: ['text'] },
    think_efforts: { support: true, valid_efforts: ['low', 'high', 'max'], default_effort: 'max' },
  },
  {
    id: 'kimi-for-coding-highspeed',
    display_name: 'K2.7 Code Highspeed',
    context_length: 262_144,
    modalities: { input: ['text', 'image'], output: ['text'] },
  },
  {
    id: 'k3',
    display_name: 'K3',
    context_length: 1_048_576,
    modalities: { input: ['text', 'image'], output: ['text'] },
    think_efforts: { support: true, valid_efforts: ['low', 'high', 'max'], default_effort: 'high' },
  },
  {
    id: 'k3-256k',
    display_name: 'K3-256k',
    context_length: 262_144,
    modalities: { input: ['text', 'image'], output: ['text'] },
    think_efforts: { support: true, valid_efforts: ['low', 'high', 'max'], default_effort: 'high' },
  },
]

/** Adapter options with a recording fetch and one cached listing. */
function options(overrides: Partial<KimiAdapterOptions> = {}): KimiAdapterOptions {
  return {
    apiBase: 'https://api.kimi.com/coding/v1',
    discovery: false,
    streamIdleTimeoutMs: 5_000,
    tokens: tokenManager(),
    cachedListing: async () => LISTING,
    ...overrides,
  }
}

/** Adapter options with no cached listing: a first run that has neither fetched nor cached. */
function cold(overrides: Partial<KimiAdapterOptions> = {}): KimiAdapterOptions {
  const base: KimiAdapterOptions = { ...options(), ...overrides }
  delete (base as { cachedListing?: () => Promise<unknown> }).cachedListing
  return base
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

/** Capture the body of the next wire request. */
function recorder(): { fetchFn: typeof fetch, body(): Record<string, unknown> } {
  let body: Record<string, unknown> = {}
  const fetchFn: typeof fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return sseResponse([{ type: 'response.completed', response: {} }])
  }
  return { fetchFn, body: () => body }
}

describe('KimiAdapter catalog', () => {
  test('describes the route it serves', () => {
    const adapter = new KimiAdapter(options())
    assert.deepEqual(adapter.providerInfo('kimi'), { id: 'kimi', name: 'Kimi Code' })
    assert.equal(adapter.providerRetryPolicy(), undefined)
  })

  test('publishes what the endpoint last listed, with the endpoint own metadata', async () => {
    const adapter = new KimiAdapter(options())
    const models = await adapter.listModels('kimi')
    // Membership, names and windows are the listing's, not a table this build ships. Note
    // that `k3` is 1M here: the endpoint folded the long window into the plain id.
    assert.deepEqual(models.map((model) => model.id), ['kimi-for-coding', 'k3', 'k3-256k'])
    assert.equal(models[0]?.name, 'K2.8 Preview')
    assert.equal(models[0]?.provider, 'kimi')
    // `video` is not in the harness vocabulary, so it is not advertised.
    assert.deepEqual(models[0]?.inputModalities, ['text', 'image'])
    assert.equal((await adapter.resolveModel('kimi', 'k3')).context?.contextWindow, KIMI_LONG_CONTEXT_WINDOW)
    assert.equal((await adapter.resolveModel('kimi', 'k3-256k')).context?.contextWindow, KIMI_CONTEXT_WINDOW)
  })

  test('a picker query never asks the endpoint', async () => {
    let calls = 0
    const fetchFn: typeof fetch = async () => {
      calls += 1
      throw new Error('the picker must not fetch')
    }
    const adapter = new KimiAdapter(options({ fetchFn }))
    // The cached listing is the table; a query renders it and nothing else.
    assert.equal((await adapter.listModels('kimi')).length, 3)
    await adapter.resolveModel('kimi', 'k3')
    assert.equal(calls, 0)
  })

  test('a listing decides both membership and metadata, with no shipped table', async () => {
    // A listing from a future service: one model this build never heard of, and no `k3`
    // at all. It is published as the endpoint states it, not as this build remembers it.
    const adapter = new KimiAdapter(options({
      cachedListing: async () => [
        { id: 'k4', display_name: 'K4', context_length: 2_097_152 },
        { id: 'k3', display_name: 'K3', context_length: 1_048_576 },
      ],
    }))
    const models = await adapter.listModels('kimi')
    assert.deepEqual(models.map((model) => model.id), ['kimi-for-coding', 'k4', 'k3'])
    const resolved = await adapter.resolveModel('kimi', 'k4')
    assert.equal(resolved.name, 'K4')
    assert.equal(resolved.context?.contextWindow, 2_097_152)
    // A model the listing omits is not offered, however familiar its id is.
    assert.equal(adapter.catalogEntries().some((entry) => entry.id === 'k3-256k'), false)
  })

  test('the retired k3[1m] selector is never a row and answers as k3', async () => {
    const adapter = new KimiAdapter(options())
    assert.equal((await adapter.listModels('kimi')).some((model) => model.id === 'k3[1m]'), false)
    // A session that saved the old spelling answers with the model that replaced it, and
    // the 1M window the endpoint now folds into `k3`.
    const resolved = await adapter.resolveModel('kimi', 'k3[1m]')
    assert.equal(resolved.id, 'k3')
    assert.equal(resolved.name, 'K3')
    assert.equal(resolved.context?.contextWindow, KIMI_LONG_CONTEXT_WINDOW)
  })

  test('a model the listing does not name resolves conservatively', async () => {
    const adapter = new KimiAdapter(options())
    // The endpoint is the authority on ids this build has never seen: `k4` may serve even
    // though no cached listing mentions it yet, so it is not refused here.
    const resolved = await adapter.resolveModel('kimi', 'k4')
    assert.equal(resolved.id, 'k4')
    assert.equal(resolved.context?.contextWindow, KIMI_CONTEXT_WINDOW)
  })

  test('the endpoint can rename a model mid-session and the next turn follows', async () => {
    // The endpoint's own refusal names the id to use; that answer is worth more than any
    // table this build ships, so the turn is retried and later turns go straight there.
    // The body below is verbatim from the live service.
    const refusal = JSON.stringify({
      error: {
        message: 'Your model id does not exist, recognized as other:k9. Please set model id as `k9-preview`.',
        type: 'invalid_authentication_error',
      },
    })
    const seen: string[] = []
    const fetchFn: typeof fetch = async (_input, init) => {
      const model = (JSON.parse(String(init?.body)) as { model: string }).model
      seen.push(model)
      if (model === 'k9') {
        return new Response(refusal, { status: 401, headers: { 'content-type': 'application/json' } })
      }
      return sseResponse([{ type: 'response.completed', response: {} }])
    }
    const warnings: string[] = []
    const adapter = new KimiAdapter(options({ fetchFn, onWarn: (message) => warnings.push(message) }))
    await collect(adapter.stream(request({ model: 'k9' })))
    assert.deepEqual(seen, ['k9', 'k9-preview'])
    assert.match(warnings.join('\n'), /model k9 is retired; using k9-preview/)
    // The rename is remembered, so the refused request is paid once.
    await collect(adapter.stream(request({ model: 'k9' })))
    assert.deepEqual(seen, ['k9', 'k9-preview', 'k9-preview'])
  })

  test('an unknown model does not mark the account as needing a new login', async () => {
    // A 401 for a model id is not a credential failure: refreshing the token and flagging
    // the account would both be wrong, and would hide the real cause.
    const rejected: string[] = []
    const forced: boolean[] = []
    const manager = tokenManager(async (account?, force?) => {
      forced.push(force === true)
      return { account: account ?? 'user-1', accessToken: 'token', expiresAt: Date.now() + 60_000 }
    })
    const fetchFn: typeof fetch = async () => new Response(JSON.stringify({
      error: { message: 'Your model id does not exist, recognized as other:k9. Please set model id as `k9-preview`' },
    }), { status: 401, headers: { 'content-type': 'application/json' } })
    const adapter = new KimiAdapter(options({
      fetchFn,
      tokens: manager,
      onCredentialRejected: (account) => rejected.push(account),
    }))
    await assert.rejects(collect(adapter.stream(request({ model: 'k9' }))))
    assert.deepEqual(rejected, [])
    assert.deepEqual(forced, [false])
  })

  test('pairs the fast variant the listing names', async () => {
    const adapter = new KimiAdapter(options())
    await adapter.hydrate()
    // `kimi-for-coding-highspeed` is a row of the listing; it is recognized as a variant of
    // the row whose id it extends, which is the recognition the quick-mode button needs.
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
    // The host-facing list holds the row under its own id — the host validates every GUI
    // selection against that list — so the picker always offers a way back to the
    // standard model. The fast id is a wire id, not a picker row.
    const models = await adapter.listModels('kimi')
    assert.equal(models.some((model) => model.id === 'kimi-for-coding-highspeed'), false)
    assert.equal(models.some((model) => model.id === 'kimi-for-coding'), true)
    const resolved = await adapter.resolveModel('kimi', 'kimi-for-coding-highspeed')
    // A variant is a wire id, not a row, so a stale selection of one resolves onto the row
    // that owns it — with the row's own name and window, which is what the listing stated.
    assert.equal(resolved.id, 'kimi-for-coding')
    assert.equal(resolved.name, 'K2.8 Preview')
    assert.equal(resolved.context?.contextWindow, KIMI_LONG_CONTEXT_WINDOW)
    // The row carries the `fast` rung, which is what the quick-mode button selects.
    assert.equal(
      (await adapter.resolveModel('kimi', 'kimi-for-coding')).reasoning?.efforts
        .some((effort) => String(effort.id) === 'highspeed'),
      true,
    )
  })

  test('folds a live variant into the row it belongs to, and caches the listing', async () => {
    const saved: unknown[] = []
    const fetchFn: typeof fetch = async () =>
      Response.json({ data: [{ id: 'kimi-for-coding' }, { id: 'kimi-for-coding-turbo' }, { id: 'k3' }] })
    const adapter = new KimiAdapter(cold({
      discovery: true,
      fetchFn,
      saveListing: async (payload) => { saved.push(payload) },
    }))
    // The variant is not a row of its own; it rides its row, and the ids the fetch reports
    // are the rows the picker shows.
    assert.deepEqual(await adapter.fetchCatalog('token'), ['kimi-for-coding', 'k3'])
    assert.deepEqual(adapter.fastPairOf('kimi-for-coding'), {
      baseId: 'kimi-for-coding',
      wireId: 'kimi-for-coding-turbo',
    })
    // The endpoint's own rows are what is cached, verbatim, so the next session derives
    // the same table without asking again.
    assert.deepEqual(saved, [[{ id: 'kimi-for-coding' }, { id: 'kimi-for-coding-turbo' }, { id: 'k3' }]])
    assert.deepEqual((await adapter.listModels('kimi')).map((model) => model.id), ['kimi-for-coding', 'k3'])
  })

  test('a failed listing keeps the last catalog and says so once', async () => {
    const warnings: string[] = []
    const fetchFn: typeof fetch = async () => new Response('nope', { status: 503 })
    const adapter = new KimiAdapter(cold({
      discovery: true,
      fetchFn,
      onWarn: (message) => warnings.push(message),
    }))
    assert.equal(await adapter.fetchCatalog('token'), undefined)
    assert.match(warnings.join('\n'), /Kimi model discovery failed \(HTTP 503\)/)
    // The fetch failed, so there is no listing: only the configured default is offered.
    assert.deepEqual((await adapter.listModels('kimi')).map((model) => model.id), ['kimi-for-coding'])
  })

  test('exposes the reasoning ladder the listing stated', async () => {
    const adapter = new KimiAdapter(options())
    const resolved = await adapter.resolveModel('kimi', 'k3')
    // The ladder is the endpoint's (`low`, `high`, `max`), not a shipped ladder, and its
    // default is the endpoint's too.
    assert.deepEqual(resolved.reasoning?.efforts.map((effort) => String(effort.id)), ['low', 'high', 'max'])
    assert.equal(String(resolved.reasoning?.defaultEffort), 'high')
    assert.equal(resolved.context?.contextWindow, KIMI_LONG_CONTEXT_WINDOW)
    assert.equal(resolved.defaultMaxTokens, 32_000)
  })

  test('offers the fast rung beside the ladder for a row that has a variant', async () => {
    const adapter = new KimiAdapter(options())
    const resolved = await adapter.resolveModel('kimi', 'kimi-for-coding')
    assert.deepEqual(
      resolved.reasoning?.efforts.map((effort) => String(effort.id)),
      ['low', 'high', 'max', 'highspeed'],
    )
    assert.equal(String(resolved.reasoning?.defaultEffort), 'max')
  })

  test('resolves an unknown model with the standard window and shared ladder', async () => {
    const adapter = new KimiAdapter(options())
    const resolved = await adapter.resolveModel('kimi', 'k3-next')
    assert.equal(resolved.id, 'k3-next')
    assert.equal(resolved.name, 'k3-next')
    assert.equal(resolved.context?.contextWindow, KIMI_CONTEXT_WINDOW)
    // The ladder is borrowed from the route's default model, which the listing described.
    assert.deepEqual(resolved.reasoning?.efforts.map((effort) => String(effort.id)), ['low', 'high', 'max'])
  })

  test('appends configured extra models after the listing', async () => {
    const adapter = new KimiAdapter(options({ extraModels: ['k3-next', 'k3'] }))
    const models = await adapter.listModels('kimi')
    assert.deepEqual(models.map((model) => model.id), ['kimi-for-coding', 'k3', 'k3-256k', 'k3-next'])
    assert.match(models.at(-1)?.description ?? '', /plugin configuration/)
  })

  test('always offers the configured default model', async () => {
    const adapter = new KimiAdapter(options({
      defaultModel: 'kimi-for-coding',
      cachedListing: async () => [{ id: 'k3', display_name: 'K3', context_length: 1_048_576 }],
    }))
    // A subscription that re-points its alias at a new release follows the config: the
    // model the picker preselects stays selectable even when this listing omits it.
    assert.deepEqual(
      (await adapter.listModels('kimi')).map((model) => model.id),
      ['kimi-for-coding', 'k3'],
    )
  })

  test('offers only the configured default before any listing exists', async () => {
    const adapter = new KimiAdapter(cold())
    // A first run that has neither fetched nor cached anything: the picker can still
    // select the model the route preselects, and nothing else is invented.
    assert.deepEqual((await adapter.listModels('kimi')).map((model) => model.id), ['kimi-for-coding'])
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
    assert.match(warnings[0] ?? '', /keeping the last catalog/)
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
      ['kimi-for-coding', 'k3', 'k3-256k', 'k3-next'],
    )
    // It has no shipped metadata, so the standard window is advertised.
    const resolved = await adapter.resolveModel('kimi', 'k3-next')
    assert.equal(resolved.id, 'k3-next')
    assert.equal(resolved.context?.contextWindow, KIMI_CONTEXT_WINDOW)

    // One the listing already names is not duplicated by a hand-added copy.
    const known = new KimiAdapter(options({ userModels: async () => ['k3'] }))
    assert.deepEqual(
      (await known.listModels('kimi')).map((model) => model.id),
      ['kimi-for-coding', 'k3', 'k3-256k'],
    )
  })

  test('an unreadable hand-added list is reported, not fatal', async () => {
    const warnings: string[] = []
    const adapter = new KimiAdapter(options({
      userModels: async () => { throw new Error('disk offline') },
      onWarn: (message) => warnings.push(message),
    }))
    assert.equal((await adapter.listModels('kimi')).length, 3)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /user-added models unavailable/)
  })

  test('a retired selector dispatches as the model it now names', async () => {
    const { fetchFn, body } = recorder()
    const adapter = new KimiAdapter(options({ fetchFn }))
    // `k3[1m]` is retired (HTTP 401): the endpoint serves the 1M window as plain
    // `k3`, so a session that saved the old spelling folds onto it at dispatch.
    await collect(adapter.stream(request({ model: 'k3[1m]' })))
    assert.equal(body().model, 'k3')
  })

  test('a model id this build does not know dispatches unchanged', async () => {
    const { fetchFn, body } = recorder()
    const adapter = new KimiAdapter(options({ fetchFn }))
    await collect(adapter.stream(request({ model: 'k3-next' })))
    assert.equal(body().model, 'k3-next')
  })

  test('the fast rung dispatches the highspeed variant under the row id', async () => {
    const { fetchFn, body } = recorder()
    const adapter = new KimiAdapter(options({ fetchFn }))
    // The listing is what names the variant, so the table is loaded before dispatch — the
    // same order the host uses, which resolves the model before it generates.
    await adapter.hydrate()
    // The selection keeps the row's own id — that is what the host validated — and the
    // request goes to the variant, with no `fast` effort sent as a thinking budget.
    await collect(adapter.stream(request({ model: 'kimi-for-coding', reasoningEffort: ReasoningEffortId('highspeed') })))
    assert.equal(body().model, 'kimi-for-coding-highspeed')
    assert.equal(body().reasoning_effort, undefined)
  })
})

/** The antigravity route: OAuth, project discovery, catalog, envelope, streaming. */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createUserMessage, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, RequestMessage, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'

import { REAUTH_REQUIRED, ProviderError } from '../src/errors.js'
import type { TokenManager } from '../src/auth/tokens.js'
import {
  ANTIGRAVITY_AUTHORIZE_URL,
  ANTIGRAVITY_CALLBACK_PORT,
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_SCOPES,
  AntigravityAdapter,
  callInternal,
  discoverAntigravityAccount,
  exchangeAntigravityCode,
  parseAntigravitySession,
  parseGoogleTokenPayload,
  refreshAntigravityToken,
} from '../src/providers/antigravity.js'
import type { AntigravityAdapterOptions, AntigravitySession } from '../src/providers/antigravity.js'
import {
  AntigravityStreamTranslator,
  antigravityReasoning,
  antigravityThinking,
  mapAntigravityUsage,
  streamAntigravity,
  toAntigravityContents,
  toAntigravityRequest,
  toAntigravityTools,
} from '../src/translate/antigravity.js'

/** A JSON response. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** An SSE response of Antigravity frames. */
function sseResponse(frames: unknown[]): Response {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** A token manager that answers with one usable session. */
function tokenManager(session?: Partial<AntigravitySession>): TokenManager<AntigravitySession> {
  const held: AntigravitySession = {
    accessToken: 'token',
    expiresAt: Date.now() + 60_000,
    projectId: 'project-1',
    ...session,
  }
  return {
    resolve: async () => ({ account: 'user-1', accessToken: held.accessToken, expiresAt: held.expiresAt }),
    session: async () => ({ account: 'user-1', session: held }),
    accounts: async () => ['user-1'],
    defaultAccount: async () => 'user-1',
  } as unknown as TokenManager<AntigravitySession>
}

/** Adapter options with a recording fetch. */
function adapterOptions(overrides: Partial<AntigravityAdapterOptions> = {}): AntigravityAdapterOptions {
  return {
    discovery: false,
    streamIdleTimeoutMs: 5_000,
    tokens: tokenManager(),
    ...overrides,
  }
}

/** A minimal one-turn request. */
function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'antigravity',
    model: 'gemini-3-pro',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })],
    ...overrides,
  }
}

/**
 * A durable assistant turn.
 *
 * The envelope reads message content only, so the identity fields a session log
 * carries are filled with the minimum the types require.
 */
function assistantMessage(content: ContentBlock[]): RequestMessage {
  return {
    role: 'assistant',
    id: 'msg-assistant',
    source: { kind: 'model', provider: 'antigravity', model: 'gemini-3-pro' },
    content,
  } as unknown as RequestMessage
}

/** A durable tool result for one call. */
function toolMessage(callId: string, text: string, isError = false): RequestMessage {
  return {
    role: 'tool',
    id: `msg-tool-${callId}`,
    source: { kind: 'tool', callId },
    toolCallId: callId,
    ...isError ? { isError: true } : {},
    content: [{ type: 'text', text }],
  } as unknown as RequestMessage
}

/** Collect every chunk a stream produces. */
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('Antigravity OAuth constants', () => {
  test('pins the desktop client and its scopes', () => {
    assert.match(ANTIGRAVITY_CLIENT_ID, /apps\.googleusercontent\.com$/)
    assert.equal(ANTIGRAVITY_CALLBACK_PORT, 51121)
    assert.equal(ANTIGRAVITY_AUTHORIZE_URL, 'https://accounts.google.com/o/oauth2/v2/auth')
    assert.equal(ANTIGRAVITY_SCOPES.includes('https://www.googleapis.com/auth/cclog'), true)
    // The cloud-platform scope is what makes the project discoverable.
    assert.equal(ANTIGRAVITY_SCOPES.includes('https://www.googleapis.com/auth/cloud-platform'), true)
  })
})

describe('parseAntigravitySession', () => {
  const base = { accessToken: 'a', projectId: 'p', expiresAt: 1 }

  test('accepts a complete session and rejects the rest', () => {
    assert.deepEqual(parseAntigravitySession(base), base)
    assert.equal(parseAntigravitySession({ ...base, projectId: '' }), undefined)
    assert.equal(parseAntigravitySession({ ...base, expiresAt: 'soon' }), undefined)
    assert.equal(parseAntigravitySession('nope'), undefined)
  })

  test('keeps the plan when one was recorded', () => {
    assert.equal(parseAntigravitySession({ ...base, plan: 'Antigravity Pro' })?.plan, 'Antigravity Pro')
  })
})

describe('Google token handling', () => {
  test('computes an absolute expiry from the granted lifetime', () => {
    const before = Date.now()
    const tokens = parseGoogleTokenPayload({ access_token: 'a', refresh_token: 'r', expires_in: 3600 })
    assert.equal(tokens.accessToken, 'a')
    assert.equal(tokens.refreshToken, 'r')
    assert.ok(tokens.expiresAt >= before + 3_600_000)
  })

  test('rejects a payload without a usable lifetime', () => {
    assert.throws(() => parseGoogleTokenPayload({ access_token: 'a' }), /missing required fields/)
    assert.throws(() => parseGoogleTokenPayload({ expires_in: 10 }), /missing required fields/)
  })

  test('exchanges a code with PKCE and the desktop client', async () => {
    let body = ''
    const fetchFn: typeof fetch = async (_input, init) => {
      body = String(init?.body ?? '')
      return jsonResponse({ access_token: 'a', refresh_token: 'r', expires_in: 60 })
    }
    const tokens = await exchangeAntigravityCode({
      fetchFn,
      code: 'the-code',
      redirectUri: `http://127.0.0.1:${String(ANTIGRAVITY_CALLBACK_PORT)}/oauth-callback`,
      verifier: 'verifier-1',
    })
    assert.equal(tokens.accessToken, 'a')
    assert.match(body, /grant_type=authorization_code/)
    assert.match(body, new RegExp(`client_id=${ANTIGRAVITY_CLIENT_ID}`))
    assert.match(body, /code_verifier=verifier-1/)
    assert.match(body, /redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A51121%2Foauth-callback/)
  })

  test('a refused refresh is a re-authentication failure', async () => {
    const fetchFn: typeof fetch = async () => jsonResponse({ error: 'invalid_grant' }, 400)
    await assert.rejects(
      refreshAntigravityToken({ fetchFn, refreshToken: 'old' }),
      (error: unknown) => error instanceof ProviderError && error.code === REAUTH_REQUIRED,
    )
  })
})

describe('project discovery', () => {
  test('reads an existing project and the plan', async () => {
    const fetchFn: typeof fetch = async (input) => {
      if (String(input).includes('userinfo')) return jsonResponse({ email: 'A@B.c' })
      return jsonResponse({ cloudaicompanionProject: 'project-9', paidTier: { name: 'Antigravity Pro' } })
    }
    const account = await discoverAntigravityAccount('token', { fetchFn })
    assert.equal(account.projectId, 'project-9')
    assert.equal(account.account, 'a@b.c')
    assert.equal(account.plan, 'Antigravity Pro')
  })

  test('accepts the nested project shape', async () => {
    const fetchFn: typeof fetch = async () => jsonResponse({ cloudaicompanionProject: { id: 'nested-project' } })
    assert.equal((await discoverAntigravityAccount('token', { fetchFn })).projectId, 'nested-project')
  })

  test('onboards when loadCodeAssist reports no project yet', async () => {
    let onboarded = false
    const fetchFn: typeof fetch = async (input) => {
      if (String(input).includes('onboardUser')) {
        onboarded = true
        return jsonResponse({ done: true, response: { cloudaicompanionProject: 'new-project' } })
      }
      if (String(input).includes('userinfo')) return jsonResponse({ email: 'a@b.c' })
      return jsonResponse({ cloudaicompanionProject: null, allowedTiers: [{ id: 'FREE', isDefault: true }] })
    }
    const account = await discoverAntigravityAccount('token', { fetchFn })
    assert.equal(account.projectId, 'new-project')
    assert.equal(onboarded, true)
  })

  test('refuses to invent a project when onboarding grants none', async () => {
    const fetchFn: typeof fetch = async () => jsonResponse({ cloudaicompanionProject: null, allowedTiers: [] })
    await assert.rejects(
      discoverAntigravityAccount('token', { fetchFn, onboard: false }),
      /has no Cloud AI Companion project/,
    )
  })

  test('falls back to the production origin when the daily one is unavailable', async () => {
    const seen: string[] = []
    const fetchFn: typeof fetch = async (input) => {
      seen.push(String(input))
      return String(input).includes('daily-cloudcode-pa')
        ? new Response('nope', { status: 503 })
        : jsonResponse({ ok: true })
    }
    assert.deepEqual(await callInternal('loadCodeAssist', {}, 'token', { fetchFn }), { ok: true })
    assert.deepEqual(seen.map((url) => new URL(url).host), ['daily-cloudcode-pa.googleapis.com', 'cloudcode-pa.googleapis.com'])
  })
})

describe('Antigravity envelope', () => {
  test('maps reasoning efforts onto the family ladder and budgets', () => {
    assert.deepEqual(antigravityReasoning('claude-sonnet-4')?.efforts.map((entry) => String(entry.id)), ['high'])
    assert.deepEqual(antigravityReasoning('gemini-3-pro')?.efforts.map((entry) => String(entry.id)), ['low', 'medium', 'high'])
    assert.equal(antigravityReasoning('gemini-2.0-flash'), undefined)
    // A fixed-effort model variant advertises exactly that level.
    assert.deepEqual(antigravityReasoning('gemini-3-pro-high')?.efforts.map((entry) => String(entry.id)), ['high'])
  })

  test('an unsupported effort is refused before any request', () => {
    assert.throws(() => antigravityThinking('claude-sonnet-4', 'low'), /does not support reasoning effort low/)
    assert.throws(() => antigravityThinking('gemini-3-pro', 'max'), /does not support reasoning effort max/)
  })

  test('a thinking budget larger than the output cap is refused locally', () => {
    assert.throws(() => antigravityThinking('claude-sonnet-4', 'high', 500), /must exceed the thinking budget/)
    assert.deepEqual(antigravityThinking('claude-sonnet-4', 'high', 4_000), { includeThoughts: true, thinkingBudget: 1024 })
  })

  test('tools use parametersJsonSchema for Gemini and parameters for the legacy families', () => {
    const tools: ToolSchema[] = [{ name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }]
    const gemini = toAntigravityTools(tools, 'gemini-3-pro')[0]?.functionDeclarations[0]
    assert.equal(Object.hasOwn(gemini ?? {}, 'parametersJsonSchema'), true)
    const claude = toAntigravityTools(tools, 'claude-sonnet-4')[0]?.functionDeclarations[0]
    assert.equal(Object.hasOwn(claude ?? {}, 'parameters'), true)
    // The schema is detached from the caller's object.
    assert.notEqual(gemini?.parametersJsonSchema, tools[0]?.parameters)
  })

  test('carries system text, contents, tools and generation config', async () => {
    const envelope = await toAntigravityRequest(
      request({
        system: 'be brief',
        tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }],
        maxTokens: 1_000,
        temperature: 0.2,
        stop: ['END'],
        reasoningEffort: ReasoningEffortId('high'),
      }),
      'project-1',
      'be brief',
      undefined,
      true,
    )
    assert.equal(envelope.project, 'project-1')
    assert.equal(envelope.userAgent, 'antigravity')
    assert.equal(envelope.requestType, 'agent')
    assert.match(envelope.requestId, /^agent\/\d+\/.+\/4$/)
    assert.deepEqual(envelope.request.systemInstruction, { parts: [{ text: 'be brief' }] })
    assert.deepEqual(envelope.request.contents[0]?.parts, [{ text: 'hello' }])
    assert.deepEqual(envelope.request.generationConfig, {
      maxOutputTokens: 1_000,
      temperature: 0.2,
      stopSequences: ['END'],
      thinkingConfig: { includeThoughts: true, thinkingBudget: -1 },
    })
    assert.equal(envelope.request.toolConfig?.functionCallingConfig.mode, 'VALIDATED')
  })

  test('gives a Gemini 3 first function call the validator-skip signature', async () => {
    const contents = await toAntigravityContents([
      assistantMessage([
        { type: 'tool-call', id: 'call_1' as never, name: 'read_file', arguments: '{"path":"a"}' },
        { type: 'tool-call', id: 'call_2' as never, name: 'read_file', arguments: '{"path":"b"}' },
      ]),
    ], 'gemini-3-pro')
    assert.equal(contents[0]?.parts[0]?.thoughtSignature, 'skip_thought_signature_validator')
    // Only the first call carries it.
    assert.equal(contents[0]?.parts[1]?.thoughtSignature, undefined)
  })

  test('recovers a tool result name from the preceding call', async () => {
    const contents = await toAntigravityContents([
      assistantMessage([{ type: 'tool-call', id: 'call_1' as never, name: 'read_file', arguments: '{}' }]),
      toolMessage('call_1', '{"content":"hi"}'),
    ], 'gemini-3-pro')
    const response = contents.at(-1)?.parts[0]?.functionResponse
    assert.equal(response?.name, 'read_file')
    // A JSON object survives verbatim, which the protobuf Struct field requires.
    assert.deepEqual(response?.response, { content: 'hi' })
  })

  test('wraps a non-object tool result in an output envelope', async () => {
    const contents = await toAntigravityContents([
      toolMessage('call_9', '[1,2]'),
    ], 'gemini-3-pro')
    assert.deepEqual(contents[0]?.parts[0]?.functionResponse?.response, { output: [1, 2] })
  })
})

describe('Antigravity streaming', () => {
  test('translates thought, text, tool call and usage frames', () => {
    const translator = new AntigravityStreamTranslator()
    const first = translator.push({
      response: {
        candidates: [{ content: { parts: [{ thought: true, text: 'thinking…' }] } }],
      },
    })
    assert.deepEqual(first.map((chunk) => chunk.type), ['block-start', 'reasoning-delta'])

    const second = translator.push({
      response: { candidates: [{ content: { parts: [{ text: 'Hi' }, { functionCall: { id: 'c1', name: 'read_file', args: { path: 'a' } } }] } }] },
    })
    assert.deepEqual(second.map((chunk) => chunk.type), [
      'block-start', 'text-delta', 'block-start', 'tool-call-delta', 'block-end',
    ])

    const final = translator.push({
      response: {
        candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 2, cachedContentTokenCount: 3 },
      },
    })
    assert.deepEqual(final.map((chunk) => chunk.type), ['block-end', 'block-end', 'usage', 'finish'])
    const usage = final.find((chunk) => chunk.type === 'usage')
    assert.deepEqual(usage?.type === 'usage' ? usage.usage : undefined, {
      inputTokens: 7,
      outputTokens: 4,
      cacheReadTokens: 3,
      reasoningTokens: 2,
    })
    const finish = final.at(-1)
    // A tool call in the turn makes the finish reason `tool-calls`.
    assert.deepEqual(finish?.type === 'finish' ? finish.reason : undefined, { kind: 'tool-calls' })
    assert.equal(translator.terminated, true)
  })

  test('an empty response is an error rather than a silent stop', () => {
    const translator = new AntigravityStreamTranslator()
    const chunks = translator.push({ response: { candidates: [{ finishReason: 'STOP' }] } })
    const finish = chunks.at(-1)
    assert.equal(finish?.type === 'finish' ? finish.reason.kind : undefined, 'error')
  })

  test('a blocked response names the filter', () => {
    const translator = new AntigravityStreamTranslator()
    translator.push({ response: { candidates: [{ content: { parts: [{ text: 'x' }] } }] } })
    const finish = translator.push({ response: { candidates: [{ finishReason: 'SAFETY' }] } }).at(-1)
    assert.equal(finish?.type === 'finish' ? finish.reason.kind : undefined, 'error')
    assert.match(finish?.type === 'finish' && finish.reason.kind === 'error' ? finish.reason.failure.code : '', /CONTENT_FILTER/)
  })

  test('maximum length maps onto max-tokens', () => {
    const translator = new AntigravityStreamTranslator()
    translator.push({ response: { candidates: [{ content: { parts: [{ text: 'x' }] } }] } })
    const finish = translator.push({ response: { candidates: [{ finishReason: 'MAX_TOKENS' }] } }).at(-1)
    assert.deepEqual(finish?.type === 'finish' ? finish.reason : undefined, { kind: 'max-tokens' })
  })

  test('a stream that ends without a finish chunk is reported', async () => {
    const response = new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    await assert.rejects(
      collect(streamAntigravity(response.body as ReadableStream<Uint8Array>)),
      (error: unknown) => error instanceof LlmError && /before a finish chunk/.test(error.message),
    )
  })

  test('mapAntigravityUsage never double counts the cached prefix', () => {
    assert.deepEqual(mapAntigravityUsage({ promptTokenCount: 5, cachedContentTokenCount: 5 }), {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 5,
    })
  })
})

describe('AntigravityAdapter', () => {
  test('describes the route it serves and has no shipped catalog', async () => {
    const adapter = new AntigravityAdapter(adapterOptions())
    assert.deepEqual(adapter.providerInfo('antigravity'), { id: 'antigravity', name: 'Google Antigravity' })
    // Antigravity ships no curated list: an account's catalog is plan-dependent,
    // so before any read the picker has nothing to offer.
    assert.deepEqual(await adapter.listModels('antigravity'), [])
    assert.deepEqual(adapter.catalogEntries(), [])
  })

  test('a cached listing is the catalog, and a query makes no request', async () => {
    const cached = [
      { id: 'gemini-3-pro', name: 'Gemini 3 Pro', contextWindow: 1_048_576, inputModalities: ['text', 'image'] },
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', contextWindow: 200_000, inputModalities: ['text'] },
    ]
    const adapter = new AntigravityAdapter(adapterOptions({
      cachedListing: async () => cached,
      fetchFn: async () => { throw new Error('a picker query must not fetch') },
      tokens: tokenManager(),
    }))
    // The cached table is the last live read, so the picker renders it without asking the
    // endpoint anything — which is what makes a cold start work offline.
    await adapter.hydrate()
    assert.deepEqual(adapter.catalogEntries().map((entry) => entry.id), ['gemini-3-pro', 'claude-sonnet-4'])
    assert.deepEqual(
      (await adapter.listModels('antigravity')).map((model) => model.id),
      ['gemini-3-pro', 'claude-sonnet-4'],
    )
    const resolved = await adapter.resolveModel('antigravity', 'gemini-3-pro')
    assert.equal(resolved.context?.contextWindow, 1_048_576)
  })

  test('a fresh listing replaces the cached one and is persisted', async () => {
    const saved: unknown[] = []
    const fetchFn: typeof fetch = async () => jsonResponse({
      models: { 'gemini-3-pro': { displayName: 'Gemini 3 Pro', inputTokenLimit: 1_048_576 } },
      agentModelSorts: [{ groups: [{ modelIds: ['gemini-3-pro'] }] }],
    })
    const adapter = new AntigravityAdapter(adapterOptions({
      discovery: true,
      fetchFn,
      tokens: tokenManager(),
      cachedListing: async () => [
        { id: 'stale-model', name: 'Stale', contextWindow: 1_000 },
      ],
      saveListing: async (payload) => { saved.push(payload) },
    }))
    await adapter.hydrate()
    assert.deepEqual(adapter.catalogEntries().map((entry) => entry.id), ['stale-model'])
    await adapter.fetchCatalog('token', 'project-1')
    // A model the endpoint no longer reports is gone; the read is cached for next time.
    assert.deepEqual(adapter.catalogEntries().map((entry) => entry.id), ['gemini-3-pro'])
    assert.equal(saved.length, 1)
  })

  test('an unusable cache payload is a miss, not an empty picker', async () => {
    const adapter = new AntigravityAdapter(adapterOptions({
      cachedListing: async () => ({ nope: true }),
      tokens: tokenManager(),
    }))
    await adapter.hydrate()
    assert.deepEqual(adapter.catalogEntries(), [])
  })

  test('reads the live catalog and its quota', async () => {
    const fetchFn: typeof fetch = async (input) => {
      assert.match(String(input), /v1internal:fetchAvailableModels$/)
      return jsonResponse({
        models: {
          'gemini-3-pro': {
            displayName: 'Gemini 3 Pro',
            inputTokenLimit: 1_048_576,
            quotaInfo: { remainingFraction: 0.25, resetTime: '2026-11-02T00:00:00Z' },
          },
          'claude-sonnet-4': { maxInputTokens: 200_000 },
        },
      })
    }
    const adapter = new AntigravityAdapter(adapterOptions({ discovery: true, fetchFn, tokens: tokenManager() }))
    const ids = await adapter.fetchCatalog('token', 'project-1')
    assert.deepEqual(ids, ['gemini-3-pro', 'claude-sonnet-4'])
    assert.deepEqual((await adapter.listModels('antigravity')).map((model) => model.id), ['gemini-3-pro', 'claude-sonnet-4'])
    const resolved = await adapter.resolveModel('antigravity', 'claude-sonnet-4')
    assert.equal(resolved.context?.contextWindow, 200_000)
    assert.deepEqual(resolved.reasoning?.efforts.map((entry) => String(entry.id)), ['high'])
  })

  test('reports the plan and one allowance per model family', async () => {
    const fetchFn: typeof fetch = async () => jsonResponse({
      models: {
        'gemini-3-pro': { quotaInfo: { remainingFraction: 0.25, resetTime: '2026-11-02T00:00:00Z' } },
        'gemini-3-flash': { quotaInfo: { remainingFraction: 0.5, resetTime: '2026-11-02T00:00:00Z' } },
        'claude-sonnet-4': { quotaInfo: { remainingFraction: 0.9, resetTime: '2026-11-03T00:00:00Z' } },
      },
    })
    const adapter = new AntigravityAdapter(adapterOptions({ discovery: true, fetchFn, tokens: tokenManager() }))
    const usage = await adapter.usage('token', 'project-1', 'Antigravity Pro')
    assert.equal(usage?.plan, 'Antigravity Pro')
    // Two buckets, Gemini first, each at its worst-spent model.
    assert.deepEqual(usage?.windows.map((window) => window.label), ['gemini', 'claude'])
    assert.equal(usage?.windows[0]?.usedPercent, 75)
    assert.equal(usage?.windows[0]?.resetsAt, Date.parse('2026-11-02T00:00:00Z'))
    // A 0.9 remainder is 10% spent, within float noise.
    assert.ok(Math.abs((usage?.windows[1]?.usedPercent ?? 0) - 10) < 1e-6)
    assert.equal(usage?.windows[1]?.resetsAt, Date.parse('2026-11-03T00:00:00Z'))
  })

  test('a catalog with only Gemini models reports one allowance', async () => {
    const fetchFn: typeof fetch = async () => jsonResponse({
      models: { 'gemini-3-pro': { quotaInfo: { remainingFraction: 0.5 } } },
    })
    const adapter = new AntigravityAdapter(adapterOptions({ discovery: true, fetchFn, tokens: tokenManager() }))
    const usage = await adapter.usage('token', 'project-1')
    assert.deepEqual(usage?.windows.map((window) => window.label), ['gemini'])
    assert.equal(usage?.windows[0]?.usedPercent, 50)
  })

  test('a 403 on the account summary is retried with the plain product token', async () => {
    const agents: string[] = []
    const fetchFn: typeof fetch = async (input, init) => {
      const agent = new Headers(init?.headers).get('user-agent') ?? ''
      if (!String(input).includes('retrieveUserQuotaSummary')) return jsonResponse({ models: {} })
      agents.push(agent)
      // The IDE fingerprint is refused for accounting only; the plain token answers.
      if (agent !== 'antigravity/1.0') {
        return new Response(
          JSON.stringify({ error: { code: 403, message: 'You do not have a valid license of this product.' } }),
          { status: 403 },
        )
      }
      return jsonResponse({
        groups: [{
          displayName: 'Gemini Models',
          buckets: [{ window: '5h', bucketId: 'gemini-5h', remainingFraction: 0.75, resetTime: '2026-11-02T00:00:00Z' }],
        }],
      })
    }
    const adapter = new AntigravityAdapter(adapterOptions({ fetchFn }))
    const usage = await adapter.usage('token', 'project-1')
    // The account's own accounting, not the per-model substitute.
    assert.equal(usage?.usageError, undefined)
    assert.deepEqual(usage?.windows.map((window) => window.label), ['gemini'])
    assert.equal(usage?.windows[0]?.usedPercent, 25)
    assert.ok(agents.includes('antigravity/1.0'))
  })

  test('streams a request over the v1internal endpoint with the account project', async () => {
    let seenUrl = ''
    let seenBody: Record<string, unknown> = {}
    let seenHeaders = new Headers()
    const fetchFn: typeof fetch = async (input, init) => {
      seenUrl = String(input)
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      seenHeaders = new Headers(init?.headers)
      return sseResponse([{ response: { candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] } }])
    }
    const adapter = new AntigravityAdapter(adapterOptions({ fetchFn, tokens: tokenManager({ projectId: 'project-7' }) }))
    const chunks = await collect(adapter.stream(request()))
    assert.match(seenUrl, /daily-cloudcode-pa\.googleapis\.com\/v1internal:streamGenerateContent\?alt=sse$/)
    assert.equal(seenBody.project, 'project-7')
    assert.equal(seenBody.model, 'gemini-3-pro')
    assert.equal(seenHeaders.get('authorization'), 'Bearer token')
    assert.match(seenHeaders.get('user-agent') ?? '', /^antigravity\//)
    assert.deepEqual(chunks.map((chunk) => chunk.type), ['block-start', 'text-delta', 'block-end', 'finish'])
  })

  test('a context-window failure is reported as such', async () => {
    const fetchFn: typeof fetch = async () => new Response(
      JSON.stringify({ error: { message: 'The input token count exceeds the maximum' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )
    const adapter = new AntigravityAdapter(adapterOptions({ fetchFn }))
    await assert.rejects(collect(adapter.stream(request())), (error: unknown) => error instanceof LlmError)
  })

  test('a transient connect fault is retried and then succeeds', async () => {
    let calls = 0
    const warnings: string[] = []
    const fetchFn: typeof fetch = async () => {
      calls += 1
      if (calls <= 2) throw new TypeError('fetch failed: Connect Timeout Error')
      return sseResponse([{ response: { candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] } }])
    }
    const adapter = new AntigravityAdapter(adapterOptions({
      fetchFn,
      tokens: tokenManager({ projectId: 'project-7' }),
      onWarn: (message) => { warnings.push(message) },
    }))
    const chunks = await collect(adapter.stream(request()))
    assert.equal(calls, 3)
    assert.ok(warnings.some((message) => /transient network fault/.test(message)))
    assert.deepEqual(chunks.map((chunk) => chunk.type), ['block-start', 'text-delta', 'block-end', 'finish'])
  })

  test('a persistent connect fault exhausts retries and fails the turn', async () => {
    const fetchFn: typeof fetch = async () => { throw new TypeError('fetch failed: Connect Timeout Error') }
    const adapter = new AntigravityAdapter(adapterOptions({ fetchFn, tokens: tokenManager({ projectId: 'project-7' }) }))
    await assert.rejects(collect(adapter.stream(request())), (error: unknown) => error instanceof LlmError)
  })

  test('an expired login names the fix', async () => {
    const tokens = {
      resolve: async () => { throw new ProviderError('no Antigravity account is signed in', REAUTH_REQUIRED) },
      session: async () => undefined,
    } as unknown as TokenManager<AntigravitySession>
    const adapter = new AntigravityAdapter(adapterOptions({ tokens }))
    await assert.rejects(collect(adapter.stream(request())), (error: unknown) =>
      error instanceof LlmError && error.failure.code === 'INVALID_CREDENTIAL' && /Settings → Subscriptions/.test(error.message))
  })
})

describe('the quota probe', () => {
  test('asks Google before the configured request base', async () => {
    const urls: string[] = []
    const adapter = new AntigravityAdapter(adapterOptions({
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
    }))

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
    const adapter = new AntigravityAdapter(adapterOptions({
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
    }))

    const read = await adapter.usage('token', 'proj')
    // Google was tried first and refused, then the configured base answered.
    assert.equal(urls[0]?.startsWith('https://daily-cloudcode-pa.googleapis.com'), true)
    assert.equal(urls.some((url) => url.startsWith('https://proxy.example')), true)
    assert.deepEqual(read.windows.map((window) => window.label), ['gemini_weekly'])
  })

  test('per-model figures stand in when the summary is gone, and say so', async () => {
    const adapter = new AntigravityAdapter(adapterOptions({
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
    }))

    const read = await adapter.usage('token', 'proj')
    assert.deepEqual(read.windows.map((window) => window.label), ['gemini', 'claude'])
    assert.equal(read.windows[0]?.usedPercent, 70)
    assert.equal(read.windows[1]?.usedPercent, 90)
    // The substitute is labelled as one, so the page can say why.
    assert.match(read.usageError ?? '', /per-model figures/)
  })
})

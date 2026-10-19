/** The antigravity route: OAuth, project discovery, catalog, envelope, streaming. */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createUserMessage, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, RequestMessage, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'

import { REAUTH_REQUIRED, ProviderError } from '../src/errors.js'
import type { TokenManager } from '../src/auth/tokens.js'
import {
  ANTIGRAVITY_AUTHORIZE_URL,
  ANTIGRAVITY_BASE_URL,
  ANTIGRAVITY_CALLBACK_PORT,
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_PROD_URL,
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

/** A token manager that answers for a pool of accounts, keyed by account name. */
function poolTokenManager(accounts: string[], defaultAccount = accounts[0] ?? 'user-1'): TokenManager<AntigravitySession> {
  const sessions = new Map(accounts.map((account) => [account, {
    accessToken: `${account}-token`,
    expiresAt: Date.now() + 60_000,
    projectId: 'project-1',
  } as AntigravitySession]))
  return {
    resolve: async (account?: string) => {
      const key = account ?? defaultAccount
      const held = sessions.get(key)
      if (held === undefined) throw new Error(`no session for ${key}`)
      return { account: key, accessToken: held.accessToken, expiresAt: held.expiresAt }
    },
    session: async (account?: string) => {
      const key = account ?? defaultAccount
      const held = sessions.get(key)
      return held === undefined ? undefined : { account: key, session: held }
    },
    accounts: async () => accounts,
    defaultAccount: async () => defaultAccount,
  } as unknown as TokenManager<AntigravitySession>
}

/** Google's verification gate: a 403 whose details name the link that clears it. */
function gateResponse(url = GATE_URL): Response {
  return jsonResponse({
    error: {
      code: 403,
      message: 'Verify your account to continue.',
      status: 'PERMISSION_DENIED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: 'VALIDATION_REQUIRED',
          domain: 'cloudcode-pa.googleapis.com',
          metadata: { validation_url: url, validation_error_message: 'Verify your account to continue.' },
        },
        {
          '@type': 'type.googleapis.com/google.rpc.Help',
          links: [{ description: 'Verify your account', url }],
        },
      ],
    },
  }, 403)
}

/** The link shape Google returns; asserted on, never opened. */
const GATE_URL = 'https://accounts.google.com/signin/continue?sarp=1&continue=https://developers.google.com/gemini-code-assist/auth/auth_success_gemini'

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
    // Resets a couple of hours out are the rolling bucket of each family.
    const geminiResets = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
    const claudeResets = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString()
    const fetchFn: typeof fetch = async () => jsonResponse({
      models: {
        'gemini-3-pro': { quotaInfo: { remainingFraction: 0.25, resetTime: geminiResets } },
        'gemini-3-flash': { quotaInfo: { remainingFraction: 0.5, resetTime: geminiResets } },
        'claude-sonnet-4': { quotaInfo: { remainingFraction: 0.9, resetTime: claudeResets } },
      },
    })
    const adapter = new AntigravityAdapter(adapterOptions({ discovery: true, fetchFn, tokens: tokenManager() }))
    const usage = await adapter.usage('token', 'project-1', 'Antigravity Pro')
    assert.equal(usage?.plan, 'Antigravity Pro')
    // Two buckets, Gemini first, each at its worst-spent model.
    assert.deepEqual(usage?.windows.map((window) => window.label), ['gemini', 'claude'])
    assert.equal(usage?.windows[0]?.usedPercent, 75)
    assert.equal(usage?.windows[0]?.resetsAt, Date.parse(geminiResets))
    // A 0.9 remainder is 10% spent, within float noise.
    assert.ok(Math.abs((usage?.windows[1]?.usedPercent ?? 0) - 10) < 1e-6)
    assert.equal(usage?.windows[1]?.resetsAt, Date.parse(claudeResets))
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

  test('a 400 invalid argument is retried, and a repaired request can finish the turn', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchFn: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      if (bodies.length <= 2) {
        return jsonResponse({ error: { code: 400, message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT' } }, 400)
      }
      return sseResponse([{ response: { candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] } }])
    }
    const adapter = new AntigravityAdapter(adapterOptions({ fetchFn, tokens: tokenManager() }))

    const chunks = await collect(adapter.stream(request({ model: 'gemini-3-pro', reasoningEffort: ReasoningEffortId('high') })))
    // Three dispatches: the refusal, one with fresh ids, and the repaired one that served.
    assert.equal(bodies.length, 3)
    const config = (index: number): Record<string, unknown> | undefined =>
      (bodies[index]?.request as { generationConfig?: Record<string, unknown> } | undefined)?.generationConfig
    // The turn was refused twice with the thinking budget in place, then served without it.
    assert.notEqual(config(0)?.thinkingConfig, undefined)
    assert.notEqual(config(1)?.thinkingConfig, undefined)
    assert.equal(config(2)?.thinkingConfig, undefined)
    assert.deepEqual(chunks.map((chunk) => chunk.type), ['block-start', 'text-delta', 'block-end', 'finish'])
  })

  test('a 400 that survives every repair fails, naming the field Google blamed', async () => {
    let calls = 0
    const fetchFn: typeof fetch = async () => {
      calls += 1
      return jsonResponse({
        error: {
          code: 400,
          message: 'Request contains an invalid argument.',
          status: 'INVALID_ARGUMENT',
          details: [{
            '@type': 'type.googleapis.com/google.rpc.BadRequest',
            fieldViolations: [{ field: 'request.contents[3].parts[0].inlineData', description: 'Unsupported image.' }],
          }],
        },
      }, 400)
    }
    const adapter = new AntigravityAdapter(adapterOptions({ fetchFn, tokens: tokenManager() }))

    await assert.rejects(collect(adapter.stream(request({ model: 'gemini-3-pro' }))), (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.failure.code, 'INVALID_REQUEST')
      // The retries happened, and the failure still names what the service refused.
      assert.equal(calls, 4)
      assert.match(error.message, /request\.contents\[3\]\.parts\[0\]\.inlineData/)
      return true
    })
  })

  test('a verification-gated account is set aside for one that can serve', async () => {
    const gatedAccount = 'gated-1@example.com'
    const healthyAccount = 'ok-1@example.com'
    const seen: string[] = []
    const fetchFn: typeof fetch = async (_input, init) => {
      const auth = new Headers(init?.headers).get('authorization') ?? ''
      seen.push(auth)
      if (auth === 'Bearer ' + gatedAccount + '-token') return gateResponse()
      return sseResponse([{ response: { candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] } }])
    }
    const adapter = new AntigravityAdapter(adapterOptions({
      fetchFn,
      tokens: poolTokenManager([gatedAccount, healthyAccount]),
    }))

    const first = await collect(adapter.stream(request({ model: 'gemini-3-flash' })))
    assert.deepEqual(first.map((chunk) => chunk.type), ['block-start', 'text-delta', 'block-end', 'finish'])
    // The gate is read off the first answer, so it costs one probe and not the forced
    // refresh the plugin would otherwise spend on a credential that is perfectly good.
    assert.equal(seen.filter((auth) => auth === 'Bearer ' + gatedAccount + '-token').length, 1)

    // The gate is remembered: the next turn goes straight to the account that serves.
    const before = seen.length
    await collect(adapter.stream(request({ model: 'gemini-3-flash' })))
    assert.equal(seen.slice(before).some((auth) => auth.includes(gatedAccount)), false)
    assert.equal(seen.slice(before).length, 1)
  })

  test('an all-gated pool names the verification link', async () => {
    const fetchFn: typeof fetch = async () => gateResponse()
    const adapter = new AntigravityAdapter(adapterOptions({
      fetchFn,
      tokens: poolTokenManager(['gated-2@example.com', 'gated-3@example.com']),
    }))
    await assert.rejects(collect(adapter.stream(request({ model: 'gemini-3-flash' }))), (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.match(error.message, /Google requires verification for gated-2@example\.com/)
      assert.match(error.message, /verify here: https:\/\/accounts\.google\.com\/signin\/continue/)
      // Both accounts are named, but the long URL is printed once.
      assert.match(error.message, /verification required for gated-3@example\.com/)
      assert.equal(error.message.split('https://accounts.google.com').length - 1, 1)
      // The wall clears in the browser, so a retry of the same request cannot help.
      assert.equal(error.code, 'ACCOUNT_VERIFICATION_REQUIRED')
      return true
    })
  })

  test('a lone gated account names the link instead of a bare refusal', async () => {
    const fetchFn: typeof fetch = async () => gateResponse()
    const adapter = new AntigravityAdapter(adapterOptions({
      fetchFn,
      tokens: poolTokenManager(['gated-4@example.com']),
    }))
    await assert.rejects(collect(adapter.stream(request({ model: 'gemini-3-flash' }))), (error: unknown) => {
      assert.ok(error instanceof LlmError)
      assert.match(error.message, /Google requires verification for gated-4@example\.com/)
      assert.match(error.message, /verify here: https:\/\/accounts\.google\.com\/signin\/continue/)
      assert.equal(error.code, 'ACCOUNT_VERIFICATION_REQUIRED')
      return true
    })
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

  test('a stream that closes before a finish chunk is redispatched and then succeeds', async () => {
    let calls = 0
    const warnings: string[] = []
    const fetchFn: typeof fetch = async () => {
      calls += 1
      // First answer is cut off mid-stream (no finish chunk); the redispatch completes.
      if (calls === 1) {
        return new Response(
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}}\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }
      return sseResponse([{ response: { candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] } }])
    }
    const adapter = new AntigravityAdapter(adapterOptions({
      fetchFn,
      tokens: tokenManager({ projectId: 'project-7' }),
      onWarn: (message) => { warnings.push(message) },
    }))
    const chunks = await collect(adapter.stream(request()))
    assert.equal(calls, 2)
    assert.ok(warnings.some((message) => /stream closed early/.test(message)))
    // The first (cut) answer's text already streamed, then the redispatch's: two text
    // blocks, closed in order, and a single terminal finish.
    assert.deepEqual(chunks.map((chunk) => chunk.type), ['block-start', 'text-delta', 'block-start', 'text-delta', 'block-end', 'finish'])
  })

  test('a stream cut that never completes exhausts retries and fails the turn', async () => {
    const fetchFn: typeof fetch = async () => new Response(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
    const adapter = new AntigravityAdapter(adapterOptions({ fetchFn, tokens: tokenManager({ projectId: 'project-7' }) }))
    await assert.rejects(collect(adapter.stream(request())), (error: unknown) =>
      error instanceof LlmError && error.failure.code === 'STREAM_CLOSED')
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
    // Google's own host answers the summary, so the proxy is never even asked — and the
    // complete answer means the second Google host is not asked either. The per-model read
    // rides along on the same host, which is where the rolling figure lives.
    assert.equal(urls[0], `${ANTIGRAVITY_PROD_URL}/v1internal:retrieveUserQuotaSummary`)
    assert.equal(urls.some((url) => url.startsWith('https://proxy.example') && url.includes('retrieveUserQuotaSummary')), false)
    assert.deepEqual(read.windows.map((window) => window.label), ['gemini', 'gemini_weekly', 'claude', 'claude_weekly'])
    assert.equal(read.windows[0]?.usedPercent, 75)
    assert.equal(read.windows[1]?.usedPercent, 60)
    assert.equal(read.usageError, undefined)
  })

  test('a host that names only some allowance groups is completed by the next one', async () => {
    const urls: string[] = []
    const adapter = new AntigravityAdapter(adapterOptions({
      fetchFn: (async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input)
        urls.push(url)
        // The production host states the Gemini group; the daily host stopped stating it.
        if (url.startsWith(ANTIGRAVITY_PROD_URL)) {
          return new Response(JSON.stringify({ groups: [
            { displayName: 'Gemini Models', buckets: [
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.4 },
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 1 },
            ] },
            { displayName: 'Claude and GPT models', buckets: [
              { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.25 },
            ] },
          ] }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response(JSON.stringify({ groups: [
          { displayName: 'Claude and GPT models', buckets: [
            { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.25 },
            { bucketId: '3p-5h', window: '5h', remainingFraction: 0.5 },
          ] },
        ] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as never,
    }))

    const read = await adapter.usage('token', 'proj')
    // Both hosts were asked, and the union carries all four rows: the Gemini weekly figure
    // the daily host had dropped is back, and the group both hosts state is not double-listed.
    assert.deepEqual(read.windows.map((window) => window.label), ['gemini', 'gemini_weekly', 'claude', 'claude_weekly'])
    assert.equal(read.windows[0]?.usedPercent, 0)
    assert.equal(read.windows[1]?.usedPercent, 60)
    assert.equal(read.windows[2]?.usedPercent, 50)
    assert.equal(read.windows[3]?.usedPercent, 75)
    assert.equal(read.usageError, undefined)
    // The union of the two hosts, and no host asked twice for the summary.
    assert.equal(urls.filter((url) => url.includes('retrieveUserQuotaSummary')).length, 2)
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
    // Both Google hosts were tried and refused, then the configured base answered.
    assert.equal(urls[0]?.startsWith(ANTIGRAVITY_PROD_URL), true)
    assert.equal(urls.some((url) => url.startsWith(ANTIGRAVITY_BASE_URL)), true)
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

  test('the Gemini rolling row follows the per-model quota, not the summary fixture', async () => {
    const rollingResets = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString()
    const weeklyResets = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString()
    const adapter = new AntigravityAdapter(adapterOptions({
      fetchFn: (async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input)
        if (url.includes('retrieveUserQuotaSummary')) {
          // Google states the Gemini rolling bucket as full whatever has been spent; only
          // the weekly bucket moves there.
          return new Response(JSON.stringify({ groups: [
            { displayName: 'Gemini Models', buckets: [
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.5 },
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 1 },
            ] },
            { displayName: 'Claude and GPT models', buckets: [
              { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.8 },
            ] },
          ] }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        // The live rolling figure: 60 percent of the five-hour window spent. Claude states
        // only a weekly reset, which is how a spent allowance reads.
        return new Response(JSON.stringify({
          models: {
            'gemini-3.8-flash-tiered': { displayName: 'Gemini 3.8 Flash', quotaInfo: { remainingFraction: 0.4, resetTime: rollingResets } },
            'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6', quotaInfo: { resetTime: weeklyResets } },
          },
          agentModelSorts: [{ groups: [{ modelIds: ['gemini-3.8-flash-tiered', 'claude-sonnet-4-6'] }] }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as never,
    }))

    const read = await adapter.usage('token', 'proj')
    assert.deepEqual(read.windows.map((window) => window.label), ['gemini', 'gemini_weekly', 'claude_weekly'])
    assert.equal(read.windows[0]?.usedPercent, 60)
    assert.equal(read.windows[0]?.resetsAt, Date.parse(rollingResets))
    // The weekly bucket keeps the summary's accounting.
    assert.equal(read.windows[1]?.usedPercent, 50)
    // A Claude entry that states only its weekly reset has spent that weekly allowance, so
    // it confirms the summary's figure instead of reading as a free five hours.
    assert.equal(read.windows[2]?.usedPercent, 100)
    // Its reset is a week out, so it is no rolling figure: no Claude five-hour row is invented.
    assert.equal(read.windows.some((window) => window.label === 'claude'), false)
    assert.equal(read.usageError, undefined)
  })

  test('a disabled five-hour bucket is not reported as a free five hours', async () => {
    const adapter = new AntigravityAdapter(adapterOptions({
      fetchFn: (async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input)
        if (url.includes('retrieveUserQuotaSummary')) {
          // The weekly limit is what binds, so Google reports the group's five-hour bucket
          // as full and disables it.
          return new Response(JSON.stringify({ groups: [{
            displayName: 'Claude and GPT models',
            buckets: [
              { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0, resetTime: '2026-10-20T07:18:48Z' },
              { bucketId: '3p-5h', window: '5h', remainingFraction: 1, disabled: true },
            ],
          }] }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response(JSON.stringify({
          models: { 'claude-sonnet-4-6': { quotaInfo: { resetTime: '2026-10-20T07:18:48Z' } } },
          agentModelSorts: [{ groups: [{ modelIds: ['claude-sonnet-4-6'] }] }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as never,
    }))

    const read = await adapter.usage('token', 'proj')
    assert.deepEqual(read.windows.map((window) => window.label), ['claude_weekly'])
    assert.equal(read.windows[0]?.usedPercent, 100)
  })

  test('a per-model figure never lowers a rolling figure the summary stated', async () => {
    const adapter = new AntigravityAdapter(adapterOptions({
      fetchFn: (async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input)
        if (url.includes('retrieveUserQuotaSummary')) {
          return new Response(JSON.stringify({ groups: [
            { displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.25 }] },
          ] }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response(JSON.stringify({
          models: {
            'gemini-3.8-flash-tiered': { displayName: 'Gemini 3.8 Flash', quotaInfo: { remainingFraction: 0.9 } },
          },
          agentModelSorts: [{ groups: [{ modelIds: ['gemini-3.8-flash-tiered'] }] }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as never,
    }))

    const read = await adapter.usage('token', 'proj')
    assert.equal(read.windows[0]?.usedPercent, 75)
  })

  test('a second account does not inherit the first one’s per-model figures', async () => {
    const adapter = new AntigravityAdapter(adapterOptions({
      fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input)
        const body = typeof init?.body === 'string' ? init.body : ''
        const project = /"project":"([^"]+)"/.exec(body)?.[1] ?? ''
        if (url.includes('retrieveUserQuotaSummary')) {
          // Both accounts' summaries state the Gemini rolling bucket as full, which is
          // exactly why the per-model figures must not leak between them.
          return new Response(JSON.stringify({ groups: [
            { displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 1 }] },
          ] }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        const spent = project === 'proj-a' ? 0.2 : 1
        return new Response(JSON.stringify({
          models: {
            'gemini-3.8-flash-tiered': {
              displayName: 'Gemini 3.8 Flash',
              quotaInfo: { remainingFraction: spent, resetTime: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
            },
          },
          agentModelSorts: [{ groups: [{ modelIds: ['gemini-3.8-flash-tiered'] }] }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as never,
    }))

    const first = await adapter.usage('token', 'proj-a')
    assert.equal(first.windows[0]?.usedPercent, 80)
    // The second account has spent none of its rolling window; the first account's 80
    // percent must not be carried over just because its read came first.
    const second = await adapter.usage('token', 'proj-b')
    assert.equal(second.windows[0]?.usedPercent, 0)
  })

  test('a host still calling an allowance full does not hide the other host’s figure', async () => {
    // Google runs two Code Assist deployments, and one can answer "full" for every model of
    // a family while the other — the one Antigravity itself uses — reports the same models
    // nearly spent. Reading whichever host answered first showed a comfortable 0 % next to
    // an allowance that was 90 % gone.
    const weeklyResets = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString()
    const adapter = new AntigravityAdapter(adapterOptions({
      fetchFn: (async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input)
        if (url.includes('retrieveUserQuotaSummary')) {
          // Both hosts state the weekly bucket as full here; the catalog is where they differ.
          return new Response(JSON.stringify({ groups: [{
            displayName: 'Gemini Models',
            buckets: [
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 1 },
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 1 },
            ],
          }] }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        const remaining = url.startsWith(ANTIGRAVITY_PROD_URL) ? 1 : 0.1
        return new Response(JSON.stringify({
          models: {
            'gemini-3.8-flash-tiered': {
              displayName: 'Gemini 3.8 Flash',
              quotaInfo: { remainingFraction: remaining, resetTime: weeklyResets },
            },
          },
          agentModelSorts: [{ groups: [{ modelIds: ['gemini-3.8-flash-tiered'] }] }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as never,
    }))

    const read = await adapter.usage('token', 'proj')
    const weekly = read.windows.find((window) => window.label === 'gemini_weekly')
    // The daily host's 90 % is the allowance that is really being consumed.
    assert.equal(Math.round(weekly?.usedPercent ?? 0), 90)
    // The summary's claim that the same bucket is full loses to it.
    assert.equal(read.windows.find((window) => window.label === 'gemini')?.usedPercent, 0)
  })
})

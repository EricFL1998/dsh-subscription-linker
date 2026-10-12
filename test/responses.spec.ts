/** Responses wire: request assembly, usage mapping, and the stream translator. */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  EMPTY_RESPONSE_CODE,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'

import {
  mapResponsesUsage,
  responsesFailure,
  ResponsesStreamTranslator,
  streamResponses,
  toResponsesInput,
  toResponsesTools,
} from '../src/translate/responses.js'
import type { ResponsesStreamEvent } from '../src/translate/responses.js'

/** An SSE body made of the given event objects, one `data:` frame each. */
function sseBody(events: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      controller.close()
    },
  })
}

/** Collect every chunk a stream produces. */
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('toResponsesInput', () => {
  test('folds system prompts into instructions, explicit argument first', async () => {
    const resolved = await toResponsesInput(
      [createSystemMessage('from history'), createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      'from the caller',
    )
    assert.equal(resolved.instructions, 'from the caller\n\nfrom history')
    assert.deepEqual(resolved.input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }])
  })

  test('omits instructions when there is no system text', async () => {
    const resolved = await toResponsesInput([createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })])
    assert.equal(resolved.instructions, undefined)
    assert.equal(Object.hasOwn(resolved, 'instructions'), false)
  })

  test('represents assistant text and tool calls as output items', async () => {
    const resolved = await toResponsesInput([
      createAssistantMessage({
        content: [
          { type: 'text', text: 'thinking out loud' },
          { type: 'reasoning', text: 'private reasoning' },
          { type: 'tool-call', id: ToolCallId('call-1'), name: 'read_file', arguments: '{"path":"a"}' },
        ],
        source: { provider: 'kimi', model: 'k3' },
      }),
    ])
    assert.deepEqual(resolved.input, [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'thinking out loud' }] },
      { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"a"}' },
    ])
  })

  test('never replays reasoning text', async () => {
    const resolved = await toResponsesInput([
      createAssistantMessage({
        content: [{ type: 'reasoning', text: 'secret chain of thought' }],
        source: { provider: 'kimi', model: 'k3' },
      }),
    ])
    assert.deepEqual(resolved.input, [])
  })

  test('represents tool results as function_call_output items', async () => {
    const resolved = await toResponsesInput([
      createToolResultMessage({
        callId: ToolCallId('call-1'),
        content: [{ type: 'text', text: 'file contents' }],
        isError: false,
      }),
    ])
    assert.deepEqual(resolved.input, [
      { type: 'function_call_output', call_id: 'call-1', output: 'file contents' },
    ])
  })

  test('gives a failed tool call with no text an explicit output', async () => {
    const resolved = await toResponsesInput([
      createToolResultMessage({ callId: ToolCallId('call-2'), content: [], isError: true }),
    ])
    assert.deepEqual(resolved.input, [
      { type: 'function_call_output', call_id: 'call-2', output: 'tool call rejected' },
    ])
  })

  test('inlines a resolved image and marks an unresolvable one', async () => {
    const resolved = await toResponsesInput(
      [
        createUserMessage({
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', attachment: { attachmentId: 'a', mediaType: 'image/png', bytes: 3, width: 1, height: 1 } },
            { type: 'image', attachment: { attachmentId: 'b', mediaType: 'image/webp', bytes: 3, width: 1, height: 1 } },
          ] as ContentBlock[] as never,
          source: { kind: 'user' },
        }),
      ],
      undefined,
      async (ref) => ref.attachmentId === 'a' ? { mediaType: 'image/png', base64: 'AAAA' } : undefined,
    ) as { input: { content: Record<string, unknown>[] }[] }
    assert.deepEqual(resolved.input[0]?.content, [
      { type: 'input_text', text: 'look' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
      { type: 'input_text', text: '[image unavailable]' },
    ])
  })

  test('skips developer turns, whose declarations travel in tools', async () => {
    const resolved = await toResponsesInput([
      {
        role: 'developer',
        id: 'm1',
        content: [{ type: 'tool-addition', toolName: 'read_file' }],
        source: { kind: 'user' },
      } as never,
    ])
    assert.deepEqual(resolved.input, [])
  })
})

describe('toResponsesTools', () => {
  test('emits function tools with strict normalization disabled', () => {
    assert.deepEqual(
      toResponsesTools([{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }]),
      [{ type: 'function', name: 'read_file', description: 'Read a file', parameters: { type: 'object' }, strict: false }],
    )
  })
})

describe('mapResponsesUsage', () => {
  test('reports disjoint input and output counts', () => {
    assert.deepEqual(
      mapResponsesUsage({
        input_tokens: 100,
        output_tokens: 20,
        input_tokens_details: { cached_tokens: 40 },
        output_tokens_details: { reasoning_tokens: 5 },
      }),
      { inputTokens: 60, outputTokens: 20, cacheReadTokens: 40, reasoningTokens: 5 },
    )
  })

  test('never reports a negative uncached count', () => {
    assert.equal(mapResponsesUsage({ input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: 40 } }).inputTokens, 0)
  })

  test('tolerates a usage object with only totals', () => {
    assert.deepEqual(mapResponsesUsage({}), { inputTokens: 0, outputTokens: 0 })
  })
})

describe('responsesFailure', () => {
  test('classifies context overflow and quota failures', () => {
    assert.equal(responsesFailure('context_window_exceeded', 'too long').code, CONTEXT_WINDOW_EXCEEDED_CODE)
    assert.equal(responsesFailure(undefined, 'insufficient quota').code, QUOTA_EXCEEDED_CODE)
    assert.equal(responsesFailure('boom', 'something else').code, 'SERVER')
  })

  test('falls back to the code or a default sentence', () => {
    assert.match(responsesFailure(undefined, undefined).message, /failed response/)
    assert.equal(responsesFailure('weird_code', undefined).message, 'weird_code')
  })
})

describe('ResponsesStreamTranslator', () => {
  test('assembles a text response with terminal usage', () => {
    const translator = new ResponsesStreamTranslator()
    const chunks = [
      ...translator.push({ type: 'response.created' }),
      ...translator.push({ type: 'response.output_text.delta', item_id: 'i1', content_index: 0, delta: 'Hel' }),
      ...translator.push({ type: 'response.output_text.delta', item_id: 'i1', content_index: 0, delta: 'lo' }),
      ...translator.push({
        type: 'response.completed',
        response: { usage: { input_tokens: 5, output_tokens: 2 } },
      }),
    ]
    assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'text' })
    assert.deepEqual(chunks[1], { type: 'text-delta', index: 0, text: 'Hel' })
    assert.deepEqual(chunks[2], { type: 'text-delta', index: 0, text: 'lo' })
    assert.deepEqual(chunks[3], { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } })
    assert.deepEqual(chunks[4], { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } })
    assert.deepEqual(chunks[5], { type: 'finish', reason: { kind: 'stop' } })
    assert.equal(translator.terminated, true)
    // Nothing is emitted after the terminal finish.
    assert.deepEqual(translator.push({ type: 'response.output_text.delta', item_id: 'i1', delta: '!' }), [])
  })

  test('assembles a tool call and finishes as tool-calls', () => {
    const translator = new ResponsesStreamTranslator()
    const chunks = [
      ...translator.push({
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc1', call_id: 'call-1', name: 'read_file' },
      }),
      ...translator.push({ type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '{"path"' }),
      ...translator.push({ type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: ':"a"}' }),
      ...translator.push({
        type: 'response.output_item.done',
        item: { type: 'function_call', id: 'fc1', call_id: 'call-1', name: 'read_file' },
      }),
      ...translator.push({ type: 'response.completed', response: {} }),
    ]
    const starts = chunks.filter((chunk) => chunk.type === 'block-start')
    assert.deepEqual(starts, [{ type: 'block-start', index: 0, blockType: 'tool-call' }])
    const end = chunks.find((chunk) => chunk.type === 'block-end')
    assert.deepEqual(end, {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"a"}' },
    })
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
  })

  test('repairs arguments delivered only on the done event', () => {
    const translator = new ResponsesStreamTranslator()
    const chunks = [
      ...translator.push({
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc1', call_id: 'call-1', name: 'read_file' },
      }),
      ...translator.push({
        type: 'response.output_item.done',
        item: { type: 'function_call', id: 'fc1', call_id: 'call-1', name: 'read_file', arguments: '{"path":"a"}' },
      }),
    ]
    const end = chunks.find((chunk) => chunk.type === 'block-end')
    assert.deepEqual(end, {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"a"}' },
    })
  })

  test('synthesizes a text block from a completed item that streamed no deltas', () => {
    const translator = new ResponsesStreamTranslator()
    const chunks = [
      ...translator.push({
        type: 'response.output_item.done',
        item: { type: 'message', id: 'i1', content: [{ type: 'output_text', text: 'complete' }] },
      }),
    ]
    assert.deepEqual(chunks, [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'complete' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'complete' } },
    ])
  })

  test('reports an empty completed response as a failure', () => {
    const translator = new ResponsesStreamTranslator()
    const chunks = translator.push({ type: 'response.completed', response: {} })
    assert.equal(chunks.length, 1)
    const finish = chunks[0]
    assert.equal(finish?.type, 'finish')
    assert.deepEqual(finish, {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
      },
    })
  })

  test('throws on failed, incomplete, and error events', () => {
    assert.throws(
      () => new ResponsesStreamTranslator().push({ type: 'response.failed', response: { error: { message: 'nope' } } }),
      (error: unknown) => error instanceof LlmError && error.message === 'nope',
    )
    assert.throws(
      () => new ResponsesStreamTranslator().push({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }),
      /incomplete response/,
    )
    assert.throws(
      () => new ResponsesStreamTranslator().push({ type: 'error', code: 'boom', message: 'bad' }),
      /bad/,
    )
  })

  test('keeps reasoning in its own block, before the text it precedes', () => {
    const translator = new ResponsesStreamTranslator()
    const chunks = [
      ...translator.push({ type: 'response.reasoning_summary_text.delta', item_id: 'r1', summary_index: 0, delta: 'why' }),
      ...translator.push({ type: 'response.output_text.delta', item_id: 'i1', content_index: 0, delta: 'answer' }),
    ]
    assert.deepEqual(chunks, [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'why' },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'answer' },
    ])
  })
})

describe('streamResponses', () => {
  test('consumes an SSE body into chunks', async () => {
    const body = sseBody([
      { type: 'response.output_text.delta', item_id: 'i1', content_index: 0, delta: 'Hi' },
      { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ])
    const chunks = await collect(streamResponses(body))
    assert.deepEqual(chunks.map((chunk) => chunk.type), ['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  })

  test('reports activity for every frame, including comments', async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(': keep-alive\n\n'))
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","item_id":"i1","delta":"Hi"}\n\n'))
        controller.enqueue(encoder.encode('data: {"type":"response.completed","response":{}}\n\n'))
        controller.close()
      },
    })
    let pulses = 0
    await collect(streamResponses(body, () => { pulses += 1 }))
    assert.ok(pulses >= 3, `expected several activity pulses, saw ${String(pulses)}`)
  })

  test('rejects a malformed payload', async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {not json}\n\n'))
        controller.close()
      },
    })
    await assert.rejects(collect(streamResponses(body)), (error: unknown) =>
      error instanceof LlmError && error.failure.code === 'MALFORMED_RESPONSE')
  })

  test('rejects a body that ends before response.completed', async () => {
    const body = sseBody([{ type: 'response.output_text.delta', item_id: 'i1', delta: 'partial' }])
    await assert.rejects(collect(streamResponses(body)), (error: unknown) =>
      error instanceof LlmError && error.failure.code === 'STREAM_CLOSED')
  })

  test('stops reading once the response completed', async () => {
    const encoder = new TextEncoder()
    const frames: string[] = []
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        frames.push('pulled')
        if (frames.length === 1) {
          controller.enqueue(encoder.encode('data: {"type":"response.completed","response":{}}\n\n'))
          return
        }
        await delay(5)
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","item_id":"late","delta":"ignored"}\n\n'))
      },
    })
    const chunks = await collect(streamResponses(body))
    assert.deepEqual(chunks.map((chunk) => chunk.type), ['finish'])
  })
})

describe('ResponsesStreamEvent typing', () => {
  test('accepts the shapes the endpoint sends', () => {
    const events: ResponsesStreamEvent[] = [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'i1' } },
      { type: 'response.completed', response: { status: 'completed' } },
    ]
    assert.equal(events.length, 2)
  })
})

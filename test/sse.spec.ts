/** SSE framing: multi-line data, comments, CRLF, and an unterminated tail. */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { parseSse } from '../src/translate/sse.js'
import type { SseEvent } from '../src/translate/sse.js'

/** Build a byte stream from the given raw chunks. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

/** Collect every event a stream produces. */
async function collect(stream: ReadableStream<Uint8Array>, onActivity?: () => void): Promise<SseEvent[]> {
  const events: SseEvent[] = []
  for await (const event of parseSse(stream, onActivity)) events.push(event)
  return events
}

describe('parseSse', () => {
  test('splits events on the blank-line terminator', async () => {
    const events = await collect(streamOf(['data: one\n\ndata: two\n\n']))
    assert.deepEqual(events, [{ data: 'one' }, { data: 'two' }])
  })

  test('joins multiple data lines of one event with newlines', async () => {
    const events = await collect(streamOf(['data: line one\ndata: line two\n\n']))
    assert.deepEqual(events, [{ data: 'line one\nline two' }])
  })

  test('carries the event name when the server sets one', async () => {
    const events = await collect(streamOf(['event: response.completed\ndata: {}\n\n']))
    assert.deepEqual(events, [{ data: '{}', event: 'response.completed' }])
  })

  test('tolerates CRLF framing', async () => {
    const events = await collect(streamOf(['data: one\r\n\r\n']))
    assert.deepEqual(events, [{ data: 'one' }])
  })

  test('skips comments but still reports activity', async () => {
    let pulses = 0
    const events = await collect(streamOf([': keep-alive\n\ndata: one\n\n']), () => { pulses += 1 })
    assert.deepEqual(events, [{ data: 'one' }])
    assert.ok(pulses >= 2)
  })

  test('reassembles events split across transport chunks', async () => {
    const events = await collect(streamOf(['da', 'ta: he', 'llo\n', '\n']))
    assert.deepEqual(events, [{ data: 'hello' }])
  })

  test('flushes an unterminated trailing event', async () => {
    const events = await collect(streamOf(['data: tail']))
    assert.deepEqual(events, [{ data: 'tail' }])
  })

  test('ignores a field-less event with no data', async () => {
    assert.deepEqual(await collect(streamOf(['\n\n'])), [])
  })

  test('drops the optional space after the field colon only once', async () => {
    assert.deepEqual(await collect(streamOf(['data:  two spaces\n\n'])), [{ data: ' two spaces' }])
  })

  test('handles a multi-byte character split across chunks', async () => {
    const encoder = new TextEncoder()
    const bytes = encoder.encode('data: 你好\n\n')
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 8))
        controller.enqueue(bytes.slice(8))
        controller.close()
      },
    })
    assert.deepEqual(await collect(body), [{ data: '你好' }])
  })
})

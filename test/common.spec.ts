/** The shared provider failure helpers: status codes, bodies, and the action link. */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { httpLlmError, isMissingOrInvalidCredential } from '../src/providers/common.js'

/** A JSON error response. */
function errorResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('httpLlmError', () => {
  test('a Google verification gate carries the link with its message', async () => {
    const error = await httpLlmError(errorResponse({
      error: {
        code: 403,
        message: 'Verify your account to continue.',
        status: 'PERMISSION_DENIED',
        details: [{
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: 'VALIDATION_REQUIRED',
          metadata: { validation_url: 'https://accounts.google.com/signin/continue?sarp=1' },
        }],
      },
    }, 403), 'Antigravity API')

    assert.match(error.message, /^Antigravity API request failed \(HTTP 403\): Verify your account to continue\./)
    assert.match(error.message, /verify here: https:\/\/accounts\.google\.com\/signin\/continue\?sarp=1$/)
    assert.equal(error.failure.status, 403)
    // The status still maps to the credential class, which is why the link has to travel
    // with the message: the code alone cannot say "verified, not re-authenticated".
    assert.equal(error.code, 'INVALID_CREDENTIAL')
  })

  test('the link is read from a Help entry when no ErrorInfo metadata carries it', async () => {
    const error = await httpLlmError(errorResponse({
      error: {
        code: 403,
        message: 'Verify your account to continue.',
        details: [{
          '@type': 'type.googleapis.com/google.rpc.Help',
          links: [
            { description: 'Learn more', url: 'https://support.google.com/accounts?p=al_alert' },
            { description: 'Verify your account', url: 'https://accounts.google.com/signin/continue?from=help' },
          ],
        }],
      },
    }, 403), 'Antigravity API')

    assert.match(error.message, /verify here: https:\/\/accounts\.google\.com\/signin\/continue\?from=help$/)
    assert.doesNotMatch(error.message, /support\.google\.com/)
  })

  test('an error body without an action link is left alone', async () => {
    const error = await httpLlmError(errorResponse({ error: { message: 'The input token count exceeds the maximum' } }, 400), 'Antigravity API')
    assert.equal(error.message, 'Antigravity API request failed (HTTP 400): The input token count exceeds the maximum')
    assert.equal(error.code, 'INVALID_REQUEST')
    assert.equal(isMissingOrInvalidCredential(error), false)
  })

  test('a 401 still reads as a credential failure', async () => {
    const error = await httpLlmError(errorResponse({ error: { message: 'invalid_grant' } }, 401), 'Antigravity API')
    assert.equal(error.code, 'INVALID_CREDENTIAL')
    assert.equal(isMissingOrInvalidCredential(error), true)
  })
})

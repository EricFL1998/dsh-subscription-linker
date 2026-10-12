/** Device-flow token parsing, identity extraction, and the polling grant. */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  decodeJwtClaims,
  DeviceFlowManager,
  identityFromTokens,
  LOGIN_CANCELLED_MESSAGE,
  parseTokenPayload,
  refreshKimiToken,
} from '../src/auth/device-flow.js'
import { DEFAULT_DEVICE_FLOW_TTL_MS } from '../src/constants.js'

/** Build an unsigned JWT whose payload carries the given claims. */
function jwtWithClaims(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${header}.${payload}.signature`
}

/** A JSON response, as the OAuth endpoints answer. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('parseTokenPayload', () => {
  test('records the token real expiry, with no margin baked in', () => {
    const before = Date.now()
    const tokens = parseTokenPayload({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 })
    assert.equal(tokens.accessToken, 'access')
    assert.equal(tokens.refreshToken, 'refresh')
    // Kimi Code's access tokens live 15 minutes; a stored instant that is already
    // part-spent would make the Settings card claim "expired" right after login.
    assert.ok(tokens.expiresAt >= before + 3_600_000, `expiry ${String(tokens.expiresAt)} not in the future`)
    assert.ok(tokens.expiresAt <= Date.now() + 3_600_000, 'expiry is not extended past the granted lifetime')
  })

  test('a short-lived token is not stored as already expired', () => {
    const tokens = parseTokenPayload({ access_token: 'a', expires_in: 300 })
    assert.ok(tokens.expiresAt > Date.now(), 'a 5-minute token is still usable when it is issued')
  })

  test('retains the previous refresh token when the response omits one', () => {
    const tokens = parseTokenPayload({ access_token: 'access', expires_in: 60 }, 'previous')
    assert.equal(tokens.refreshToken, 'previous')
  })

  test('leaves the refresh token absent when neither source supplies one', () => {
    const tokens = parseTokenPayload({ access_token: 'access', expires_in: 60 })
    assert.equal(tokens.refreshToken, undefined)
    assert.equal(Object.hasOwn(tokens, 'refreshToken'), false)
  })

  test('rejects a missing access token', () => {
    assert.throws(() => parseTokenPayload({ expires_in: 60 }), /missing required fields/)
  })

  test('rejects a missing, negative, or non-finite lifetime', () => {
    assert.throws(() => parseTokenPayload({ access_token: 'a' }), /missing required fields/)
    assert.throws(() => parseTokenPayload({ access_token: 'a', expires_in: -1 }), /missing required fields/)
    assert.throws(() => parseTokenPayload({ access_token: 'a', expires_in: Number.NaN }), /missing required fields/)
    assert.throws(() => parseTokenPayload({ access_token: 'a', expires_in: Number.POSITIVE_INFINITY }), /missing required fields/)
    // JSON.stringify would turn Infinity into null, so the wire form is hand-written.
    const parsed: unknown = JSON.parse('{"access_token":"a","expires_in":1e999}')
    assert.throws(() => parseTokenPayload(parsed), /missing required fields/)
  })

  test('rejects an expiry that overflows once multiplied', () => {
    assert.throws(
      () => parseTokenPayload({ access_token: 'a', expires_in: Number.MAX_VALUE }),
      /missing required fields/,
    )
  })
})

describe('decodeJwtClaims', () => {
  test('decodes a payload and tolerates opaque tokens', () => {
    assert.deepEqual(decodeJwtClaims(jwtWithClaims({ user_id: 'u1' }))?.user_id, 'u1')
    assert.equal(decodeJwtClaims('not-a-jwt'), undefined)
    assert.equal(decodeJwtClaims(undefined), undefined)
    assert.equal(decodeJwtClaims('header.@@@invalid.signature'), undefined)
  })
})

describe('identityFromTokens', () => {
  test('prefers user_id over sub within one token', () => {
    const identity = identityFromTokens(jwtWithClaims({ user_id: 'strong', sub: 'weak' }))
    assert.deepEqual(identity, { accountId: 'strong' })
  })

  test('falls back to sub', () => {
    assert.deepEqual(identityFromTokens(jwtWithClaims({ sub: 'subject' })), { accountId: 'subject' })
  })

  test('a refresh-token user_id outranks an access-token sub', () => {
    const access = jwtWithClaims({ sub: 'access-sub' })
    const refresh = jwtWithClaims({ user_id: 'refresh-user' })
    assert.equal(identityFromTokens(access, refresh).accountId, 'refresh-user')
  })

  test('lowercases the email from either token', () => {
    const identity = identityFromTokens(jwtWithClaims({ user_id: 'u', email: 'Alice@Kimi.Example' }))
    assert.equal(identity.email, 'alice@kimi.example')
    const fromRefresh = identityFromTokens('opaque', jwtWithClaims({ email: 'Bob@Kimi.Example' }))
    assert.equal(fromRefresh.email, 'bob@kimi.example')
  })

  test('yields no identity for opaque tokens', () => {
    assert.deepEqual(identityFromTokens('opaque', 'also-opaque'), {})
  })
})

describe('DeviceFlowManager', () => {
  test('settles a login from the poll loop and reports the pending code', async () => {
    const calls: string[] = []
    let polls = 0
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/api/oauth/device_authorization')) {
        return jsonResponse({
          device_code: 'device',
          user_code: 'WDJB-MJHT',
          verification_uri: 'https://auth.kimi.com/device',
          verification_uri_complete: 'https://auth.kimi.com/device?user_code=WDJB-MJHT',
          expires_in: 900,
          interval: 1,
        })
      }
      polls += 1
      if (polls === 1) return jsonResponse({ error: 'authorization_pending' })
      return jsonResponse({
        access_token: jwtWithClaims({ user_id: 'kimi-user' }),
        refresh_token: 'refresh',
        expires_in: 3600,
      })
    }

    const flows = new DeviceFlowManager()
    const attempt = await flows.start('kimi', { host: 'https://auth.kimi.com', deviceId: 'a'.repeat(32), fetchFn })
    assert.equal(attempt.userCode, 'WDJB-MJHT')
    assert.equal(attempt.verificationUrl, 'https://auth.kimi.com/device?user_code=WDJB-MJHT')
    assert.ok(attempt.expiresAt > Date.now(), 'expiry is in the future')
    assert.equal(flows.isBusy('kimi'), true)
    assert.equal(flows.pending('kimi'), attempt)

    const tokens = await attempt.waitToken()
    assert.equal(tokens.refreshToken, 'refresh')
    assert.equal(identityFromTokens(tokens.accessToken).accountId, 'kimi-user')
    // The attempt removes itself once settled, so the panel stops polling.
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(flows.isBusy('kimi'), false)
    assert.ok(calls.length >= 3, 'device code plus at least two polls')
  })

  test('propagates a decline and clears the attempt', async () => {
    const fetchFn: typeof fetch = async (input) => String(input).endsWith('/device_authorization')
      ? jsonResponse({
          device_code: 'device',
          user_code: 'CODE',
          verification_uri: 'https://auth.kimi.com/device',
          interval: 1,
        })
      : jsonResponse({ error: 'access_denied' })

    const flows = new DeviceFlowManager()
    const attempt = await flows.start('kimi', { host: 'https://auth.kimi.com', deviceId: 'a'.repeat(32), fetchFn })
    await assert.rejects(attempt.waitToken(), /declined in the browser/)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(flows.isBusy('kimi'), false)
  })

  test('rejects a device-code response missing required fields', async () => {
    const fetchFn: typeof fetch = async () => jsonResponse({ user_code: 'CODE' })
    const flows = new DeviceFlowManager()
    await assert.rejects(
      flows.start('kimi', { host: 'https://auth.kimi.com', deviceId: 'a'.repeat(32), fetchFn }),
      /missing required fields/,
    )
    assert.equal(flows.isBusy('kimi'), false)
  })

  test('a cancelled attempt settles as a cancellation', async () => {
    const fetchFn: typeof fetch = async (input) => String(input).endsWith('/device_authorization')
      ? jsonResponse({
          device_code: 'device',
          user_code: 'CODE',
          verification_uri: 'https://auth.kimi.com/device',
          interval: 30,
        })
      : jsonResponse({ error: 'authorization_pending' })

    const flows = new DeviceFlowManager()
    const attempt = await flows.start('kimi', { host: 'https://auth.kimi.com', deviceId: 'a'.repeat(32), fetchFn })
    attempt.cancel()
    await assert.rejects(attempt.waitToken(), (error: unknown) =>
      error instanceof Error && error.message === LOGIN_CANCELLED_MESSAGE)
  })

  test('a non-positive interval falls back to the default poll cadence', async () => {
    const fetchFn: typeof fetch = async (input) => String(input).endsWith('/device_authorization')
      ? jsonResponse({
          device_code: 'device',
          user_code: 'CODE',
          verification_uri: 'https://auth.kimi.com/device',
          expires_in: 0,
          interval: 0,
        })
      : jsonResponse({ access_token: 'token', expires_in: 60 })

    const flows = new DeviceFlowManager()
    const attempt = await flows.start('kimi', { host: 'https://auth.kimi.com', deviceId: 'a'.repeat(32), fetchFn })
    assert.ok(attempt.expiresAt - Date.now() <= DEFAULT_DEVICE_FLOW_TTL_MS + 1_000)
    attempt.cancel()
    await attempt.waitToken().catch(() => undefined)
  })

  test('sends the CLI identity headers on both endpoints', async () => {
    const seen: Headers[] = []
    const fetchFn: typeof fetch = async (input, init) => {
      seen.push(new Headers(init?.headers))
      return String(input).endsWith('/device_authorization')
        ? jsonResponse({ device_code: 'd', user_code: 'c', verification_uri: 'https://auth.kimi.com/device', interval: 1 })
        : jsonResponse({ access_token: 'token', expires_in: 60 })
    }
    const flows = new DeviceFlowManager()
    const attempt = await flows.start('kimi', { host: 'https://auth.kimi.com', deviceId: 'b'.repeat(32), fetchFn })
    await attempt.waitToken()
    for (const headers of seen) {
      assert.equal(headers.get('x-msh-platform'), 'kimi_code_cli')
      assert.equal(headers.get('x-msh-device-id'), 'b'.repeat(32))
      assert.match(headers.get('user-agent') ?? '', /^KimiCLI\//)
    }
  })
})

describe('refreshKimiToken', () => {
  test('redeems the refresh token and keeps it when the response omits one', async () => {
    let body = ''
    const fetchFn: typeof fetch = async (_input, init) => {
      body = String(init?.body ?? '')
      return jsonResponse({ access_token: jwtWithClaims({ user_id: 'u' }), expires_in: 1800 })
    }
    const tokens = await refreshKimiToken(
      { host: 'https://auth.kimi.com', deviceId: 'a'.repeat(32), fetchFn },
      'old-refresh',
    )
    assert.equal(tokens.refreshToken, 'old-refresh')
    assert.match(body, /grant_type=refresh_token/)
    assert.match(body, /refresh_token=old-refresh/)
  })

  test('surfaces the provider description on failure', async () => {
    const fetchFn: typeof fetch = async () => jsonResponse({ error: 'invalid_grant', error_description: 'refresh token revoked' }, 400)
    await assert.rejects(
      refreshKimiToken({ host: 'https://auth.kimi.com', deviceId: 'a'.repeat(32), fetchFn }, 'old'),
      /refresh token revoked/,
    )
  })
})

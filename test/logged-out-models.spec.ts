/**
 * A route that is not signed in must not offer models.
 *
 * The picker and Auto both build their lists from `listModels`, so this is the one
 * place that decides whether a signed-out route is visible to them at all. The
 * Settings card hides its catalog on the same condition, from the other side.
 *
 * @module dsh-plugin-subscription-oauth/test/logged-out-models
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { AntigravityAdapter } from '../src/providers/antigravity.js'
import { GlmAdapter } from '../src/providers/glm.js'
import { GrokAdapter } from '../src/providers/grok.js'
import { KimiAdapter } from '../src/providers/kimi.js'

/** A token manager for an account that holds no session. */
const signedOut = { session: async () => undefined } as never

/** A token manager for an account that does. */
const signedIn = {
  session: async () => ({
    account: 'user-1',
    session: { accessToken: 'token', expiresAt: Date.now() + 3_600_000 },
  }),
} as never

describe('a signed-out route offers no models', () => {
  test('every adapter lists nothing while signed out', async () => {
    const adapters = [
      new KimiAdapter({ tokens: signedOut, discovery: false } as never),
      new GrokAdapter({ tokens: signedOut, discovery: false } as never),
      new AntigravityAdapter({ tokens: signedOut, discovery: false } as never),
      new GlmAdapter({ tokens: signedOut, discovery: false } as never),
    ]
    for (const adapter of adapters) {
      // The guard runs before any catalog work, so a signed-out route never
      // reaches the shipped list, discovery or the hand-added ids.
      assert.deepEqual(
        await adapter.listModels('any'),
        [],
        `${adapter.constructor.name} still listed models while signed out`,
      )
    }
  })

  test('a signed-in route still lists its catalog', async () => {
    const adapter = new GlmAdapter({
      tokens: signedIn,
      discovery: false,
      apiBase: 'https://open.bigmodel.cn/api/coding/paas/v4',
    } as never)
    const ids = (await adapter.listModels('glm')).map((model) => model.id)
    assert.ok(ids.length > 0, 'a signed-in route must still offer its models')
    assert.ok(ids.includes('glm-5.3'))
  })
})

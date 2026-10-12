/**
 * Live probe of Kimi's device-authorization endpoint.
 *
 * Starts a device authorization and immediately abandons it: this only checks
 * that the shipped client id and the `X-Msh-*` identity headers are accepted,
 * and never completes a login or touches an account. The issued code is left
 * to expire, and no token is requested.
 */
import { DeviceFlowManager } from '../lib/auth/device-flow.js'
import { resolveOAuthHost } from '../lib/constants.js'

const host = resolveOAuthHost()
const flows = new DeviceFlowManager()
const provider = 'kimi'

try {
  const attempt = await flows.start(provider, { host, deviceId: '0'.repeat(32) })
  console.log(JSON.stringify({
    host,
    accepted: true,
    userCodeShape: `${String(attempt.userCode.length)} chars`,
    verificationUrlHost: new URL(attempt.verificationUrl).host,
    verificationUrlPath: new URL(attempt.verificationUrl).pathname,
    expiresInMinutes: Math.round((attempt.expiresAt - Date.now()) / 60_000),
  }, null, 2))
  attempt.cancel()
  await attempt.waitToken().catch(() => undefined)
} catch (error) {
  console.log(JSON.stringify({ host, accepted: false, error: error instanceof Error ? error.message : String(error) }, null, 2))
  process.exitCode = 1
}

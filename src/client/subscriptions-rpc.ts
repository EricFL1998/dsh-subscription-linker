/**
 * Browser caller for the plugin's own RPC channel.
 *
 * The node half mounts one exact `POST /api/subscription-oauth.<endpoint>` route
 * per endpoint, so every call travels on the shared `/api` channel with a
 * prefixed endpoint name — the same wire the rest of the shell uses.
 *
 * @module dsh-plugin-subscription-oauth/client/subscriptions-rpc
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'

import { RPC_PREFIX } from '../protocol.js'
import type { CcSwitchBalanceResult, RpcEndpoint, RpcMap } from '../protocol.js'

/** The shared channel the node half's routes are mounted on. */
const CHANNEL = '/api'

/** The host's own DeepSeek account controller, from which the chip reads a balance. */
const ACCOUNT_CHANNEL = '/api'
const ACCOUNT_NAMESPACE = 'account'

/** A failed call: either the transport rejected or the endpoint answered `ok: false`. */
export class SubscriptionsRpcError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'SubscriptionsRpcError'
  }
}

/** Human-readable message for any thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Call one endpoint, unwrapping the transport result. */
export type SubscriptionsCall = <K extends RpcEndpoint>(
  endpoint: K,
  payload: RpcMap[K]['payload'],
) => Promise<RpcMap[K]['value']>

/** A caller for one manually added provider's cc-switch balance. */
export interface CcSwitchBalanceCall {
  (credentialRef: string): Promise<CcSwitchBalanceResult>
}

/**
 * Bind a caller to one connection's RPC transport.
 * @param rpc - the browser connection's RPC caller.
 * @returns a typed caller for this plugin's endpoints.
 */
export function createSubscriptionsCall(rpc: ConnectionHandle['rpc']): SubscriptionsCall {
  return async function call(endpoint, payload) {
    let result: Awaited<ReturnType<ConnectionHandle['rpc']['call']>>
    try {
      result = await rpc.call(CHANNEL, `${RPC_PREFIX}${endpoint}`, payload)
    } catch (error: unknown) {
      throw new SubscriptionsRpcError(messageOf(error), 'RPC_TRANSPORT')
    }
    if (!result.ok) throw new SubscriptionsRpcError(result.error.message, result.error.code)
    return result.value as never
  }
}

/**
 * The DeepSeek account's wallet balances, as the host's account controller reports them.
 *
 * The controller answers `null` when the account is signed out, `{ status: 'failed' }`
 * when the read did not complete, and `{ status: 'ready', value: <normal wallets>,
 * bonusWallets: <bonus wallets> }` on success.
 */
export interface HostAccountBalance {
  /** Normal (topped-up) wallets, one per currency. */
  value: readonly { currency: string, balance: string }[]
  /** Bonus / promotional wallets, one per currency. */
  bonusWallets?: readonly { currency: string, balance: string }[]
}

/** A narrow caller for the host's own account controller. */
export interface AccountBalanceCall {
  (): Promise<HostAccountBalance | { status: 'failed' } | null>
}

/**
 * Read the DeepSeek account's balance through the host's own account controller.
 *
 * The host owns the DeepSeek OAuth grant and the platform endpoint, so this asks it
 * rather than re-deriving either. It returns `null` when the account is signed out or
 * the read fails, so a chip can simply not render in that case.
 *
 * @param rpc - the browser connection's RPC caller.
 * @returns the balance, or null when there is nothing to show.
 */
export function createAccountBalanceCall(rpc: ConnectionHandle['rpc']): AccountBalanceCall {
  return async function call() {
    let result: Awaited<ReturnType<ConnectionHandle['rpc']['call']>>
    try {
      result = await rpc.call(ACCOUNT_CHANNEL, 'account/getBalance', {
        version: '1',
        locale: Intl.DateTimeFormat().resolvedOptions().locale ?? 'en-US',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset(),
      })
    } catch (error: unknown) {
      throw new SubscriptionsRpcError(messageOf(error), 'RPC_TRANSPORT')
    }
    if (!result.ok) throw new SubscriptionsRpcError(result.error.message, result.error.code)
    return result.value as HostAccountBalance | { status: 'failed' } | null
  }
}

/**
 * Read a manually added provider's balance through the plugin's cc-switch endpoint.
 *
 * The caller names the credential reference the provider's profile uses (its
 * `apiKeyEnv`), and the host's credential service resolves it to the API key. The result
 * is `undefined` when there is no key or the provider did not answer — never a wrong
 * figure.
 *
 * @param rpc - the browser connection's RPC caller.
 * @returns a narrow caller taking the credential reference.
 */
export function createCcSwitchBalanceCall(rpc: ConnectionHandle['rpc']): CcSwitchBalanceCall {
  return async function call(credentialRef: string) {
    let result: Awaited<ReturnType<ConnectionHandle['rpc']['call']>>
    try {
      result = await rpc.call(CHANNEL, `${RPC_PREFIX}ccswitch-balance`, { credentialRef })
    } catch (error: unknown) {
      throw new SubscriptionsRpcError(messageOf(error), 'RPC_TRANSPORT')
    }
    if (!result.ok) throw new SubscriptionsRpcError(result.error.message, result.error.code)
    return result.value as CcSwitchBalanceResult
  }
}

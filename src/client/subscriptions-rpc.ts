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
import type { RpcEndpoint, RpcMap } from '../protocol.js'

/** The shared channel the node half's routes are mounted on. */
const CHANNEL = '/api'

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

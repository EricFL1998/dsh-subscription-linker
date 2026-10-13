/**
 * Cross-request memory of when each provider account's allowance resets.
 *
 * This is what lets one model id draw on the whole account pool without a wasted
 * request: when the default account's allowance runs out, the moment it will refill is
 * remembered, and until then the scheduler sends work straight to another account
 * instead of trying the spent one, failing, and only then moving on. When the reset
 * time passes the spent account is first choice again.
 *
 * The holder is shared by the route's reader (which learns reset times from usage
 * reads) and its streamer (which consults them when picking an account), so the
 * scheduler's view is exactly the last read's.
 *
 * @module dsh-plugin-subscription-oauth/auth/allowance-scheduler
 */

/** One account's remembered allowance state. */
export interface AllowanceState {
  /** Epoch milliseconds at which the account's allowance resets, when known. */
  resetsAt?: number
  /** Epoch milliseconds at which this state was last learned. */
  learnedAt: number
}

/** In-memory, per-provider memory of account reset times. */
export class AllowanceScheduler {
  private readonly byProvider = new Map<string, Map<string, AllowanceState>>()

  /** One provider's account states, creating the map on first use. */
  private provider(provider: string): Map<string, AllowanceState> {
    let map = this.byProvider.get(provider)
    if (map === undefined) {
      map = new Map()
      this.byProvider.set(provider, map)
    }
    return map
  }

  /**
   * Record that one account's allowance resets at a given moment.
   *
   * @param provider - the provider route id.
   * @param account - the account key.
   * @param resetsAt - epoch milliseconds of the allowance reset, when known.
   */
  noteReset(provider: string, account: string, resetsAt?: number): void {
    this.provider(provider).set(account, { ...resetsAt === undefined ? {} : { resetsAt }, learnedAt: Date.now() })
  }

  /**
   * Forget one account's remembered state, when the account is removed.
   *
   * A signed-out account's allowance state is no longer meaningful — there is no
   * account to schedule around — and a re-added account starts fresh.
   *
   * @param provider - the provider route id.
   * @param account - the account key to forget.
   */
  clear(provider: string, account: string): void {
    this.byProvider.get(provider)?.delete(account)
  }

  /**
   * Whether one account's allowance is known to be spent now.
   *
   * True when the account was recorded with a reset time that is still in the future:
   * its allowance is spent and will not refill until then, so a request should go to a
   * different account rather than fail against this one.
   *
   * @param provider - the provider route id.
   * @param account - the account key.
   * @returns whether the account's allowance is spent until its remembered reset.
   */
  isSpentUntilReset(provider: string, account: string): boolean {
    const state = this.byProvider.get(provider)?.get(account)
    if (state === undefined) return false
    if (state.resetsAt === undefined) return false
    return Date.now() < state.resetsAt
  }

  /**
   * The moment one account's allowance is known to reset, when it was recorded.
   *
   * @param provider - the provider route id.
   * @param account - the account key.
   * @returns the reset instant, or undefined when unknown or already passed.
   */
  resetAt(provider: string, account: string): number | undefined {
    const state = this.byProvider.get(provider)?.get(account)
    if (state === undefined || state.resetsAt === undefined) return undefined
    return Date.now() < state.resetsAt ? state.resetsAt : undefined
  }
}

/** The one shared scheduler every route reads and writes. */
export const allowanceScheduler = new AllowanceScheduler()

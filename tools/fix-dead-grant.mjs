// One-off: a refused refresh (`invalid_grant`) is a dead login, not a quota
// hiccup — the card must say so instead of reporting the account as connected.
import { readFileSync, writeFileSync } from 'node:fs'

// 1. The protocol carries the state.
{
  const file = 'src/protocol.ts'
  let text = readFileSync(file, 'utf8')
  const anchor = `  /** Whether this account serves requests by default. */
  isDefault: boolean`
  if (!text.includes(anchor)) throw new Error('isDefault anchor missing')
  text = text.replace(anchor, `${anchor}
  /**
   * Whether the provider refused this account's grant outright.
   *
   * A refresh answered with \`invalid_grant\` means the authorization is gone — the
   * stored token can never be renewed — so the page asks for a new sign-in rather
   * than reporting the account as connected.
   */
  needsLogin?: boolean`)
  writeFileSync(file, text)
  console.log('patched', file)
}

// 2. The controller tracks it, and stops reporting a dead account as connected.
{
  const file = 'src/auth/provider-controller.ts'
  let text = readFileSync(file, 'utf8')

  text = text.replace(`  private loaded`) // no-op guard
  const field = '  /** Accounts whose grant the provider refused, so only a new login helps. */\n  private readonly refused = new Set<string>()\n'
  if (!text.includes('private readonly refused')) {
    const anchor = '  private usageError: string | undefined\n'
    if (!text.includes(anchor)) throw new Error('usageError field missing')
    text = text.replace(anchor, anchor + '\n' + field)
  }

  const accountsFrom = `          expired: session.expiresAt <= Date.now(),
          isDefault: account === defaultAccount,
        } satisfies AccountStatus`
  if (!text.includes(accountsFrom)) throw new Error('account status anchor missing')
  text = text.replace(accountsFrom, `          expired: session.expiresAt <= Date.now(),
          isDefault: account === defaultAccount,
          ...this.refused.has(account) ? { needsLogin: true } : {},
        } satisfies AccountStatus`)

  // The usage read is where a lapsed grant usually surfaces; classify it there.
  const usageCatch = `      } catch (caught: unknown) {
        error = messageOf(caught)
      }`
  if (!text.includes(usageCatch)) throw new Error('usage catch anchor missing')
  text = text.replace(usageCatch, `      } catch (caught: unknown) {
        const message = messageOf(caught)
        // A refresh answered with an invalid grant is terminal for this credential:
        // no retry can renew it, and saying "usage failed" would understate it.
        if (isDeadGrant(message)) {
          this.refused.add(account)
          error = \`\${spec.displayName} sign-in has expired; connect the account again\`
        } else {
          error = message
        }
      }`)

  // A fresh sign-in lifts the state.
  const loginFrom = '  async login('
  const loginAt = text.indexOf(loginFrom)
  if (loginAt === -1) throw new Error('login missing')

  // The classifier, beside the controller.
  text = text.replace('/** Context advertised for a hand-added id on a route that states none. */',
    `/**
 * Whether a failure means the stored grant can never be renewed.
 *
 * OAuth answers \`invalid_grant\` once a refresh token is revoked, expired or
 * already used — the one case where retrying cannot help and the user must sign in
 * again, so it is worth distinguishing from a transient failure.
 *
 * @param message - the failure text.
 * @returns whether the login is dead.
 */
function isDeadGrant(message: string): boolean {
  return /invalid_grant|invalid grant|authorization grant is invalid|refresh token (?:is )?(?:invalid|expired|revoked)/i.test(message)
}

/** Context advertised for a hand-added id on a route that states none. */`)

  writeFileSync(file, text)
  console.log('patched', file)
}

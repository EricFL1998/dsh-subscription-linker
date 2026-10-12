/**
 * Durable credentials, keyed by provider.
 *
 * The file mirrors the subscriptions plugin's layout so both plugins' token
 * files stay recognisable to a user browsing `~/.dsh/plugins`: a JSON object
 * keyed by provider, each entry holding a `default` account key and an
 * `accounts` record. Writes are atomic (temp file plus rename) with owner-only
 * permissions, so a crash mid-write cannot leave a truncated credential file.
 *
 * The store is generic over the session shape: each provider declares its own
 * session fields plus the parser that validates them, while account keying,
 * defaults, and the file lifecycle stay shared.
 *
 * @module dsh-plugin-subscription-oauth/auth/store
 */

import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Fields every provider's stored session carries. */
export interface SessionBase {
  accessToken: string
  /** Refresh token; absent for a token set the service issued without one. */
  refreshToken?: string
  /** Epoch milliseconds after which `accessToken` must not be sent. */
  expiresAt: number
  /** Service-disclosed account identity, when the tokens carry one. */
  accountId?: string
  email?: string
}

/** One provider entry inside the credential file. */
interface ProviderEntry {
  default?: string
  accounts?: Record<string, unknown>
  aliases?: Record<string, string>
}

/** The whole credential file. */
type CredentialFile = Record<string, ProviderEntry>

/** True for a plain object usable as a JSON record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read a non-empty trimmed string, or undefined. */
export function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** Read a finite epoch-millisecond value, or undefined. */
export function finiteInstant(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Derive the account key for one session: the identity the service disclosed,
 * falling back to a digest of the refresh token so distinct logins stay
 * distinct even when both tokens are opaque.
 * @param session - the session to key.
 * @returns a stable account key.
 */
export function accountKeyOf(session: SessionBase): string {
  if (session.accountId !== undefined) return session.accountId
  if (session.email !== undefined) return session.email
  const secret = session.refreshToken ?? session.accessToken
  return createHash('sha256').update(secret).digest('hex').slice(0, 16)
}

/** Label shown for one account in the Settings page. */
export function accountLabelOf(session: SessionBase): string {
  return session.email ?? session.accountId ?? accountKeyOf(session)
}

/**
 * Owns the on-disk credential file for one provider.
 *
 * In-memory state is authoritative between writes: a failed read leaves the
 * store empty rather than throwing, so a corrupt file degrades to "logged out"
 * instead of breaking plugin startup.
 */
export class TokenStore<S extends SessionBase> {
  private entries: Record<string, ProviderEntry> = {}
  private loaded = false
  /**
   * The in-flight load, shared by every caller.
   *
   * Without this, a second caller saw `loaded` already true, skipped the read and
   * wrote its own state — while the first read was still on its way back and then
   * replaced that state with the file it had read a moment earlier. A sign-in that
   * settled quickly enough to overlap the first load was therefore wiped: the
   * account was saved in memory, the pending read overwrote it, and the next write
   * persisted the empty document. A flow whose session arrives in milliseconds,
   * like GLM's polled one, hits that window every time.
   */
  private loading: Promise<void> | undefined

  /**
   * @param file - absolute path of the credential file.
   * @param provider - section key this store owns.
   * @param parse - validates and coerces one stored account into a session.
   */
  constructor(
    private readonly file: string,
    private readonly provider: string,
    private readonly parse: (value: unknown) => S | undefined,
  ) {}

  /** Load the file once; later calls share the same in-flight read. */
  private async ensureLoaded(reload = false): Promise<void> {
    if (this.loaded && !reload) return
    if (reload) {
      this.loaded = false
      this.loading = undefined
    }
    this.loading ??= this.read().finally(() => {
      this.loading = undefined
      this.loaded = true
    })
    await this.loading
  }

  /** Read the document from disk into memory. */
  private async read(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      this.entries = {}
      return
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      this.entries = isRecord(parsed) ? parsed as CredentialFile : {}
    } catch {
      this.entries = {}
    }
  }

  /** Re-read the file from disk, discarding in-memory changes. */
  async reload(): Promise<void> {
    await this.ensureLoaded(true)
  }

  private providerEntry(): ProviderEntry {
    return this.entries[this.provider] ?? {}
  }

  /** Every stored session, keyed by account. */
  async list(): Promise<Record<string, S>> {
    await this.ensureLoaded()
    const accounts = this.providerEntry().accounts
    if (!isRecord(accounts)) return {}
    const result: Record<string, S> = {}
    for (const [key, value] of Object.entries(accounts)) {
      const session = this.parse(value)
      if (session !== undefined) result[key] = session
    }
    return result
  }

  /** The default account key, falling back to the only stored account. */
  async defaultAccount(): Promise<string | undefined> {
    await this.ensureLoaded()
    const entry = this.providerEntry()
    const accounts = await this.list()
    const keys = Object.keys(accounts)
    const preferred = nonEmpty(entry.default)
    if (preferred !== undefined && keys.includes(preferred)) return preferred
    return keys[0]
  }

  /** Read one account's session. */
  async get(account?: string): Promise<S | undefined> {
    const accounts = await this.list()
    const key = account ?? await this.defaultAccount()
    return key === undefined ? undefined : accounts[key]
  }

  /** Whether any account is stored. */
  async hasAny(): Promise<boolean> {
    return Object.keys(await this.list()).length > 0
  }

  /** Insert or replace one account, making it the default when none is set. */
  async save(key: string, session: S, options: { makeDefault?: boolean } = {}): Promise<void> {
    await this.ensureLoaded()
    const entry = this.providerEntry()
    const accounts = { ...isRecord(entry.accounts) ? entry.accounts : {}, [key]: session }
    const makeDefault = options.makeDefault ?? true
    const next: ProviderEntry = {
      ...entry,
      accounts,
      ...makeDefault || entry.default === undefined ? { default: key } : {},
    }
    this.entries = { ...this.entries, [this.provider]: next }
    await this.persist()
  }

  /** Promote one account to default. */
  async setDefault(key: string): Promise<void> {
    await this.ensureLoaded()
    const entry = this.providerEntry()
    this.entries = { ...this.entries, [this.provider]: { ...entry, default: key } }
    await this.persist()
  }

  /** Remove one account; the default moves to a remaining account when any. */
  async remove(key: string): Promise<void> {
    await this.ensureLoaded()
    const entry = this.providerEntry()
    const accounts = { ...isRecord(entry.accounts) ? entry.accounts : {} }
    delete accounts[key]
    const remaining = Object.keys(accounts)
    const fallback = entry.default === key ? remaining[0] : entry.default
    const next: ProviderEntry = { ...entry, accounts }
    if (fallback === undefined) delete next.default
    else next.default = fallback
    this.entries = { ...this.entries, [this.provider]: next }
    await this.persist()
  }

  /** Write the file atomically with owner-only permissions. */
  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(this.entries, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    try {
      await rename(temporary, this.file)
      await chmod(this.file, 0o600)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }
}

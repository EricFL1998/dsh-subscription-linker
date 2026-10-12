/** Credential store: account keying, atomic persistence, and account lifecycle. */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import { accountKeyOf, accountLabelOf, TokenStore } from '../src/auth/store.js'
import { parseKimiSession } from '../src/providers/kimi.js'
import type { KimiSession } from '../src/providers/kimi.js'

let directory: string

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'kimi-store-'))
})

after(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** A session with the given identity fields. */
function session(overrides: Partial<KimiSession> = {}): KimiSession {
  return {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: Date.now() + 3_600_000,
    oauthHost: 'https://auth.kimi.com',
    ...overrides,
  }
}

/** A Kimi store rooted at one temp path. */
function store(name: string): TokenStore<KimiSession> {
  return new TokenStore<KimiSession>(path.join(directory, name, 'auth.json'), 'kimi', parseKimiSession)
}

/** Write a fixture credential file and return its path. */
async function fixture(name: string, contents: string): Promise<string> {
  const file = path.join(directory, name, 'auth.json')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, contents, 'utf8')
  return file
}

describe('account identity', () => {
  test('prefers the service user id, then the email', () => {
    assert.equal(accountKeyOf(session({ accountId: 'user-1', email: 'a@b.c' })), 'user-1')
    assert.equal(accountKeyOf(session({ email: 'a@b.c' })), 'a@b.c')
  })

  test('falls back to a digest that distinguishes two opaque logins', () => {
    const first = accountKeyOf(session({ refreshToken: 'one' }))
    const second = accountKeyOf(session({ refreshToken: 'two' }))
    assert.match(first, /^[0-9a-f]{16}$/)
    assert.notEqual(first, second)
    assert.equal(first, accountKeyOf(session({ refreshToken: 'one' })))
  })

  test('labels an account with its email, id, or key', () => {
    assert.equal(accountLabelOf(session({ email: 'a@b.c', accountId: 'u' })), 'a@b.c')
    assert.equal(accountLabelOf(session({ accountId: 'u' })), 'u')
    assert.match(accountLabelOf(session({ refreshToken: 'x' })), /^[0-9a-f]{16}$/)
  })
})

describe('parseKimiSession', () => {
  test('accepts a complete session and rejects the rest', () => {
    const base = { accessToken: 'a', oauthHost: 'https://auth.kimi.com', expiresAt: 1 }
    assert.deepEqual(parseKimiSession(base), base)
    assert.equal(parseKimiSession({ ...base, accessToken: '' }), undefined)
    assert.equal(parseKimiSession({ ...base, oauthHost: undefined }), undefined)
    assert.equal(parseKimiSession({ ...base, expiresAt: 'soon' }), undefined)
    assert.equal(parseKimiSession('nope'), undefined)
    assert.equal(parseKimiSession(null), undefined)
  })

  test('drops blank optional fields instead of storing empty strings', () => {
    const parsed = parseKimiSession({
      accessToken: 'a',
      oauthHost: 'https://auth.kimi.com',
      expiresAt: 1,
      refreshToken: '  ',
      email: '',
      accountId: 'u',
    })
    assert.deepEqual(parsed, { accessToken: 'a', oauthHost: 'https://auth.kimi.com', expiresAt: 1, accountId: 'u' })
  })
})

describe('TokenStore', () => {
  test('saves, reads back, and makes the first account the default', async () => {
    const subject = store('first')
    assert.equal(await subject.hasAny(), false)
    assert.equal(await subject.defaultAccount(), undefined)

    await subject.save('user-1', session({ accountId: 'user-1' }))
    assert.equal(await subject.hasAny(), true)
    assert.equal(await subject.defaultAccount(), 'user-1')
    assert.equal((await subject.get())?.accessToken, 'access')
    assert.deepEqual(Object.keys(await subject.list()), ['user-1'])

    // A second account appends without stealing the default.
    await subject.save('user-2', session({ accountId: 'user-2' }), { makeDefault: false })
    assert.deepEqual(Object.keys(await subject.list()).sort(), ['user-1', 'user-2'])
    assert.equal(await subject.defaultAccount(), 'user-1')

    await subject.setDefault('user-2')
    assert.equal(await subject.defaultAccount(), 'user-2')
  })

  test('writes owner-only permissions and re-reads from disk', async () => {
    const file = path.join(directory, 'perms', 'auth.json')
    const subject = new TokenStore<KimiSession>(file, 'kimi', parseKimiSession)
    await subject.save('user-1', session({ accountId: 'user-1' }))
    if (process.platform !== 'win32') {
      assert.equal((await stat(file)).mode & 0o777, 0o600)
    }
    const raw = await readFile(file, 'utf8')
    assert.match(raw, /"kimi"/)
    assert.match(raw, /"user-1"/)

    const reopened = new TokenStore<KimiSession>(file, 'kimi', parseKimiSession)
    assert.equal((await reopened.get('user-1'))?.oauthHost, 'https://auth.kimi.com')
  })

  test('a sign-in that overlaps the first load is still stored', async () => {
    const file = path.join(directory, 'race', 'auth.json')
    const subject = new TokenStore<KimiSession>(file, 'kimi', parseKimiSession)
    // Both start before either has read the file: exactly the interleaving a fast
    // login produces, where the still-pending read used to overwrite the write.
    await Promise.all([
      subject.list(),
      subject.save('user-1', session({ accountId: 'user-1' })),
    ])
    assert.deepEqual(Object.keys(await subject.list()), ['user-1'])
    // And it survives on disk, not just in memory.
    const reopened = new TokenStore<KimiSession>(file, 'kimi', parseKimiSession)
    assert.deepEqual(Object.keys(await reopened.list()), ['user-1'])
  })

  test('removing the default hands it to a remaining account', async () => {
    const subject = store('remove')
    await subject.save('first', session())
    await subject.save('second', session())
    assert.equal(await subject.defaultAccount(), 'second')

    await subject.remove('second')
    assert.equal(await subject.defaultAccount(), 'first')
    await subject.remove('first')
    assert.equal(await subject.defaultAccount(), undefined)
    assert.equal(await subject.hasAny(), false)
  })

  test('a corrupt file degrades to signed out instead of throwing', async () => {
    const file = await fixture('corrupt', '{ not json')
    const subject = new TokenStore<KimiSession>(file, 'kimi', parseKimiSession)
    assert.deepEqual(await subject.list(), {})
    assert.equal(await subject.hasAny(), false)
  })

  test('ignores entries that are not usable sessions', async () => {
    const file = await fixture('partial', JSON.stringify({
      kimi: {
        default: 'good',
        accounts: {
          good: { accessToken: 'a', oauthHost: 'https://auth.kimi.com', expiresAt: 1 },
          missingHost: { accessToken: 'a', expiresAt: 1 },
          badExpiry: { accessToken: 'a', oauthHost: 'https://auth.kimi.com', expiresAt: 'soon' },
          notAnObject: 'nope',
        },
      },
    }))
    const subject = new TokenStore<KimiSession>(file, 'kimi', parseKimiSession)
    assert.deepEqual(Object.keys(await subject.list()), ['good'])
  })

  test('each provider owns its own section of one file', async () => {
    const file = path.join(directory, 'shared', 'auth.json')
    const kimi = new TokenStore<KimiSession>(file, 'kimi', parseKimiSession)
    await kimi.save('user-1', session({ accountId: 'user-1' }))

    // A second provider's store writes its own section and leaves Kimi alone.
    const other = new TokenStore<{ accessToken: string, expiresAt: number }>(file, 'grok', (value) => {
      if (typeof value !== 'object' || value === null) return undefined
      const record = value as Record<string, unknown>
      return typeof record.accessToken === 'string' && typeof record.expiresAt === 'number'
        ? { accessToken: record.accessToken, expiresAt: record.expiresAt }
        : undefined
    })
    await other.save('grok-1', { accessToken: 'g', expiresAt: 2 })

    const written = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    assert.deepEqual(Object.keys(written).sort(), ['grok', 'kimi'])
    assert.equal(await kimi.hasAny(), true)
    assert.equal(await other.hasAny(), true)
    // The Kimi entry survived the other provider's write untouched.
    const reopened = new TokenStore<KimiSession>(file, 'kimi', parseKimiSession)
    assert.equal((await reopened.get('user-1'))?.oauthHost, 'https://auth.kimi.com')
  })
})

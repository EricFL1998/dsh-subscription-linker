/** Device-id persistence and the identity headers every Kimi request carries. */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import { loadOrCreateDeviceId, mintDeviceId, readDeviceId } from '../src/auth/device-id.js'
import { deviceModel, kimiIdentityHeaders, kimiRequestHeaders, platformWord } from '../src/auth/headers.js'
import { KIMI_CLI_VERSION } from '../src/constants.js'

let directory: string

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'kimi-device-'))
})

after(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('mintDeviceId', () => {
  test('matches the CLI format: 32 lowercase hex characters', () => {
    assert.match(mintDeviceId(), /^[0-9a-f]{32}$/)
    assert.notEqual(mintDeviceId(), mintDeviceId())
  })
})

describe('loadOrCreateDeviceId', () => {
  test('creates once and reuses the stored id', async () => {
    const dir = path.join(directory, 'reuse')
    const first = await loadOrCreateDeviceId(dir)
    assert.match(first, /^[0-9a-f]{32}$/)
    const stored = await readFile(path.join(dir, 'kimi-device-id'), 'utf8')
    assert.equal(stored.trim(), first)
    assert.equal(await loadOrCreateDeviceId(dir), first)
  })

  test('replaces a malformed file instead of failing', async () => {
    const dir = path.join(directory, 'malformed')
    await loadOrCreateDeviceId(dir)
    await writeFile(path.join(dir, 'kimi-device-id'), 'not-a-device-id', 'utf8')
    const replaced = await loadOrCreateDeviceId(dir)
    assert.match(replaced, /^[0-9a-f]{32}$/)
    assert.equal(await readDeviceId(path.join(dir, 'kimi-device-id')), replaced)
  })

  test('readDeviceId reports absence rather than throwing', async () => {
    assert.equal(await readDeviceId(path.join(directory, 'missing', 'kimi-device-id')), undefined)
  })
})

describe('identity headers', () => {
  test('names the platform the way the CLI does', () => {
    assert.equal(platformWord('win32'), 'Windows')
    assert.equal(platformWord('darwin'), 'macOS')
    assert.equal(platformWord('linux'), 'Linux')
    assert.equal(platformWord('freebsd'), 'freebsd')
    assert.match(deviceModel('win32'), /^Windows .+ \S+$/)
  })

  test('carries the CLI product token and the device id', () => {
    const deviceId = 'a'.repeat(32)
    const headers = kimiIdentityHeaders(deviceId)
    assert.equal(headers['User-Agent'], `KimiCLI/${KIMI_CLI_VERSION}`)
    assert.equal(headers['X-Msh-Platform'], 'kimi_code_cli')
    assert.equal(headers['X-Msh-Version'], KIMI_CLI_VERSION)
    assert.equal(headers['X-Msh-Device-Id'], deviceId)
    assert.ok((headers['X-Msh-Device-Name'] ?? '').length > 0)
    assert.match(headers['X-Msh-Device-Model'] ?? '', /\S+ .+ \S+/)
    assert.ok((headers['X-Msh-Os-Version'] ?? '').length > 0)
  })

  test('joins the CLI product and the harness attribution into one User-Agent', () => {
    const headers = kimiRequestHeaders(kimiIdentityHeaders('a'.repeat(32)), { authorization: 'Bearer token' })
    assert.equal(headers.authorization, 'Bearer token')
    assert.match(headers['User-Agent'] ?? '', /^KimiCLI\/\S+ deepseek-harness\/\S+ \(\+https:\/\//)
    // The attribution header must not survive as a second, competing field.
    assert.equal(headers['user-agent'], undefined)
    assert.deepEqual(Object.keys(headers).filter((key) => key.toLowerCase() === 'user-agent'), ['User-Agent'])
  })
})

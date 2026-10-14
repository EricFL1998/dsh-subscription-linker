/** The on-disk model-catalog cache: what a route starts from without asking again. */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import { ModelCatalogCache } from '../src/providers/model-cache.js'

let directory: string

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'model-cache-'))
})

after(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** A cache file path inside the suite's temporary directory. */
function cacheFile(name: string): string {
  return path.join(directory, name, 'model-catalog.json')
}

describe('ModelCatalogCache', () => {
  test('a written payload is read back for the route that wrote it', async () => {
    const cache = new ModelCatalogCache(cacheFile('round-trip'))
    assert.equal(await cache.read('kimi'), undefined)
    await cache.write('kimi', [{ id: 'k3' }, { id: 'k3-256k' }])
    assert.deepEqual(await cache.read('kimi'), [{ id: 'k3' }, { id: 'k3-256k' }])
    // It belongs to one route only.
    assert.equal(await cache.read('grok'), undefined)
  })

  test('writing one route leaves another route alone', async () => {
    const cache = new ModelCatalogCache(cacheFile('two-routes'))
    await cache.write('kimi', ['k3'])
    await cache.write('grok', { public: ['grok-4.7'], cli: ['grok-4.7-build-fast'] })
    assert.deepEqual(await cache.read('kimi'), ['k3'])
    // The payload is opaque: a route that needs two listings stores both.
    assert.deepEqual(await cache.read('grok'), { public: ['grok-4.7'], cli: ['grok-4.7-build-fast'] })
  })

  test('an empty payload is not cached, so a stale table is never blanked', async () => {
    const cache = new ModelCatalogCache(cacheFile('empty'))
    await cache.write('kimi', ['k3'])
    await cache.write('kimi', [])
    assert.deepEqual(await cache.read('kimi'), ['k3'])
    await cache.write('kimi', null)
    assert.deepEqual(await cache.read('kimi'), ['k3'])
  })

  test('a missing, corrupt or stale-version document is a miss, not an error', async () => {
    const missing = new ModelCatalogCache(cacheFile('missing'))
    assert.equal(await missing.read('kimi'), undefined)

    const corrupt = cacheFile('corrupt')
    await mkdir(path.dirname(corrupt), { recursive: true })
    await writeFile(corrupt, '{not json', 'utf8')
    assert.equal(await new ModelCatalogCache(corrupt).read('kimi'), undefined)

    // A document written by an older understanding is discarded rather than misread.
    const stale = cacheFile('stale')
    await mkdir(path.dirname(stale), { recursive: true })
    await writeFile(stale, JSON.stringify({ version: 0, providers: { kimi: { fetchedAt: 1, payload: ['k3'] } } }), 'utf8')
    assert.equal(await new ModelCatalogCache(stale).read('kimi'), undefined)
  })

  test('writing leaves no partial document behind', async () => {
    const file = cacheFile('atomic')
    const cache = new ModelCatalogCache(file)
    await cache.write('kimi', ['k3'])
    // Only the document itself remains: the temporary file was renamed onto it.
    assert.deepEqual(await readdir(path.dirname(file)), ['model-catalog.json'])
  })

  test('a later write replaces the table', async () => {
    const cache = new ModelCatalogCache(cacheFile('replace'))
    await cache.write('kimi', ['k3', 'k3[1m]'])
    await cache.write('kimi', ['k3', 'k3-256k'])
    assert.deepEqual(await cache.read('kimi'), ['k3', 'k3-256k'])
  })
})

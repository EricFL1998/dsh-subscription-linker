/** Catalog order and visibility for one route's models. */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { entryMatches, fallbackEntry, findEntry, resolveCatalog } from '../src/providers/catalog.js'
import type { CatalogEntry } from '../src/providers/catalog.js'

/** Three entries in curated order. */
const ENTRIES: readonly CatalogEntry[] = [
  { id: 'a', name: 'A', contextWindow: 1 },
  { id: 'b', name: 'B', contextWindow: 2 },
  { id: 'c', name: 'C', contextWindow: 3 },
]

/** Ids of a resolved catalog's listed entries. */
function listed(order: readonly string[] = [], hidden: readonly string[] = []): string[] {
  return resolveCatalog(ENTRIES, order, new Set(hidden)).entries.map((entry) => entry.id)
}

describe('resolveCatalog', () => {
  test('keeps the curated order when nothing is ranked', () => {
    assert.deepEqual(listed(), ['a', 'b', 'c'])
  })

  test('follows the dropped order, then the curated order for the rest', () => {
    assert.deepEqual(listed(['c', 'a']), ['c', 'a', 'b'])
  })

  test('ignores ranked ids the catalog does not have, and repeats', () => {
    assert.deepEqual(listed(['zz', 'c', 'c', 'a']), ['c', 'a', 'b'])
  })

  test('omits hidden ids from the picker list but keeps them for the page', () => {
    const resolved = resolveCatalog(ENTRIES, [], new Set(['b']))
    assert.deepEqual(resolved.entries.map((entry) => entry.id), ['a', 'c'])
    assert.deepEqual(resolved.enabled.map((entry) => entry.id), ['a', 'c'])
    // The Settings list must still show a hidden model, so it can be re-enabled.
    assert.deepEqual(resolved.ranked.map((entry) => entry.id), ['a', 'b', 'c'])
  })

  test('an empty catalog stays empty', () => {
    const resolved = resolveCatalog([], [], new Set())
    assert.deepEqual(resolved.entries, [])
    assert.deepEqual(resolved.ranked, [])
  })
})

describe('entry lookup', () => {
  test('matches an id or one of its aliases', () => {
    const aliased: CatalogEntry = { id: 'k3', name: 'K3', contextWindow: 1, aliases: ['kimi-k3'] }
    assert.equal(entryMatches(aliased, 'k3'), true)
    assert.equal(entryMatches(aliased, 'kimi-k3'), true)
    assert.equal(entryMatches(aliased, 'k4'), false)
    assert.equal(findEntry([aliased], 'kimi-k3')?.id, 'k3')
  })

  test('a fallback entry is dispatchable with conservative metadata', () => {
    const entry = fallbackEntry('brand-new', 'reported live', 4_096)
    assert.equal(entry.id, 'brand-new')
    assert.equal(entry.contextWindow, 4_096)
    assert.deepEqual(entry.inputModalities, ['text', 'image'])
  })
})

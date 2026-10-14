/** Catalog order and visibility for one route's models. */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  composeCatalog,
  entryMatches,
  fallbackEntry,
  findEntry,
  liveEntry,
  liveModelFacts,
  resolveCatalog,
} from '../src/providers/catalog.js'
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

describe('liveModelFacts', () => {
  test('reads the names a listing actually uses', () => {
    // Kimi states a display name, a context length and its own effort ladder.
    const facts = liveModelFacts({
      id: 'k3',
      display_name: 'K3',
      context_length: 1_048_576,
      modalities: { input: ['text', 'image', 'video'], output: ['text'] },
      think_efforts: { support: true, valid_efforts: ['low', 'high', 'max'], default_effort: 'high' },
    })
    assert.deepEqual(facts, {
      id: 'k3',
      name: 'K3',
      contextWindow: 1_048_576,
      // `video` is not in the harness vocabulary, so it is dropped rather than smuggled.
      inputModalities: ['text', 'image'],
      reasoningEfforts: ['low', 'high', 'max'],
      defaultEffort: 'high',
    })
  })

  test('accepts the OpenAI-compatible spellings too', () => {
    assert.deepEqual(liveModelFacts({ id: 'glm-5', name: 'GLM-5', context_window: 200_000 }), {
      id: 'glm-5',
      name: 'GLM-5',
      contextWindow: 200_000,
    })
    // A nested limit is read as well, and an unstated field stays unstated.
    assert.deepEqual(liveModelFacts({ model: 'x', limit: { context: 8_192 } }), {
      id: 'x',
      contextWindow: 8_192,
    })
  })

  test('states nothing it was not told, and refuses a row with no id', () => {
    assert.deepEqual(liveModelFacts({ id: 'bare' }), { id: 'bare' })
    assert.equal(liveModelFacts({ name: 'no id here' }), undefined)
    assert.equal(liveModelFacts('not a row'), undefined)
    // A non-positive or unusable figure is absence, not a zero window.
    assert.deepEqual(liveModelFacts({ id: 'x', context_length: 0 }), { id: 'x' })
  })

  test('reads the second effort shape these listings use', () => {
    const facts = liveModelFacts({
      id: 'k3',
      reasoning: { type: 'only', effort: { valid: ['low', 'max'], default: 'max' } },
    })
    assert.deepEqual(facts?.reasoningEfforts, ['low', 'max'])
    assert.equal(facts?.defaultEffort, 'max')
  })
})

describe('liveEntry', () => {
  test('lets the listing describe what it stated and the table fill the rest', () => {
    const curated: readonly CatalogEntry[] = [
      { id: 'k3', name: 'Kimi K3', description: 'Flagship', contextWindow: 262_144, inputModalities: ['text'] },
    ]
    // The listing's window contradicts the table's, and the listing wins: it is the figure
    // the model serves today.
    const entry = liveEntry({ id: 'k3', contextWindow: 1_048_576 }, curated, 4_096, 'reported')
    assert.equal(entry.id, 'k3')
    assert.equal(entry.contextWindow, 1_048_576)
    assert.equal(entry.name, 'Kimi K3')
    assert.equal(entry.description, 'Flagship')
    assert.deepEqual(entry.inputModalities, ['text'])
  })

  test('describes an unknown id conservatively', () => {
    const entry = liveEntry({ id: 'k4', name: 'K4' }, [], 4_096, 'reported by the endpoint')
    assert.equal(entry.id, 'k4')
    assert.equal(entry.name, 'K4')
    assert.equal(entry.description, 'reported by the endpoint')
    assert.equal(entry.contextWindow, 4_096)
  })
})

describe('composeCatalog', () => {
  const curated: readonly CatalogEntry[] = [
    { id: 'seed-a', name: 'Seed A', contextWindow: 1 },
    { id: 'seed-b', name: 'Seed B', contextWindow: 2 },
  ]

  test('the curated table decides membership only while no listing exists', () => {
    assert.deepEqual(
      composeCatalog({ curated, fallbackContextWindow: 9 }).map((entry) => entry.id),
      ['seed-a', 'seed-b'],
    )
  })

  test('a listing decides membership and supplies the metadata', () => {
    const composed = composeCatalog({
      curated,
      live: [
        { id: 'k4', name: 'K4', contextWindow: 4 },
        { id: 'seed-b', name: 'B from the endpoint', contextWindow: 20 },
      ],
      defaultModel: 'seed-a',
      fallbackContextWindow: 9,
    })
    // The default is offered first so the picker can select it, the listing follows, and a
    // seed the listing omits is gone.
    assert.deepEqual(composed.map((entry) => entry.id), ['seed-a', 'k4', 'seed-b'])
    assert.equal(composed[0]?.name, 'Seed A')
    // What the endpoint stated about `seed-b` wins over what this build remembered.
    assert.equal(composed[2]?.name, 'B from the endpoint')
    assert.equal(composed[2]?.contextWindow, 20)
  })

  test('configured extras come last and do not duplicate a listed model', () => {
    const composed = composeCatalog({
      curated,
      live: [{ id: 'seed-a', name: 'A', contextWindow: 1 }],
      extra: ['seed-a', 'brand-new'],
      fallbackContextWindow: 9,
      extraDescription: 'added by hand',
    })
    assert.deepEqual(composed.map((entry) => entry.id), ['seed-a', 'brand-new'])
    assert.equal(composed[1]?.description, 'added by hand')
    assert.equal(composed[1]?.contextWindow, 9)
  })
})

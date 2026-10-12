/** Moonshot tool-schema preparation: a `$ref` with sibling keywords is refused. */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { moonshotToolParameters } from '../src/translate/moonshot-schema.js'

/**
 * Every node that carries `$ref` beside any other key.
 *
 * That is the shape Moonshot's reader cannot settle. It re-expands the node
 * instead of intersecting it, so the request is refused with
 * `detected infinite recursion without termination condition` — the failure
 * seen for `properties.actions`.
 */
function siblingRefPaths(node: unknown, path = '$'): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((item, index) => siblingRefPaths(item, `${path}[${index}]`))
  }
  if (!node || typeof node !== 'object') return []
  const record = node as Record<string, unknown>
  const keys = Object.keys(record)
  const found = keys.includes('$ref') && keys.length > 1 ? [path] : []
  return [...found, ...keys.flatMap((key) => siblingRefPaths(record[key], `${path}.${key}`))]
}

/**
 * The failing tool, shrunk to the reference chain that carried it: REA's
 * `capture_browser_scenario` declares `actions` as a `$ref` narrowed by a
 * description, pointing at an array whose items are a union of objects, each
 * of which reaches further definitions.
 */
function captureBrowserScenario(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      browser: { $ref: '#/$defs/__schema0' },
      actions: {
        $ref: '#/$defs/__schema12',
        description: 'Required sequence of explicit browser actions.',
      },
    },
    required: ['actions'],
    additionalProperties: false,
    $defs: {
      __schema0: { oneOf: [{ $ref: '#/$defs/__schema1' }, { $ref: '#/$defs/__schema3' }] },
      __schema1: { type: 'object', properties: { mode: { const: 'launch' } }, required: ['mode'] },
      __schema3: { type: 'object', properties: { cdp_endpoint: { type: 'string' } } },
      __schema12: { minItems: 1, type: 'array', items: { $ref: '#/$defs/__schema13' } },
      __schema13: {
        oneOf: [{
          type: 'object',
          properties: {
            step_id: { type: 'string' },
            action: { type: 'string', const: 'goto' },
            destination: { $ref: '#/$defs/__schema9' },
          },
          required: ['step_id', 'action', 'destination'],
        }],
      },
      __schema9: {
        type: 'object',
        properties: { url: { $ref: '#/$defs/__schema5' }, query: { $ref: '#/$defs/__schema6' } },
        required: ['url'],
      },
      __schema5: { type: 'string', minLength: 1 },
      __schema6: {
        type: 'array',
        items: { type: 'object', properties: { name: { type: 'string' }, value: { $ref: '#/$defs/__schema7' } } },
      },
      __schema7: { oneOf: [{ type: 'string' }] },
    },
  }
}

describe('moonshotToolParameters', () => {
  test('leaves no $ref with sibling keywords', () => {
    const prepared = moonshotToolParameters(captureBrowserScenario())

    assert.deepEqual(siblingRefPaths(prepared), [])
  })

  test('inlines the narrowed definition under the node own keywords', () => {
    const prepared = moonshotToolParameters(captureBrowserScenario())
    const actions = (prepared.properties as Record<string, Record<string, unknown>>).actions

    assert.deepEqual(actions, {
      minItems: 1,
      type: 'array',
      items: { $ref: '#/$defs/__schema13' },
      description: 'Required sequence of explicit browser actions.',
    })
  })

  test('keeps standalone references and the definitions they resolve against', () => {
    const prepared = moonshotToolParameters(captureBrowserScenario())
    const properties = prepared.properties as Record<string, Record<string, unknown>>
    const defs = prepared.$defs as Record<string, Record<string, unknown>>

    assert.deepEqual(properties.browser, { $ref: '#/$defs/__schema0' })
    assert.deepEqual(defs.__schema5, { type: 'string', minLength: 1 })
    assert.deepEqual(defs.__schema9, {
      type: 'object',
      properties: { url: { $ref: '#/$defs/__schema5' }, query: { $ref: '#/$defs/__schema6' } },
      required: ['url'],
    })
  })

  test('rewrites a narrowed reference inside the definitions as well', () => {
    const prepared = moonshotToolParameters({
      type: 'object',
      properties: { name: { $ref: '#/$defs/__schema5' } },
      $defs: {
        __schema5: { $ref: '#/$defs/__schema2', description: 'Short automation name.' },
        __schema2: { type: 'string', minLength: 1 },
      },
    })

    assert.deepEqual(siblingRefPaths(prepared), [])
    assert.deepEqual((prepared.$defs as Record<string, Record<string, unknown>>).__schema5, {
      type: 'string',
      minLength: 1,
      description: 'Short automation name.',
    })
  })

  test('keeps the constraints a sibling adds to the referenced schema', () => {
    const prepared = moonshotToolParameters({
      type: 'object',
      properties: { pattern: { $ref: '#/$defs/__schema8', pattern: '^#', minLength: 2, type: 'string' } },
      $defs: { __schema8: { type: 'string', description: 'A pointer.' } },
    })

    assert.deepEqual(prepared.properties, {
      pattern: { type: 'string', description: 'A pointer.', pattern: '^#', minLength: 2 },
    })
  })

  test('terminates on a reference cycle by keeping the sibling keywords', () => {
    const prepared = moonshotToolParameters({
      type: 'object',
      properties: { node: { $ref: '#/$defs/__schema4', description: 'A tree node.' } },
      $defs: {
        __schema4: {
          type: 'object',
          properties: { child: { $ref: '#/$defs/__schema4', description: 'The same shape again.' } },
        },
      },
    })

    assert.deepEqual(siblingRefPaths(prepared), [])
    const node = (prepared.properties as Record<string, Record<string, unknown>>).node
    const child = (node.properties as Record<string, Record<string, unknown>>).child
    // The cycle stops at the inner node: the description is all that is left.
    assert.deepEqual(child, { description: 'The same shape again.' })
    assert.equal(node.type, 'object')
    assert.equal(node.description, 'A tree node.')
  })

  test('drops a reference it cannot resolve and keeps the sibling keywords', () => {
    const prepared = moonshotToolParameters({
      type: 'object',
      properties: { document: { $ref: 'https://example.test/schema.json', description: 'Provider document.' } },
    })

    assert.deepEqual(prepared.properties, { document: { description: 'Provider document.' } })
  })
})

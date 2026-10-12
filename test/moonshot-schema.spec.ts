/**
 * Moonshot tool-schema preparation.
 *
 * Live probes against `api.kimi.com` pinned the contract this file holds:
 * a reference whose target holds further references is refused as
 * `detected infinite recursion without termination condition` (the failing tool
 * first reported `properties.actions`, then `properties.actions.items` once that
 * node stood alone), and an expanded schema has a size ceiling between 80,081 B
 * and 124,389 B (`At path 'root': schema exceeds maximum allowed size`).
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { prepareMoonshotTool } from '../src/translate/moonshot-schema.js'

/** Every node that carries a `$ref`, at any depth. */
function refPaths(node: unknown, path = '$'): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((item, index) => refPaths(item, `${path}[${index}]`))
  }
  if (!node || typeof node !== 'object') return []
  const record = node as Record<string, unknown>
  const found = typeof record.$ref === 'string' ? [path] : []
  return [...found, ...Object.keys(record).flatMap((key) => refPaths(record[key], `${path}.${key}`))]
}

/**
 * The failing tool, shrunk to the reference chain that carried it: REA's
 * `capture_browser_scenario` declares `actions` as a `$ref` narrowed by a
 * description, pointing at an array whose items are a union of objects, each of
 * which reaches further definitions.
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

/** A valid schema whose expanded size is about `target` bytes. */
function padded(target: number): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  let index = 0
  while (JSON.stringify({ type: 'object', properties, required: Object.keys(properties) }).length < target) {
    properties[`field_${index}`] = { type: 'string', description: 'x'.repeat(150) }
    index += 1
  }
  return { type: 'object', properties, required: Object.keys(properties), description: 'A padded schema.' }
}

describe('prepareMoonshotTool', () => {
  test('leaves no reference behind', () => {
    const prepared = prepareMoonshotTool(captureBrowserScenario())

    assert.deepEqual(refPaths(prepared.parameters), [])
    assert.equal(Object.hasOwn(prepared.parameters, '$defs'), false)
    assert.equal(prepared.preparedAs, 'as-declared')
  })

  test('inlines the narrowed definition under the node own keywords', () => {
    const prepared = prepareMoonshotTool(captureBrowserScenario())
    const actions = (prepared.parameters.properties as Record<string, Record<string, unknown>>).actions

    assert.equal(actions.type, 'array')
    assert.equal(actions.minItems, 1)
    assert.equal(actions.description, 'Required sequence of explicit browser actions.')
  })

  test('inlines through the whole chain the tool declared', () => {
    const prepared = prepareMoonshotTool(captureBrowserScenario())
    const actions = (prepared.parameters.properties as Record<string, Record<string, unknown>>).actions
    const variant = (actions.items as Record<string, unknown[]>).oneOf[0] as Record<string, unknown>
    const destination = (variant.properties as Record<string, Record<string, unknown>>).destination
    const query = (destination.properties as Record<string, Record<string, unknown>>).query

    assert.deepEqual((destination.properties as Record<string, unknown>).url, { type: 'string', minLength: 1 })
    assert.deepEqual(query, {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, value: { oneOf: [{ type: 'string' }] } },
      },
    })
  })

  test('inlines a property that referenced the same definitions', () => {
    const prepared = prepareMoonshotTool(captureBrowserScenario())
    const browser = (prepared.parameters.properties as Record<string, Record<string, unknown>>).browser

    assert.deepEqual(browser, {
      oneOf: [
        { type: 'object', properties: { mode: { const: 'launch' } }, required: ['mode'] },
        { type: 'object', properties: { cdp_endpoint: { type: 'string' } } },
      ],
    })
  })

  test('keeps the constraints a sibling adds to the referenced schema', () => {
    const prepared = prepareMoonshotTool({
      type: 'object',
      properties: { pattern: { $ref: '#/$defs/__schema8', pattern: '^#', minLength: 2, type: 'string' } },
      $defs: { __schema8: { type: 'string', description: 'A pointer.' } },
    })

    assert.deepEqual(prepared.parameters.properties, {
      pattern: { type: 'string', description: 'A pointer.', pattern: '^#', minLength: 2 },
    })
  })

  test('terminates on a reference cycle by keeping the sibling keywords', () => {
    const prepared = prepareMoonshotTool({
      type: 'object',
      properties: { node: { $ref: '#/$defs/__schema4', description: 'A tree node.' } },
      $defs: {
        __schema4: {
          type: 'object',
          properties: { child: { $ref: '#/$defs/__schema4', description: 'The same shape again.' } },
        },
      },
    })

    assert.deepEqual(refPaths(prepared.parameters), [])
    const node = (prepared.parameters.properties as Record<string, Record<string, unknown>>).node
    const child = (node.properties as Record<string, Record<string, unknown>>).child
    // The cycle stops at the inner node: the description is all that is left.
    assert.deepEqual(child, { description: 'The same shape again.' })
    assert.equal(node.type, 'object')
    assert.equal(node.description, 'A tree node.')
  })

  test('drops a reference it cannot resolve and keeps the sibling keywords', () => {
    const prepared = prepareMoonshotTool({
      type: 'object',
      properties: { document: { $ref: 'https://example.test/schema.json', description: 'Provider document.' } },
    })

    assert.deepEqual(prepared.parameters.properties, { document: { description: 'Provider document.' } })
  })

  test('drops the schema identifier that only held the definitions', () => {
    const prepared = prepareMoonshotTool({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { name: { type: 'string' } },
      $defs: { __schema2: { type: 'string' } },
    })

    assert.deepEqual(prepared.parameters, { type: 'object', properties: { name: { type: 'string' } } })
  })

  test('is idempotent, so a prepared schema can be prepared again', () => {
    const once = prepareMoonshotTool(captureBrowserScenario())

    assert.deepEqual(prepareMoonshotTool(once.parameters), once)
  })

  test('keeps a schema well under the ceiling as declared', () => {
    const declared = padded(32 * 1024)
    const prepared = prepareMoonshotTool(declared)

    assert.deepEqual(prepared.parameters, declared)
    assert.equal(prepared.preparedAs, 'as-declared')
  })

  test('flattens a structural schema and keeps the arguments described', () => {
    // Five big object arguments: the nesting has to go, the argument list does not.
    const heavyArgument = (label: string) => ({
      type: 'object',
      description: label,
      properties: Object.fromEntries(
        Array.from({ length: 200 }, (_, index) => [
          `field_${index}`,
          { type: 'string', description: 'x'.repeat(150) },
        ]),
      ),
    })
    const declared = {
      type: 'object',
      description: 'Compare two captures.',
      properties: Object.fromEntries(
        Array.from({ length: 5 }, (_, index) => [`argument_${index}`, heavyArgument(`Argument ${index}.`)]),
      ),
      required: ['argument_0'],
    }

    assert.ok(Buffer.byteLength(JSON.stringify(declared)) > 64 * 1024, 'the declaration is over the ceiling')
    const prepared = prepareMoonshotTool(declared)

    assert.equal(prepared.preparedAs, 'flattened')
    assert.deepEqual(prepared.parameters, {
      type: 'object',
      description: 'Compare two captures.',
      required: ['argument_0'],
      properties: {
        argument_0: { type: 'object', description: 'Argument 0.' },
        argument_1: { type: 'object', description: 'Argument 1.' },
        argument_2: { type: 'object', description: 'Argument 2.' },
        argument_3: { type: 'object', description: 'Argument 3.' },
        argument_4: { type: 'object', description: 'Argument 4.' },
      },
    })
  })

  test('drops argument prose too when the prose is the bulk', () => {
    const declared = padded(96 * 1024)
    const prepared = prepareMoonshotTool(declared)

    assert.equal(prepared.preparedAs, 'flattened')
    assert.ok(
      Buffer.byteLength(JSON.stringify(prepared.parameters)) <= 64 * 1024,
      'what is sent fits the endpoint',
    )
    assert.equal(prepared.parameters.description, undefined)
    const properties = prepared.parameters.properties as Record<string, unknown>
    assert.deepEqual(properties.field_0, { type: 'string' })
    assert.deepEqual(properties.field_1, { type: 'string' })
    assert.equal(Object.keys(properties).length, Object.keys(declared.properties as object).length)
    assert.equal(
      (prepared.parameters.required as string[]).length,
      Object.keys(declared.properties as object).length,
    )
  })

  test('counts a reference-heavy declaration at its expanded size', () => {
    // Declared small, expands large: the ceiling applies after expansion.
    const shared = {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 200 }, (_, index) => [
          `field_${index}`,
          { type: 'string', description: 'x'.repeat(150) },
        ]),
      ),
    }
    const declared = {
      type: 'object',
      properties: {
        first: { $ref: '#/$defs/shared' },
        second: { $ref: '#/$defs/shared' },
      },
      $defs: { shared },
    }

    assert.ok(JSON.stringify(declared).length < 64 * 1024, 'the declaration itself fits')
    const prepared = prepareMoonshotTool(declared)

    assert.equal(prepared.preparedAs, 'flattened')
    assert.deepEqual(prepared.parameters.properties, {
      first: { type: 'object' },
      second: { type: 'object' },
    })
  })

  test('falls back to an unrestricted object when even the arguments are too large', () => {
    const properties = Object.fromEntries(
      Array.from({ length: 4000 }, (_, index) => [`field_${index}`, { type: 'string' }]),
    )
    const prepared = prepareMoonshotTool({ type: 'object', properties })

    assert.deepEqual(prepared.parameters, { type: 'object', additionalProperties: true })
    assert.equal(prepared.preparedAs, 'permissive')
  })
})

/**
 * Tool-schema preparation for the Moonshot wire (Kimi Code).
 *
 * Moonshot validates `tools[].function.parameters` with its own JSON-Schema
 * reader, and that reader cannot settle a `$ref` that carries sibling
 * keywords: instead of intersecting the two, it re-expands the node, so the
 * whole request is refused with
 * `detected infinite recursion without termination condition`. The harness
 * forwards tool schemas exactly as their owner declared them, and the MCP
 * tools REA registers use that shape heavily —
 * `{"$ref": "#/$defs/__schema12", "description": "..."}` — 153 of 170 tools
 * carried at least one such node, and the first one Moonshot reached killed
 * every Kimi request that included a tool.
 *
 * A `$ref` that stands alone is accepted, and so is keeping `$defs` for it, so
 * only the offending nodes are rewritten: the referenced schema is inlined
 * under the node's own keywords (JSON Schema 2020-12 applies both, and the
 * node's own keywords win on a conflict), which leaves the wire schema with
 * standalone references only. Resolution is bounded by the reference stack, so
 * a real cycle ends by dropping the `$ref` and keeping the sibling keywords
 * rather than recursing.
 *
 * @module dsh-plugin-subscription-oauth/translate/moonshot-schema
 */

/** A JSON-schema-shaped object. */
type Schema = Record<string, unknown>

/** True for a plain object usable as a schema node. */
function object(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Follow one local JSON pointer, or undefined when it does not resolve. */
function pointed(root: Schema, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined
  let node: unknown = root
  for (const segment of ref.slice(2).split('/')) {
    const key = segment.replaceAll('~1', '/').replaceAll('~0', '~')
    if (Array.isArray(node)) node = node[Number(key)]
    else if (object(node) && Object.hasOwn(node, key)) node = node[key]
    else return undefined
  }
  return node
}

/**
 * Rewrite one node so every `$ref` left on the wire stands alone.
 *
 * @param node - the node to rewrite.
 * @param root - the tool's root schema, which local pointers resolve against.
 * @param refs - pointers already being resolved on the path to this node.
 * @returns the rewritten node.
 */
function inline(node: unknown, root: Schema, refs: ReadonlySet<string>): unknown {
  if (Array.isArray(node)) return node.map((item) => inline(item, root, refs))
  if (!object(node)) return node
  const { $ref, ...siblings } = node
  if (typeof $ref !== 'string') {
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, inline(value, root, refs)]))
  }
  // A standalone reference is exactly what Moonshot expects, so it stays as is
  // and keeps its `$defs` entry.
  if (Object.keys(siblings).length === 0) return { $ref }
  // A repeated pointer, or one that is not a local object, cannot be inlined:
  // the sibling keywords are all that is left to terminate on.
  const target = refs.has($ref) ? undefined : pointed(root, $ref)
  return object(target)
    ? inline({ ...target, ...siblings }, root, new Set([...refs, $ref]))
    : inline(siblings, root, refs)
}

/**
 * Prepare one tool's parameters for Moonshot.
 *
 * @param parameters - the tool's declared argument schema.
 * @returns a detached schema whose `$ref` nodes carry no sibling keywords.
 */
export function moonshotToolParameters(parameters: Record<string, unknown>): Record<string, unknown> {
  return inline(parameters, parameters, new Set()) as Record<string, unknown>
}

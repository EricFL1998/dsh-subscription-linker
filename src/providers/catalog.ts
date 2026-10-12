/**
 * Provider model catalogs.
 *
 * A provider ships a curated catalog — the ids it serves, their display names,
 * context windows, reasoning ladder, and any aliases the endpoint also accepts.
 * Live discovery may widen it; it never narrows it, because an endpoint's own
 * listing omits variants it still serves.
 *
 * The `auto` provider is not part of any of these: it spans them, and lives in
 * its own module.
 *
 * @module dsh-plugin-subscription-oauth/providers/catalog
 */

import type { ModelModality } from '@deepseek-ai/dsh-llm'

/** One provider-owned model entry. */
export interface CatalogEntry {
  /** Model id sent on the wire. */
  id: string
  name: string
  description?: string
  /** Other ids the endpoint accepts for this entry. */
  aliases?: readonly string[]
  /** Combined request and response context, in tokens. */
  contextWindow: number
  inputModalities?: readonly ModelModality[]
  /** Selectable reasoning efforts, in display order. */
  reasoningEfforts?: readonly string[]
  /** Effort materialized when a caller picks none. */
  defaultEffort?: string
}

/** Whether one catalog entry covers a model id. */
export function entryMatches(entry: CatalogEntry, id: string): boolean {
  return entry.id === id || entry.aliases?.includes(id) === true
}

/** The entry covering a model id, when the catalog has one. */
export function findEntry(entries: readonly CatalogEntry[], id: string): CatalogEntry | undefined {
  return entries.find((entry) => entryMatches(entry, id))
}

/**
 * Build an entry for a model the curated catalog does not describe.
 *
 * Used for ids the live list reports that this build has not seen, and for ids
 * the plugin configuration adds: they are dispatchable, but their metadata is
 * the conservative default rather than a guess.
 *
 * @param id - model id.
 * @param description - why this entry exists, shown in the picker.
 * @param contextWindow - context to advertise.
 * @returns the entry.
 */
export function fallbackEntry(id: string, description: string, contextWindow: number): CatalogEntry {
  return {
    id,
    name: id,
    description,
    contextWindow,
    inputModalities: ['text', 'image'],
    reasoningEfforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'max',
  }
}

/** A catalog after the user's order and visibility choices are applied. */
export interface ResolvedCatalog {
  /** Every entry the picker may offer, hidden ids omitted (the picker's list). */
  entries: CatalogEntry[]
  /** The enabled entries, in catalog order. */
  enabled: CatalogEntry[]
  /** Every entry in catalog order, hidden ids included (the Settings list). */
  ranked: CatalogEntry[]
}

/**
 * Apply the user's model order and visibility to one provider's catalog.
 *
 * Ranked ids come first in the user's order; ids the order does not mention keep
 * their curated position after them, so a model added by a plugin update or by
 * live discovery is listed without the user having to re-rank anything.
 *
 * @param entries - the provider's catalog, in curated order.
 * @param order - the user's stored rank, as model ids.
 * @param hidden - ids the picker must omit.
 * @returns the listed entries, the full list, and the enabled entries.
 */
export function resolveCatalog(
  entries: readonly CatalogEntry[],
  order: readonly string[],
  hidden: ReadonlySet<string>,
): ResolvedCatalog {
  const available = new Map(entries.map((entry) => [entry.id, entry]))
  const ranked: CatalogEntry[] = []
  const seen = new Set<string>()
  for (const id of order) {
    if (seen.has(id)) continue
    const entry = available.get(id)
    if (entry === undefined) continue
    seen.add(id)
    ranked.push(entry)
  }
  for (const entry of entries) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    ranked.push(entry)
  }
  const enabled = ranked.filter((entry) => !hidden.has(entry.id))
  return { entries: enabled, ranked, enabled }
}

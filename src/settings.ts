/**
 * Model-visibility and model-order preferences.
 *
 * Which models appear in the session model picker, and in which order, is a user
 * choice, so it lives on the node half beside the adapter that answers the
 * picker's catalog query — not in the browser. The file is a small JSON document
 * keyed by provider; a missing or corrupt section means "everything visible, in
 * the curated order", which is the shipped default.
 *
 * The visibility set is a HIDDEN list rather than a visible list: a model that a
 * later release adds to the catalog must appear without the user re-selecting it.
 * The order is a partial rank: ids it does not mention keep their catalog
 * position, so a new model lands without disturbing the user's arrangement.
 *
 * @module dsh-plugin-subscription-oauth/settings
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Provider whose earlier, flat preference shape is migrated on load.
 *
 * Before this plugin served more than one route the document was
 * `{ hidden: string[] }`; that list belonged to Kimi Code.
 */
export const LEGACY_FLAT_PROVIDER = 'kimi'

/** The durable document. */
interface PreferencesDocument {
  /** Provider route → the model ids the picker must not offer. */
  hidden?: unknown
  /** Provider route → the user's model rank, most preferred first. */
  order?: unknown
  /** Provider route → model ids the user added by hand. */
  extra?: unknown
  /** The `auto` provider's own arrangement, which spans every other route. */
  auto?: unknown
}

/**
 * The `auto` provider's arrangement.
 *
 * `auto` is a provider of its own, so its list is not a route's catalog: it is
 * the union of every enabled model, keyed by `provider/model` because two routes
 * may serve the same id.
 */
export interface AutoPreferences {
  /** `provider/model` keys, most preferred first. */
  order: readonly string[]
  /** Keys `auto` must not use, whatever their own route offers. */
  off: readonly string[]
}

/** Read the `auto` section, keeping only usable keys. */
function readAuto(document: PreferencesDocument): AutoPreferences {
  if (!isRecord(document.auto)) return { order: [], off: [] }
  return {
    order: readIds(document.auto.order),
    off: readIds(document.auto.off),
  }
}

/** True for a plain object usable as a JSON record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read one id list, keeping only usable ids and dropping repeats. */
function readIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  const seen = new Set<string>()
  for (const id of value) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result
}

/** Coerce the document into a per-provider hidden map, migrating the flat shape. */
function readHidden(document: PreferencesDocument): Record<string, Set<string>> {
  const hidden = document.hidden
  if (Array.isArray(hidden)) {
    const legacy = readIds(hidden)
    return legacy.length === 0 ? {} : { [LEGACY_FLAT_PROVIDER]: new Set(legacy) }
  }
  if (!isRecord(hidden)) return {}
  const result: Record<string, Set<string>> = {}
  for (const [provider, ids] of Object.entries(hidden)) {
    const set = new Set(readIds(ids))
    if (set.size > 0) result[provider] = set
  }
  return result
}

/** Read the user-added ids, per provider. */
function readExtra(document: PreferencesDocument): Record<string, string[]> {
  if (!isRecord(document.extra)) return {}
  const result: Record<string, string[]> = {}
  for (const [provider, ids] of Object.entries(document.extra)) {
    const list = readIds(ids)
    if (list.length > 0) result[provider] = list
  }
  return result
}

/** Coerce the document into a per-provider order map. */
function readOrder(document: PreferencesDocument): Record<string, string[]> {
  const order = document.order
  if (!isRecord(order)) return {}
  const result: Record<string, string[]> = {}
  for (const [provider, ids] of Object.entries(order)) {
    const list = readIds(ids)
    if (list.length > 0) result[provider] = list
  }
  return result
}

/**
 * Owns the model preference document.
 *
 * Reads are cached; every write updates the cache and the file together, so the
 * picker's next catalog query sees the change without a restart.
 */
export class ModelPreferences {
  private hidden: Record<string, Set<string>> = {}
  private order: Record<string, string[]> = {}
  private auto: AutoPreferences = { order: [], off: [] }
  private extra: Record<string, string[]> = {}
  private loaded = false
  /** The in-flight first read, so concurrent callers share one. */
  private loading: Promise<void> | undefined

  constructor(private readonly file: string) {}

  /**
   * Load the document once; `reload` forces a re-read.
   *
   * Callers read several sections at once (`hidden`, `order`, `extra`), so the load
   * is single-flight: marking the object loaded before the file had been read let a
   * concurrent first call return an empty snapshot, which silently dropped the
   * user's stored choices for whichever read lost the race.
   */
  private async ensureLoaded(reload = false): Promise<void> {
    if (reload) {
      this.loaded = false
      this.loading = undefined
    }
    if (this.loaded) return
    this.loading ??= this.read().finally(() => { this.loading = undefined })
    await this.loading
  }

  /** Read the file into memory and record that the state is loaded. */
  private async read(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      this.hidden = {}
      this.order = {}
      this.auto = { order: [], off: [] }
      this.extra = {}
      this.loaded = true
      return
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      const document = (isRecord(parsed) ? parsed : {}) as PreferencesDocument
      this.hidden = readHidden(document)
      this.order = readOrder(document)
      this.auto = readAuto(document)
      this.extra = readExtra(document)
    } catch {
      this.hidden = {}
      this.order = {}
      this.auto = { order: [], off: [] }
      this.extra = {}
    }
    this.loaded = true
  }

  /** Re-read the file, discarding in-memory state. */
  async reload(): Promise<void> {
    await this.ensureLoaded(true)
  }

  /** The ids one provider's picker must not offer. */
  async hiddenIds(provider: string): Promise<ReadonlySet<string>> {
    await this.ensureLoaded()
    return new Set(this.hidden[provider] ?? [])
  }

  /** The user's model rank for one provider, most preferred first. */
  async orderOf(provider: string): Promise<readonly string[]> {
    await this.ensureLoaded()
    return [...this.order[provider] ?? []]
  }

  /** The ids the user added by hand for one provider. */
  async extraIds(provider: string): Promise<readonly string[]> {
    await this.ensureLoaded()
    return [...this.extra[provider] ?? []]
  }

  /**
   * Add one model id by hand.
   *
   * The point of the button is a model the catalog does not know yet, so nothing
   * here validates the id against an endpoint — only that it is a plausible id.
   *
   * @param provider - provider route key.
   * @param id - the model id the endpoint accepts.
   * @returns whether the stored list actually changed.
   */
  async addExtra(provider: string, id: string): Promise<boolean> {
    await this.ensureLoaded()
    const current = this.extra[provider] ?? []
    if (current.includes(id)) return false
    this.extra = { ...this.extra, [provider]: [...current, id] }
    await this.persist()
    return true
  }

  /**
   * Forget one hand-added id.
   * @param provider - provider route key.
   * @param id - the model id to drop.
   * @returns whether the stored list actually changed.
   */
  async removeExtra(provider: string, id: string): Promise<boolean> {
    await this.ensureLoaded()
    const current = this.extra[provider] ?? []
    if (!current.includes(id)) return false
    const next = current.filter((entry) => entry !== id)
    const copy = { ...this.extra }
    if (next.length === 0) delete copy[provider]
    else copy[provider] = next
    this.extra = copy
    await this.persist()
    return true
  }

  /** The `auto` provider's arrangement. */
  async autoPreferences(): Promise<AutoPreferences> {
    await this.ensureLoaded()
    return { order: [...this.auto.order], off: [...this.auto.off] }
  }

  /**
   * Replace the `auto` provider's order.
   * @param keys - `provider/model` keys, most preferred first.
   * @returns whether the stored order actually changed.
   */
  async setAutoOrder(keys: readonly string[]): Promise<boolean> {
    await this.ensureLoaded()
    const next = readIds([...keys])
    const current = this.auto.order
    if (current.length === next.length && current.every((key, index) => key === next[index])) return false
    this.auto = { ...this.auto, order: next }
    await this.persist()
    return true
  }

  /**
   * Record whether `auto` may use one model.
   * @param key - `provider/model` key.
   * @param enabled - whether `auto` may fall back to it.
   * @returns whether the stored state actually changed.
   */
  async setAutoEnabled(key: string, enabled: boolean): Promise<boolean> {
    await this.ensureLoaded()
    const current = new Set(this.auto.off)
    const shouldOff = !enabled
    if (current.has(key) === shouldOff) return false
    if (shouldOff) current.add(key)
    else current.delete(key)
    this.auto = { ...this.auto, off: [...current] }
    await this.persist()
    return true
  }

  /**
   * Record one model's visibility.
   * @param provider - provider route key.
   * @param id - model id as the catalog reports it.
   * @param visible - whether the picker should offer it.
   * @returns whether the stored state actually changed.
   */
  async setVisible(provider: string, id: string, visible: boolean): Promise<boolean> {
    await this.ensureLoaded()
    const current = this.hidden[provider] ?? new Set<string>()
    const shouldHide = !visible
    if (current.has(id) === shouldHide) return false
    if (shouldHide) current.add(id)
    else current.delete(id)
    if (current.size === 0) delete this.hidden[provider]
    else this.hidden[provider] = current
    await this.persist()
    return true
  }

  /**
   * Replace one provider's model rank.
   * @param provider - provider route key.
   * @param ids - the complete rank, most preferred first.
   * @returns whether the stored order actually changed.
   */
  async setOrder(provider: string, ids: readonly string[]): Promise<boolean> {
    await this.ensureLoaded()
    const next = readIds([...ids])
    const current = this.order[provider] ?? []
    if (current.length === next.length && current.every((id, index) => id === next[index])) return false
    if (next.length === 0) delete this.order[provider]
    else this.order[provider] = next
    await this.persist()
    return true
  }

  /** Write the document atomically with owner-only permissions. */
  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true })
    const hidden: Record<string, string[]> = {}
    for (const [provider, ids] of Object.entries(this.hidden)) {
      if (ids.size > 0) hidden[provider] = [...ids].sort()
    }
    const order: Record<string, string[]> = {}
    for (const [provider, ids] of Object.entries(this.order)) {
      if (ids.length > 0) order[provider] = [...ids]
    }
    const document: PreferencesDocument = {
      hidden,
      order,
      auto: { order: [...this.auto.order], off: [...this.auto.off] },
      extra: Object.fromEntries(Object.entries(this.extra).filter(([, ids]) => ids.length > 0)),
    }
    const temporary = `${this.file}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    try {
      await rename(temporary, this.file)
      await chmod(this.file, 0o600)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }
}

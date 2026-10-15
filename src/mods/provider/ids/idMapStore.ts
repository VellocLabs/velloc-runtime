/**
 * The id map per (session, provider), both ways: forward is the cache, reverse
 * decodes ids the model echoes so the transcript keeps its own. Loaded on first need,
 * written (debounced) only when an entry was added, removed with the session. An
 * unreadable file is an empty map (reported once). Bounded by `maxEntries` and
 * `maxLoaded`.
 */

import type { IdKind } from './idRules'

export const ID_MAP_FILE_VERSION = 1
export const ID_MAP_MAX_ENTRIES = 20_000
export const ID_MAP_FLUSH_DELAY_MS = 400
export const ID_MAP_MAX_LOADED = 48

/** Two engine ids mapped to one wire id: the map refuses, the request fails. */
export class IdCollisionError extends Error {
  constructor(readonly mapped: string) {
    super(`two different ids map to "${mapped}" - the provider's id rule gives too few distinct ids`)
    this.name = 'IdCollisionError'
  }
}

type Entry = { kind: IdKind; value: string; mapped: string }

const keyOf = (kind: IdKind, value: string): string => `${kind}\u0000${value}`

export class IdMap {
  private readonly forward = new Map<string, Entry>()
  private readonly reverse = new Map<string, Entry>()
  /** Set when an entry was added; the store's write clears it. */
  dirty = false
  /** Called after an add (the store schedules the write). */
  onAdd: (() => void) | undefined

  constructor(readonly maxEntries = ID_MAP_MAX_ENTRIES) {}

  get size(): number {
    return this.forward.size
  }

  lookup(kind: IdKind, value: string): string | undefined {
    return this.forward.get(keyOf(kind, value))?.mapped
  }

  /** The id the engine holds for a wire id, or undefined (not in the map). */
  original(mapped: string): { kind: IdKind; value: string } | undefined {
    const entry = this.reverse.get(mapped)
    return entry ? { kind: entry.kind, value: entry.value } : undefined
  }

  add(kind: IdKind, value: string, mapped: string): void {
    const key = keyOf(kind, value)
    const known = this.forward.get(key)
    if (known) {
      if (known.mapped === mapped) return
      this.reverse.delete(known.mapped)
      this.forward.delete(key)
    }
    const owner = this.reverse.get(mapped)
    if (owner && (owner.kind !== kind || owner.value !== value)) throw new IdCollisionError(mapped)
    const entry: Entry = { kind, value, mapped }
    this.forward.set(key, entry)
    this.reverse.set(mapped, entry)
    while (this.forward.size > this.maxEntries) {
      const oldest = this.forward.entries().next().value as [string, Entry]
      this.forward.delete(oldest[0])
      this.reverse.delete(oldest[1].mapped)
    }
    this.dirty = true
    this.onAdd?.()
  }

  serialize(): string {
    return JSON.stringify({
      version: ID_MAP_FILE_VERSION,
      entries: [...this.forward.values()].map(entry => [entry.kind, entry.value, entry.mapped]),
    })
  }

  /** The entries of a stored map, or null when `text` is not one. */
  static parse(text: string): Entry[] | null {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return null
    }
    if (typeof parsed !== 'object' || parsed === null) return null
    const file = parsed as { version?: unknown; entries?: unknown }
    if (file.version !== ID_MAP_FILE_VERSION || !Array.isArray(file.entries)) return null
    const out: Entry[] = []
    for (const row of file.entries) {
      if (
        !Array.isArray(row)
        || row.length !== 3
        || typeof row[0] !== 'string'
        || typeof row[1] !== 'string'
        || typeof row[2] !== 'string'
      ) {
        return null
      }
      out.push({ kind: row[0] as IdKind, value: row[1], mapped: row[2] })
    }
    return out
  }

  /** Fill from stored entries; entries that clash are dropped, never thrown. */
  load(entries: readonly Entry[]): void {
    for (const entry of entries) {
      const key = keyOf(entry.kind, entry.value)
      if (this.forward.has(key) || this.reverse.has(entry.mapped)) continue
      this.forward.set(key, entry)
      this.reverse.set(entry.mapped, entry)
    }
    while (this.forward.size > this.maxEntries) {
      const oldest = this.forward.entries().next().value as [string, Entry]
      this.forward.delete(oldest[0])
      this.reverse.delete(oldest[1].mapped)
    }
  }
}

/** The file behind one map. */
export type IdMapFile = {
  /** The stored text, or null when there is none yet. */
  read(): Promise<string | null>
  write(text: string): Promise<void>
}

/** What `IdMapStores` needs of a backend (`SessionStoreBackend.openIdMap`). */
export type IdMapBackend = {
  openIdMap?(providerId: string, sessionId: string): IdMapFile
}

type Slot = {
  sessionId: string
  providerId: string
  map: Promise<IdMap>
  file: IdMapFile | undefined
  timer: ReturnType<typeof setTimeout> | undefined
  /** The write in flight; the next one waits for it. */
  writing: Promise<void>
  ended: boolean
  warned: boolean
}

export class IdMapStores {
  private readonly slots = new Map<string, Slot>()
  /** Writes of slots that left `slots`; a reopen waits for them. */
  private readonly leaving = new Map<string, Promise<void>>()
  private readonly maxEntries: number
  private readonly flushDelayMs: number
  private readonly maxLoaded: number

  constructor(
    private readonly backend: IdMapBackend | undefined,
    private readonly options: {
      maxEntries?: number
      flushDelayMs?: number
      maxLoaded?: number
      report?: (line: string) => void
    } = {},
  ) {
    this.maxEntries = options.maxEntries ?? ID_MAP_MAX_ENTRIES
    this.flushDelayMs = options.flushDelayMs ?? ID_MAP_FLUSH_DELAY_MS
    this.maxLoaded = options.maxLoaded ?? ID_MAP_MAX_LOADED
  }

  private slotKey(providerId: string, sessionId: string): string {
    return `${sessionId}\u0000${providerId}`
  }

  /**
   * The map of (provider, session). Without a session id (a request that
   * names none) the map is a fresh in-memory one: nothing to keep it with.
   */
  async open(providerId: string, sessionId: string | undefined): Promise<IdMap> {
    if (sessionId === undefined) return new IdMap(this.maxEntries)
    const key = this.slotKey(providerId, sessionId)
    const slot = this.slots.get(key)
    if (slot) {
      // Most recently used goes last.
      this.slots.delete(key)
      this.slots.set(key, slot)
      return slot.map
    }
    const created: Slot = {
      sessionId,
      providerId,
      map: undefined as unknown as Promise<IdMap>,
      file: this.backend?.openIdMap?.(providerId, sessionId),
      timer: undefined,
      writing: Promise.resolve(),
      ended: false,
      warned: false,
    }
    created.map = this.load(created, key)
    this.slots.set(key, created)
    this.trim()
    return created.map
  }

  private async load(slot: Slot, key: string): Promise<IdMap> {
    const map = new IdMap(this.maxEntries)
    const leaving = this.leaving.get(key)
    if (leaving) await leaving
    if (slot.file) {
      let text: string | null = null
      try {
        text = await slot.file.read()
      } catch {
        // No file yet (or an unreadable one): see below.
        text = null
      }
      if (text !== null && text !== '') {
        const entries = IdMap.parse(text)
        if (entries) map.load(entries)
        else this.warn(slot, `the id map of ${slot.providerId} for session ${slot.sessionId} could not be read; it starts empty`)
      }
      map.onAdd = () => this.schedule(slot, map)
    }
    return map
  }

  private warn(slot: Slot, line: string): void {
    if (slot.warned) return
    slot.warned = true
    this.options.report?.(`provider ids: ${line}`)
  }

  private schedule(slot: Slot, map: IdMap): void {
    if (slot.timer !== undefined || slot.ended || !slot.file) return
    slot.timer = setTimeout(() => {
      slot.timer = undefined
      void this.flush(slot, map)
    }, this.flushDelayMs)
    ;(slot.timer as { unref?: () => void }).unref?.()
  }

  private flush(slot: Slot, map: IdMap): Promise<void> {
    slot.writing = slot.writing.then(async () => {
      if (!map.dirty || slot.ended || !slot.file) return
      map.dirty = false
      try {
        await slot.file.write(map.serialize())
      } catch (error) {
        map.dirty = true
        this.warn(slot, `the id map of ${slot.providerId} could not be saved (${error instanceof Error ? error.message : String(error)})`)
      }
    })
    return slot.writing
  }

  /** Least recently used maps beyond the bound leave memory, after their write. */
  private trim(): void {
    while (this.slots.size > this.maxLoaded) {
      const [key, slot] = this.slots.entries().next().value as [string, Slot]
      this.slots.delete(key)
      if (slot.timer !== undefined) clearTimeout(slot.timer)
      slot.timer = undefined
      const leave = slot.map.then(map => this.flush(slot, map)).finally(() => {
        if (this.leaving.get(key) === leave) this.leaving.delete(key)
      })
      this.leaving.set(key, leave)
    }
  }

  /** Write every map that has something to write, now. */
  async flushAll(): Promise<void> {
    await Promise.all(
      [...this.slots.values()].map(async slot => {
        if (slot.timer !== undefined) clearTimeout(slot.timer)
        slot.timer = undefined
        await this.flush(slot, await slot.map)
      }),
    )
  }

  /**
   * The session is deleted: stop its maps (no write after this), wait for a
   * write already in flight, forget them. The files go with the session's
   * directory, which the caller removes next.
   */
  async end(sessionId: string): Promise<void> {
    const ending: Promise<void>[] = []
    for (const [key, slot] of [...this.slots.entries()]) {
      if (slot.sessionId !== sessionId) continue
      slot.ended = true
      if (slot.timer !== undefined) clearTimeout(slot.timer)
      slot.timer = undefined
      this.slots.delete(key)
      ending.push(slot.writing.catch(() => undefined))
    }
    for (const [key, pending] of [...this.leaving.entries()]) {
      if (key.startsWith(`${sessionId}\u0000`)) ending.push(pending.catch(() => undefined))
    }
    await Promise.all(ending)
  }
}

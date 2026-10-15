/**
 * `$.store`: a plugin's key-value file across sessions, `mods/<plugin>/store.json`,
 * capped at 4 MiB of JSON text; values round-trip through JSON; an entry list keeps
 * insertion order. One shared `FileModStore` per file; writes are serialized and
 * whole-file. On-disk contract (D-1).
 */

import { toJsonData } from './modState'

export type ModStoreHost = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}

/** `store.json`: the entries in insertion order. */
export type ModStoreFile = {
  version: 1
  entries: Array<[key: string, value: unknown]>
}

export const MOD_STORE_FILE_VERSION = 1
export const MOD_STORE_FILE_NAME = 'store.json'
/** "a store over 4 MiB of JSON text in all" is refused. */
export const MOD_STORE_CAP_BYTES = 4 * 1024 * 1024

/** The two file operations a store needs; the runtime's fs satisfies it. */
export type ModStoreFs = {
  readFile(path: string, options: { encoding: string }): Promise<string>
  writeFile(path: string, data: string, options?: { encoding?: string }): Promise<void>
  /** Create the file's directory (and its ancestors). */
  ensureDir(dir: string): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseModStoreFile(text: string): ModStoreFile | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.version !== MOD_STORE_FILE_VERSION || !Array.isArray(parsed.entries)) {
    return null
  }
  const entries: ModStoreFile['entries'] = []
  for (const entry of parsed.entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') continue
    if (entry[1] === undefined) continue
    entries.push([entry[0], entry[1]])
  }
  return { version: MOD_STORE_FILE_VERSION, entries }
}

const encoder = new TextEncoder()

export class FileModStore implements ModStoreHost {
  private values: Map<string, unknown> | undefined
  private loading: Promise<Map<string, unknown>> | undefined
  /** The write in flight; the next one waits for it. */
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly options: {
      path: string
      dir: string
      fs: ModStoreFs
      capBytes?: number
      report?: (line: string) => void
    },
  ) {}

  private load(): Promise<Map<string, unknown>> {
    if (this.values) return Promise.resolve(this.values)
    if (!this.loading) {
      this.loading = (async () => {
        const values = new Map<string, unknown>()
        let text: string | null = null
        try {
          text = await this.options.fs.readFile(this.options.path, { encoding: 'utf-8' })
        } catch {
          text = null
        }
        if (text !== null && text !== '') {
          const parsed = parseModStoreFile(text)
          if (parsed) for (const [key, value] of parsed.entries) values.set(key, value)
          else this.options.report?.(`mods: ${this.options.path} could not be read; the store starts empty`)
        }
        this.values = values
        return values
      })()
    }
    return this.loading
  }

  private serialize(values: Map<string, unknown>): string {
    const file: ModStoreFile = { version: MOD_STORE_FILE_VERSION, entries: [...values.entries()] }
    return JSON.stringify(file)
  }

  /** Change the store, after the change before it: `change` edits a copy of
   *  the values as the disk holds them, the copy is written whole, and only a
   *  write that lands replaces the values `get` reads. A change that throws,
   *  or a write that fails, leaves memory and disk as they were — and a
   *  change queued behind it starts from them, not from the failed one. */
  private commit(change: (next: Map<string, unknown>) => boolean): Promise<void> {
    const run = this.queue.then(async () => {
      if (this.closed) throw new Error('$.store: the store was closed; the change was not written')
      const next = new Map(await this.load())
      if (!change(next)) return
      const text = this.serialize(next)
      const bytes = encoder.encode(text).length
      const cap = this.options.capBytes ?? MOD_STORE_CAP_BYTES
      if (bytes > cap) {
        throw new RangeError(
          `$.store.set: the store would hold ${bytes} bytes of JSON text, over its ${cap}-byte cap`,
        )
      }
      await this.options.fs.ensureDir(this.options.dir)
      await this.options.fs.writeFile(this.options.path, text, { encoding: 'utf-8' })
      this.values = next
    })
    // The queue goes on whatever this change did.
    this.queue = run.catch(() => undefined)
    return run
  }

  private closed = false

  /** No change is written from now on, those queued included; resolves once
   *  a write already under way has landed. */
  close(): Promise<void> {
    this.closed = true
    return this.queue
  }

  async get(key: string): Promise<unknown> {
    return (await this.load()).get(key)
  }

  async set(key: string, value: unknown): Promise<void> {
    const data = toJsonData(value, '$.store.set')
    await this.commit(next => {
      next.set(key, data)
      return true
    })
  }

  async delete(key: string): Promise<void> {
    await this.commit(next => next.delete(key))
  }

  async keys(): Promise<string[]> {
    return [...(await this.load()).keys()]
  }
}

/** A store that keeps its values in memory alone — a test's, or a session
 *  whose runtime has no filesystem. */
export class MemoryModStore implements ModStoreHost {
  private readonly values = new Map<string, unknown>()
  constructor(private readonly capBytes = MOD_STORE_CAP_BYTES) {}
  async get(key: string): Promise<unknown> {
    return this.values.get(key)
  }
  async set(key: string, value: unknown): Promise<void> {
    const data = toJsonData(value, '$.store.set')
    const had = this.values.has(key)
    const before = this.values.get(key)
    this.values.set(key, data)
    const bytes = encoder.encode(JSON.stringify([...this.values.entries()])).length
    if (bytes > this.capBytes) {
      if (had) this.values.set(key, before)
      else this.values.delete(key)
      throw new RangeError(
        `$.store.set: the store would hold ${bytes} bytes of JSON text, over its ${this.capBytes}-byte cap`,
      )
    }
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key)
  }
  async keys(): Promise<string[]> {
    return [...this.values.keys()]
  }
}

/** The stores open in this realm, by file path: one in-memory copy per file. */
const openStores = new Map<string, FileModStore>()

/** The plugin's store under `modsDir` (`~/.velloc/mods`): opened once per
 *  realm, shared by every slot that asks for it. */
export function fileModStore(
  modsDir: string,
  plugin: string,
  fs: ModStoreFs,
  options: { report?: (line: string) => void; capBytes?: number } = {},
): FileModStore {
  const safe = pluginDirName(plugin)
  const dir = modsDir.endsWith('/') ? `${modsDir}${safe}` : `${modsDir}/${safe}`
  const path = `${dir}/${MOD_STORE_FILE_NAME}`
  let store = openStores.get(path)
  if (!store) {
    store = new FileModStore({ path, dir, fs, ...options })
    openStores.set(path, store)
  }
  return store
}

/** A plugin's name as a directory: the characters a path cannot carry are
 *  replaced, so a name cannot climb out of `mods/`, and it is lower-cased,
 *  since a Windows path ignores case (`Notes` and `notes` would share a
 *  file). Both are lossy (`foo/bar`, `foo:bar` and `foo_bar` all read
 *  `foo_bar`), so a name that had to change gets a hash of the ORIGINAL
 *  appended — two plugins never share a store directory, and a name that was
 *  already safe keeps its own. */
export function pluginDirName(plugin: string): string {
  const safe = plugin.replace(/[^A-Za-z0-9._@-]/g, '_').replace(/^\.+/, '_').toLowerCase()
  if (safe === plugin) return safe === '' ? '_' : safe
  return `${safe}-${fnv1a(plugin)}`
}

/** FNV-1a, 32 bits, as 8 hex digits — a name's fingerprint, not a secret. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** Tests only: forget every open store. */
export function resetModStoresForTests(): void {
  openStores.clear()
}

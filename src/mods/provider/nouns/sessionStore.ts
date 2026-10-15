/**
 * `$.provider.sessionStore(sessionId)`: a key-value store per (session, provider),
 * one file under `provider-sessions/<session>/`, removed with the session (memory
 * without a filesystem). Capped at 256 KiB of JSON text.
 */

import { FileModStore, MemoryModStore, pluginDirName, type ModStoreFs, type ModStoreHost } from '../../modStore'
import type { IdMapFile } from '../ids/idMapStore'

export const SESSION_STORE_CAP_BYTES = 256 * 1024
export const SESSION_KEY_MAX_CHARS = 256

export interface SessionStoreBackend {
  /** The store of (provider, session). Opening it twice gives the same data. */
  open(providerId: string, sessionId: string): ModStoreHost
  /** The id mapper's file for (provider, session): one file, read and
   *  written whole, removed with the session. Absent = no file backend; the
   *  maps then live in memory. */
  openIdMap?(providerId: string, sessionId: string): IdMapFile
  /** Remove every provider's store of the session. */
  end(sessionId: string): Promise<void>
}

/** A session id as given by the runtime, or null. */
export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= 200
}

export function isSessionKey(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= SESSION_KEY_MAX_CHARS
}

export class MemorySessionStores implements SessionStoreBackend {
  private readonly stores = new Map<string, Map<string, MemoryModStore>>()
  private readonly idMaps = new Map<string, string>()

  constructor(private readonly capBytes = SESSION_STORE_CAP_BYTES) {}

  openIdMap(providerId: string, sessionId: string): IdMapFile {
    const key = `${sessionId}\u0000${providerId}`
    return {
      read: async () => this.idMaps.get(key) ?? null,
      write: async text => {
        this.idMaps.set(key, text)
      },
    }
  }

  open(providerId: string, sessionId: string): ModStoreHost {
    let session = this.stores.get(sessionId)
    if (!session) {
      session = new Map()
      this.stores.set(sessionId, session)
    }
    let store = session.get(providerId)
    if (!store) {
      store = new MemoryModStore(this.capBytes)
      session.set(providerId, store)
    }
    return store
  }

  async end(sessionId: string): Promise<void> {
    this.stores.delete(sessionId)
    for (const key of [...this.idMaps.keys()]) if (key.startsWith(`${sessionId}\u0000`)) this.idMaps.delete(key)
  }
}

export type SessionStoreFs = ModStoreFs & {
  /** Remove a directory and what is in it; a missing one is not an error. */
  removeDir(dir: string): Promise<void>
}

export class FileSessionStores implements SessionStoreBackend {
  private readonly opened = new Map<string, FileModStore>()

  constructor(
    private readonly options: {
      /** `…/provider-sessions` */
      root: string
      fs: SessionStoreFs
      capBytes?: number
      report?: (line: string) => void
    },
  ) {}

  private dirOf(sessionId: string): string {
    const root = this.options.root.endsWith('/') ? this.options.root.slice(0, -1) : this.options.root
    return `${root}/${pluginDirName(sessionId)}`
  }

  open(providerId: string, sessionId: string): ModStoreHost {
    const dir = this.dirOf(sessionId)
    const path = `${dir}/${pluginDirName(providerId)}.json`
    let store = this.opened.get(path)
    if (!store) {
      store = new FileModStore({
        path,
        dir,
        fs: this.options.fs,
        capBytes: this.options.capBytes ?? SESSION_STORE_CAP_BYTES,
        ...(this.options.report ? { report: this.options.report } : {}),
      })
      this.opened.set(path, store)
    }
    return store
  }

  openIdMap(providerId: string, sessionId: string): IdMapFile {
    const dir = this.dirOf(sessionId)
    const path = `${dir}/${pluginDirName(providerId)}.idmap.json`
    const { fs } = this.options
    return {
      read: async () => {
        try {
          return await fs.readFile(path, { encoding: 'utf-8' })
        } catch {
          return null
        }
      },
      write: async text => {
        await fs.ensureDir(dir)
        await fs.writeFile(path, text, { encoding: 'utf-8' })
      },
    }
  }

  async end(sessionId: string): Promise<void> {
    const dir = this.dirOf(sessionId)
    const closing: Promise<void>[] = []
    for (const [path, store] of [...this.opened]) {
      if (!path.startsWith(`${dir}/`)) continue
      this.opened.delete(path)
      closing.push(store.close())
    }
    // A change still queued would write the folder back after it is removed.
    await Promise.all(closing)
    await this.options.fs.removeDir(dir)
  }
}

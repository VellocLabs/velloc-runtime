/**
 * One app's state as its background module holds it (F-40): the value, a
 * version each batch increments, the file it is read from at start and
 * written back to after each batch, and the realm bus each batch reaches.
 * The value given out is never changed afterwards: a batch yields a new one.
 */

import type { AppDataPatch } from '../../browser/runtimeProtocol/modApps'
import { APP_STATE_MAX_BYTES, appStateBytes, appStateText, applyAppPatches, checkAppPatches, diffJson } from './appStateDiff'
import { clearAppState, publishAppState, type AppStateEvent } from './appStateBus'

export const APP_STATE_PERSIST_DELAY_MS = 300

export type AppStateDocumentFs = {
  readFile(path: string, options: { encoding: string }): Promise<string>
  writeFile(path: string, data: string, options?: { encoding?: string }): Promise<void>
}

export type AppStateDocumentOptions = {
  appId: string
  /** The file the state lives in, absolute. */
  file: string
  fs: AppStateDocumentFs
  /** Creates the file's directory and its ancestors. */
  ensureDir(dir: string): Promise<void>
  report(line: string): void
  /** Where a batch goes; default the realm bus. */
  publish?: (event: AppStateEvent) => void
  persistDelayMs?: number
  maxBytes?: number
}

const dirOf = (file: string): string => {
  const at = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  return at > 0 ? file.slice(0, at) : file
}

let nextOwner = 0

export class AppStateDocument {
  /** Unique per document in the realm, so two documents of one app never share a version. */
  readonly owner = ++nextOwner
  private current: unknown = {}
  private currentVersion = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private writing: Promise<void> = Promise.resolve()
  private dirty = false
  private disposed = false

  constructor(private readonly options: AppStateDocumentOptions) {}

  get value(): unknown {
    return this.current
  }

  get version(): number {
    return this.currentVersion
  }

  /** The file's value, `{}` when it is absent or not JSON (reported). */
  async load(): Promise<void> {
    let text: string
    try {
      text = await this.options.fs.readFile(this.options.file, { encoding: 'utf-8' })
    } catch {
      this.current = {}
      return
    }
    try {
      const parsed: unknown = JSON.parse(text)
      this.current = parsed === null || parsed === undefined ? {} : parsed
    } catch (error) {
      this.options.report(`${this.options.appId}: the state file is not JSON (${error instanceof Error ? error.message : String(error)}); the app starts from {}`)
      this.current = {}
    }
  }

  /** Applies the batch, or throws and leaves the state as it was. */
  apply(patches: unknown): { version: number } {
    if (this.disposed) throw new Error(`${this.options.appId}: the app's background module is stopped`)
    const refused = checkAppPatches(patches)
    if (refused) throw new TypeError(refused)
    const list = patches as readonly AppDataPatch[]
    const next = applyAppPatches(this.current, list)
    const bytes = appStateBytes(next)
    const cap = this.options.maxBytes ?? APP_STATE_MAX_BYTES
    if (bytes > cap) throw new RangeError(`$.app.publish(patches): the state would be ${bytes} bytes; at most ${cap}`)
    // Published as the diff, not as given: `-` and array removals become the replacements every reader applies alike.
    const published = diffJson(this.current, next)
    this.current = next
    this.currentVersion += 1
    this.schedulePersist()
    ;(this.options.publish ?? publishAppState)({ appId: this.options.appId, owner: this.owner, version: this.currentVersion, value: next, patches: published })
    return { version: this.currentVersion }
  }

  /** The pending write, done. */
  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.dirty) this.persistNow()
    await this.writing
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    clearAppState(this.options.appId, this.owner)
    await this.flush()
  }

  private schedulePersist(): void {
    this.dirty = true
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.persistNow()
    }, this.options.persistDelayMs ?? APP_STATE_PERSIST_DELAY_MS)
  }

  private persistNow(): void {
    this.dirty = false
    const text = appStateText(this.current)
    const { file, fs, ensureDir } = this.options
    this.writing = this.writing
      .then(async () => {
        await ensureDir(dirOf(file))
        await fs.writeFile(file, text, { encoding: 'utf-8' })
      })
      .catch(error => {
        this.options.report(`${this.options.appId}: the state could not be written to ${file} (${error instanceof Error ? error.message : String(error)})`)
      })
  }
}

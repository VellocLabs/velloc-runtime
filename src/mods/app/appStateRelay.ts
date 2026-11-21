/**
 * Contract: the runtime's side of one app's state (F-40). The app's script
 * holds the value and numbers its batches; this relay checks each batch,
 * passes its patches to the realm bus, and keeps no value. It asks the
 * script for the state's text in two cases: to write the data file a short
 * while after a batch, and to give a reader the state whole. `load` reads
 * the file for a script that starts. A batch that does not follow the one
 * before is passed on without patches, so every reader reads again.
 *
 * Security: a batch is refused past `maxBytes`, and a text past it is
 * neither written nor given out, so a script cannot grow the file or a
 * page's copy without bound.
 */

import type { AppDataPatch } from '../../browser/runtimeProtocol/modApps'
import { APP_STATE_MAX_BYTES, checkAppPatches, utf8Length } from './appStateDiff'
import { clearAppState, holdAppState, publishAppState, type AppStateEvent, type AppStateSource } from './appStateBus'

export const APP_STATE_PERSIST_DELAY_MS = 300

export type AppStateRelayFs = {
  readFile(path: string, options: { encoding: string }): Promise<string>
  writeFile(path: string, data: string, options?: { encoding?: string }): Promise<void>
}

/** What the script answers: its state as text and the batch it stands at, or that it never read the state. */
export type AppStateTextAnswer = { text: string; seq: number } | { unloaded: true }

export type AppStateRelayOptions = {
  appId: string
  /** The file the state lives in, absolute. */
  file: string
  fs: AppStateRelayFs
  /** Creates the file's directory and its ancestors. */
  ensureDir(dir: string): Promise<void>
  report(line: string): void
  /** Asks the running script for its state; rejects when none runs. */
  ask(): Promise<unknown>
  /** Where a batch goes; default the realm bus. */
  publish?: (event: AppStateEvent) => void
  persistDelayMs?: number
  maxBytes?: number
}

const dirOf = (file: string): string => {
  const at = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  return at > 0 ? file.slice(0, at) : file
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function textAnswer(answer: unknown): AppStateTextAnswer {
  const given = answer as { text?: unknown; seq?: unknown; unloaded?: unknown } | null
  if (given && given.unloaded === true) return { unloaded: true }
  if (given && typeof given.text === 'string' && typeof given.seq === 'number') return { text: given.text, seq: given.seq }
  throw new TypeError('the script of the app did not answer with its state')
}

let nextOwner = 0

export class AppStateRelay implements AppStateSource {
  /** Unique per relay in the realm, so two relays of one app never share a version. */
  readonly owner = ++nextOwner
  private current = 0
  private held = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private writing: Promise<void> = Promise.resolve()
  private dirty = false
  private disposed = false

  constructor(private readonly options: AppStateRelayOptions) {}

  version(): number {
    return this.current
  }

  /** The file's value for a script that starts, `{}` when it is absent or not JSON (reported). */
  async load(): Promise<{ value: unknown; version: number }> {
    if (this.disposed) throw new Error(`${this.options.appId}: the app's background module is stopped`)
    const value = await this.fileValue()
    if (this.held) {
      // A script started again: what readers hold may be ahead of the file.
      this.current += 1
      this.emit({})
    } else {
      this.held = true
      holdAppState(this.options.appId, this)
    }
    return { value, version: this.current }
  }

  /** Passes the batch on, or throws and passes nothing. */
  relay(patches: unknown, seq: unknown): { version: number } {
    if (this.disposed) throw new Error(`${this.options.appId}: the app's background module is stopped`)
    const refused = checkAppPatches(patches)
    if (refused) throw new TypeError(refused)
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq <= this.current) {
      throw new TypeError(`$.app.publish(patches): batch ${String(seq)} does not come after batch ${this.current}`)
    }
    const list = patches as readonly AppDataPatch[]
    const bytes = utf8Length(JSON.stringify(list))
    const cap = this.options.maxBytes ?? APP_STATE_MAX_BYTES
    if (bytes > cap) throw new RangeError(`$.app.publish(patches): the batch is ${bytes} bytes; at most ${cap}`)
    const follows = seq === this.current + 1
    this.current = seq
    this.schedulePersist()
    this.emit(follows ? { patches: list } : {})
    return { version: seq }
  }

  async read(): Promise<{ version: number; value: unknown }> {
    let answer: AppStateTextAnswer
    try {
      answer = textAnswer(await this.options.ask())
    } catch {
      // No script answers: the file is the state.
      return { version: this.current, value: await this.fileValue() }
    }
    if ('unloaded' in answer) return { version: this.current, value: await this.fileValue() }
    this.checkSize(answer.text)
    return { version: answer.seq, value: JSON.parse(answer.text) as unknown }
  }

  /** The pending write, done. Call while the script still answers. */
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
    await this.flush()
    clearAppState(this.options.appId, this.owner)
  }

  private emit(extra: Pick<AppStateEvent, 'patches'>): void {
    ;(this.options.publish ?? publishAppState)({ appId: this.options.appId, owner: this.owner, version: this.current, ...extra })
  }

  private checkSize(text: string): void {
    const bytes = utf8Length(text)
    const cap = this.options.maxBytes ?? APP_STATE_MAX_BYTES
    if (bytes > cap) throw new RangeError(`${this.options.appId}: the state is ${bytes} bytes; at most ${cap}`)
  }

  private async fileValue(): Promise<unknown> {
    let text: string
    try {
      text = await this.options.fs.readFile(this.options.file, { encoding: 'utf-8' })
    } catch {
      return {}
    }
    try {
      const parsed: unknown = JSON.parse(text)
      return parsed === null || parsed === undefined ? {} : parsed
    } catch (error) {
      this.options.report(`${this.options.appId}: the state file is not JSON (${reason(error)}); the app starts from {}`)
      return {}
    }
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
    const { file, fs, ensureDir } = this.options
    this.writing = this.writing
      .then(async () => {
        const answer = textAnswer(await this.options.ask())
        if ('unloaded' in answer) return
        this.checkSize(answer.text)
        await ensureDir(dirOf(file))
        await fs.writeFile(file, answer.text, { encoding: 'utf-8' })
      })
      .catch(error => {
        this.options.report(`${this.options.appId}: the state could not be written to ${file} (${reason(error)})`)
      })
  }
}

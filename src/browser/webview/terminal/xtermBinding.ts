/**
 * The glue between one `terminal/<id>` subscription and one emulator (F-31),
 * kept free of xterm.js so it is unit-testable: a snapshot resets the screen
 * and replays the scrollback, an `output` delta is written, `resize` /
 * `title` / `state` deltas update the mirrored record; the replay gate holds
 * back the emulator's answers to queries in replayed text. Also the input
 * batcher: keystrokes per animation frame (or timer), split at the cap.
 */
import {
  TERMINAL_WRITE_MAX_BYTES,
  isTerminalState,
  type TerminalSnapshot,
  type TerminalState,
} from '@/terminal/protocol'

/** What the binding needs from the emulator. `parsed` runs once `data` has been parsed. */
export interface EmulatorLike {
  reset(): void
  write(data: string, parsed?: () => void): void
}

const ESC = 0x1b

/**
 * Closed while a snapshot's scrollback is being parsed. The scrollback can
 * hold console queries (device attributes, cursor position) answered long
 * ago; the emulator answers them again as it replays, and those answers are
 * not input, and let through they would be typed at the shell's prompt
 * on every re-open.
 * Keystrokes still pass; only escape-led data is held back while closed.
 */
export class ReplayGate {
  private replays = 0

  /** A replay begins; the returned function ends it (once). */
  begin(): () => void {
    this.replays++
    let ended = false
    return () => {
      if (ended) return
      ended = true
      this.replays--
    }
  }

  get replaying(): boolean {
    return this.replays > 0
  }

  /** Whether `data` the emulator produced may go to the shell now. */
  admits(data: string): boolean {
    return !this.replaying || data.charCodeAt(0) !== ESC
  }
}

/** The terminal as the topic last described it. */
export interface MirroredTerminal {
  cols: number
  rows: number
  title: string
  state: TerminalState
}

export type TerminalTopicEventLike = {
  form: 'snapshot' | 'delta' | 'deltas'
  type?: string
  payload: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export function isTerminalSnapshot(value: unknown): value is TerminalSnapshot {
  return (
    isRecord(value) &&
    typeof value.cols === 'number' &&
    typeof value.rows === 'number' &&
    typeof value.title === 'string' &&
    typeof value.scrollback === 'string' &&
    isTerminalState(value.state)
  )
}

/**
 * Apply one topic event. Returns the mirrored record after the event (the
 * same reference when the event changed nothing of it). A snapshot's replay
 * keeps `gate` closed until the emulator has parsed it.
 */
export function applyTerminalTopicEvent(
  emulator: EmulatorLike,
  mirror: MirroredTerminal | null,
  event: TerminalTopicEventLike,
  gate?: ReplayGate,
): MirroredTerminal | null {
  if (event.form === 'snapshot') {
    if (!isTerminalSnapshot(event.payload)) return mirror
    emulator.reset()
    const scrollback = event.payload.scrollback
    if (scrollback && gate) emulator.write(scrollback, gate.begin())
    else if (scrollback) emulator.write(scrollback)
    return {
      cols: event.payload.cols,
      rows: event.payload.rows,
      title: event.payload.title,
      state: event.payload.state,
    }
  }
  const payload = event.payload
  switch (event.type) {
    case 'output':
      if (isRecord(payload) && typeof payload.data === 'string' && payload.data) {
        emulator.write(payload.data)
      }
      return mirror
    case 'resize':
      if (mirror && isRecord(payload) && typeof payload.cols === 'number' && typeof payload.rows === 'number') {
        if (payload.cols === mirror.cols && payload.rows === mirror.rows) return mirror
        return { ...mirror, cols: payload.cols, rows: payload.rows }
      }
      return mirror
    case 'title':
      if (mirror && isRecord(payload) && typeof payload.title === 'string') {
        return payload.title === mirror.title ? mirror : { ...mirror, title: payload.title }
      }
      return mirror
    case 'state':
      if (mirror && isRecord(payload) && isTerminalState(payload.state)) {
        // A restart: the runtime starts the scrollback afresh, so does the screen.
        if (payload.state.kind === 'starting' && mirror.state.kind !== 'starting') emulator.reset()
        return { ...mirror, state: payload.state }
      }
      return mirror
    default:
      return mirror
  }
}

const utf8 = new TextEncoder()

/**
 * Split `data` into pieces of at most `maxBytes` of UTF-8, never inside a
 * surrogate pair. One piece for anything that fits.
 */
export function splitForWire(data: string, maxBytes: number = TERMINAL_WRITE_MAX_BYTES): string[] {
  if (utf8.encode(data).byteLength <= maxBytes) return data ? [data] : []
  const pieces: string[] = []
  let piece = ''
  let bytes = 0
  for (const ch of data) {
    const size = utf8.encode(ch).byteLength
    if (bytes + size > maxBytes && piece) {
      pieces.push(piece)
      piece = ''
      bytes = 0
    }
    piece += ch
    bytes += size
  }
  if (piece) pieces.push(piece)
  return pieces
}

/**
 * How long a batch waits for an animation frame before a timer sends it:
 * a covered window renders no frame at all.
 */
export const INPUT_FLUSH_FALLBACK_MS = 32

/** The default batch tick: the next animation frame, or the fallback timer, whichever comes first. */
export function scheduleInputFlush(flush: () => void): void {
  let done = false
  const once = (): void => {
    if (done) return
    done = true
    flush()
  }
  const timer = setTimeout(once, INPUT_FLUSH_FALLBACK_MS)
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      clearTimeout(timer)
      once()
    })
  }
}

/**
 * Collects input and flushes it once per `schedule` tick (the default tick
 * in the view, a manual tick in tests) through `send`, in wire-sized
 * pieces. Data that begins with ESC (a key sequence, or the emulator's reply
 * to a console query such as the cursor position, which the host waits for
 * only briefly) is flushed at once. `dispose` drops anything pending.
 */
export class InputBatcher {
  private pending = ''
  private scheduled = false
  private disposed = false

  constructor(
    private readonly send: (data: string) => void,
    private readonly schedule: (flush: () => void) => void = scheduleInputFlush,
  ) {}

  push(data: string): void {
    if (this.disposed || !data) return
    this.pending += data
    if (data.charCodeAt(0) === ESC) {
      this.flush()
      return
    }
    if (this.scheduled) return
    this.scheduled = true
    this.schedule(() => this.flush())
  }

  flush(): void {
    this.scheduled = false
    if (this.disposed) return
    const data = this.pending
    this.pending = ''
    for (const piece of splitForWire(data)) this.send(piece)
  }

  dispose(): void {
    this.disposed = true
    this.pending = ''
  }
}

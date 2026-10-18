/**
 * The glue between one `terminal/<id>` subscription and one emulator (F-31),
 * kept free of xterm.js so it is unit-testable: a snapshot resets the screen
 * and replays the scrollback, an `output` delta is written, `resize` /
 * `title` / `state` deltas update the mirrored record. Also the input
 * batcher: keystrokes are collected per animation frame and sent as one
 * `terminal.write`, split at the wire's size cap.
 */
import {
  TERMINAL_WRITE_MAX_BYTES,
  isTerminalState,
  type TerminalSnapshot,
  type TerminalState,
} from '@/terminal/protocol'

/** What the binding needs from the emulator. */
export interface EmulatorLike {
  reset(): void
  write(data: string): void
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
 * same reference when the event changed nothing of it).
 */
export function applyTerminalTopicEvent(
  emulator: EmulatorLike,
  mirror: MirroredTerminal | null,
  event: TerminalTopicEventLike,
): MirroredTerminal | null {
  if (event.form === 'snapshot') {
    if (!isTerminalSnapshot(event.payload)) return mirror
    emulator.reset()
    if (event.payload.scrollback) emulator.write(event.payload.scrollback)
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
 * Collects input and flushes it once per `schedule` tick (an animation
 * frame in the view, a manual tick in tests) through `send`, in wire-sized
 * pieces. `dispose` drops anything pending.
 */
export class InputBatcher {
  private pending = ''
  private scheduled = false
  private disposed = false

  constructor(
    private readonly send: (data: string) => void,
    private readonly schedule: (flush: () => void) => void = flush => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => flush())
      else setTimeout(flush, 0)
    },
  ) {}

  push(data: string): void {
    if (this.disposed || !data) return
    this.pending += data
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

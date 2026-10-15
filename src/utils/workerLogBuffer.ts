/**
 * SharedWorker console capture: a ring buffer of `console.warn` / `error` and
 * uncaught errors, flushed on `trace.flush` and streamed via `trace.subscribe`.
 * Off by default: nothing is retained until a capture source (`'tracer'` or
 * `'debug'`) is on; when the last source turns off the ring is cleared.
 */

/**
 * Log levels, lowest to highest. Console capture only ever pushes `warn` / `error`; the lower levels come
 * from explicit `traceLine` instrumentation (`src/utils/debugLog.ts`) and
 * are gated behind the runtime debug switch (`/debug log on`).
 */
export type WorkerLogLevel = 'verbose' | 'debug' | 'info' | 'warn' | 'error'

export type WorkerLogEntry = {
  /** Unique id (de-dupe / React keys). */
  id: string
  /** `performance.timeOrigin + performance.now()` — Unix ms, sub-ms precision. */
  timeMs: number
  level: WorkerLogLevel
  /** Formatted single-string rendering of the console args. */
  text: string
  /** Leading `[tag]` parsed off the text, e.g. `mcp` for `[mcp] …`. */
  source?: string
}

export type WorkerLogListener = (entry: WorkerLogEntry) => void

const BUFFER_SIZE = 500

class WorkerLogBuffer {
  private ring: Array<WorkerLogEntry | undefined> = new Array(BUFFER_SIZE)
  private writeIdx = 0
  private wrapped = false
  private readonly listeners = new Set<WorkerLogListener>()

  push(level: WorkerLogLevel, text: string): void {
    // Master gate: with no capture source on, the ring collects nothing —
    // not even warn/error. See the module doc for the source semantics.
    if (!isWorkerLogCaptureEnabled()) return
    const entry: WorkerLogEntry = {
      id: newId(),
      timeMs: nowMs(),
      level,
      text,
      source: parseSource(text),
    }
    this.ring[this.writeIdx] = entry
    this.writeIdx = (this.writeIdx + 1) % BUFFER_SIZE
    if (this.writeIdx === 0) this.wrapped = true
    if (this.listeners.size > 0) {
      for (const listener of this.listeners) {
        try {
          listener(entry)
        } catch {
          // A listener must never poison the (patched) console hot path.
        }
      }
    }
  }

  /** Oldest→newest snapshot of the ring. Does not clear. */
  drain(): WorkerLogEntry[] {
    const out: WorkerLogEntry[] = []
    if (!this.wrapped) {
      for (let i = 0; i < this.writeIdx; i++) {
        const rec = this.ring[i]
        if (rec) out.push(rec)
      }
    } else {
      for (let i = 0; i < BUFFER_SIZE; i++) {
        const idx = (this.writeIdx + i) % BUFFER_SIZE
        const rec = this.ring[idx]
        if (rec) out.push(rec)
      }
    }
    return out
  }

  subscribe(listener: WorkerLogListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Drop all retained entries (last capture source turned off). */
  clear(): void {
    this.ring = new Array(BUFFER_SIZE)
    this.writeIdx = 0
    this.wrapped = false
  }
}

/**
 * Who can turn ring collection on. Independent switches so the trace
 * plumbing and the `/debug log` session switch don't fight over one bit.
 */
export type WorkerLogCaptureSource = 'tracer' | 'debug'

const captureSources = new Set<WorkerLogCaptureSource>()

export function setWorkerLogCaptureSource(
  source: WorkerLogCaptureSource,
  on: boolean,
): void {
  if (on) {
    captureSources.add(source)
  } else {
    captureSources.delete(source)
    // Last source gone → release the retained entries. A disabled debug
    // system must hold nothing in memory.
    if (captureSources.size === 0) buffer?.clear()
  }
}

export function isWorkerLogCaptureEnabled(): boolean {
  return captureSources.size > 0
}

let buffer: WorkerLogBuffer | null = null
let installed = false

export function getWorkerLogBuffer(): WorkerLogBuffer {
  if (!buffer) buffer = new WorkerLogBuffer()
  return buffer
}

/**
 * Patch `console.warn` / `console.error` (passthrough) and attach
 * `error` / `unhandledrejection` listeners on the worker global so every
 * warning/error lands in the buffer. Idempotent — safe to call from the
 * manager constructor and any per-session worker; the global console is
 * patched at most once per realm.
 */
export function installWorkerLogCapture(): WorkerLogBuffer {
  const buf = getWorkerLogBuffer()
  if (installed) return buf
  installed = true

  const target = globalThis.console
  if (target) {
    const origWarn = target.warn.bind(target)
    const origError = target.error.bind(target)
    // Check the gate BEFORE formatting: with capture off the wrapper is a
    // boolean test + passthrough, so the patch costs nothing measurable.
    target.warn = (...args: unknown[]) => {
      try {
        if (isWorkerLogCaptureEnabled()) buf.push('warn', formatArgs(args))
      } catch {
        // never block the original console call
      }
      origWarn(...args)
    }
    target.error = (...args: unknown[]) => {
      try {
        if (isWorkerLogCaptureEnabled()) buf.push('error', formatArgs(args))
      } catch {
        // never block the original console call
      }
      origError(...args)
    }
  }

  const scope = globalThis as typeof globalThis & {
    addEventListener?: (type: string, listener: (event: Event) => void) => void
  }
  if (typeof scope.addEventListener === 'function') {
    scope.addEventListener('error', event => {
      if (!isWorkerLogCaptureEnabled()) return
      const e = event as ErrorEvent
      const message =
        e.error instanceof Error
          ? formatError(e.error)
          : e.message || 'Uncaught error'
      buf.push('error', `[uncaught] ${message}`)
    })
    scope.addEventListener('unhandledrejection', event => {
      if (!isWorkerLogCaptureEnabled()) return
      const reason = (event as PromiseRejectionEvent).reason
      const message =
        reason instanceof Error ? formatError(reason) : safeStringify(reason)
      buf.push('error', `[unhandledrejection] ${message}`)
    })
  }

  return buf
}

function formatArgs(args: unknown[]): string {
  return args.map(formatOne).join(' ')
}

function formatOne(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return formatError(value)
  return safeStringify(value)
}

function formatError(error: Error): string {
  return error.stack ? `${error.message}\n${error.stack}` : error.message
}

function safeStringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function parseSource(text: string): string | undefined {
  const match = /^\[([^\]]+)\]/.exec(text)
  return match ? match[1] : undefined
}

function nowMs(): number {
  if (
    typeof performance !== 'undefined' &&
    typeof performance.now === 'function'
  ) {
    return (performance.timeOrigin ?? 0) + performance.now()
  }
  return Date.now()
}

function newId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID()
  }
  return `wl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

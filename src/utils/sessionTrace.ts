/**
 * Session-load trace: a ring-buffer tracer in every realm (UI + SharedWorker)
 * that reconstructs one user action's timeline. Off by default: while disabled
 * `span()` / `event()` are no-ops and nothing is retained. Consumed by pull
 * (`drain()`) or push (`subscribe`); `traceId` / `parentSpanId` propagate across
 * realms via protocol fields.
 */

export type TraceContext = 'ui' | 'worker'

export type TraceRecord = {
  /** Shared by every span in one user-action lineage. */
  traceId: string
  /** Unique per record. */
  spanId: string
  /** Parent span this nests under, if any. */
  parentSpanId?: string
  /** Dotted name, e.g. `ui.session.switch` or `worker.fs.readFile`. */
  name: string
  /** `performance.timeOrigin + performance.now()` — Unix ms, sub-ms precision. */
  startMs: number
  /** Wall-clock duration. Omitted for instantaneous events. */
  durationMs?: number
  /** Realm the span ran in. */
  context: TraceContext
  /** Free-form structured attributes (size, sessionId, etc.). */
  attrs?: Record<string, unknown>
}

export interface Span {
  readonly traceId: string
  readonly spanId: string
  end(extraAttrs?: Record<string, unknown>): void
}

export type TraceListener = (record: TraceRecord) => void

const DEFAULT_BUFFER_SIZE = 4096

const NOOP_SPAN: Span = {
  traceId: 'noop',
  spanId: 'noop',
  end() {},
}

class SessionTracer {
  private records: Array<TraceRecord | undefined>
  private writeIdx = 0
  private wrapped = false
  private listeners = new Set<TraceListener>()
  // Opt-in: stays false until a realm's debug gate calls setEnabled(true).
  private enabled = false
  /**
   * Latest known root, set when a high-level user action opens its top-level span,
   * so concurrent unrelated spans join that lineage. Never cleared; overwritten on
   * every new root.
   */
  private currentTraceContext:
    | { traceId: string; parentSpanId?: string }
    | undefined

  constructor(
    private readonly context: TraceContext,
    private readonly bufferSize: number,
  ) {
    this.records = new Array(bufferSize)
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) {
      // Release everything collected so far — a disabled tracer must not
      // keep records (or their attrs object graphs) alive in memory.
      this.records = new Array(this.bufferSize)
      this.writeIdx = 0
      this.wrapped = false
    }
  }

  isEnabled(): boolean {
    return this.enabled
  }

  setCurrentTraceContext(
    ctx: { traceId: string; parentSpanId?: string } | undefined,
  ): void {
    this.currentTraceContext = ctx
  }

  getCurrentTraceContext():
    | { traceId: string; parentSpanId?: string }
    | undefined {
    return this.currentTraceContext
  }

  /**
   * Open a span. Call `.end()` on the returned handle to record duration.
   * If the tracer is disabled, returns a no-op handle so call sites don't
   * need to guard.
   */
  span(
    name: string,
    opts?: {
      traceId?: string
      parentSpanId?: string
      attrs?: Record<string, unknown>
    },
  ): Span {
    if (!this.enabled) return NOOP_SPAN

    const startMs = nowMs()
    const traceId = opts?.traceId ?? newId()
    const spanId = newId()
    const parentSpanId = opts?.parentSpanId
    const baseAttrs = opts?.attrs
    const context = this.context
    const tracer = this
    let ended = false

    return {
      traceId,
      spanId,
      end(extraAttrs?: Record<string, unknown>): void {
        if (ended) return
        ended = true
        const endMs = nowMs()
        const record: TraceRecord = {
          traceId,
          spanId,
          parentSpanId,
          name,
          startMs,
          durationMs: endMs - startMs,
          context,
          attrs: extraAttrs
            ? { ...(baseAttrs ?? {}), ...extraAttrs }
            : baseAttrs,
        }
        tracer.push(record)
      },
    }
  }

  /**
   * Record an instantaneous event (no duration). Useful for moments like
   * "message posted" or "manager received init".
   */
  event(
    name: string,
    opts?: {
      traceId?: string
      parentSpanId?: string
      attrs?: Record<string, unknown>
    },
  ): { traceId: string; spanId: string } {
    if (!this.enabled) {
      return { traceId: 'noop', spanId: 'noop' }
    }
    const traceId = opts?.traceId ?? newId()
    const spanId = newId()
    const record: TraceRecord = {
      traceId,
      spanId,
      parentSpanId: opts?.parentSpanId,
      name,
      startMs: nowMs(),
      context: this.context,
      attrs: opts?.attrs,
    }
    this.push(record)
    return { traceId, spanId }
  }

  /**
   * Snapshot of the current ring buffer, sorted by `startMs`. Does not
   * clear — callers can drain repeatedly without losing history. The
   * buffer caps at `bufferSize`; oldest records are evicted on overflow.
   */
  drain(): TraceRecord[] {
    const out: TraceRecord[] = []
    if (!this.wrapped) {
      for (let i = 0; i < this.writeIdx; i++) {
        const rec = this.records[i]
        if (rec) out.push(rec)
      }
    } else {
      for (let i = 0; i < this.bufferSize; i++) {
        const idx = (this.writeIdx + i) % this.bufferSize
        const rec = this.records[idx]
        if (rec) out.push(rec)
      }
    }
    out.sort((a, b) => a.startMs - b.startMs)
    return out
  }

  /**
   * Subscribe to per-span pushes. The listener fires once per `span.end()`
   * or `event()` call. Return value is the unsubscribe function.
   */
  subscribe(listener: TraceListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private push(record: TraceRecord): void {
    this.records[this.writeIdx] = record
    this.writeIdx = (this.writeIdx + 1) % this.bufferSize
    if (this.writeIdx === 0) this.wrapped = true
    if (this.listeners.size > 0) {
      for (const listener of this.listeners) {
        try {
          listener(record)
        } catch {
          // listener errors must not poison hot path
        }
      }
    }
  }
}

function nowMs(): number {
  // performance.timeOrigin is ms-since-epoch as of the realm's
  // construction; performance.now() is ms-since-timeOrigin with sub-ms
  // precision. Sum gives sub-ms-precision Unix ms — correlatable across
  // realms within ~µs.
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
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Singleton traceId shared by every cross-file boot-diagnostic span/event, so
 * they land in one trace lineage. Generated lazily.
 */
let bootDiagnosticTraceId: string | undefined
export function getBootDiagnosticTraceId(): string {
  if (!bootDiagnosticTraceId) {
    bootDiagnosticTraceId = newId()
  }
  return bootDiagnosticTraceId
}

let activeTracer: SessionTracer | null = null

export type InstallSessionTracerOptions = {
  context: TraceContext
  bufferSize?: number
}

export function installSessionTracer(
  opts: InstallSessionTracerOptions,
): SessionTracer {
  if (activeTracer) return activeTracer
  activeTracer = new SessionTracer(opts.context, opts.bufferSize ?? DEFAULT_BUFFER_SIZE)
  return activeTracer
}

export function getSessionTracer(): SessionTracer {
  if (!activeTracer) {
    activeTracer = new SessionTracer(detectContext(), DEFAULT_BUFFER_SIZE)
  }
  return activeTracer
}

function detectContext(): TraceContext {
  return typeof window !== 'undefined' ? 'ui' : 'worker'
}

/**
 * Format a list of records as a Gantt-shaped table for `console.table()`.
 * Times are rendered as offsets from the earliest span in the list.
 */
export function formatTraceTable(
  records: readonly TraceRecord[],
): Array<{
  trace: string
  span: string
  parent: string
  ctx: TraceContext
  name: string
  'offset (ms)': string
  'duration (ms)': string
  attrs: string
}> {
  if (records.length === 0) return []
  const t0 = records[0]!.startMs
  return records.map(r => ({
    trace: r.traceId.slice(0, 8),
    span: r.spanId.slice(0, 8),
    parent: r.parentSpanId?.slice(0, 8) ?? '',
    ctx: r.context,
    name: r.name,
    'offset (ms)': (r.startMs - t0).toFixed(2),
    'duration (ms)':
      r.durationMs === undefined ? '·' : r.durationMs.toFixed(2),
    attrs: r.attrs ? JSON.stringify(r.attrs) : '',
  }))
}

/**
 * The trace a scenario records: what crossed each boundary of the engine, in
 * order, per boundary. Every section is a plain JSON value so a trace can be
 * normalized, written as a fixture and compared with deep equality.
 */
export type Trace = {
  /** Each model request as sent to the transport (`model.streamStart` /
   *  `model.call` payloads): system prompt, messages, tool definitions. */
  modelRequests: unknown[]
  /** Each scripted reply as it was consumed, with the request it answered. */
  modelResponses: unknown[]
  /** The transport actions in the order the engine sent them. */
  transport: string[]
  /** Backoff delays the retry ladder decided, in ms (never waited out). */
  retryDelays: number[]
  /** Tool execution: `start` / `end` per call, with the calls in flight at
   *  each start — the concurrency grouping. */
  toolCalls: unknown[]
  /** Permission questions and the decisions given. */
  permissions: unknown[]
  /** Lifecycle hook invocations, with the payload each read on stdin. */
  hooks: unknown[]
  /** Every extension (mod) event the engine raised, with its payload. */
  mods: unknown[]
  /** Session writes: rows appended per `saveTranscriptRows`, terminal states,
   *  conversation resets, flushes. */
  sessionWrites: unknown[]
  /** Every message the engine yielded, in order. */
  emitted: unknown[]
  /** Host pushes (`session.setAgentLoopSettings`). */
  hostPushes: unknown[]
  /** How the run ended: the result message subtype or the loop terminal. */
  terminal: unknown
  /** Scenario-specific observations (e.g. a title saved, an epoch). */
  notes: unknown[]
}

export class TraceRecorder {
  readonly trace: Trace = {
    modelRequests: [],
    modelResponses: [],
    transport: [],
    retryDelays: [],
    toolCalls: [],
    permissions: [],
    hooks: [],
    mods: [],
    sessionWrites: [],
    emitted: [],
    hostPushes: [],
    terminal: null,
    notes: [],
  }

  note(value: unknown): void {
    this.trace.notes.push(toJson(value))
  }
}

/** A JSON-safe deep copy: functions and undefined drop, Maps / Sets become
 *  arrays, Errors become `{ name, message }`, cycles become `[cycle]`. */
export function toJson(value: unknown): unknown {
  const seen = new WeakSet<object>()
  const walk = (v: unknown): unknown => {
    if (v === null) return null
    if (typeof v === 'function' || typeof v === 'symbol') return undefined
    if (typeof v === 'bigint') return String(v)
    if (typeof v !== 'object') return v
    if (seen.has(v)) return '[cycle]'
    seen.add(v)
    try {
      if (v instanceof Error) return { name: v.name, message: v.message }
      if (v instanceof Map) return [...v.entries()].map(e => walk(e))
      if (v instanceof Set) return [...v].map(e => walk(e))
      if (v instanceof Uint8Array) return `[bytes:${v.length}]`
      if (Array.isArray(v)) return v.map(e => {
        const w = walk(e)
        return w === undefined ? null : w
      })
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v)) {
        const w = walk(val)
        if (w !== undefined) out[k] = w
      }
      return out
    } finally {
      seen.delete(v)
    }
  }
  return walk(value)
}

/** The parts of a message a trace keeps: identity, kind, role, visibility and
 *  content. Wall-clock measurements (durations) are left out — they are not
 *  behaviour. */
export function summarizeMessage(message: unknown): unknown {
  if (!message || typeof message !== 'object') return toJson(message)
  const m = message as Record<string, unknown>
  const inner = (m.message ?? undefined) as Record<string, unknown> | undefined
  const event = m.event as Record<string, unknown> | undefined
  const pick: Record<string, unknown> = {
    type: m.type,
    subtype: m.subtype,
    uuid: m.uuid,
    isMeta: m.isMeta,
    origin: m.origin,
    role: inner?.role,
    content: inner?.content ?? m.content,
    stop_reason: inner?.stop_reason,
    isApiErrorMessage: m.isApiErrorMessage,
    apiError: m.apiError,
    error: m.error,
    attachment: m.attachment,
    event: event ? { type: event.type, toolUseID: event.toolUseID, data: event.data } : undefined,
    toolUseResult: m.toolUseResult,
    sourceToolAssistantUUID: m.sourceToolAssistantUUID,
    result: m.result,
    is_error: m.is_error,
    terminal: m.terminal,
    slashCommand: m.slashCommand,
    pluginPrompt: m.pluginPrompt,
    level: m.level,
    compactMetadata: m.compactMetadata,
  }
  return toJson(pick)
}

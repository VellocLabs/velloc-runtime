import type { RuntimeConfig } from '../../runtime/interfaces/RuntimeConfig'

import type { QueryRuntimeDeps } from '../../runtime/interfaces/QueryRuntimeDeps'
import type {
  BrowserBridgeTransport,
} from '../../browser/bridge/browserBridgeProtocol'

export type ModelTransportOptions = {
  bridgeTransport?: BrowserBridgeTransport
  runtimeConfig?: RuntimeConfig
  queuedAttachmentProvider?: QueryRuntimeDeps['getQueuedAttachments']
  traceLogger?: (entry: TraceLoggerEntry) => void
}

export type TraceLoggerEntry = {
  level: 'info' | 'warn'
  message?: string
  data?: unknown
}

export type ModelUploadTraceEntry = {
  trace: 'NexusTrace'
  scope: 'ModelUpload'
  event: 'request'
  index: number
  timestamp: string
  sessionId?: string
  turnCaller: string
  providerId?: string
  model?: string
  /** Count of messages on the wire (post-serialization). */
  transcriptLength: number
  /**
   * Count of messages entering serialization. Compare with
   * `transcriptLength`: if they differ, `serializeMessagesForBridge`
   * dropped messages (typically because their `content` was neither
   * an array nor a string, or their role couldn't be resolved). When
   * the user reports "last 2 messages missing", this is the field to
   * check first.
   */
  inputMessageCount?: number
  toolCount: number
  payloadLength: number
  payload: unknown
}

type ModelResponseTraceEntry = {
  trace: 'NexusTrace'
  scope: 'ModelUpload'
  event: 'response'
  /** Index of the request entry this response belongs to. */
  requestIndex: number
  /** Sequential within a single request (handles multi-yield streams). */
  responseIndex: number
  timestamp: string
  sessionId?: string
  turnCaller: string
  providerId?: string
  model?: string
  message: unknown
}

type ModelTraceGlobal = typeof globalThis & {
  __nexusModelUploads?: ModelUploadTraceEntry[]
}

// Model-upload trace switch, off by default; set by `AgentRuntimeWorker.runInit` from the init payload's
// `traceModelRequests` (the worker's `location` is not the page URL).
let modelUploadTraceEnabled = false

export function setModelUploadTraceEnabled(value: boolean): void {
  modelUploadTraceEnabled = value
}

export function isModelUploadTraceEnabled(): boolean {
  return modelUploadTraceEnabled
}

export function shouldTraceModelRequests(): boolean {
  return modelUploadTraceEnabled
}

export function sanitizeModelTraceValue(
  value: unknown,
  path: WeakSet<object> = new WeakSet<object>(),
): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value
  }

  if (typeof value === 'bigint') {
    return value.toString()
  }

  if (typeof value === 'undefined') {
    return '[undefined]'
  }

  if (typeof value === 'function') {
    return `[Function ${value.name || 'anonymous'}]`
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    }
  }

  if (value instanceof ArrayBuffer) {
    return `[ArrayBuffer ${value.byteLength} bytes]`
  }

  if (ArrayBuffer.isView(value)) {
    return `[${value.constructor.name} ${value.byteLength} bytes]`
  }

  if (Array.isArray(value)) {
    return value.map(entry => sanitizeModelTraceValue(entry, path))
  }

  if (value instanceof Set) {
    return Array.from(value, entry => sanitizeModelTraceValue(entry, path))
  }

  if (value instanceof Map) {
    return Array.from(value.entries(), ([key, entry]) => [
      sanitizeModelTraceValue(key, path),
      sanitizeModelTraceValue(entry, path),
    ])
  }

  if (typeof value === 'object') {
    if (path.has(value)) {
      return '[Circular]'
    }
    path.add(value)

    if (Array.isArray(value)) {
      return value.map(entry => sanitizeModelTraceValue(entry, path))
    }

    try {
      const result: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(value)) {
        result[key] = sanitizeModelTraceValue(entry, path)
      }
      return result
    } finally {
      path.delete(value)
    }
  }

  return String(value)
}

// Retention cap for the devtools-inspectable `__nexusModelUploads` global.
// Each entry holds a full sanitized request payload (megabytes for large
// transcripts), so unbounded growth turns a long tracing session into a
// slow memory leak. 20 recent requests is plenty for the overlay's
// inspect-the-last-few-calls workflow. `index` stays monotonic across
// evictions (a counter, NOT `uploads.length`) because the response trace
// pairs to its request by index.
const MAX_MODEL_UPLOAD_TRACE_HISTORY = 20
let modelUploadTraceCounter = 0

function recordModelUploadTrace(entry: {
  sessionId?: string
  turnCaller: string
  providerId?: string
  model?: string
  payload: unknown
  payloadLength: number
  transcriptLength: number
  inputMessageCount?: number
  toolCount: number
}): ModelUploadTraceEntry {
  const traceGlobal = globalThis as ModelTraceGlobal
  const uploads = traceGlobal.__nexusModelUploads ?? []
  const traceEntry: ModelUploadTraceEntry = {
    trace: 'NexusTrace',
    scope: 'ModelUpload',
    event: 'request',
    index: modelUploadTraceCounter++,
    timestamp: new Date().toISOString(),
    sessionId: entry.sessionId,
    turnCaller: entry.turnCaller,
    providerId: entry.providerId,
    model: entry.model,
    transcriptLength: entry.transcriptLength,
    inputMessageCount: entry.inputMessageCount,
    toolCount: entry.toolCount,
    payloadLength: entry.payloadLength,
    payload: entry.payload,
  }
  uploads.push(traceEntry)
  if (uploads.length > MAX_MODEL_UPLOAD_TRACE_HISTORY) {
    const evicted = uploads.splice(
      0,
      uploads.length - MAX_MODEL_UPLOAD_TRACE_HISTORY,
    )
    // Drop the per-request response counters for evicted requests so the
    // map doesn't grow one entry per model call forever.
    for (const old of evicted) {
      responseIndexByRequest.delete(old.index)
    }
  }
  traceGlobal.__nexusModelUploads = uploads
  return traceEntry
}

export function logModelRequestTrace(
  payload: unknown,
  metadata: {
    sessionId?: string
    turnCaller: string
    providerId?: string
    model?: string
    toolCount: number
    transcriptLength: number
    inputMessageCount?: number
  },
  traceLogger?: ModelTransportOptions['traceLogger'],
): ModelUploadTraceEntry | null {
  // Gate up front: in nexus mode `traceLogger` is always set (used for
  // other diagnostic streams), so we can't rely on its presence to mean
  // "the user opted into model-upload tracing". `shouldTraceModelRequests`
  // is the single source of truth and is wired from the page-side flag.
  if (!shouldTraceModelRequests()) {
    return null
  }

  const emit = (level: 'info' | 'warn', data: unknown): void => {
    if (traceLogger) {
      traceLogger({ level, data })
      return
    }

    if (level === 'warn') {
      console.warn(data)
      return
    }

    console.info(data)
  }

  let sanitizedPayload: unknown
  let payloadLength: number
  try {
    sanitizedPayload = sanitizeModelTraceValue(payload)
    payloadLength = JSON.stringify(sanitizedPayload).length
  } catch (error) {
    sanitizedPayload = {
      error: sanitizeModelTraceValue(error),
    }
    payloadLength = JSON.stringify(sanitizedPayload).length
  }
  const traceEntry = recordModelUploadTrace({
    sessionId: metadata.sessionId,
    turnCaller: metadata.turnCaller,
    providerId: metadata.providerId,
    model: metadata.model,
    payload: sanitizedPayload,
    payloadLength,
    transcriptLength: metadata.transcriptLength,
    inputMessageCount: metadata.inputMessageCount,
    toolCount: metadata.toolCount,
  })
  emit('info', traceEntry)
  if (
    metadata.inputMessageCount !== undefined
    && metadata.inputMessageCount !== metadata.transcriptLength
  ) {
    // Bridge serialization dropped messages — the model is seeing fewer
    // messages than the transcript fed in. Surface it on its own channel
    // so the overlay's JSON tab can highlight, and DevTools shows a warn
    // even without the tab open.
    emit('warn', {
      trace: 'NexusTrace',
      scope: 'ModelUpload',
      event: 'serialization-dropped-messages',
      sessionId: metadata.sessionId,
      inputMessageCount: metadata.inputMessageCount,
      serializedMessageCount: metadata.transcriptLength,
      droppedCount: metadata.inputMessageCount - metadata.transcriptLength,
    })
  }
  return traceEntry
}

// Counter used to disambiguate multiple assistant yields within a
// single request (the streaming path can yield several times for one
// call when the provider produces multiple `message_start` chunks).
const responseIndexByRequest = new Map<number, number>()

/**
 * Emit a response trace entry for an assistant message that just came
 * back from the model. Paired with the request entry by
 * `requestIndex` so the UI's JSON tab can stitch them together —
 * solves the "last assistant text response missing from the log"
 * gap, because the previous design only logged what was SENT and the
 * final response of a turn never appeared in any subsequent request.
 */
export function logModelResponseTrace(
  message: unknown,
  metadata: {
    requestIndex: number
    sessionId?: string
    turnCaller: string
    providerId?: string
    model?: string
  },
  traceLogger?: ModelTransportOptions['traceLogger'],
): void {
  if (!shouldTraceModelRequests()) return

  let sanitized: unknown
  try {
    sanitized = sanitizeModelTraceValue(message)
  } catch (error) {
    sanitized = { error: sanitizeModelTraceValue(error) }
  }

  const next = (responseIndexByRequest.get(metadata.requestIndex) ?? 0) + 1
  responseIndexByRequest.set(metadata.requestIndex, next)

  const entry: ModelResponseTraceEntry = {
    trace: 'NexusTrace',
    scope: 'ModelUpload',
    event: 'response',
    sessionId: metadata.sessionId,
    requestIndex: metadata.requestIndex,
    responseIndex: next,
    timestamp: new Date().toISOString(),
    turnCaller: metadata.turnCaller,
    providerId: metadata.providerId,
    model: metadata.model,
    message: sanitized,
  }

  if (traceLogger) {
    traceLogger({ level: 'info', data: entry })
  } else {
    console.info(entry)
  }
}

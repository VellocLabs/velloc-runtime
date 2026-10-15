/**
 * UI-realm pub/sub for `ModelUploadTraceEntry` records the worker emits before
 * every `callModel` request. Late subscribers get the last `MAX` entries via
 * `getModelUploadHistory`.
 */

export type ModelUploadResponseEntry = {
  trace: 'NexusTrace'
  scope: 'ModelUpload'
  event: 'response'
  /** Session that issued the request this response belongs to. */
  sessionId?: string
  /** Index of the request entry this response belongs to. */
  requestIndex: number
  /** Sequential within a single request (handles multi-yield streams). */
  responseIndex: number
  timestamp: string
  querySource: string
  providerId?: string
  model?: string
  message: unknown
}

export type ModelUploadEntry = {
  trace: 'NexusTrace'
  scope: 'ModelUpload'
  event: 'request' | string
  index: number
  timestamp: string
  /** Session whose callModel invocation produced this upload. */
  sessionId?: string
  querySource: string
  providerId?: string
  model?: string
  /** Count of messages on the wire (post-serialization). */
  messageCount: number
  /**
   * Count of messages going INTO serialization (post-compact-boundary
   * slice, post-microcompact). Compare with `messageCount` to detect
   * messages dropped by `serializeMessagesForBridge` — when the two
   * differ, the request lost messages somewhere in the normalization
   * pipeline. Optional because older trace entries (pre-diagnostic)
   * don't carry it.
   */
  inputMessageCount?: number
  toolCount: number
  payloadLength: number
  payload: unknown
  /**
   * Assistant messages yielded by the model in response to this
   * request. Empty (or absent) until the first response arrives.
   * Mutated in place when a `ModelUploadResponseEntry` lands on the
   * bus — so subscribers re-render with the latest pairing. This
   * closes the "last assistant text response missing from the log"
   * gap that the request-only view had.
   */
  responses?: ModelUploadResponseEntry[]
}

type AnyModelTraceEntry = ModelUploadEntry | ModelUploadResponseEntry

function isResponseEntry(
  entry: AnyModelTraceEntry,
): entry is ModelUploadResponseEntry {
  return entry.event === 'response'
}

const MAX_HISTORY = 64
const history: ModelUploadEntry[] = []
const listeners = new Set<(entry: ModelUploadEntry) => void>()

// Off by default: every entry point short-circuits until `nexusBoot` enables it.
let enabled = false

export function setModelUploadBusEnabled(value: boolean): void {
  enabled = value
  if (!value) {
    history.length = 0
    listeners.clear()
  }
}

export function isModelUploadBusEnabled(): boolean {
  return enabled
}

export function isModelUploadEntry(value: unknown): value is AnyModelTraceEntry {
  if (!enabled) return false
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return v.trace === 'NexusTrace' && v.scope === 'ModelUpload'
}

export function publishModelUpload(entry: AnyModelTraceEntry): void {
  if (!enabled) return
  if (isResponseEntry(entry)) {
    // Attach the response to its request entry. If the matching
    // request hasn't been seen yet (out-of-order on the wire) or
    // was evicted from the ring, drop the response — there's no
    // useful place to display it.
    const request = history.find(e => e.index === entry.requestIndex)
    if (!request) return
    if (!request.responses) request.responses = []
    request.responses.push(entry)
    // Notify listeners that the request entry changed shape, so the
    // overlay re-renders its JSON tree with the newly arrived
    // response message included.
    for (const listener of listeners) {
      try {
        listener(request)
      } catch {
        // Subscriber errors must not poison the bus.
      }
    }
    return
  }
  history.push(entry)
  if (history.length > MAX_HISTORY) history.shift()
  for (const listener of listeners) {
    try {
      listener(entry)
    } catch {
      // Subscriber errors must not poison the bus.
    }
  }
}

export function getModelUploadHistory(): ModelUploadEntry[] {
  if (!enabled) return []
  return history.slice()
}

export function subscribeModelUpload(
  listener: (entry: ModelUploadEntry) => void,
): () => void {
  if (!enabled) {
    return () => {}
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function clearModelUploadHistory(): void {
  history.length = 0
}

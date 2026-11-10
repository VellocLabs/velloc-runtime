import type { AgentWorkerOutboundMessage } from '../worker/workerProtocol'

// Optional handler installed by `nexusBoot` when the model-upload
// trace gate is on. Kept as a runtime reference (no static import of
// `modelUploadBus`) so production bundles with the switch off omit
// the bus module entirely — `setModelUploadHandler` is the sole
// load-bearing surface, and `nexusBoot` only calls it from inside a
// dynamic `import('../../utils/modelUploadBus')` behind the same gate.
type ModelUploadHandler = (entry: unknown) => void
let modelUploadHandler: ModelUploadHandler | null = null

export function setModelUploadHandler(
  handler: ModelUploadHandler | null,
): void {
  modelUploadHandler = handler
}

/** A worker's `worker.debugLog` payload. */
export type WorkerDebugLogPayload = Extract<
  AgentWorkerOutboundMessage,
  { type: 'worker.debugLog' }
>['payload']

/** Route one worker debug-log entry to the console and, when installed, the
 *  model-upload handler. */
export function routeWorkerDebugLog(payload: WorkerDebugLogPayload): void {
  const { level, data } = payload
  // ModelUpload info entries go EXCLUSIVELY to the upload bus when its handler is installed;
  // warn-level entries always reach the console.
  const isModelUploadTraceEntry =
    data !== null
    && typeof data === 'object'
    && (data as { trace?: unknown }).trace === 'NexusTrace'
    && (data as { scope?: unknown }).scope === 'ModelUpload'
  const traceUiOnly =
    level !== 'warn'
    && isModelUploadTraceEntry
    && modelUploadHandler !== null
  if (!traceUiOnly) {
    if (level === 'warn') {
      if (data !== undefined) {
        console.warn(data)
      } else {
        console.warn(payload.message)
      }
    } else {
      if (data !== undefined) {
        console.info(data)
      } else {
        console.info(payload.message)
      }
    }
  }
  if (modelUploadHandler && data !== undefined) {
    // The handler is responsible for checking the entry shape;
    // when it's not installed, no work is done here at all and
    // the `modelUploadBus` module is never imported.
    modelUploadHandler(data)
  }
}

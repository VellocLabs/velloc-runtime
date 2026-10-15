/**
 * Diagnostic logger for the `callModel` streaming path: `[NexusCallModelTrace] <event> { …fields }`.
 * Enabled only by `globalThis.__NEXUS_LOG_CALL_MODEL__`; routed through the worker's `traceLogger`
 * (no-op when none is wired). Events: call-start, stream-start, stream-read, msg-start,
 * assistant-yield, fallback, fallback-yield. Counters are module-scoped; reset on worker init.
 */

declare global {
  // eslint-disable-next-line no-var
  var __NEXUS_LOG_CALL_MODEL__: boolean | undefined
}

let callCounter = 0
let assistantYieldCounter = 0
let submitCounter = 0
let loopIterCounter = 0

export type CallModelTraceEmitter = (
  event: string,
  data: Record<string, unknown>,
) => void

let emitter: CallModelTraceEmitter | undefined

export function isCallModelLogEnabled(): boolean {
  if (typeof globalThis === 'undefined') return false
  return globalThis.__NEXUS_LOG_CALL_MODEL__ === true
}

/**
 * Install (or reinstall) the emitter. The worker calls this once at
 * init time with a function that wraps `worker.debugLog` so events
 * flow to the webview's DevTools console. Tests can pass a custom
 * emitter to capture events directly.
 */
export function setCallModelEmitter(
  next: CallModelTraceEmitter | undefined,
): void {
  emitter = next
}

/** The currently-installed emitter — lets an installer tear down ONLY its
 *  own installation (last-writer-wins realm global): a scope
 *  disposing after a newer session re-installed must not clobber the newer
 *  session's emitter. */
export function getCallModelEmitter(): CallModelTraceEmitter | undefined {
  return emitter
}

export function setCallModelLogEnabled(value: boolean): void {
  globalThis.__NEXUS_LOG_CALL_MODEL__ = value
  if (value) {
    logCallModelEvent('enabled', { callCounter: 0, assistantYieldCounter: 0 })
  }
  callCounter = 0
  assistantYieldCounter = 0
  submitCounter = 0
  loopIterCounter = 0
}

export function nextCallId(): number {
  return ++callCounter
}

export function nextAssistantYieldId(): number {
  return ++assistantYieldCounter
}

export function nextSubmitId(): number {
  return ++submitCounter
}

export function nextLoopIterId(): number {
  return ++loopIterCounter
}

export function logCallModelEvent(
  event: string,
  data: Record<string, unknown>,
): void {
  if (!isCallModelLogEnabled()) return
  if (emitter) {
    emitter(event, data)
    return
  }
  // No emitter wired (unit tests, headless runs without a worker
  // bridge). Fall through silently — production won't accidentally
  // spam stderr if the flag is set without an emitter.
}

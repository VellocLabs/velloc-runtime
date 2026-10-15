/**
 * Contract: `traceLine(message, {level})` records `[tag]`-prefixed lines into
 * the `workerLogBuffer` ring for the `/debug` skill. Nothing is captured while
 * no capture source is on; `warn` / `error` land whenever any source is on;
 * `verbose` / `debug` / `info` also require `startTraceCapture()`. The switch
 * is per realm and never persisted.
 */

import {
  getWorkerLogBuffer,
  setWorkerLogCaptureSource,
} from './workerLogBuffer'

export type TraceLevel = 'verbose' | 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<TraceLevel, number> = {
  verbose: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
}

/** Default min level 'debug' filters out 'verbose' messages. */
const MIN_DEBUG_LOG_LEVEL: TraceLevel = 'debug'

let traceCaptureOn = false

/** Whether the sub-warn capture switch is currently on. */
export function isTraceCapturing(): boolean {
  return traceCaptureOn
}

/**
 * Enable capturing `verbose`/`debug`/`info` instrumentation into the worker
 * log ring. Returns whether logging was ALREADY active (`wasActive`), so
 * the `/debug` skill can tell the user nothing prior to this invocation was
 * captured.
 */
export function startTraceCapture(): boolean {
  const wasActive = traceCaptureOn
  traceCaptureOn = true
  // Open the ring's 'debug' capture source so entries actually land —
  // without a source the ring's master gate drops everything.
  setWorkerLogCaptureSource('debug', true)
  return wasActive
}

/**
 * Turn the sub-warn capture back off (`/debug log off`). The ring is shared
 * with warn/error capture, so heavy debug traffic
 * aging real errors out of the 500-entry window is worth being able to
 * stop.
 */
export function disableDebugLogging(): void {
  traceCaptureOn = false
  // Release this module's hold on the ring. If the tracer gate is also
  // off, the ring clears — nothing stays resident after opting out.
  setWorkerLogCaptureSource('debug', false)
}

/**
 * Record a diagnostic message into the worker log ring. `warn`/`error`
 * land whenever any capture source is on; lower levels additionally
 * require the runtime switch (see module doc). With every source off the
 * ring's master gate drops the push entirely — zero collection.
 * No console passthrough — callers that also want dev-console visibility
 * should `console.warn` instead (the ring's console patch captures it).
 */
export function traceLine(
  message: string,
  { level }: { level: TraceLevel } = { level: 'debug' },
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_DEBUG_LOG_LEVEL]) {
    return
  }
  if (
    LEVEL_ORDER[level] < LEVEL_ORDER.warn
    && !traceCaptureOn
  ) {
    return
  }
  try {
    getWorkerLogBuffer().push(level, message.trim())
  } catch {
    // Diagnostics must never break the instrumented code path.
  }
}

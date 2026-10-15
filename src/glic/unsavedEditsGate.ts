/**
 * The page's unsaved-edits gate for the background updater: surfaces with
 * page-local state register a hold, and the updater does not reload while
 * `window.__nexusUnsavedEdits` (the hold count) is non-zero. Page memory only.
 */

import { useEffect } from 'react'

type GateTarget = { __nexusUnsavedEdits?: number }

const defaultTarget = (): GateTarget => globalThis as GateTarget

/**
 * Hold the gate until the returned release is called. Release is idempotent,
 * so a cleanup that runs twice cannot release someone else's hold.
 */
export function registerUnsavedEdits(
  target: GateTarget = defaultTarget(),
): () => void {
  target.__nexusUnsavedEdits = (target.__nexusUnsavedEdits ?? 0) + 1
  let released = false
  return () => {
    if (released) return
    released = true
    target.__nexusUnsavedEdits = Math.max(
      0,
      (target.__nexusUnsavedEdits ?? 1) - 1,
    )
  }
}

/** True while any surface holds the gate. */
export function hasUnsavedEdits(target: GateTarget = defaultTarget()): boolean {
  return (target.__nexusUnsavedEdits ?? 0) > 0
}

/** Hold the gate for as long as `active` is true and the caller is mounted. */
export function useUnsavedEditsGate(active: boolean): void {
  useEffect(() => {
    if (!active) return
    return registerUnsavedEdits()
  }, [active])
}

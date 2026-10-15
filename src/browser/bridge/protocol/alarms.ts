/**
 * The `alarms` capability — named wall-clock alarms kept in profile prefs; an
 * older host answers NOT_IMPLEMENTED. A fire is an `alarms.onAlarm` event; with
 * no runtime connected it is queued, so call `list()` once at boot for `fired`.
 * A missed periodic alarm fires ONCE. Times are Date.now() milliseconds (P-3).
 */

export type BridgeAlarm = {
  name: string
  /** Next fire, ms since the epoch. */
  whenMs: number
  /** Absent for a one-shot alarm. */
  periodMs?: number
}

/** One fire — `scheduledMs` is when it was due, not when it ran. */
export type BridgeAlarmFire = { name: string; scheduledMs: number }

export type AlarmsBridgeActionMap = {
  /** Create or replace. `whenMs` absent with a `periodMs` = one period from
   *  now. periodMs >= 30000; name 1-64 chars; at most 256 alarms. */
  create: {
    payload: { name: string; whenMs?: number; periodMs?: number }
    result: { ok: true }
  }
  clear: {
    payload: { name: string }
    result: { cleared: boolean }
  }
  /** The alarms, and the fires queued while no runtime was connected
   *  (drained by this call). */
  list: {
    payload: Record<string, never>
    result: { alarms: BridgeAlarm[]; fired: BridgeAlarmFire[] }
  }
  /** Host-pushed EVENT (never requested). */
  onAlarm: {
    payload: BridgeAlarmFire
    result: never
  }
}

/**
 * Routine ids `rt_<base36-timestamp>_<random>`: time-prefixed so lexical order
 * is creation order. Not cryptographically unique.
 */
export function newRoutineId(): string {
  const ts = Date.now().toString(36)
  // 8 chars of random base36 — ~41 bits of entropy. Combined with the
  // ms-resolution timestamp, two routines registered in the same
  // millisecond would still need to collide on both halves.
  const rand = Math.random().toString(36).slice(2, 10).padStart(8, '0')
  return `rt_${ts}_${rand}`
}

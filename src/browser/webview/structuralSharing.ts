/**
 * Structural sharing between two conversions of the same transcript: `shareStructure(previous, next)`
 * returns `previous` wherever `next` equals it, at any depth, so assistant-ui's identity-keyed caches hold.
 * Arrays and plain objects compare by content, Dates by time, everything else by identity.
 */
export function shareStructure<T>(previous: unknown, next: T): T {
  return share(previous, next) as T
}

/**
 * `shareStructure` over a list of rows matched by `id` rather than position, so
 * a row inserted or removed above (a compaction divider, a dropped error card)
 * does not defeat sharing for every row below it. Returns `previous` itself
 * when nothing changed.
 */
export function shareRowsById<T extends { readonly id?: string }>(
  previous: readonly T[] | null,
  next: readonly T[],
): readonly T[] {
  if (!previous || previous.length === 0) return next
  const byId = new Map<string, T>()
  for (const row of previous) if (row.id !== undefined) byId.set(row.id, row)
  let same = previous.length === next.length
  const out = next.map((row, index) => {
    const match = row.id !== undefined ? byId.get(row.id) : undefined
    const shared = match === undefined ? row : (share(match, row) as T)
    if (shared !== previous[index]) same = false
    return shared
  })
  return same ? previous : out
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function share(previous: unknown, next: unknown): unknown {
  if (previous === next) return next
  if (Array.isArray(next)) {
    if (!Array.isArray(previous)) return next
    let same = previous.length === next.length
    const out = new Array<unknown>(next.length)
    for (let i = 0; i < next.length; i++) {
      const item = share(i < previous.length ? previous[i] : undefined, next[i])
      out[i] = item
      if (item !== previous[i]) same = false
    }
    return same ? previous : out
  }
  if (isPlainObject(next)) {
    if (!isPlainObject(previous)) return next
    const keys = Object.keys(next)
    let same = keys.length === Object.keys(previous).length
    const out: Record<string, unknown> = {}
    for (const key of keys) {
      const had = Object.prototype.hasOwnProperty.call(previous, key)
      const value = share(had ? previous[key] : undefined, next[key])
      if (key === '__proto__') {
        Object.defineProperty(out, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        })
      } else {
        out[key] = value
      }
      if (!had || value !== previous[key]) same = false
    }
    return same ? previous : out
  }
  if (next instanceof Date) {
    return previous instanceof Date && previous.getTime() === next.getTime()
      ? previous
      : next
  }
  return next
}

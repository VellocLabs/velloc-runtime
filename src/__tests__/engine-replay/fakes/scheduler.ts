/**
 * Deterministic scheduler for the interleaving tests (F-26): enumerates every order in which a small set of
 * concurrently-completable items (tool progress, a background settle, a
 * cancellation, a timer, queued input) can arrive, optionally constrained by
 * "a must come before b" pairs. The fake interpreter then replays one order
 * per run, so every interleaving is a separate, reproducible trace.
 */

export type ArrivalKind = 'fragment' | 'backgroundSettle' | 'cancel' | 'timer' | 'queuedInput'

/** One thing that can complete concurrently with the serial effect chain. */
export type Arrival<P = unknown> = {
  /** Unique within a scenario; used for constraints and trace labels. */
  readonly label: string
  readonly kind: ArrivalKind
  readonly payload?: P
}

/** `[before, after]`: `before` must arrive earlier than `after`. */
export type OrderConstraint = readonly [string, string]

/**
 * Every permutation of `items` that respects `constraints`, in a stable order
 * (lexicographic by input position). 3 unconstrained items → 6 orders.
 * Small scenarios only: n! grows fast, so more than 8 items is refused.
 */
export function enumerateInterleavings<T extends { readonly label: string }>(
  items: readonly T[],
  constraints: readonly OrderConstraint[] = [],
): T[][] {
  if (items.length > 8) throw new Error(`enumerateInterleavings: ${items.length} items is too many (max 8)`)
  const labels = new Set(items.map((i) => i.label))
  if (labels.size !== items.length) throw new Error('enumerateInterleavings: labels must be unique')
  for (const [a, b] of constraints) {
    if (!labels.has(a) || !labels.has(b)) throw new Error(`enumerateInterleavings: unknown label in [${a}, ${b}]`)
  }
  const out: T[][] = []
  const used = new Array<boolean>(items.length).fill(false)
  const current: T[] = []
  const placed = new Set<string>()
  const ready = (item: T): boolean =>
    constraints.every(([before, after]) => after !== item.label || placed.has(before))
  const walk = (): void => {
    if (current.length === items.length) {
      out.push([...current])
      return
    }
    for (let i = 0; i < items.length; i += 1) {
      if (used[i] || !ready(items[i])) continue
      used[i] = true
      current.push(items[i])
      placed.add(items[i].label)
      walk()
      placed.delete(items[i].label)
      current.pop()
      used[i] = false
    }
  }
  walk()
  return out
}

/** Runs `run` once per interleaving and returns each result with its order. */
export function forEachInterleaving<T extends { readonly label: string }, R>(
  items: readonly T[],
  run: (order: readonly T[]) => R,
  constraints: readonly OrderConstraint[] = [],
): Array<{ order: string[]; result: R }> {
  return enumerateInterleavings(items, constraints).map((order) => ({
    order: order.map((i) => i.label),
    result: run(order),
  }))
}

import { createContext } from 'react'
import type { ThreadMessageLike } from '@assistant-ui/react'

import { INITIAL_ACTIVE_TAIL, MESSAGE_TAIL_KEEP } from './messageVirtualization'

/**
 * Which conversation rows hand their content to assistant-ui. Rows the virtualizer does not keep go as
 * stubs (same id, role and metadata, empty content). A kept row renders only once assistant-ui holds its
 * content; the last `MESSAGE_TAIL_KEEP` rows always carry content.
 */

export type HistoryContentWindow = {
  /** Rows the virtualizer last asked for; null until it first reports. */
  readonly wanted: ReadonlySet<number> | null
  /** Called by the virtualizer with the rows it keeps, ascending. */
  publish(rows: readonly number[]): void
}

/** Absent outside a thread that windows its content — every row is real. */
export const HistoryContentWindowContext =
  createContext<HistoryContentWindow | null>(null)

/** Whether row `index` of `count` carries its content. */
export function isRowMaterialized(
  index: number,
  count: number,
  wanted: ReadonlySet<number> | null,
): boolean {
  if (index >= count - MESSAGE_TAIL_KEEP) return true
  // Before the first report the virtualizer renders exactly this tail.
  if (wanted === null) return index >= count - INITIAL_ACTIVE_TAIL
  return wanted.has(index)
}

/**
 * Rows materialized ahead of a newly wanted run, in the direction it grows. Each materialization costs
 * one O(history) sync, so chunks make them rarer (F-22).
 */
export const HISTORY_MATERIALIZE_CHUNK = 50

/**
 * The rows to materialize after the virtualizer publishes `rows`: the current set, `rows`, and a chunk
 * ahead of each newly wanted run (none on the first publish or past the highest published row). Returns
 * `current` when nothing is added. One-way: re-stubbing a row leaks part-client heap.
 */
export function mergeWantedRows(
  current: ReadonlySet<number> | null,
  rows: readonly number[],
  chunk = HISTORY_MATERIALIZE_CHUNK,
): ReadonlySet<number> {
  if (current !== null && rows.every(row => current.has(row))) return current
  const next = new Set(current ?? [])
  for (const row of rows) next.add(row)
  if (current === null || chunk <= 0) return next

  let last = -1
  for (const row of rows) if (row > last) last = row
  const fresh = rows.filter(row => !current.has(row)).sort((a, b) => a - b)
  const add = (from: number, to: number): void => {
    for (let row = Math.max(0, from); row <= Math.min(last, to); row++) next.add(row)
  }
  // Each contiguous run of fresh rows, extended by where it touches `current`.
  for (let start = 0; start < fresh.length; ) {
    let end = start
    while (end + 1 < fresh.length && fresh[end + 1] === fresh[end]! + 1) end++
    const low = fresh[start]!
    const high = fresh[end]!
    const heldAbove = current.has(high + 1)
    const heldBelow = current.has(low - 1)
    if (heldAbove && !heldBelow) add(low - chunk, low - 1)
    else if (heldBelow && !heldAbove) add(high + 1, high + chunk)
    else if (!heldAbove && !heldBelow) {
      const half = Math.ceil(chunk / 2)
      add(low - half, high + half)
    }
    start = end + 1
  }
  return next
}

/** `metadata.custom` key marking a stub; see `stubRowsKey`. */
export const CONTENT_STUB_KEY = 'contentWindowStub'

// One stub per message object, so a culled row hands assistant-ui the same
// object on every render and its (contentless) client is reused, not rebuilt.
const stubs = new WeakMap<ThreadMessageLike, ThreadMessageLike>()

function stubOf(message: ThreadMessageLike): ThreadMessageLike {
  let stub = stubs.get(message)
  if (!stub) {
    const metadata = message.metadata
    stub = {
      ...message,
      content: [],
      metadata: {
        ...metadata,
        custom: { ...metadata?.custom, [CONTENT_STUB_KEY]: true },
      },
    }
    stubs.set(message, stub)
  }
  return stub
}

/**
 * `messages` with every row that is not materialized replaced by its stub
 * (system rows excepted — see the loop).
 * Returns `messages` itself when nothing is stubbed.
 */
export function windowMessageContent(
  messages: readonly ThreadMessageLike[],
  wanted: ReadonlySet<number> | null,
): readonly ThreadMessageLike[] {
  const count = messages.length
  let out: ThreadMessageLike[] | null = null
  for (let index = 0; index < count; index++) {
    if (isRowMaterialized(index, count, wanted)) continue
    // assistant-ui rejects a system message without exactly one text part
    // (and the whole thread with it). One text part is all a system row has
    // anyway — nothing to save by stubbing it.
    if (messages[index]!.role === 'system') continue
    out ??= messages.slice()
    out[index] = stubOf(messages[index]!)
  }
  return out ?? messages
}

/**
 * The stubbed row indices among assistant-ui's own messages, as a stable
 * string (`"3,4,9"`, `""` for none) — cheap to select per store update and
 * equal across updates that don't move it.
 */
export function stubRowsKey(
  messages: readonly { readonly metadata?: { readonly custom?: unknown } }[],
): string {
  let key = ''
  for (let index = 0; index < messages.length; index++) {
    const custom = messages[index]?.metadata?.custom as
      | Record<string, unknown>
      | undefined
    if (custom?.[CONTENT_STUB_KEY] === true) key += key ? `,${index}` : `${index}`
  }
  return key
}

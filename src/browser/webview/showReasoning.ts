import { useSyncExternalStore } from 'react'
import type { ThreadMessageLike } from '@assistant-ui/react'

/**
 * Show reasoning: whether the conversation renders reasoning parts (Settings · Appearance, on by default).
 * A pure view preference in the guest's localStorage: the model is sent and billed the same. Anything
 * but "0" (or a throwing storage) reads as shown.
 */

export const SHOW_REASONING_STORAGE_KEY = 'velloc.appearance.showReasoning'

export const DEFAULT_SHOW_REASONING = true

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

const listeners = new Set<() => void>()

export function readShowReasoning(storage: StorageLike | null = defaultStorage()): boolean {
  try {
    const raw = storage?.getItem(SHOW_REASONING_STORAGE_KEY)
    if (raw === '0') return false
    if (raw === '1') return true
    return DEFAULT_SHOW_REASONING
  } catch {
    return DEFAULT_SHOW_REASONING
  }
}

/** Persist the choice and notify subscribers in this window. */
export function writeShowReasoning(
  show: boolean,
  storage: StorageLike | null = defaultStorage(),
): void {
  let stored = false
  try {
    if (storage) {
      storage.setItem(SHOW_REASONING_STORAGE_KEY, show ? '1' : '0')
      stored = true
    }
  } catch {
    // Handled below with the absent-storage case.
  }
  // Storage unavailable (absent, blocked, or the write threw): the choice
  // still applies for this page's lifetime.
  memoryFallback = stored ? undefined : show
  for (const listener of listeners) listener()
}

// When storage is unavailable or throws on write, the last choice is still
// honoured in this realm instead of snapping back to the stored value.
let memoryFallback: boolean | undefined

function snapshot(): boolean {
  return memoryFallback ?? readShowReasoning()
}

/**
 * Subscribe to changes from this window's writes AND from other windows of
 * this origin (which arrive only as `storage` events — the listener set is
 * per realm). Returns a disposer.
 */
export function subscribeShowReasoning(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== SHOW_REASONING_STORAGE_KEY) return
    memoryFallback = undefined
    listener()
  }
  const target = typeof window === 'undefined' ? null : window
  target?.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    target?.removeEventListener('storage', onStorage)
  }
}

/** The live preference, re-rendering on every change. */
export function useShowReasoning(): boolean {
  return useSyncExternalStore(subscribeShowReasoning, snapshot, () => DEFAULT_SHOW_REASONING)
}

/**
 * The thread messages with every `reasoning` part removed from assistant content; messages without
 * reasoning are returned by identity. Filtered before assistant-ui so every pass indexes the same parts;
 * `partLines` is filtered in step, or dropped when it does not line up with the content.
 */
export function withoutReasoningParts(
  messages: readonly ThreadMessageLike[],
): ThreadMessageLike[] {
  return messages.map(stripMessageCached)
}

// The thread's rows are structurally shared across renders (an unchanged row
// keeps its identity), so caching by the source row keeps a stripped copy
// stable too — a token streaming into the live row does not re-render every
// settled row that happened to carry reasoning.
const stripped = new WeakMap<ThreadMessageLike, ThreadMessageLike>()

function stripMessageCached(message: ThreadMessageLike): ThreadMessageLike {
  const hit = stripped.get(message)
  if (hit) return hit
  const next = stripMessage(message)
  stripped.set(message, next)
  return next
}

function stripMessage(message: ThreadMessageLike): ThreadMessageLike {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return message
  const content = message.content as ReadonlyArray<{ type?: unknown }>
  if (!content.some(isReasoningPart)) return message
  const kept: number[] = []
  for (let i = 0; i < content.length; i++) {
    if (!isReasoningPart(content[i])) kept.push(i)
  }
  const next = {
    ...message,
    content: kept.map((i) => content[i]),
  } as unknown as ThreadMessageLike
  const custom = (message.metadata as { custom?: Record<string, unknown> } | undefined)?.custom
  const partLines = custom?.partLines
  const reasoningOnly = kept.length === 0
  if (typeof partLines === 'string' || reasoningOnly) {
    const nextCustom: Record<string, unknown> = { ...custom }
    if (typeof partLines === 'string') {
      const lines = partLines.split(' ')
      if (lines.length === content.length) {
        nextCustom.partLines = kept.map((i) => lines[i]).join(' ')
      } else {
        delete nextCustom.partLines
      }
    }
    if (reasoningOnly) nextCustom[REASONING_ONLY_ROW_KEY] = true
    ;(next as { metadata?: unknown }).metadata = {
      ...message.metadata,
      custom: nextCustom,
    }
  }
  return next
}

/**
 * Set in `metadata.custom` on a row that held nothing but reasoning, now
 * stripped to zero parts. The row stays in the list — the search jump and the
 * virtualized list index rows one-for-one with the unfiltered messages — and
 * the thread collapses it at render time instead of drawing a blank bubble.
 * A live row still only thinking collapses too; the composer's running
 * indicator is what shows the turn is under way.
 */
export const REASONING_ONLY_ROW_KEY = 'reasoningOnlyHidden'

function isReasoningPart(part: { type?: unknown } | undefined): boolean {
  return part?.type === 'reasoning'
}

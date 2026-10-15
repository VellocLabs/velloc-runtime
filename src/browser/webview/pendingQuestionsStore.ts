import { createContext, useContext, useEffect } from 'react'
import { useSyncExternalStore } from 'react'

/**
 * How many AskUserQuestion cards are awaiting an answer; the composer disables input while any is.
 * Cards register while unanswered and deregister on answer or unmount. Per-thread via
 * `PendingQuestionsContext` (hidden threads stay mounted); the module-global is only the unscoped fallback.
 */
export interface PendingQuestionsStore {
  increment(): void
  decrement(): void
  getSnapshot(): number
  subscribe(listener: () => void): () => void
}

/** Create an isolated pending-questions counter (one per mounted Thread). */
export function createPendingQuestionsStore(): PendingQuestionsStore {
  let pendingCount = 0
  const listeners = new Set<() => void>()
  const emit = (): void => {
    for (const listener of listeners) listener()
  }
  return {
    increment(): void {
      pendingCount += 1
      emit()
    },
    decrement(): void {
      pendingCount = Math.max(0, pendingCount - 1)
      emit()
    },
    getSnapshot(): number {
      return pendingCount
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

let globalPendingCount = 0
const globalListeners = new Set<() => void>()

function emitGlobal(): void {
  for (const listener of globalListeners) listener()
}

/**
 * Module-global fallback store. Used as the `PendingQuestionsContext` default,
 * so a surface that renders an AskUserQuestion card / composer WITHOUT a
 * per-thread provider still works (it just isn't session-isolated). Production
 * always wraps each Thread in a provider (see thread.tsx), so this is reached
 * only by tests and standalone previews.
 */
export const pendingQuestionsStore = {
  increment(): void {
    globalPendingCount += 1
    emitGlobal()
  },
  decrement(): void {
    globalPendingCount = Math.max(0, globalPendingCount - 1)
    emitGlobal()
  },
  getSnapshot(): number {
    return globalPendingCount
  },
  subscribe(listener: () => void): () => void {
    globalListeners.add(listener)
    return () => {
      globalListeners.delete(listener)
    }
  },
  /** Test-only: reset module state between cases. */
  __resetForTests(): void {
    globalPendingCount = 0
    globalListeners.clear()
  },
}

/**
 * The store consumed by `usePendingQuestionCount` / `usePendingQuestionRegistration`.
 * Each mounted `Thread` overrides this with a fresh `createPendingQuestionsStore()`
 * so pending questions are counted PER session. Defaults to the module-global.
 */
export const PendingQuestionsContext =
  createContext<PendingQuestionsStore>(pendingQuestionsStore)

/** Number of AskUserQuestion cards currently awaiting an answer in THIS thread. */
export function usePendingQuestionCount(): number {
  const store = useContext(PendingQuestionsContext)
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => 0)
}

/**
 * Register the calling component as awaiting an answer while `pending` is true,
 * into the nearest `PendingQuestionsContext` (its own thread's store). Increments
 * on mount/`pending→true`, decrements on `pending→false`/unmount, so answering a
 * question (the card flips to its answered branch — no unmount) or leaving the
 * session both release the composer. StrictMode's double-invoke is balanced
 * (inc → cleanup dec → inc).
 */
export function usePendingQuestionRegistration(pending: boolean): void {
  const store = useContext(PendingQuestionsContext)
  useEffect(() => {
    if (!pending) return
    store.increment()
    return () => {
      store.decrement()
    }
  }, [pending, store])
}

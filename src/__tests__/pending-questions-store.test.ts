// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { createContext, createElement, useContext, type ReactNode } from 'react'

import {
  PendingQuestionsContext,
  type PendingQuestionsStore,
  createPendingQuestionsStore,
  pendingQuestionsStore,
  usePendingQuestionCount,
  usePendingQuestionRegistration,
} from '../browser/webview/pendingQuestionsStore'

/** renderHook wrapper that scopes hooks to a specific per-session store. */
const wrapperFor =
  (store: PendingQuestionsStore) =>
  ({ children }: { children: ReactNode }) =>
    createElement(PendingQuestionsContext.Provider, { value: store }, children)

/**
 * The composer subscribes to this store to disable input while the agent is
 * blocked on an AskUserQuestion answer. The AskUserQuestion card registers
 * while unanswered and deregisters when answered (render flips, no unmount) or
 * when its session is left (unmount).
 */
describe('pendingQuestionsStore', () => {
  beforeEach(() => pendingQuestionsStore.__resetForTests())

  it('counts up and down', () => {
    pendingQuestionsStore.increment()
    pendingQuestionsStore.increment()
    expect(pendingQuestionsStore.getSnapshot()).toBe(2)
    pendingQuestionsStore.decrement()
    expect(pendingQuestionsStore.getSnapshot()).toBe(1)
  })

  it('never goes negative', () => {
    pendingQuestionsStore.decrement()
    expect(pendingQuestionsStore.getSnapshot()).toBe(0)
  })

  it('notifies subscribers on change and stops after unsubscribe', () => {
    let calls = 0
    const unsub = pendingQuestionsStore.subscribe(() => {
      calls += 1
    })
    pendingQuestionsStore.increment()
    pendingQuestionsStore.decrement()
    expect(calls).toBe(2)
    unsub()
    pendingQuestionsStore.increment()
    expect(calls).toBe(2)
  })
})

describe('usePendingQuestionRegistration', () => {
  beforeEach(() => pendingQuestionsStore.__resetForTests())

  it('increments while pending and decrements on unmount', () => {
    const { unmount } = renderHook(() => usePendingQuestionRegistration(true))
    expect(pendingQuestionsStore.getSnapshot()).toBe(1)
    unmount()
    expect(pendingQuestionsStore.getSnapshot()).toBe(0)
  })

  it('does not register when not pending', () => {
    renderHook(() => usePendingQuestionRegistration(false))
    expect(pendingQuestionsStore.getSnapshot()).toBe(0)
  })

  it('deregisters when pending flips to false (question answered)', () => {
    const { rerender } = renderHook(
      ({ pending }) => usePendingQuestionRegistration(pending),
      { initialProps: { pending: true } },
    )
    expect(pendingQuestionsStore.getSnapshot()).toBe(1)
    rerender({ pending: false })
    expect(pendingQuestionsStore.getSnapshot()).toBe(0)
  })
})

/**
 * Regression — the composer of a freshly-created code project came up DISABLED.
 * MultiSessionShell keeps the last few sessions mounted at once (inactive ones
 * hidden with `display:none`, NOT unmounted). With a module-global counter, an
 * unanswered AskUserQuestion in a BACKGROUND session raised the count the ACTIVE
 * session's composer reads, disabling it. Each Thread now provides its own
 * store via `PendingQuestionsContext`, isolating the count per session.
 */
describe('per-session isolation (PendingQuestionsContext)', () => {
  beforeEach(() => pendingQuestionsStore.__resetForTests())

  it('createPendingQuestionsStore instances are independent counters', () => {
    const a = createPendingQuestionsStore()
    const b = createPendingQuestionsStore()
    a.increment()
    expect(a.getSnapshot()).toBe(1)
    expect(b.getSnapshot()).toBe(0)
  })

  it('a pending question in a BACKGROUND session does not disable the ACTIVE composer', () => {
    const background = createPendingQuestionsStore()
    const active = createPendingQuestionsStore()

    // Background (hidden but mounted) session has an unanswered question card.
    const bg = renderHook(() => usePendingQuestionRegistration(true), {
      wrapper: wrapperFor(background),
    })
    expect(background.getSnapshot()).toBe(1)

    // The ACTIVE session's composer reads ITS OWN store → 0 → stays enabled.
    const activeComposer = renderHook(() => usePendingQuestionCount(), {
      wrapper: wrapperFor(active),
    })
    expect(activeComposer.result.current).toBe(0)

    // ...and the module-global is never touched on the scoped path (no leak).
    expect(pendingQuestionsStore.getSnapshot()).toBe(0)
    bg.unmount()
  })

  it('falls back to the module-global store when no provider scopes the tree', () => {
    const { unmount } = renderHook(() => usePendingQuestionRegistration(true))
    expect(pendingQuestionsStore.getSnapshot()).toBe(1)
    unmount()
    expect(pendingQuestionsStore.getSnapshot()).toBe(0)
  })
})

/**
 * LRU re-attach with a pending AskUserQuestion: the composer stays disabled via the durable
 * `snapshotNeedsAnswer(state.snapshot)` flag (available on `worker.ready`), unioned with
 * `usePendingQuestionCount() > 0`, before the card re-registers.
 */
describe('LRU re-attach: composer stays disabled via snapshotNeedsAnswer', () => {
  // Minimal context mirroring SnapshotNeedsAnswerContext from thread.tsx.
  const SnapshotNeedsAnswerCtx = createContext<boolean>(false)

  /** The union the Composer computes: render-derived OR durable snapshot. */
  const useComposerAwaitingAnswer = () => {
    const snapshotNeeds = useContext(SnapshotNeedsAnswerCtx)
    const pendingCount = usePendingQuestionCount()
    return pendingCount > 0 || snapshotNeeds
  }

  beforeEach(() => pendingQuestionsStore.__resetForTests())

  it('disables the composer via snapshotNeedsAnswer even when no card is mounted', () => {
    // Simulate: Thread just remounted after LRU eviction. The per-thread
    // store is fresh (count=0), but the worker snapshot says a question is
    // pending (pendingUserInteraction is populated).
    const freshStore = createPendingQuestionsStore()
    expect(freshStore.getSnapshot()).toBe(0)

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        PendingQuestionsContext.Provider,
        { value: freshStore },
        createElement(
          SnapshotNeedsAnswerCtx.Provider,
          { value: true }, // snapshotNeedsAnswer(snapshot) === true
          children,
        ),
      )

    const { result } = renderHook(() => useComposerAwaitingAnswer(), { wrapper })
    // Composer is disabled despite no card being mounted yet.
    expect(result.current).toBe(true)
  })

  it('re-enables the composer once the question is answered (both signals clear)', () => {
    const freshStore = createPendingQuestionsStore()

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        PendingQuestionsContext.Provider,
        { value: freshStore },
        createElement(
          SnapshotNeedsAnswerCtx.Provider,
          { value: false }, // snapshot cleared after user answers
          children,
        ),
      )

    const { result } = renderHook(() => useComposerAwaitingAnswer(), { wrapper })
    // Both signals false → composer enabled.
    expect(result.current).toBe(false)
  })

  it('stays disabled while the card is mounted and pending (render-derived path)', () => {
    const store = createPendingQuestionsStore()

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        PendingQuestionsContext.Provider,
        { value: store },
        createElement(
          SnapshotNeedsAnswerCtx.Provider,
          { value: false },
          children,
        ),
      )

    // Card mounts and registers.
    renderHook(() => usePendingQuestionRegistration(true), { wrapper })
    const { result } = renderHook(() => useComposerAwaitingAnswer(), { wrapper })
    expect(result.current).toBe(true)
  })
})

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
  COMPOSER_DRAFT_DEBOUNCE_MS,
  useComposerDraftSync,
  type ComposerDraftRuntime,
} from '../browser/webview/useComposerDraftSync'
import { hasUnsavedEdits } from '../glic/unsavedEditsGate'

// ---------------------------------------------------------------------------
// Restoring a saved composer draft must never look like typing.
//
// `lastComposerEditAt` is half the sidebar's sort key (`sessionActivityTime`),
// so a restore that flushed through `onComposerEdit` stamped `now` and floated
// the session to the top of the list purely for being opened — the row the
// user just clicked jumped out from under the cursor.
// ---------------------------------------------------------------------------

/** Minimal stand-in for assistant-ui's ComposerRuntime. */
function createComposer(initialText = ''): ComposerDraftRuntime & {
  type: (text: string) => void
} {
  let text = initialText
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of [...listeners]) listener()
  }
  return {
    getState: () => ({ text }),
    setText: (next: string) => {
      text = next
      notify()
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    // Same mechanics as setText; named for intent in the tests below.
    type: (next: string) => {
      text = next
      notify()
    },
  }
}

describe('useComposerDraftSync', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not report an edit when a draft arrives AFTER mount and is restored', () => {
    const composer = createComposer()
    const onComposerEdit = vi.fn()
    // First render with no draft — the `session.list` broadcast that carries it
    // hasn't landed yet (the case the rehydrate effect exists for).
    const { rerender } = renderHook(
      ({ draft }: { draft?: string }) =>
        useComposerDraftSync(composer, draft, onComposerEdit),
      { initialProps: {} as { draft?: string } },
    )

    rerender({ draft: 'saved draft' })
    vi.advanceTimersByTime(COMPOSER_DRAFT_DEBOUNCE_MS * 2)

    expect(composer.getState().text).toBe('saved draft')
    expect(onComposerEdit).not.toHaveBeenCalled()
  })

  it('reports a real keystroke after the debounce', () => {
    const composer = createComposer()
    const onComposerEdit = vi.fn()
    renderHook(() => useComposerDraftSync(composer, undefined, onComposerEdit))

    composer.type('typed by hand')
    expect(onComposerEdit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(COMPOSER_DRAFT_DEBOUNCE_MS)

    expect(onComposerEdit).toHaveBeenCalledWith('typed by hand', expect.any(Number))
  })

  it('still reports an edit that retypes exactly the restored text', () => {
    const composer = createComposer()
    const onComposerEdit = vi.fn()
    const { rerender } = renderHook(
      ({ draft }: { draft?: string }) =>
        useComposerDraftSync(composer, draft, onComposerEdit),
      { initialProps: {} as { draft?: string } },
    )
    rerender({ draft: 'saved draft' })
    vi.advanceTimersByTime(COMPOSER_DRAFT_DEBOUNCE_MS * 2)
    onComposerEdit.mockClear()

    // User clears the composer, then types the same text back. The
    // restore guard is one-shot, so this must persist.
    composer.type('')
    vi.advanceTimersByTime(COMPOSER_DRAFT_DEBOUNCE_MS)
    composer.type('saved draft')
    vi.advanceTimersByTime(COMPOSER_DRAFT_DEBOUNCE_MS)

    expect(onComposerEdit).toHaveBeenLastCalledWith(
      'saved draft',
      expect.any(Number),
    )
  })

  it('does not report an edit for a draft already present at mount', () => {
    const composer = createComposer()
    const onComposerEdit = vi.fn()
    renderHook(() => useComposerDraftSync(composer, 'saved draft', onComposerEdit))
    vi.advanceTimersByTime(COMPOSER_DRAFT_DEBOUNCE_MS * 2)

    expect(composer.getState().text).toBe('saved draft')
    expect(onComposerEdit).not.toHaveBeenCalled()
  })

  it('never clobbers text the user typed before the draft arrived', () => {
    const composer = createComposer()
    const onComposerEdit = vi.fn()
    const { rerender } = renderHook(
      ({ draft }: { draft?: string }) =>
        useComposerDraftSync(composer, draft, onComposerEdit),
      { initialProps: {} as { draft?: string } },
    )
    composer.type('in progress')
    vi.advanceTimersByTime(COMPOSER_DRAFT_DEBOUNCE_MS)
    onComposerEdit.mockClear()

    rerender({ draft: 'saved draft' })
    vi.advanceTimersByTime(COMPOSER_DRAFT_DEBOUNCE_MS * 2)

    expect(composer.getState().text).toBe('in progress')
    expect(onComposerEdit).not.toHaveBeenCalled()
  })

  it('never restores the echo of a draft the user already cleared', () => {
    // The race the plan-approval e2e hit under load: the user types mid-turn,
    // the debounced persist round-trips through `session.list`, and the prop
    // lands AFTER the user cleared the composer. Restoring it would refill
    // text the user deliberately deleted (and, since Stop hides while the
    // composer has content, make the Stop button vanish). Any genuine user
    // edit must disarm the one-shot rehydrate for good.
    const composer = createComposer()
    const onComposerEdit = vi.fn()
    const { rerender } = renderHook(
      ({ draft }: { draft?: string }) =>
        useComposerDraftSync(composer, draft, onComposerEdit),
      { initialProps: {} as { draft?: string } },
    )

    composer.type('draft typed while approval is pending')
    vi.advanceTimersByTime(COMPOSER_DRAFT_DEBOUNCE_MS)
    composer.type('')
    // The earlier persist now echoes back as the saved-draft prop.
    rerender({ draft: 'draft typed while approval is pending' })
    vi.advanceTimersByTime(COMPOSER_DRAFT_DEBOUNCE_MS * 2)

    expect(composer.getState().text).toBe('')
  })

  it('flushes a pending edit on unmount (mount-LRU eviction)', () => {
    const composer = createComposer()
    const onComposerEdit = vi.fn()
    const { unmount } = renderHook(() =>
      useComposerDraftSync(composer, undefined, onComposerEdit),
    )

    composer.type('half typed')
    unmount()

    expect(onComposerEdit).toHaveBeenCalledWith('half typed', expect.any(Number))
  })

  it('holds the updater reload gate while the composer has a draft, and releases it', () => {
    // A composer draft is page state the background updater's hidden-page
    // reload would cost the user (glic/unsavedEditsGate.ts). Earlier cases in
    // this file leave their hooks mounted with text, so start from zero.
    ;(globalThis as { __nexusUnsavedEdits?: number }).__nexusUnsavedEdits = 0
    const composer = createComposer()
    const { unmount } = renderHook(() =>
      useComposerDraftSync(composer, undefined, undefined),
    )
    expect(hasUnsavedEdits()).toBe(false)
    composer.type('half typed')
    expect(hasUnsavedEdits()).toBe(true)
    composer.type('   ')
    expect(hasUnsavedEdits()).toBe(false)
    composer.type('again')
    expect(hasUnsavedEdits()).toBe(true)
    unmount()
    expect(hasUnsavedEdits()).toBe(false)
  })
})

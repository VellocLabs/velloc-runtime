import { useEffect, useRef } from 'react'

import { registerUnsavedEdits } from '../../glic/unsavedEditsGate'

/**
 * The slice of assistant-ui's `ComposerRuntime` this hook needs. Declared
 * structurally so the hook (and its tests) don't depend on the runtime itself
 * — the real `useComposerRuntime()` value satisfies it.
 */
export type ComposerDraftRuntime = {
  getState: () => { text: string; attachments?: readonly unknown[] }
  setText: (text: string) => void
  subscribe: (listener: () => void) => () => void
}

/** How long typing must pause before a draft is persisted. */
export const COMPOSER_DRAFT_DEBOUNCE_MS = 500

/**
 * Two-way composer-draft sync. Rehydrates the saved draft once per session mount, only into an empty
 * composer; pushes a debounced `onComposerEdit`, flushed on unmount. A restore is not an edit: it is
 * adopted as the baseline (`restoredTextRef`), never flushed.
 */
export function useComposerDraftSync(
  composer: ComposerDraftRuntime,
  initialComposerDraft: string | undefined,
  onComposerEdit:
    | ((composerDraft: string, editedAt: number) => void)
    | undefined,
): void {
  const onComposerEditRef = useRef(onComposerEdit)
  onComposerEditRef.current = onComposerEdit

  // Armed once the draft is applied or the user first edits, so a later-arriving draft prop never
  // overwrites the composer (G-2).
  const appliedRef = useRef(false)
  // Text this hook just wrote into the composer itself — see the "a restore is
  // NOT an edit" note above.
  const restoredTextRef = useRef<string | null>(null)
  useEffect(() => {
    if (appliedRef.current) return
    if (!initialComposerDraft || initialComposerDraft.length === 0) return
    if (composer.getState().text !== '') {
      // Composer already has content (user typed before draft arrived,
      // or another effect populated it) — don't clobber.
      appliedRef.current = true
      return
    }
    try {
      restoredTextRef.current = initialComposerDraft
      composer.setText(initialComposerDraft)
    } catch (error) {
      restoredTextRef.current = null
      console.warn('Failed to restore composer draft:', error)
    }
    appliedRef.current = true
  }, [composer, initialComposerDraft])

  // Second effect: subscribe to composer edits and forward debounced
  // flushes to `onComposerEdit`. This is decoupled from
  // `initialComposerDraft` so the subscription's lifecycle isn't
  // re-bound every time the saved-draft prop updates.
  useEffect(() => {
    // A draft restored BEFORE this subscription existed is already part of the
    // baseline below — disarm the guard so it can never swallow a later real
    // edit that happens to retype the same text.
    restoredTextRef.current = null
    let lastEmittedText = composer.getState().text
    let pendingTimer: ReturnType<typeof setTimeout> | null = null

    const flush = () => {
      pendingTimer = null
      onComposerEditRef.current?.(lastEmittedText, Date.now())
    }

    const unsubscribe = composer.subscribe(() => {
      const text = composer.getState().text
      if (text === lastEmittedText) return
      if (restoredTextRef.current !== null && text === restoredTextRef.current) {
        // Our own draft restore echoing back — adopt it as the baseline
        // without persisting a fresh `lastComposerEditAt`.
        restoredTextRef.current = null
        lastEmittedText = text
        return
      }
      // A genuine user edit — including clearing the input — permanently
      // disarms the rehydrate: the composer now reflects the user's intent,
      // and a draft prop landing later (often the echo of this very edit)
      // must not clobber it.
      appliedRef.current = true
      lastEmittedText = text
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer)
      }
      pendingTimer = setTimeout(flush, COMPOSER_DRAFT_DEBOUNCE_MS)
    })

    return () => {
      unsubscribe()
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer)
        flush()
      }
    }
  }, [composer])

  // Third effect: a non-empty composer (text or attachments) is page state a
  // reload would cost the user — attachments are never persisted, and typed
  // text is only after the debounce. Hold the background updater's reload
  // while there is any (glic/unsavedEditsGate.ts). Driven by the
  // subscription, not React state, so typing never re-renders this host.
  useEffect(() => {
    let release: (() => void) | null = null
    const sync = () => {
      const state = composer.getState()
      const hasDraft =
        state.text.trim() !== '' || (state.attachments?.length ?? 0) > 0
      if (hasDraft && !release) {
        release = registerUnsavedEdits()
      } else if (!hasDraft && release) {
        release()
        release = null
      }
    }
    sync()
    const unsubscribe = composer.subscribe(sync)
    return () => {
      unsubscribe()
      release?.()
    }
  }, [composer])
}

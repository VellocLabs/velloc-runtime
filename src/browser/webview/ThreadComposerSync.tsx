
import {
  AssistantRuntimeProvider,
  useComposerRuntime,
} from '@assistant-ui/react'

import { Suspense, lazy, useEffect, useRef } from 'react'

import { useComposerDraftSync } from './useComposerDraftSync'

// Static import on purpose: a lazy() Thread suspends on cold load for its chunk and its
// markdown chunk (P-2).
import { Thread } from '@/components/assistant-ui/thread'

/**
 * Hydrates an empty composer with the parent's draft on mount, debounces `onComposerEdit`
 * (500 ms), and flushes a pending change on unmount.
 */
export function ComposerDraftSync({
  initialComposerDraft,
  onComposerEdit,
}: {
  initialComposerDraft?: string
  onComposerEdit?: (composerDraft: string, editedAt: number) => void
}) {
  useComposerDraftSync(
    useComposerRuntime(),
    initialComposerDraft,
    onComposerEdit,
  )
  return null
}

/**
 * Puts intercepted draft text back into the composer. Used by the `onNew`
 * adopt-default path: by the time `onNew` runs the runtime has already
 * cleared the composer, and the composer runtime is only reachable via hook
 * from INSIDE the AssistantRuntimeProvider tree — hence this render-nothing
 * child instead of a direct call (same pattern as ProviderMissingDialog's
 * restore-on-close).
 */
export function ComposerTextRestore({
  text,
  onDone,
}: {
  text: string
  onDone: () => void
}) {
  const composer = useComposerRuntime()
  useEffect(() => {
    try {
      composer.setText(text)
    } catch (error) {
      console.warn('Failed to restore composer text:', error)
    }
    onDone()
  }, [composer, text, onDone])
  return null
}

/**
 * Adds `insert.text` to the end of the composer once per `insert.nonce`,
 * after a space when the draft does not end in whitespace.
 */
export function ComposerTextInsert({
  insert,
}: {
  insert: { text: string; nonce: number }
}) {
  const composer = useComposerRuntime()
  const applied = useRef<number | null>(null)
  useEffect(() => {
    if (applied.current === insert.nonce) return
    applied.current = insert.nonce
    try {
      const draft = composer.getState().text
      const glue = draft === '' || /\s$/.test(draft) ? '' : ' '
      composer.setText(`${draft}${glue}${insert.text}`)
    } catch (error) {
      console.warn('Failed to add text to the composer:', error)
    }
  }, [composer, insert.nonce, insert.text])
  return null
}

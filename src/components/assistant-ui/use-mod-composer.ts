/**
 * The prompt box's answers to `$.prompt.read`, `$.prompt.fill` and `$.prompt.suggest`
 * (F-25). `fill` is refused with `dialog` while a question holds the box; a suggestion
 * shows only in an empty box with no turn running. Mod text is shown as it is. While a
 * mod hooks `prompt.edit`, typing, deleting and pasting are asked of the runtime first.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

import type { ModsPromptEditKey } from '@/browser/runtimeProtocol'
import { fillBox } from '@/mods/modComposer'

import { PromptEditPump, type PageEdit, type PromptEditBox } from './mod-prompt-edit'
import { useModUi, type ModUiComposerAnswer, type ModUiComposerRequest } from './mod-ui-context'

/** The slice of assistant-ui's `ComposerRuntime` the hook needs. */
export type ModComposerRuntime = {
  getState: () => { text: string }
  setText: (text: string) => void
  subscribe: (listener: () => void) => () => void
}

export type ModComposerOptions = {
  composer: ModComposerRuntime
  /** The composer's textarea, for the caret. */
  input: RefObject<HTMLTextAreaElement | null>
  /** A turn runs: a suggestion is not shown. */
  isRunning: boolean
  /** A question holds the box: a fill is refused with `dialog`. */
  isBlocked: boolean
}

export type ModComposerSuggestion = {
  /** The text shown dim in the empty box; null when none. */
  suggestion: string | null
  /** Tab / →: the suggestion becomes the draft. False when there is none to
   *  take (the box holds text). */
  takeSuggestion: () => boolean
}

/** The request's answer, from the box as it stands. Pure, for the tests. */
export function answerComposerRequest(
  request: ModUiComposerRequest,
  box: { text: string; cursor: number },
  state: { isRunning: boolean; isBlocked: boolean },
): { answer: ModUiComposerAnswer; write?: { text: string; cursor: number }; suggest?: string } {
  switch (request.op) {
    case 'read':
      return { answer: { requestId: request.requestId, op: 'read', box } }
    case 'fill': {
      if (state.isBlocked) {
        return { answer: { requestId: request.requestId, op: 'fill', isFilled: false, refusal: 'dialog', box } }
      }
      const next = fillBox(box, request.text, request.mode)
      return { answer: { requestId: request.requestId, op: 'fill', isFilled: true, box: next }, write: next }
    }
    case 'suggest': {
      const isShown = box.text === '' && !state.isRunning && request.text.trim() !== ''
      return {
        answer: { requestId: request.requestId, op: 'suggest', isShown },
        ...(isShown ? { suggest: request.text } : {}),
      }
    }
  }
}

/** `KeyboardEvent` as `prompt.edit`'s `key`: a special key's name or the
 *  character typed. */
export function promptEditKeyOf(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'shiftKey' | 'metaKey'>): ModsPromptEditKey {
  const named: Record<string, string> = { Backspace: 'backspace', Delete: 'delete', Enter: 'return', Tab: 'tab', Escape: 'escape' }
  const key = named[event.key] ?? ([...event.key].length === 1 ? event.key : event.key.toLowerCase())
  return {
    key,
    ...(event.ctrlKey ? { ctrl: true as const } : {}),
    ...(event.shiftKey ? { shift: true as const } : {}),
    ...(event.metaKey ? { meta: true as const } : {}),
  }
}

/** A `beforeinput` as an edit the runtime is asked about; null for one that
 *  lands as the editor makes it (word deletes, undo, drops, an input method's
 *  composition). `key` is the keydown that made it, when one did. */
export function pageEditOf(
  event: Pick<InputEvent, 'inputType' | 'data'> & { dataTransfer?: Pick<DataTransfer, 'getData'> | null },
  key: ModsPromptEditKey | undefined,
): PageEdit | null {
  switch (event.inputType) {
    case 'insertText':
      if (event.data === null || event.data === '') return null
      return { op: 'insert', text: event.data, ...(key && key.key === event.data ? { key } : {}) }
    case 'insertLineBreak':
      return { op: 'insert', text: '\n', ...(key?.key === 'return' ? { key } : {}) }
    case 'insertFromPaste': {
      const text = event.dataTransfer?.getData('text/plain') ?? event.data
      return text ? { op: 'insert', text } : null
    }
    case 'deleteContentBackward':
      return { op: 'deleteBackward', ...(key?.key === 'backspace' ? { key } : {}) }
    case 'deleteContentForward':
      return { op: 'deleteForward', ...(key?.key === 'delete' ? { key } : {}) }
    default:
      return null
  }
}

/** Show `box` in the textarea as typed text would land, keeping its undo
 *  history. False where the editor refuses. */
function writeTextarea(element: HTMLTextAreaElement, box: PromptEditBox): boolean {
  const before = element.value
  if (before !== box.text) {
    const limit = Math.min(before.length, box.text.length)
    let head = 0
    while (head < limit && before[head] === box.text[head]) head += 1
    let tail = 0
    while (tail < limit - head && before[before.length - 1 - tail] === box.text[box.text.length - 1 - tail]) tail += 1
    const middle = box.text.slice(head, box.text.length - tail)
    element.setSelectionRange(head, before.length - tail)
    const ok = middle === '' ? document.execCommand('delete') : document.execCommand('insertText', false, middle)
    if (!ok || element.value !== box.text) return false
  }
  element.setSelectionRange(box.cursor, box.cursor)
  return true
}

export function useModComposer({ composer, input, isRunning, isBlocked }: ModComposerOptions): ModComposerSuggestion {
  const { onComposerRequest, answerComposer, editHooked, promptEdit } = useModUi()
  const [suggestion, setSuggestion] = useState<string | null>(null)
  const state = useRef({ isRunning, isBlocked })
  state.current = { isRunning, isBlocked }
  // The caret a fill just placed, until the textarea holds its text: a read
  // that arrives before the re-render answers it, not the stale caret.
  const placed = useRef<{ text: string; cursor: number } | null>(null)

  useEffect(() => {
    if (!onComposerRequest || !answerComposer) return
    return onComposerRequest(request => {
      const text = composer.getState().text
      const caret = input.current?.selectionStart
      const cursor =
        placed.current?.text === text && input.current?.value !== text
          ? placed.current.cursor
          : typeof caret === 'number'
            ? Math.max(0, Math.min(caret, text.length))
            : text.length
      const { answer, write, suggest } = answerComposerRequest(request, { text, cursor }, state.current)
      // Answer before writing: the answer is computed already, and `setText`
      // re-renders the composer synchronously — on a loaded page that render
      // outlasted the runtime's wait, and a fill that landed came back
      // to the mod as headless (`isFilled: false`).
      void answerComposer(answer).catch(() => {
        // The runtime times the request out and answers as headless.
      })
      if (write) {
        placed.current = write
        composer.setText(write.text)
        // The caret after the text, once the textarea holds it.
        setTimeout(() => {
          const element = input.current
          if (element && element.value === write.text) element.setSelectionRange(write.cursor, write.cursor)
          if (placed.current === write) placed.current = null
        }, 0)
      }
      if (suggest !== undefined) setSuggestion(suggest)
    })
  }, [onComposerRequest, answerComposer, composer, input])

  // `prompt.edit`: each edit is held and asked of the runtime while a mod
  // hooks it; the editor's own handling is untouched otherwise.
  useEffect(() => {
    const element = input.current
    if (!editHooked || !promptEdit || !element) return
    let writing = false
    let lastKey: ModsPromptEditKey | undefined
    let composing: { text: string; start: number; end: number } | null = null
    const read = () => ({ text: element.value, start: element.selectionStart, end: element.selectionEnd })
    const pump = new PromptEditPump({
      read,
      write: box => {
        writing = true
        let written = false
        try {
          written = writeTextarea(element, box)
        } finally {
          writing = false
        }
        if (written) return
        composer.setText(box.text)
        setTimeout(() => {
          if (element.value === box.text) element.setSelectionRange(box.cursor, box.cursor)
        }, 0)
      },
      ask: edit => promptEdit(edit),
    })
    const onKeyDown = (event: KeyboardEvent): void => {
      const key = promptEditKeyOf(event)
      lastKey = key
      setTimeout(() => {
        if (lastKey === key) lastKey = undefined
      }, 0)
    }
    const onBeforeInput = (event: InputEvent): void => {
      if (writing || event.isComposing || composing) return
      const edit = pageEditOf(event, lastKey)
      if (!edit) return
      event.preventDefault()
      pump.edit(edit)
    }
    const onCompositionStart = (): void => {
      composing = read()
    }
    // An input method's commit lands as composed; it is then asked as one
    // edit with no key.
    const onCompositionEnd = (event: CompositionEvent): void => {
      const before = composing
      composing = null
      if (!before || event.data === '') return
      const start = Math.min(before.start, before.end)
      const end = Math.max(before.start, before.end)
      pump.landed({ text: before.text, cursor: end, start, end, inputText: event.data })
    }
    element.addEventListener('keydown', onKeyDown, true)
    element.addEventListener('beforeinput', onBeforeInput)
    element.addEventListener('compositionstart', onCompositionStart)
    element.addEventListener('compositionend', onCompositionEnd)
    return () => {
      pump.dispose()
      element.removeEventListener('keydown', onKeyDown, true)
      element.removeEventListener('beforeinput', onBeforeInput)
      element.removeEventListener('compositionstart', onCompositionStart)
      element.removeEventListener('compositionend', onCompositionEnd)
    }
  }, [editHooked, promptEdit, input, composer])

  // Typing, or a turn starting, takes the suggestion away.
  useEffect(() => {
    if (suggestion === null) return
    return composer.subscribe(() => {
      if (composer.getState().text !== '') setSuggestion(null)
    })
  }, [composer, suggestion])
  useEffect(() => {
    if (isRunning) setSuggestion(null)
  }, [isRunning])

  const takeSuggestion = useCallback((): boolean => {
    if (suggestion === null || composer.getState().text !== '') return false
    composer.setText(suggestion)
    setSuggestion(null)
    return true
  }, [composer, suggestion])

  return { suggestion, takeSuggestion }
}

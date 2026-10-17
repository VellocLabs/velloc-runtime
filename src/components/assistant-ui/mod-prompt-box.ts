/**
 * The page's prompt-box helpers for the mods (F-25): the virtual text drawn over the
 * draft (`PromptDecoration.virtualText`), the token the typeahead asks the mods about
 * (`prompt.autocomplete`), and the untyped changes the box tells (`prompt.change`).
 * Pure, for the tests.
 */
import type { ModsPromptAutocompleteQuery, ModsPromptVirtualText } from '@/browser/runtimeProtocol'
import { autocompleteTokenAt } from '@/mods/promptBoxEvents'

/** The virtual text over one draft: shown while the box holds exactly that
 *  draft, gone at its next change. */
export type DecoratedDraft = { text: string; runs: readonly ModsPromptVirtualText[] }

/** A fill's runs, given as offsets into the filled text, moved to where that
 *  text lands in the draft. */
export function landFillRuns(
  runs: readonly ModsPromptVirtualText[],
  mode: 'replace' | 'append' | 'insert',
  before: { text: string; cursor: number },
): ModsPromptVirtualText[] {
  const at = mode === 'replace' ? 0 : mode === 'append' ? before.text.length : Math.max(0, Math.min(before.cursor, before.text.length))
  return runs.map(run => ({ ...run, start: run.start + at, end: run.end + at }))
}

/** The virtual text the box draws for `draft`: the runs that end at the
 *  draft's end, in order. A run ending inside the draft is not drawn — the
 *  box cannot open a gap between typed characters. Null when none. */
export function trailingVirtualText(draft: DecoratedDraft | null, text: string): string | null {
  if (!draft || draft.text !== text) return null
  const shown = draft.runs
    .filter(run => Math.max(0, Math.min(run.end, text.length)) === text.length && run.virtualText !== '')
    .map(run => run.virtualText)
    .join('')
  return shown === '' ? null : shown
}

/** What the typeahead asks the mods about for a caret: the token ending at
 *  it, or null where none does. */
export function autocompleteQueryAt(text: string, cursor: number): ModsPromptAutocompleteQuery | null {
  const caret = Math.max(0, Math.min(cursor, text.length))
  const at = autocompleteTokenAt(text, caret)
  return at ? { text, cursor: caret, token: at.token, start: at.start } : null
}

/** A query's identity: rows answered for another query are not shown. */
export function autocompleteQueryKey(query: ModsPromptAutocompleteQuery): string {
  return `${query.start}\u0000${query.cursor}\u0000${query.text}`
}

/** An `input` event's change, when no one typed it: an undo or a redo. */
export function untypedInputCause(inputType: string): 'undo' | null {
  return inputType === 'historyUndo' || inputType === 'historyRedo' ? 'undo' : null
}

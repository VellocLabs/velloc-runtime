/**
 * `prompt.autocomplete` and `prompt.change` (F-25): the prompt box's typeahead rows a
 * mod adds for the token at the caret, and the box's text changing without a typed
 * edit. Both are raised in the runtime on the page's ask (`mods.promptAutocomplete`,
 * `mods.promptChange`), or by the runtime itself for a plugin's fill.
 */

import type { DispatchContext } from './modTypes'
import type { ModDispatcher } from './ModDispatcher'
import type { PromptBox } from './modComposer'

/** `PromptAutocompleteInput`: the draft, the caret, and the run of
 *  non-whitespace that ends at it (`text.slice(start, cursor)`, never empty). */
export type PromptAutocompleteInput = { text: string; cursor: number; token: string; start: number }

/** `PromptAutocompleteSuggestion`: what taking the row writes in place of the
 *  token (never empty), what the row shows, and a dim line beside it. */
export type PromptAutocompleteSuggestion = { text: string; label?: string; description?: string }

/** `PromptAutocompleteResult`: the rows, drawn beneath the page's own. */
export type PromptAutocompleteResult = { suggestions: PromptAutocompleteSuggestion[] }

/** Why the box changed without a typed edit. Velloc's box keeps no history
 *  to recall, so `history` is never raised (F-25). */
export type PromptChangeCause = 'history' | 'clear' | 'undo' | 'fill'
export const PROMPT_CHANGE_CAUSES: readonly PromptChangeCause[] = ['history', 'clear', 'undo', 'fill']

/** `prompt.change`'s input: the box after the change, and its cause. */
export type PromptChangeInput = PromptBox & { cause: PromptChangeCause }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOffset(value: unknown, length: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= length
}

function isWhitespace(char: string): boolean {
  return /\s/u.test(char)
}

/** The token a caret stands at the end of: the run of non-whitespace ending
 *  at `cursor`, or null where none does (the caret after a space, or at 0). */
export function autocompleteTokenAt(text: string, cursor: number): { token: string; start: number } | null {
  const end = Math.max(0, Math.min(cursor, text.length))
  let start = end
  while (start > 0 && !isWhitespace(text[start - 1]!)) start -= 1
  return start === end ? null : { token: text.slice(start, end), start }
}

/** The box after taking `row` for the token: the token replaced by the row's
 *  text, the caret after it. */
export function takeAutocompleteRow(input: Pick<PromptAutocompleteInput, 'text' | 'cursor' | 'start'>, row: Pick<PromptAutocompleteSuggestion, 'text'>): PromptBox {
  const text = input.text.slice(0, input.start) + row.text + input.text.slice(input.cursor)
  return { text, cursor: input.start + row.text.length }
}

export function isPromptAutocompleteInput(value: unknown): value is PromptAutocompleteInput {
  if (!isRecord(value) || typeof value.text !== 'string' || typeof value.token !== 'string') return false
  const { text, cursor, start, token } = value
  return (
    isOffset(cursor, text.length) &&
    isOffset(start, text.length) &&
    (start as number) < (cursor as number) &&
    text.slice(start as number, cursor as number) === token &&
    autocompleteTokenAt(text, cursor as number)?.start === start
  )
}

export function isPromptAutocompleteSuggestion(value: unknown): value is PromptAutocompleteSuggestion {
  return (
    isRecord(value) &&
    typeof value.text === 'string' &&
    value.text !== '' &&
    (value.label === undefined || typeof value.label === 'string') &&
    (value.description === undefined || typeof value.description === 'string')
  )
}

/** Whether a hook's return answers `prompt.autocomplete`: `{ suggestions }`,
 *  every row one. Else the hook is skipped. */
export function isPromptAutocompleteResult(value: unknown): value is PromptAutocompleteResult {
  return isRecord(value) && Array.isArray(value.suggestions) && value.suggestions.every(isPromptAutocompleteSuggestion)
}

export function isPromptChangeInput(value: unknown): value is PromptChangeInput {
  return (
    isRecord(value) &&
    typeof value.text === 'string' &&
    isOffset(value.cursor, value.text.length) &&
    PROMPT_CHANGE_CAUSES.includes(value.cause as PromptChangeCause)
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * `prompt.autocomplete` for the token at the caret: the rows the hooks add, in
 * order; none from core, whatever reached it. A failed chain is reported and
 * adds no rows. Rejects only on `signal`'s abort.
 */
export async function raisePromptAutocomplete(
  dispatcher: ModDispatcher,
  input: PromptAutocompleteInput,
  report: (line: string) => void,
  signal?: AbortSignal,
): Promise<PromptAutocompleteSuggestion[]> {
  if (!dispatcher.hasHooksFor('prompt.autocomplete')) return []
  const e = { text: input.text, cursor: input.cursor, token: input.token, start: input.start }
  try {
    const result = await dispatcher.dispatch(
      'prompt.autocomplete',
      e,
      () => ({ suggestions: [] }),
      { ...(signal ? { signal } : {}), accepts: isPromptAutocompleteResult },
    )
    return (result as PromptAutocompleteResult).suggestions.map(row => ({
      text: row.text,
      ...(row.label !== undefined ? { label: row.label } : {}),
      ...(row.description !== undefined ? { description: row.description } : {}),
    }))
  } catch (error) {
    if (signal?.aborted) throw error
    report(`mods: prompt.autocomplete failed: ${messageOf(error)}; no rows are added`)
    return []
  }
}

/**
 * `prompt.change`: observe. `next(e)` resolves to the box as it stands; a
 * hook's answer changes nothing. `context` names the plugin whose own call
 * (a fill) made the change. Never rejects.
 */
export async function raisePromptChange(
  dispatcher: ModDispatcher,
  change: PromptChangeInput,
  report: (line: string) => void,
  context?: DispatchContext,
): Promise<void> {
  if (!dispatcher.hasHooksFor('prompt.change')) return
  const e = { text: change.text, cursor: change.cursor, cause: change.cause }
  try {
    await dispatcher.dispatch('prompt.change', e, () => ({ text: e.text, cursor: e.cursor }), {
      ...(context ? { context } : {}),
      accepts: isRecord,
    })
  } catch (error) {
    report(`mods: prompt.change failed: ${messageOf(error)}`)
  }
}

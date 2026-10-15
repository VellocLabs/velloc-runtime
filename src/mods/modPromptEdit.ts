/**
 * `prompt.edit` (F-25): one edit the person makes in the page's prompt box, raised
 * in the runtime on the page's ask (`mods.promptEdit`). Core applies the splice;
 * the box the chain resolves to is what the page shows.
 */

import type { ModDispatcher } from './ModDispatcher'
import { isPromptBox, type PromptBox } from './modComposer'

/** `ClientKeyEvent`: the one key that made an edit. */
export type PromptEditKey = { key: string; ctrl?: true; shift?: true; meta?: true }

/** `prompt.edit`'s input less `origin`: the draft before, the caret, and the
 *  splice (`[start, end)` replaced by `inputText`). No `key` for a paste or a
 *  burst of keys folded into one edit. */
export type PromptEdit = {
  key?: PromptEditKey
  text: string
  cursor: number
  start: number
  end: number
  inputText: string
}

/** `PromptEditOrigin`: the person at the composer, the one origin raised. */
export const PROMPT_EDIT_ORIGIN = Object.freeze({ kind: 'composer' as const })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOffset(value: unknown, length: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= length
}

export function isPromptEditKey(value: unknown): value is PromptEditKey {
  return (
    isRecord(value) &&
    typeof value.key === 'string' &&
    value.key !== '' &&
    (value.ctrl === undefined || value.ctrl === true) &&
    (value.shift === undefined || value.shift === true) &&
    (value.meta === undefined || value.meta === true)
  )
}

/** The edit's fields are in range: every offset within `text`, `start <= end`. */
export function isPromptEdit(value: unknown): value is PromptEdit {
  if (!isRecord(value) || typeof value.text !== 'string' || typeof value.inputText !== 'string') return false
  const length = value.text.length
  return (
    isOffset(value.cursor, length) &&
    isOffset(value.start, length) &&
    isOffset(value.end, length) &&
    (value.start as number) <= (value.end as number) &&
    (value.key === undefined || isPromptEditKey(value.key))
  )
}

/** Core's box: `text` with the splice applied, the caret after what went in. */
export function applyPromptEdit(edit: Pick<PromptEdit, 'text' | 'start' | 'end' | 'inputText'>): PromptBox {
  return {
    text: edit.text.slice(0, edit.start) + edit.inputText + edit.text.slice(edit.end),
    cursor: edit.start + edit.inputText.length,
  }
}

function sameKey(a: PromptEditKey | undefined, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/**
 * `prompt.edit` through the chain; resolves to the box the page shows. `origin`
 * and `key` are pinned: a hook rewriting either is refused. A failed chain is
 * reported and the edit lands as typed. Rejects only on `signal`'s abort.
 */
export async function raisePromptEdit(
  dispatcher: ModDispatcher,
  edit: PromptEdit,
  report: (line: string) => void,
  signal?: AbortSignal,
): Promise<PromptBox> {
  const typed = applyPromptEdit(edit)
  if (!dispatcher.hasHooksFor('prompt.edit')) return typed
  const e = { origin: PROMPT_EDIT_ORIGIN, ...edit }
  try {
    const result = await dispatcher.dispatch(
      'prompt.edit',
      e,
      async arrived => {
        if (!isRecord(arrived)) throw new Error('the rewritten event is refused: it is not an edit')
        if (arrived.origin !== undefined && JSON.stringify(arrived.origin) !== JSON.stringify(PROMPT_EDIT_ORIGIN)) {
          throw new Error('the rewritten event is refused: origin is pinned')
        }
        if (!sameKey(edit.key, arrived.key)) throw new Error('the rewritten event is refused: key is pinned')
        if (!isPromptEdit(arrived)) throw new Error('the rewritten event is refused: an offset is outside its text')
        return applyPromptEdit(arrived)
      },
      { ...(signal ? { signal } : {}), accepts: isPromptBox },
    )
    return { text: result.text, cursor: result.cursor }
  } catch (error) {
    if (signal?.aborted) throw error
    report(`mods: prompt.edit failed: ${error instanceof Error ? error.message : String(error)}; the edit lands as typed`)
    return typed
  }
}

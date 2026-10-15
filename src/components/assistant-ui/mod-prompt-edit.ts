/**
 * The page's half of `prompt.edit` (F-25): while some mod hooks it, each edit of the
 * prompt box is held, asked of the runtime, and the box it answers is shown. Keys
 * typed while an ask is out fold into one edit with no `key`. An ask unanswered
 * within `PROMPT_EDIT_TIMEOUT_MS` lands as typed and its late answer is dropped.
 */
import type { ModsPromptEdit, ModsPromptEditKey } from '@/browser/runtimeProtocol'
import { applyPromptEdit } from '@/mods/modPromptEdit'

export type PromptEditBox = { text: string; cursor: number }

/** How long a held edit waits for the runtime before it lands as typed: past
 *  it, typing would feel slow. */
export const PROMPT_EDIT_TIMEOUT_MS = 100

/** One edit as the page's editor reports it, before it lands. */
export type PageEdit =
  | { op: 'insert'; text: string; key?: ModsPromptEditKey }
  | { op: 'deleteBackward'; key?: ModsPromptEditKey }
  | { op: 'deleteForward'; key?: ModsPromptEditKey }

/** The box and its selection as the editor holds them. */
export type EditorState = { text: string; start: number; end: number }

export type PromptEditPumpOptions = {
  read: () => EditorState
  /** Show `box` in the editor. */
  write: (box: PromptEditBox) => void
  /** Ask the runtime; null when it answers none (the edit lands as typed). */
  ask: (edit: ModsPromptEdit) => Promise<PromptEditBox | null>
  timeoutMs?: number
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/** The offset one code point before `at` (`at` at 0 stays). */
function backOne(text: string, at: number): number {
  if (at <= 0) return 0
  return at >= 2 && isLowSurrogate(text.charCodeAt(at - 1)) && isHighSurrogate(text.charCodeAt(at - 2)) ? at - 2 : at - 1
}

/** The offset one code point after `at` (`at` at the end stays). */
function forwardOne(text: string, at: number): number {
  if (at >= text.length) return text.length
  return at + 1 < text.length && isHighSurrogate(text.charCodeAt(at)) && isLowSurrogate(text.charCodeAt(at + 1)) ? at + 2 : at + 1
}

/** `edit` as a splice of the editor's state; null for a delete with nothing
 *  to delete. */
export function spliceOf(state: EditorState, edit: PageEdit): ModsPromptEdit | null {
  const { text } = state
  const start = Math.max(0, Math.min(state.start, state.end, text.length))
  const end = Math.max(start, Math.min(Math.max(state.start, state.end), text.length))
  const key = edit.key ? { key: edit.key } : {}
  if (edit.op === 'insert') return { ...key, text, cursor: end, start, end, inputText: edit.text }
  if (start !== end) return { ...key, text, cursor: end, start, end, inputText: '' }
  if (edit.op === 'deleteBackward') {
    const from = backOne(text, start)
    return from === start ? null : { ...key, text, cursor: start, start: from, end: start, inputText: '' }
  }
  const to = forwardOne(text, start)
  return to === start ? null : { ...key, text, cursor: start, start, end: to, inputText: '' }
}

/** Edits typed while an ask was out, as one splice of `box` at its caret.
 *  One edit alone keeps its key; a burst has none. */
export function foldEdits(box: PromptEditBox, edits: readonly PageEdit[]): ModsPromptEdit | null {
  if (edits.length === 1) return spliceOf({ text: box.text, start: box.cursor, end: box.cursor }, edits[0]!)
  let inserted = ''
  let start = box.cursor
  let end = box.cursor
  for (const edit of edits) {
    if (edit.op === 'insert') inserted += edit.text
    else if (edit.op === 'deleteBackward') {
      if (inserted !== '') inserted = inserted.slice(0, backOne(inserted, inserted.length))
      else start = backOne(box.text, start)
    } else if (inserted === '') end = forwardOne(box.text, end)
  }
  if (inserted === '' && start === end) return null
  return { text: box.text, cursor: box.cursor, start, end, inputText: inserted }
}

/**
 * Holds the editor's edits through the runtime, one ask at a time. The caller
 * prevents each edit's default and hands it to `edit`; `dispose` lands what is
 * held — the edit out and the keys queued behind it — as typed, and drops the
 * late answer.
 */
export class PromptEditPump {
  private inFlight = false
  private queued: PageEdit[] = []
  private disposed = false
  /** Settles the ask that is out, as unanswered; null when none is. */
  private settleOut: ((box: PromptEditBox | null) => void) | null = null
  /** Disposing: what is held lands as typed, nothing more is asked. */
  private landing = false
  private readonly timeoutMs: number
  private readonly setTimer: (run: () => void, ms: number) => unknown
  private readonly clearTimer: (timer: unknown) => void

  constructor(private readonly options: PromptEditPumpOptions) {
    this.timeoutMs = options.timeoutMs ?? PROMPT_EDIT_TIMEOUT_MS
    this.setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms))
    this.clearTimer = options.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>))
  }

  /** Whether an ask is out: an edit now is queued, not asked. */
  get busy(): boolean {
    return this.inFlight
  }

  edit(edit: PageEdit): void {
    if (this.disposed) return
    if (this.inFlight) {
      this.queued.push(edit)
      return
    }
    const state = this.options.read()
    const splice = spliceOf(state, edit)
    if (splice) this.send(splice)
  }

  /** An edit that already landed (an input method's commit): asked, and the
   *  answer shown only while the editor still holds what landed. */
  landed(splice: ModsPromptEdit): void {
    if (this.disposed || this.inFlight) return
    this.send(splice, applyPromptEdit(splice).text)
  }

  dispose(): void {
    if (this.disposed) return
    this.landing = true
    this.settleOut?.(null)
    this.disposed = true
    this.queued = []
  }

  private send(splice: ModsPromptEdit, holding: string = splice.text): void {
    this.inFlight = true
    let settled = false
    const settle = (box: PromptEditBox | null): void => {
      if (settled) return
      settled = true
      this.settleOut = null
      this.clearTimer(timer)
      if (this.disposed) return
      // The editor moved under the ask (a send, a fill): the answer is for a
      // box that is gone, and the queued edits land on the box as it stands.
      const moved = this.options.read().text !== holding
      if (!moved) this.options.write(box ?? applyPromptEdit(splice))
      this.flush()
    }
    this.settleOut = settle
    const timer = this.setTimer(() => settle(null), this.timeoutMs)
    this.options.ask(splice).then(settle, () => settle(null))
  }

  private flush(): void {
    const edits = this.queued
    this.queued = []
    this.inFlight = false
    if (edits.length === 0) return
    const state = this.options.read()
    const folded = foldEdits({ text: state.text, cursor: Math.max(state.start, state.end) }, edits)
    if (!folded) return
    if (this.landing) this.options.write(applyPromptEdit(folded))
    else this.send(folded)
  }
}

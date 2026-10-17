/**
 * `$.ui.status`, `$.ui.toast`, `$.ui.notice` and the `$.ui.ask` dialog (F-25): slot
 * state published on `mods/ui/<sessionId>` and drawn by the client. Mod text is
 * shown as is, not translated. An ask is held as STATE; the first page to answer
 * settles it, and the slot's wall-clock bounds pause while it is open.
 */

import type { ModComposerRequest } from './modComposer'
import type { ModPageRequest } from './modPage'
import type { ModAgentView } from './modAgentView'

export type ModStatusLine = { plugin: string; text: string }
export type ModNoticeLine = { toolUseId: string; plugin: string; text: string }
export type ModToast = { plugin: string; text: string; timeoutMs: number }

/** The toast's default stay: "default 4000". */
export const MOD_TOAST_DEFAULT_TIMEOUT_MS = 4_000
/** A toast's longest stay, so a plugin cannot pin one forever. */
export const MOD_TOAST_MAX_TIMEOUT_MS = 60_000
/** A status line, a toast or a notice longer than this is cut (characters). */
export const MOD_UI_TEXT_MAX_CHARS = 2_000

/** One open pane as the client draws it (`modPanes.ts`). */
export type ModUiPane = {
  plugin: string
  id: string
  title: string
  /** The pane in front of the roster (what an inline client draws). */
  isShown: boolean
  isFocused: boolean
  /** False while an unasked open waits for a client that places it. */
  isPlaced: boolean
  /** An open of the person's not yet shown: a docked client shows it. */
  asked: boolean
  /** An open with `focus` not yet shown: a docked client shows it too. */
  focus: boolean
  /** Its latest open's place in the slot's opens. */
  openSeq: number
  closeOnEscape: boolean
  rows?: number
  columns?: number
}

/** A `ui.render` site some loaded hook may draw: the component it names
 *  and, for a Pane, the id — so the client asks for what is hooked alone. */
export type ModUiHookedSite = { plugin: string; component?: string; requestId?: string }

/** What a `turn.complete` hook answered beneath the answer: "a text
 *  other than a main-loop answer's is shown beneath it". Cleared when the
 *  next turn starts. */
export type ModUiTurnNote = { turnId: string; text: string }

/** One option of a `$.ui.ask`. `engine` marks a label the engine padded a
 *  short list with ("fewer than two are padded with Yes/No"): the answer is
 *  the label as written, the page draws it in the person's language. */
export type ModUiAskOption = { label: string; engine?: 'yes' | 'no' }

/** `$.ui.ask(question, options)` as normalized: 2-4 options, the chip, and
 *  whether several may be picked. */
export type ModUiAskArgs = {
  question: string
  header?: string
  options: ModUiAskOption[]
  multiSelect: boolean
}

/** A question waiting for the person, as the page draws it. */
export type ModUiAsk = ModUiAskArgs & { requestId: string; plugin: string }

/** The page's answer: the label chosen, the chosen labels comma-joined, or
 *  the text typed under "Other"; or that the person dismissed it. */
export type ModUiAskAnswer = { requestId: string; answer: string } | { requestId: string; dismissed: true }

/** "2-4 option labels". */
export const MOD_ASK_MAX_OPTIONS = 4
/** "A short chip beside the question (`Approach`, 12 characters at most)" —
 *  AskUserQuestion's chip width; a longer header is cut. */
export const MOD_ASK_HEADER_MAX_CHARS = 12
/** The labels a short list is padded with, in this order. */
const MOD_ASK_PADDING: ReadonlyArray<ModUiAskOption> = [
  { label: 'Yes', engine: 'yes' },
  { label: 'No', engine: 'no' },
]

/** `$.ui.ask`'s arguments: `(question, labels?)` or `(question, { options?,
 *  header?, multiSelect? })`. Throws a TypeError naming what is wrong. */
export function uiAskArgsOf(question: unknown, options: unknown): ModUiAskArgs {
  if (typeof question !== 'string' || question.trim() === '') {
    throw new TypeError('$.ui.ask(question, options?): question must be a non-empty string')
  }
  let labels: unknown = undefined
  let header: unknown = undefined
  let multiSelect: unknown = undefined
  if (Array.isArray(options)) labels = options
  else if (typeof options === 'object' && options !== null) {
    ;({ options: labels, header, multiSelect } = options as Record<string, unknown>)
  } else if (options !== undefined) {
    throw new TypeError('$.ui.ask: options must be a list of labels or { options, header, multiSelect }')
  }
  if (labels !== undefined && (!Array.isArray(labels) || !labels.every(label => typeof label === 'string' && label.trim() !== ''))) {
    throw new TypeError('$.ui.ask: options must be non-empty strings')
  }
  const given = ((labels as string[] | undefined) ?? []).map(label => sanitizeModUiText(label))
  if (given.length > MOD_ASK_MAX_OPTIONS) throw new TypeError(`$.ui.ask: at most ${MOD_ASK_MAX_OPTIONS} options`)
  if (new Set(given).size !== given.length) throw new TypeError('$.ui.ask: option labels must be unique')
  if (header !== undefined && typeof header !== 'string') throw new TypeError('$.ui.ask: header must be a string')
  if (multiSelect !== undefined && typeof multiSelect !== 'boolean') throw new TypeError('$.ui.ask: multiSelect must be true')
  const picked: ModUiAskOption[] = given.map(label => ({ label }))
  for (const pad of MOD_ASK_PADDING) {
    if (picked.length >= 2) break
    if (!given.includes(pad.label)) picked.push({ ...pad })
  }
  return {
    question: sanitizeModUiText(question),
    ...(typeof header === 'string' && header !== ''
      ? { header: sanitizeModUiText(header.slice(0, MOD_ASK_HEADER_MAX_CHARS)) }
      : {}),
    options: picked,
    multiSelect: multiSelect === true,
  }
}

export type ModUiSnapshot = {
  status: ModStatusLine[]
  notices: ModNoticeLine[]
  /** The questions waiting for the person (`$.ui.ask`); absent when none. */
  asks?: ModUiAsk[]
  /** Absent on a bare `ModUiState` snapshot; `ModRuntime` fills them. */
  panes?: ModUiPane[]
  hooked?: ModUiHookedSite[]
  /** Some loaded hook selects `prompt.edit`; absent when none. */
  editHooked?: true
  /** Some loaded hook selects `prompt.autocomplete`; absent when none. */
  autocompleteHooked?: true
  /** Some loaded hook selects `prompt.change`; absent when none. */
  changeHooked?: true
  turnNote?: ModUiTurnNote
  /** The agent view last asked for (`$.ui.view`); absent before any call. */
  view?: ModAgentView
}

/** A drawing (or every drawing a plugin's matchers may select) is to be
 *  asked for again: a `$.state` value it read changed, or the plugin called
 *  `$.ui.invalidate`. */
export type ModUiStale = { plugin?: string; component?: string; requestId?: string }

export type ModUiEvent =
  | { kind: 'state'; state: ModUiSnapshot }
  | { kind: 'toast'; toast: ModToast }
  | { kind: 'stale'; stale: ModUiStale }
  /** A request to the page's prompt box (`modComposer.ts`). */
  | { kind: 'composer'; composer: ModComposerRequest }
  /** A request to the page's clipboard, focus ring or windows (`modPage.ts`). */
  | { kind: 'page'; page: ModPageRequest }

/** An unpaired surrogate half is drawn as U+FFFD, and the text is bounded. */
export function sanitizeModUiText(text: string): string {
  let out = text.length > MOD_UI_TEXT_MAX_CHARS ? text.slice(0, MOD_UI_TEXT_MAX_CHARS) : text
  // `toWellFormed` where the realm has it; a manual pass otherwise.
  const wellFormed = (out as string & { toWellFormed?: () => string }).toWellFormed
  if (typeof wellFormed === 'function') return wellFormed.call(out)
  let fixed = ''
  for (let i = 0; i < out.length; i += 1) {
    const code = out.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = out.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        fixed += out[i]! + out[i + 1]!
        i += 1
      } else fixed += '�'
    } else if (code >= 0xdc00 && code <= 0xdfff) fixed += '�'
    else fixed += out[i]!
  }
  out = fixed
  return out
}

function askError(name: 'DismissedError' | 'NotSupportedError' | 'AbortError', message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

type PendingAsk = { ask: ModUiAsk; settle: (outcome: { answer: string } | { error: Error }) => void }

let viewSeq = 0

export class ModUiState {
  private readonly status = new Map<string, string>()
  private readonly notices = new Map<string, { plugin: string; text: string }>()
  private readonly asks = new Map<string, PendingAsk>()
  private nextAsk = 0
  private view: ModAgentView | undefined

  /** `canAsk`: a page draws this session, so `$.ui.ask` has someone to ask.
   *  Without it (a headless build, a sub-agent's slot) the call rejects.
   *  `onAsking`: a question opened — the person is being waited on; the
   *  function it returns is called once, when the question closes. */
  constructor(
    private readonly onEvent: (event: ModUiEvent) => void = () => {},
    private readonly options: { canAsk?: boolean; onAsking?: () => () => void } = {},
  ) {}

  /** Whether `$.ui.ask` has someone to ask in this session. */
  canAsk(): boolean {
    return this.options.canAsk === true
  }

  snapshot(): ModUiSnapshot {
    return {
      status: [...this.status.entries()].map(([plugin, text]) => ({ plugin, text })),
      notices: [...this.notices.entries()].map(([toolUseId, line]) => ({ toolUseId, ...line })),
      ...(this.asks.size > 0 ? { asks: [...this.asks.values()].map(pending => pending.ask) } : {}),
      ...(this.view ? { view: this.view } : {}),
    }
  }

  /** `$.ui.view`: the page is asked to show `view`. Each call takes a new
   *  `seq` from one realm-wide count, so a rebuilt slot never repeats the one
   *  a page last read. */
  setView(view: Omit<ModAgentView, 'seq'>): void {
    this.view = { seq: ++viewSeq, ...view }
    this.changed()
  }

  /** The dialog of a `$.ui.ask` for `plugin` — the call's core: shown until
   *  the person answers or dismisses it, the call is abandoned, the plugin's
   *  seat goes, or the session ends. */
  openAsk(plugin: string, args: ModUiAskArgs, signal?: AbortSignal): Promise<string> {
    if (!this.options.canAsk) {
      return Promise.reject(askError('NotSupportedError', '$.ui.ask: no one to ask — this session is drawn on no page'))
    }
    if (signal?.aborted) return Promise.reject(askError('AbortError', '$.ui.ask: the call was abandoned'))
    const requestId = `a${++this.nextAsk}`
    return new Promise<string>((resolve, reject) => {
      const closed = this.options.onAsking?.()
      const abort = (): void => {
        if (this.asks.delete(requestId)) this.changed()
        closed?.()
        reject(askError('AbortError', '$.ui.ask: the call was abandoned'))
      }
      this.asks.set(requestId, {
        ask: { ...args, options: args.options.map(option => ({ ...option })), requestId, plugin },
        settle: outcome => {
          signal?.removeEventListener('abort', abort)
          closed?.()
          if ('answer' in outcome) resolve(outcome.answer)
          else reject(outcome.error)
        },
      })
      signal?.addEventListener('abort', abort, { once: true })
      this.changed()
    })
  }

  /** A page's answer. False when nothing waits for it (answered already, by
   *  another page) or the answer is empty. */
  answerAsk(answer: ModUiAskAnswer): boolean {
    const pending = this.asks.get(answer.requestId)
    if (!pending) return false
    if ('dismissed' in answer) {
      this.asks.delete(answer.requestId)
      this.changed()
      pending.settle({ error: askError('DismissedError', '$.ui.ask: the question was dismissed') })
      return true
    }
    if (typeof answer.answer !== 'string' || answer.answer.trim() === '') return false
    this.asks.delete(answer.requestId)
    this.changed()
    pending.settle({ answer: answer.answer })
    return true
  }

  /** Every question of `plugin` (every one, `plugin` undefined) rejects:
   *  there is no longer anyone to hand the answer to. */
  private dropAsks(plugin: string | undefined, why: string): boolean {
    let dropped = false
    for (const [requestId, pending] of [...this.asks]) {
      if (plugin !== undefined && pending.ask.plugin !== plugin) continue
      this.asks.delete(requestId)
      pending.settle({ error: askError('AbortError', `$.ui.ask: ${why}`) })
      dropped = true
    }
    return dropped
  }

  private changed(): void {
    this.onEvent({ kind: 'state', state: this.snapshot() })
  }

  /** `$.ui.status(text)`: the plugin's one line; `undefined` clears it. */
  setStatus(plugin: string, text: string | undefined): void {
    if (text === undefined) {
      if (!this.status.delete(plugin)) return
    } else {
      const clean = sanitizeModUiText(text)
      if (this.status.get(plugin) === clean) return
      this.status.set(plugin, clean)
    }
    this.changed()
  }

  /** `$.ui.toast(text, { timeoutMs })`. */
  toast(plugin: string, text: string, timeoutMs?: number): void {
    const stay =
      typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.min(timeoutMs, MOD_TOAST_MAX_TIMEOUT_MS)
        : MOD_TOAST_DEFAULT_TIMEOUT_MS
    this.onEvent({ kind: 'toast', toast: { plugin, text: sanitizeModUiText(text), timeoutMs: stay } })
  }

  /** `$.ui.notice(tool_use_id, text)`: one line per call; `undefined`
   *  removes it. The LAST plugin to write a call's line owns it. */
  setNotice(plugin: string, toolUseId: string, text: string | undefined): void {
    if (text === undefined) {
      const held = this.notices.get(toolUseId)
      if (!held || held.plugin !== plugin) return
      this.notices.delete(toolUseId)
    } else {
      this.notices.set(toolUseId, { plugin, text: sanitizeModUiText(text) })
    }
    this.changed()
  }

  /** "Core removes the line when the call resolves." */
  clearNotice(toolUseId: string): void {
    if (this.notices.delete(toolUseId)) this.changed()
  }

  /** A seat is gone: its status line and its notices go with it. */
  clearPlugin(plugin: string): void {
    let changed = this.dropAsks(plugin, 'the plugin was unloaded')
    if (this.status.delete(plugin)) changed = true
    for (const [toolUseId, line] of this.notices) {
      if (line.plugin !== plugin) continue
      this.notices.delete(toolUseId)
      changed = true
    }
    if (changed) this.changed()
  }

  clear(): void {
    const dropped = this.dropAsks(undefined, 'the session ended')
    if (this.status.size === 0 && this.notices.size === 0) {
      if (dropped) this.changed()
      return
    }
    this.status.clear()
    this.notices.clear()
    this.changed()
  }
}

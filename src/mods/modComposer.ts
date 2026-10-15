/**
 * `$.prompt.read`, `.fill`, `.suggest` (F-25): the prompt box is the PAGE's, so each
 * core is a round trip over `mods/ui/<sessionId>` answered by `mods.composerAnswer`.
 * A session no page draws a composer for answers as headless.
 */

/** `PromptBox`: the draft and the cursor, a UTF-16 offset into it. */
export type PromptBox = { text: string; cursor: number }

/** `PromptFillMode`. */
export type PromptFillMode = 'replace' | 'append' | 'insert'
export const PROMPT_FILL_MODES: readonly PromptFillMode[] = ['replace', 'append', 'insert']

/** `PromptDecoration`: `[start, end)` and the paint. Carried down the chain
 *  as given; Velloc's composer paints none (F-25). */
export type PromptDecoration = { start: number; end: number } & Record<string, unknown>

/** `$.prompt.fill(args)` — `PromptFillArgs`. */
export type PromptFillArgs = { text: string; mode?: PromptFillMode; decorations?: PromptDecoration[] }

/** `$.prompt.suggest(args)` — `PromptSuggestArgs`. */
export type PromptSuggestArgs = { text: string }

/** Why the engine itself refused a fill — `PromptFillResult.refusal`. */
export type PromptFillRefusal = 'no_composer' | 'dialog'

/** What `$.prompt.fill` resolves to — `PromptFilled`. */
export type PromptFilled = { isFilled: boolean; refusal?: PromptFillRefusal } & PromptBox

/** What the runtime asks of the page's box. */
export type ModComposerAsk =
  | { op: 'read' }
  | { op: 'fill'; text: string; mode: PromptFillMode }
  | { op: 'suggest'; text: string }

/** One request to the page. */
export type ModComposerRequest = ModComposerAsk & { requestId: string }

/** The page's answer. A page that draws no composer for the session does not
 *  answer; the request then times out as headless. */
export type ModComposerAnswer =
  | { requestId: string; op: 'read'; box: PromptBox }
  | { requestId: string; op: 'fill'; isFilled: boolean; refusal?: PromptFillRefusal; box: PromptBox }
  | { requestId: string; op: 'suggest'; isShown: boolean }

/** What `$.prompt.read` / `fill` / `suggest` need of the session: the box,
 *  one round trip each. Absent (a headless build): answered as headless. */
export type ModComposerHost = {
  read(signal?: AbortSignal): Promise<PromptBox>
  fill(input: { text: string; mode: PromptFillMode }, signal?: AbortSignal): Promise<{ isFilled: boolean; refusal?: PromptFillRefusal; box: PromptBox }>
  suggest(input: { text: string }, signal?: AbortSignal): Promise<{ isShown: boolean }>
}

export const EMPTY_PROMPT_BOX: PromptBox = Object.freeze({ text: '', cursor: 0 }) as PromptBox

/** How long a request waits for a page before answering as headless. A
 *  window in the background or behind another one runs its timers seconds
 *  late, and its answer still names a box that took the fill. */
export const MOD_COMPOSER_TIMEOUT_MS = 5_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isPromptBox(value: unknown): value is PromptBox {
  return (
    isRecord(value) &&
    typeof value.text === 'string' &&
    typeof value.cursor === 'number' &&
    Number.isInteger(value.cursor) &&
    value.cursor >= 0 &&
    value.cursor <= value.text.length
  )
}

/** "The box takes it without the code points a terminal draws as nothing":
 *  the C0 and C1 controls but the line feed and the tab, and DEL. */
export function withoutInvisible(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')
}

function isDecoration(value: unknown): value is PromptDecoration {
  return isRecord(value) && typeof value.start === 'number' && typeof value.end === 'number'
}

export function promptFillArgsOf(value: unknown): PromptFillArgs {
  if (!isRecord(value)) throw new TypeError('$.prompt.fill(args): args must be { text, mode?, decorations? }')
  const { text, mode, decorations } = value
  if (typeof text !== 'string') throw new TypeError('$.prompt.fill: text must be a string')
  if (mode !== undefined && !PROMPT_FILL_MODES.includes(mode as PromptFillMode)) {
    throw new TypeError("$.prompt.fill: mode is 'replace', 'append' or 'insert'")
  }
  if (decorations !== undefined && (!Array.isArray(decorations) || !decorations.every(isDecoration))) {
    throw new TypeError('$.prompt.fill: decorations must be a list of { start, end, … }')
  }
  if (value.origin !== undefined) throw new TypeError("$.prompt.fill: origin is the engine's to set")
  return {
    text,
    ...(mode !== undefined ? { mode: mode as PromptFillMode } : {}),
    ...(decorations !== undefined ? { decorations: (decorations as PromptDecoration[]).map(d => ({ ...d })) } : {}),
  }
}

export function promptSuggestArgsOf(value: unknown): PromptSuggestArgs {
  if (!isRecord(value) || typeof value.text !== 'string') {
    throw new TypeError('$.prompt.suggest(args): args must be { text }')
  }
  if (value.origin !== undefined) throw new TypeError("$.prompt.suggest: origin is the engine's to set")
  return { text: value.text }
}

/**
 * The box after a fill — `PromptFillMode`: "`replace` empties the box first
 * and leaves the cursor at the text's end; `append` keeps the draft and adds
 * the text after it, cursor at the end; `insert` splices the text in at the
 * cursor and moves the cursor past it".
 */
export function fillBox(box: PromptBox, text: string, mode: PromptFillMode): PromptBox {
  const cursor = Math.max(0, Math.min(box.cursor, box.text.length))
  switch (mode) {
    case 'replace':
      return { text, cursor: text.length }
    case 'append': {
      const next = box.text + text
      return { text: next, cursor: next.length }
    }
    case 'insert':
      return { text: box.text.slice(0, cursor) + text + box.text.slice(cursor), cursor: cursor + text.length }
  }
}

/**
 * The runtime's half of the round trip: a request pushed to the page and the
 * first answer that names it. A request no page answers within the timeout is
 * answered as headless — a session open in no window has no box.
 */
export class ModComposerBridge implements ModComposerHost {
  private readonly pending = new Map<string, { op: ModComposerRequest['op']; settle: (answer: ModComposerAnswer | null) => void }>()
  private next = 0
  private disposed = false

  constructor(
    private readonly push: (request: ModComposerRequest) => void,
    private readonly timeoutMs: number = MOD_COMPOSER_TIMEOUT_MS,
  ) {}

  private ask(request: ModComposerAsk, signal?: AbortSignal): Promise<ModComposerAnswer | null> {
    if (this.disposed) return Promise.resolve(null)
    const requestId = `c${++this.next}`
    return new Promise<ModComposerAnswer | null>((resolve, reject) => {
      const done = (answer: ModComposerAnswer | null): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        this.pending.delete(requestId)
        resolve(answer)
      }
      const abort = (): void => {
        clearTimeout(timer)
        this.pending.delete(requestId)
        const error = new Error('the call was abandoned')
        error.name = 'AbortError'
        reject(error)
      }
      if (signal?.aborted) {
        abort()
        return
      }
      const timer = setTimeout(() => done(null), this.timeoutMs)
      signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(requestId, { op: request.op, settle: done })
      try {
        this.push({ ...request, requestId })
      } catch {
        done(null)
      }
    })
  }

  /** A page's answer. False when nothing waits for it (late, or another
   *  page answered first) or it does not match the request. */
  answer(answer: ModComposerAnswer): boolean {
    const waiting = this.pending.get(answer.requestId)
    if (!waiting || waiting.op !== answer.op) return false
    if ((answer.op === 'read' || answer.op === 'fill') && !isPromptBox(answer.box)) return false
    waiting.settle(answer)
    return true
  }

  async read(signal?: AbortSignal): Promise<PromptBox> {
    const answer = await this.ask({ op: 'read' }, signal)
    return answer?.op === 'read' ? answer.box : { ...EMPTY_PROMPT_BOX }
  }

  async fill(
    input: { text: string; mode: PromptFillMode },
    signal?: AbortSignal,
  ): Promise<{ isFilled: boolean; refusal?: PromptFillRefusal; box: PromptBox }> {
    const answer = await this.ask({ op: 'fill', text: input.text, mode: input.mode }, signal)
    if (answer?.op !== 'fill') return { isFilled: false, refusal: 'no_composer', box: { ...EMPTY_PROMPT_BOX } }
    return {
      isFilled: answer.isFilled === true,
      ...(answer.isFilled !== true && (answer.refusal === 'dialog' || answer.refusal === 'no_composer')
        ? { refusal: answer.refusal }
        : {}),
      box: answer.box,
    }
  }

  async suggest(input: { text: string }, signal?: AbortSignal): Promise<{ isShown: boolean }> {
    const answer = await this.ask({ op: 'suggest', text: input.text }, signal)
    return { isShown: answer?.op === 'suggest' && answer.isShown === true }
  }

  /** Every pending request answers as headless. */
  dispose(): void {
    this.disposed = true
    for (const waiting of [...this.pending.values()]) waiting.settle(null)
    this.pending.clear()
  }
}

/** A box answered for a session with none — `read` never rejects. */
export const HEADLESS_COMPOSER: ModComposerHost = {
  read: async () => ({ ...EMPTY_PROMPT_BOX }),
  fill: async () => ({ isFilled: false, refusal: 'no_composer', box: { ...EMPTY_PROMPT_BOX } }),
  suggest: async () => ({ isShown: false }),
}

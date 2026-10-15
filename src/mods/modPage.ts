/**
 * `$.ui.copy`, `$.ui.focus`, `$.ui.scroll` (F-25): op events whose cores are round
 * trips to the page (`mods.pageAnswer`). A copy takes every path it has (the host
 * clipboard, then each page's clipboard API and `execCommand`); `isCopied` is true
 * when any took it. A transcript row scrolls only in answer to the person's own
 * input.
 */
import type { ModDispatcher } from './ModDispatcher'
import type { DispatchContext } from './modTypes'

/** How long the runtime waits for a page's answer. A page that draws no
 *  thread for the session never answers. */
export const MOD_PAGE_TIMEOUT_MS = 4_000
/** After one page failed, how long another has to succeed before the
 *  failure is the answer. */
export const MOD_PAGE_GRACE_MS = 300
/** How long the host's clipboard write may take before it counts as failed. */
export const MOD_HOST_CLIPBOARD_TIMEOUT_MS = 2_000
/** How long the page waits for an element not yet drawn ("awaited, bounded"). */
export const MOD_PAGE_ELEMENT_WAIT_MS = 1_000
/** How long a page whose first two clipboard paths failed waits for focus
 *  to come back and tries the clipboard API again. */
export const MOD_PAGE_FOCUS_WAIT_MS = 2_500

/** `RenderSurface`. Velloc draws on `desktop` alone (`session.surfaces`). */
export const MOD_RENDER_SURFACES = ['terminal', 'desktop', 'mobile', 'vscode'] as const
export type ModRenderSurface = (typeof MOD_RENDER_SURFACES)[number]
export const MOD_SESSION_SURFACE: ModRenderSurface = 'desktop'

/** The sites that keep a focus ring and a window: a pane's body, the band. */
export type ModPageComponent = 'Pane' | 'AbovePrompt'
/** The band's one id, as its `ui.render` hook sees it. */
export const MOD_BAND_ID = 'band'

export type ModScrollTarget = { key: string } | { requestId: string } | 'start' | 'end'
export const MOD_SCROLL_BLOCKS = ['start', 'center', 'end', 'nearest'] as const
export type ModScrollBlock = (typeof MOD_SCROLL_BLOCKS)[number]

/** `$.ui.copy`'s argument and the `ui.copy` event's `e`. */
export type UiCopyArgs = { text: string; surface: ModRenderSurface }
/** What `$.ui.copy` resolves to. */
export type UiCopyResult = { isCopied: true } | { isCopied: false; reason: 'no-surface' | 'no-clipboard' | 'refused' }
/** `$.ui.focus`'s argument. */
export type UiFocusArgs = { requestId: string; key: string }
/** `$.ui.scroll`'s argument, `block` filled in. */
export type UiScrollArgs = { to: ModScrollTarget; in?: string; block: ModScrollBlock }
/** What `$.ui.focus` and `$.ui.scroll` resolve to, and what their events'
 *  hooks answer. */
export type UiMoveResult = { deny?: string }

/** One window as the page measured it, in rows: where it is, where the
 *  target would put it, how many rows it shows and how many the tree has. */
export type ModScrollMeasured = {
  component: ModPageComponent
  site: string
  current: number
  offset: number
  bodyRows: number
  contentRows: number
}

/** What the runtime asks of the page. */
export type ModPageAsk =
  | { op: 'copy'; text: string; hostCopied: boolean }
  | { op: 'focus'; plugin: string; component: ModPageComponent; site: string; key: string; holdsKeys: boolean }
  | { op: 'scrollMeasure'; plugin: string; to: ModScrollTarget; in?: string; block: ModScrollBlock }
  | { op: 'scrollApply'; component: ModPageComponent; site: string; offset: number; stickToEnd: boolean }
  | { op: 'scrollRow'; row: string; block: ModScrollBlock }

export type ModPageRequest = ModPageAsk & { requestId: string }

/** The page's answer. */
export type ModPageAnswer =
  | { requestId: string; op: 'copy'; isCopied: boolean }
  | { requestId: string; op: 'focus'; deny?: string }
  | { requestId: string; op: 'scrollMeasure'; deny?: string; measured?: ModScrollMeasured; row?: string }
  | { requestId: string; op: 'scrollApply'; deny?: string }
  | { requestId: string; op: 'scrollRow'; deny?: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function named(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

/** Whether an answer is the one the request wanted: a copy that took, a
 *  move that was not denied. Another page may still succeed where one
 *  failed (a remote page's clipboard, the window that shows the pane). */
function succeeded(answer: ModPageAnswer): boolean {
  if (answer.op === 'copy') return answer.isCopied
  return answer.deny === undefined
}

function isMeasured(value: unknown): value is ModScrollMeasured {
  return (
    isRecord(value) &&
    (value.component === 'Pane' || value.component === 'AbovePrompt') &&
    typeof value.site === 'string' &&
    ['current', 'offset', 'bodyRows', 'contentRows'].every(
      field => typeof value[field] === 'number' && Number.isInteger(value[field]) && (value[field] as number) >= 0,
    )
  )
}

/**
 * The page round trip. Every page drawing the session hears each request;
 * the first that succeeds settles it, and a failure settles it only once no
 * other page succeeded within `MOD_PAGE_GRACE_MS` — or at the timeout, with
 * null when no page answered at all.
 */
export class ModPageBridge {
  private readonly pending = new Map<
    string,
    { op: ModPageAsk['op']; settle: (answer: ModPageAnswer | null) => void; failed?: ModPageAnswer; grace?: ReturnType<typeof setTimeout> }
  >()
  private next = 0
  private disposed = false

  constructor(
    private readonly push: (request: ModPageRequest) => void,
    private readonly timeoutMs: number = MOD_PAGE_TIMEOUT_MS,
    private readonly graceMs: number = MOD_PAGE_GRACE_MS,
  ) {}

  ask(request: ModPageAsk, signal?: AbortSignal): Promise<ModPageAnswer | null> {
    if (this.disposed) return Promise.resolve(null)
    const requestId = `p${++this.next}`
    return new Promise<ModPageAnswer | null>((resolve, reject) => {
      const done = (answer: ModPageAnswer | null): void => {
        const waiting = this.pending.get(requestId)
        if (waiting?.grace) clearTimeout(waiting.grace)
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        this.pending.delete(requestId)
        resolve(answer)
      }
      const abort = (): void => {
        const waiting = this.pending.get(requestId)
        if (waiting?.grace) clearTimeout(waiting.grace)
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(named('AbortError', 'the call was abandoned'))
      }
      if (signal?.aborted) {
        abort()
        return
      }
      const timer = setTimeout(() => done(this.pending.get(requestId)?.failed ?? null), this.timeoutMs)
      signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(requestId, { op: request.op, settle: done })
      try {
        this.push({ ...request, requestId } as ModPageRequest)
      } catch {
        done(null)
      }
    })
  }

  /** A page's answer. False when nothing waits for it, or it does not match
   *  the request. */
  answer(answer: ModPageAnswer): boolean {
    const waiting = this.pending.get(answer.requestId)
    if (!waiting || waiting.op !== answer.op) return false
    if (answer.op === 'scrollMeasure' && answer.deny === undefined && !isMeasured(answer.measured) && typeof answer.row !== 'string') {
      return false
    }
    if (succeeded(answer)) {
      waiting.settle(answer)
      return true
    }
    if (waiting.failed === undefined) {
      waiting.failed = answer
      waiting.grace = setTimeout(() => waiting.settle(answer), this.graceMs)
    }
    return true
  }

  /** Every pending request settles as unanswered. */
  dispose(): void {
    this.disposed = true
    for (const waiting of [...this.pending.values()]) waiting.settle(null)
    this.pending.clear()
  }
}

/** The host's clipboard, from the runtime (`ui.writeClipboard`): true when
 *  the text is on it. */
export type ModClipboardHost = { write(text: string): Promise<boolean> }

/** What the three nouns need of the slot (`ModRuntime` supplies it). */
export type ModPageHost = {
  /** Core of `ui.copy`: every clipboard path there is (see the header). */
  copy(text: string, signal?: AbortSignal): Promise<UiCopyResult>
  /** One round trip to the pages; null when none answered. Absent: no page
   *  draws this session. */
  ask?(request: ModPageAsk, signal?: AbortSignal): Promise<ModPageAnswer | null>
  /** `requestId` as one of `plugin`'s sites: the band, or a pane it opened —
   *  and whether that site holds the keyboard (a pane opened with `focus`). */
  site(plugin: string, requestId: string): { component: ModPageComponent; holdsKeys: boolean } | undefined
  /** A person's press, typing or pick is being answered in this session. */
  answersPerson(): boolean
}

/**
 * Core of `ui.copy` for the session's own surface: the host's clipboard
 * first, then the pages', as the header says. `pages` absent: no page draws
 * the session. `host` absent: the host has no clipboard to write (an older
 * binary, a dev host).
 */
export async function copyEverywhere(
  text: string,
  paths: { host?: ModClipboardHost; pages?: ModPageHost['ask'] },
  signal?: AbortSignal,
): Promise<UiCopyResult> {
  let hostCopied = false
  if (paths.host) {
    let timer: ReturnType<typeof setTimeout> | undefined
    hostCopied = await Promise.race([
      paths.host.write(text).then(
        ok => ok === true,
        () => false,
      ),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), MOD_HOST_CLIPBOARD_TIMEOUT_MS)
      }),
    ])
    clearTimeout(timer)
  }
  if (signal?.aborted) throw named('AbortError', 'the call was abandoned')
  if (paths.pages) {
    const answered = paths.pages({ op: 'copy', text, hostCopied }, signal)
    // The host took it: the pages copy for their own devices, and the call
    // does not wait on them.
    if (hostCopied) {
      answered.catch(() => {})
      return { isCopied: true }
    }
    const answer = await answered
    if (answer?.op === 'copy' && answer.isCopied) return { isCopied: true }
    return { isCopied: false, reason: 'no-clipboard' }
  }
  if (hostCopied) return { isCopied: true }
  return paths.host ? { isCopied: false, reason: 'no-clipboard' } : { isCopied: false, reason: 'no-surface' }
}

// ── the nouns' arguments ──

/** `$.ui.copy(args)`: `{ text, surface? }`, `surface` filled with the
 *  session's first. */
export function uiCopyArgsOf(value: unknown): UiCopyArgs {
  if (!isRecord(value) || typeof value.text !== 'string') {
    throw new TypeError('$.ui.copy({ text, surface }): text must be a string')
  }
  const surface = value.surface
  if (surface !== undefined && !(MOD_RENDER_SURFACES as readonly unknown[]).includes(surface)) {
    throw new TypeError(`$.ui.copy: surface must be one of ${MOD_RENDER_SURFACES.join(', ')}`)
  }
  return { text: value.text, surface: (surface as ModRenderSurface | undefined) ?? MOD_SESSION_SURFACE }
}

export function isUiCopyResult(value: unknown): value is UiCopyResult {
  if (!isRecord(value)) return false
  if (value.isCopied === true) return true
  return value.isCopied === false && (value.reason === 'no-surface' || value.reason === 'no-clipboard' || value.reason === 'refused')
}

/** `$.ui.focus(args)`: `{ requestId, key }`. */
export function uiFocusArgsOf(value: unknown): UiFocusArgs {
  if (!isRecord(value) || typeof value.requestId !== 'string' || value.requestId === '') {
    throw new TypeError('$.ui.focus({ requestId, key }): requestId must be a non-empty string')
  }
  if (typeof value.key !== 'string' || value.key === '') {
    throw new TypeError('$.ui.focus({ requestId, key }): key must be a non-empty string')
  }
  return { requestId: value.requestId, key: value.key }
}

function scrollTargetOf(to: unknown): ModScrollTarget {
  if (to === 'start' || to === 'end') return to
  if (isRecord(to) && typeof to.key === 'string' && to.key !== '' && to.requestId === undefined) return { key: to.key }
  if (isRecord(to) && typeof to.requestId === 'string' && to.requestId !== '' && to.key === undefined) {
    return { requestId: to.requestId }
  }
  throw new TypeError('$.ui.scroll({ to }): to must be "start", "end", { key } or { requestId }')
}

/** `$.ui.scroll(args)`: `{ to, in?, block? }`, `block` `nearest` when left
 *  out; `in` required with `start` and `end`. */
export function uiScrollArgsOf(value: unknown): UiScrollArgs {
  if (!isRecord(value)) throw new TypeError('$.ui.scroll({ to, in, block }): takes an object')
  const to = scrollTargetOf(value.to)
  if (value.in !== undefined && (typeof value.in !== 'string' || value.in === '')) {
    throw new TypeError('$.ui.scroll: in must be a non-empty string')
  }
  if ((to === 'start' || to === 'end') && value.in === undefined) {
    throw new TypeError(`$.ui.scroll: to "${to}" needs in, the site to scroll`)
  }
  const block = value.block ?? 'nearest'
  if (!(MOD_SCROLL_BLOCKS as readonly unknown[]).includes(block)) {
    throw new TypeError(`$.ui.scroll: block must be one of ${MOD_SCROLL_BLOCKS.join(', ')}`)
  }
  return { to, ...(value.in !== undefined ? { in: value.in as string } : {}), block: block as ModScrollBlock }
}

function isMoveResult(value: unknown): value is UiMoveResult {
  return isRecord(value) && (value.deny === undefined || (typeof value.deny === 'string' && value.deny !== ''))
}

function moveResultOf(value: unknown): UiMoveResult {
  return isRecord(value) && typeof value.deny === 'string' && value.deny !== '' ? { deny: value.deny } : {}
}

// ── the nouns ──

/** What a noun's run is handed (`modNouns.ts`). */
export type ModPageCall = {
  plugin: string
  context: DispatchContext
  signal?: AbortSignal
  host: ModPageHost
  dispatcher: Pick<ModDispatcher, 'dispatch' | 'hasHooksFor'>
  report: (line: string) => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Every key of `e` but `free` is pinned: a rewrite that changes one fails
 *  the hook. */
function checkPinned(arrived: unknown, e: Record<string, unknown>, free: string): Record<string, unknown> {
  const got = isRecord(arrived) ? arrived : {}
  for (const [field, value] of Object.entries(e)) {
    if (field === free || !(field in got)) continue
    if (JSON.stringify(got[field]) !== JSON.stringify(value)) {
      throw new Error(`the rewritten event is refused: ${field} is pinned`)
    }
  }
  for (const field of Object.keys(got)) {
    if (!(field in e) && field !== free) throw new Error(`the rewritten event is refused: ${field} is not the event's`)
  }
  return got
}

/**
 * `$.ui.copy`: `ui.copy` raised with the caller's context, core the
 * clipboard of the surface `e.surface` names — Velloc's `desktop`, or
 * `no-surface` for any other. A `{ deny }` is `reason: 'refused'`; a chain
 * that fails copies as the plugin asked.
 */
export async function uiCopy(args: UiCopyArgs, call: ModPageCall): Promise<UiCopyResult> {
  const core = async (arrived: unknown): Promise<UiCopyResult> => {
    const got = isRecord(arrived) ? arrived : {}
    const text = typeof got.text === 'string' ? got.text : args.text
    const surface = got.surface === undefined ? args.surface : got.surface
    if (surface !== MOD_SESSION_SURFACE) return { isCopied: false, reason: 'no-surface' }
    return call.host.copy(text, call.signal)
  }
  if (!call.dispatcher.hasHooksFor('ui.copy')) return core(args)
  try {
    const result = (await call.dispatcher.dispatch('ui.copy', { ...args }, async arrived => ({ value: await core(arrived) }), {
      context: call.context,
      ...(call.signal ? { signal: call.signal } : {}),
      accepts: r =>
        isRecord(r) &&
        (typeof r.deny === 'string' ? r.deny !== '' && r.value === undefined : r.deny === undefined && isUiCopyResult(r.value)),
    })) as { value?: UiCopyResult; deny?: string }
    if (typeof result.deny === 'string') return { isCopied: false, reason: 'refused' }
    return result.value as UiCopyResult
  } catch (error) {
    if (call.signal?.aborted) throw error
    call.report(`mods: ui.copy (${call.plugin}) failed: ${messageOf(error)}; the text is copied as asked`)
    return core(args)
  }
}

/**
 * `$.ui.focus`: `ui.focus` with origin `plugin`, core the page's ring — the
 * element `plugin` drew under `e.element` in the site, focused while the
 * site holds the keyboard. The site is one of the caller's: the band, or a
 * pane it opened.
 */
export async function uiFocus(args: UiFocusArgs, call: ModPageCall): Promise<UiMoveResult> {
  const site = call.host.site(call.plugin, args.requestId)
  if (!site) return { deny: `${args.requestId} is not one of ${call.plugin}'s sites (its panes, the band)` }
  const ask = call.host.ask
  if (!ask) return { deny: 'no page draws this session' }
  const e = {
    component: site.component,
    requestId: args.requestId,
    plugin: call.plugin,
    element: args.key,
    origin: { kind: 'plugin', name: call.plugin },
  }
  const core = async (arrived: unknown): Promise<UiMoveResult> => {
    const got = checkPinned(arrived, e, 'element')
    const element = typeof got.element === 'string' && got.element !== '' ? got.element : args.key
    const answer = await ask(
      { op: 'focus', plugin: call.plugin, component: site.component, site: args.requestId, key: element, holdsKeys: site.holdsKeys },
      call.signal,
    )
    if (!answer) return { deny: 'no page answered' }
    return moveResultOf(answer)
  }
  if (!call.dispatcher.hasHooksFor('ui.focus')) return core(e)
  return raiseMove('ui.focus', e, core, call)
}

/** Raise `ui.focus` / `ui.scroll`: what the chain answers, `{}` or
 *  `{ deny }`; a chain that fails is a `{ deny }` naming why. */
async function raiseMove(
  event: 'ui.focus' | 'ui.scroll',
  e: Record<string, unknown>,
  core: (arrived: unknown) => Promise<UiMoveResult>,
  call: ModPageCall,
): Promise<UiMoveResult> {
  try {
    const result = await call.dispatcher.dispatch(event, e, core, {
      context: call.context,
      ...(call.signal ? { signal: call.signal } : {}),
      accepts: isMoveResult,
    })
    return moveResultOf(result)
  } catch (error) {
    if (call.signal?.aborted) throw error
    call.report(`mods: ${event} (${call.plugin}) failed: ${messageOf(error)}`)
    return { deny: messageOf(error) }
  }
}

/**
 * `$.ui.scroll`: a site of the caller's moves under `ui.scroll` (origin
 * `plugin`, `offset` the hook's to rewrite), core the page's window; a
 * transcript row, a render instance by `requestId`, is revealed only while
 * the call answers the person's own input.
 */
export async function uiScroll(args: UiScrollArgs, call: ModPageCall): Promise<UiMoveResult> {
  const ask = call.host.ask
  if (args.in !== undefined && !call.host.site(call.plugin, args.in)) {
    return { deny: `${args.in} is not one of ${call.plugin}'s sites (its panes, the band)` }
  }
  if (!ask) return { deny: 'no page draws this session' }
  if (typeof args.to === 'object' && 'requestId' in args.to) {
    // A render instance: one of the caller's own sites is brought into view
    // where it sits; a transcript row is the person's to move.
    const own = call.host.site(call.plugin, args.to.requestId) !== undefined
    if (!own && !call.host.answersPerson()) return { deny: 'not person-initiated' }
    const answer = await ask({ op: 'scrollRow', row: args.to.requestId, block: args.block }, call.signal)
    return answer ? moveResultOf(answer) : { deny: 'no page answered' }
  }
  const measuredAnswer = await ask(
    { op: 'scrollMeasure', plugin: call.plugin, to: args.to, ...(args.in !== undefined ? { in: args.in } : {}), block: args.block },
    call.signal,
  )
  if (!measuredAnswer) return { deny: 'no page answered' }
  if (measuredAnswer.op !== 'scrollMeasure' || measuredAnswer.deny !== undefined || !measuredAnswer.measured) {
    return { deny: measuredAnswer.op === 'scrollMeasure' && measuredAnswer.deny ? measuredAnswer.deny : 'nothing to scroll' }
  }
  const measured = measuredAnswer.measured
  // A key the caller drew in a site that is not its own (another plugin's
  // pane) is not its to move.
  if (!call.host.site(call.plugin, measured.site)) {
    return { deny: `${measured.site} is not one of ${call.plugin}'s sites (its panes, the band)` }
  }
  const lastOffset = Math.max(0, measured.contentRows - measured.bodyRows)
  const e = {
    component: measured.component,
    requestId: measured.site,
    offset: measured.offset,
    by: measured.offset - measured.current,
    bodyRows: measured.bodyRows,
    contentRows: measured.contentRows,
    origin: { kind: 'plugin', name: call.plugin },
  }
  const core = async (arrived: unknown): Promise<UiMoveResult> => {
    const got = checkPinned(arrived, e, 'offset')
    const asked = typeof got.offset === 'number' && Number.isFinite(got.offset) ? Math.round(got.offset) : e.offset
    // "One past the tree's end lands at the end."
    const offset = Math.max(0, Math.min(asked, lastOffset))
    const answer = await ask(
      {
        op: 'scrollApply',
        component: measured.component,
        site: measured.site,
        offset,
        // "`end` keeps up with a tree that grows … until anything next moves it."
        stickToEnd: args.to === 'end' && offset === lastOffset,
      },
      call.signal,
    )
    return answer ? moveResultOf(answer) : { deny: 'no page answered' }
  }
  if (!call.dispatcher.hasHooksFor('ui.scroll')) return core(e)
  return raiseMove('ui.scroll', e, core, call)
}

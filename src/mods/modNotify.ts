/**
 * `$.ui.notify(text, options)` and `$.ui.cancelNotify(key)` (F-25): the
 * session's `Notification` hooks run, now or when a booking (`delayMs` / `at`)
 * held by the slot's runtime falls due, and the call resolves `no-surface`, as
 * Velloc has no terminal channel. `cancelNotify` drops a booking not yet due.
 * Both are raised as events: a hook above may rewrite, `{ deny }` or answer.
 */

import type { DispatchContext } from './modTypes'

/** The event's `e`: `title` the plugin's name when left out or empty;
 *  `key` names the notification within the plugin; `delayMs` / `at` book it
 *  for later (never both); `untilBack` drops a booked one once the person
 *  returns. */
export type UiNotifyArgs = {
  text: string
  title?: string
  key?: string
  delayMs?: number
  at?: number
  untilBack?: boolean
}

/** `$.ui.cancelNotify(key)`'s event `e`. */
export type UiCancelNotifyArgs = { key: string }

/** What `$.ui.cancelNotify` resolves to: whether a booking not yet due was
 *  dropped. */
export type UiCancelNotifyResult = { isSent: boolean }

/** The furthest a notification may be booked ahead: seven days. */
export const MAX_NOTIFY_DELAY_MS = 7 * 24 * 60 * 60 * 1000
/** The most bookings one plugin holds at once; one past it is refused. */
export const MAX_NOTIFY_BOOKINGS_PER_PLUGIN = 64

export type UiNotifyChannel = 'iterm2' | 'iterm2_with_bell' | 'kitty' | 'ghostty' | 'terminal_bell'
export type UiNotifyReason = 'disabled' | 'no-channel' | 'no-surface' | 'refused'

/** "`{ isSent: true, channel }`, or `{ isSent: false, reason }`". */
export type UiNotifyResult =
  | { isSent: true; channel: UiNotifyChannel }
  | { isSent: false; reason: UiNotifyReason }

/** The `notification_type` the `Notification` hooks read for a plugin's notice. */
export const PLUGIN_NOTIFICATION_TYPE = 'plugin_notification'

export type ModNotice = { message: string; title: string }

/** What `$.ui.notify` needs: the session's `Notification` hooks for one
 *  notice, raised under the caller's `context` so its own hook is left out.
 *  Resolves once they ran; none run while the session is unbound.
 *  `bookings` absent: a booked notice runs its hooks at once. */
export type ModNotifyHost = {
  runHooks(notice: ModNotice, context: DispatchContext): Promise<void>
  bookings?: ModNotifyBookings
}

type Booking = {
  plugin: string
  key?: string
  untilBack: boolean
  /** The person runs begun before it was booked. */
  runs: number
  timer: ReturnType<typeof setTimeout>
}

/**
 * The booked notices of one session slot, in memory only (F-25). Each fires
 * once, at its due time, through `fire`. A plugin holds at most one booking
 * per `key`: a new one replaces it. A booking lives no longer than the
 * module instance that made it (`dropPlugin`) or the slot (`clear`); an app
 * restart loses every booking.
 */
export class ModNotifyBookings {
  private readonly held = new Set<Booking>()
  private runs = 0

  constructor(
    private readonly fire: (notice: ModNotice, context: DispatchContext) => Promise<void>,
    private readonly report: (line: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  /** Hold `notice` until `delayMs` passed or the clock reads `at`. The
   *  context kept is the caller's own frame, as for any `$` call made past
   *  its hook. */
  book(
    plugin: string,
    notice: ModNotice,
    when: { delayMs?: number; at?: number },
    options: { key?: string; untilBack?: boolean },
    context: DispatchContext,
  ): void {
    if (options.key !== undefined) this.cancel(plugin, options.key)
    let mine = 0
    for (const booking of this.held) if (booking.plugin === plugin) mine++
    if (mine >= MAX_NOTIFY_BOOKINGS_PER_PLUGIN) {
      throw new RangeError(`$.ui.notify: ${MAX_NOTIFY_BOOKINGS_PER_PLUGIN} notifications are already booked`)
    }
    const wait = when.delayMs ?? Math.max(0, (when.at ?? 0) - this.now())
    const kept: DispatchContext = {
      origin: context.origin,
      depth: context.depth,
      ...(context.frames && context.frames.length > 0 ? { frames: context.frames.slice(-1) } : {}),
    }
    const booking: Booking = {
      plugin,
      ...(options.key !== undefined ? { key: options.key } : {}),
      untilBack: options.untilBack === true,
      runs: this.runs,
      timer: setTimeout(() => {
        if (!this.held.delete(booking)) return
        this.fire(notice, kept).catch((error: unknown) => {
          this.report(`${plugin}: a booked notification's hooks failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      }, Math.min(wait, MAX_NOTIFY_DELAY_MS)),
    }
    this.held.add(booking)
  }

  /** Drop `plugin`'s booking under `key`; true when one was still held. */
  cancel(plugin: string, key: string): boolean {
    for (const booking of this.held) {
      if (booking.plugin === plugin && booking.key === key) {
        this.drop(booking)
        return true
      }
    }
    return false
  }

  /** The person's own prompt or command begins; the mark `personBack`
   *  takes once it has run. */
  personRunBegins(): number {
    return ++this.runs
  }

  /** The person came back: the run marked `mark` has run, and every
   *  `untilBack` booking made before it began goes. */
  personBack(mark: number): void {
    for (const booking of [...this.held]) if (booking.untilBack && booking.runs < mark) this.drop(booking)
  }

  /** `plugin`'s module instance is gone (disabled, removed, reloaded or
   *  lost): its bookings go with it. */
  dropPlugin(plugin: string): void {
    for (const booking of [...this.held]) if (booking.plugin === plugin) this.drop(booking)
  }

  clear(): void {
    for (const booking of [...this.held]) this.drop(booking)
  }

  get size(): number {
    return this.held.size
  }

  private drop(booking: Booking): void {
    clearTimeout(booking.timer)
    this.held.delete(booking)
  }
}

const CHANNELS: readonly string[] = ['iterm2', 'iterm2_with_bell', 'kitty', 'ghostty', 'terminal_bell']
const REASONS: readonly string[] = ['disabled', 'no-channel', 'no-surface', 'refused']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `e` from the call's arguments; each refusal names the field. `now` is
 *  the clock `at` is measured against. */
export function uiNotifyArgsOf(text: unknown, options: unknown, now: number = Date.now()): UiNotifyArgs {
  if (typeof text !== 'string') throw new TypeError('$.ui.notify(text): text must be a string')
  if (options !== undefined && !isRecord(options)) {
    throw new TypeError('$.ui.notify(text, options): options must be { title?, key?, delayMs?, at?, untilBack? }')
  }
  const { title, key, delayMs, at, untilBack } = isRecord(options) ? options : {}
  if (title !== undefined && typeof title !== 'string') throw new TypeError('$.ui.notify: title must be a string')
  if (key !== undefined && (typeof key !== 'string' || key === '')) throw new TypeError('$.ui.notify: key must be a non-empty string')
  if (delayMs !== undefined && at !== undefined) throw new TypeError('$.ui.notify: give delayMs or at, not both')
  if (delayMs !== undefined) {
    if (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs < 0) {
      throw new TypeError('$.ui.notify: delayMs must be a number of milliseconds, 0 or more')
    }
    if (delayMs > MAX_NOTIFY_DELAY_MS) throw new RangeError('$.ui.notify: delayMs is more than 7 days')
  }
  if (at !== undefined) {
    if (typeof at !== 'number' || !Number.isFinite(at)) throw new TypeError('$.ui.notify: at must be epoch milliseconds')
    if (at - now > MAX_NOTIFY_DELAY_MS) throw new RangeError('$.ui.notify: at is more than 7 days ahead')
  }
  if (untilBack !== undefined && typeof untilBack !== 'boolean') throw new TypeError('$.ui.notify: untilBack must be a boolean')
  return {
    text,
    ...(title !== undefined ? { title } : {}),
    ...(key !== undefined ? { key } : {}),
    ...(delayMs !== undefined ? { delayMs } : {}),
    ...(at !== undefined ? { at } : {}),
    ...(untilBack !== undefined ? { untilBack } : {}),
  }
}

/** `$.ui.cancelNotify(key)`'s `e`. */
export function uiCancelNotifyArgsOf(key: unknown): UiCancelNotifyArgs {
  if (typeof key !== 'string' || key === '') throw new TypeError('$.ui.cancelNotify(key): key must be a non-empty string')
  return { key }
}

/** Whether a hook's answer is one `ui.cancelNotify` takes. */
export function isUiCancelNotifyResult(value: unknown): value is UiCancelNotifyResult {
  return isRecord(value) && typeof value.isSent === 'boolean'
}

/** Core of `ui.cancelNotify`: drops the caller's booking under `key`. */
export function uiCancelNotifyCore(
  e: unknown,
  call: { plugin: string },
  host: ModNotifyHost | undefined,
): UiCancelNotifyResult {
  const key = isRecord(e) && typeof e.key === 'string' ? e.key : ''
  return { isSent: key !== '' && host?.bookings?.cancel(call.plugin, key) === true }
}

/** Whether a hook's answer is one `ui.notify` takes. */
export function isUiNotifyResult(value: unknown): value is UiNotifyResult {
  if (!isRecord(value)) return false
  if (value.isSent === true) return typeof value.channel === 'string' && CHANNELS.includes(value.channel)
  return value.isSent === false && typeof value.reason === 'string' && REASONS.includes(value.reason)
}

/** Core of `ui.notify`: the hooks now, or when a booking falls due; then no
 *  channel on this surface. A hook above may have rewritten `e`, so its
 *  booking fields are read as numbers and nothing more. */
export async function uiNotifyCore(
  e: unknown,
  call: { plugin: string; context: DispatchContext },
  host: ModNotifyHost | undefined,
): Promise<UiNotifyResult> {
  const fields = isRecord(e) ? e : {}
  const text = typeof fields.text === 'string' ? fields.text : ''
  const title = typeof fields.title === 'string' && fields.title !== '' ? fields.title : call.plugin
  const delayMs = typeof fields.delayMs === 'number' && Number.isFinite(fields.delayMs) ? Math.max(0, fields.delayMs) : undefined
  const at = delayMs === undefined && typeof fields.at === 'number' && Number.isFinite(fields.at) ? fields.at : undefined
  if (host?.bookings && (delayMs !== undefined || at !== undefined)) {
    host.bookings.book(
      call.plugin,
      { message: text, title },
      { ...(delayMs !== undefined ? { delayMs } : {}), ...(at !== undefined ? { at } : {}) },
      {
        ...(typeof fields.key === 'string' && fields.key !== '' ? { key: fields.key } : {}),
        untilBack: fields.untilBack === true,
      },
      call.context,
    )
  } else if (host) {
    await host.runHooks({ message: text, title }, call.context)
  }
  return { isSent: false, reason: 'no-surface' }
}

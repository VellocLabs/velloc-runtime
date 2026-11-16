/**
 * `$.ui.notify(text, options)` and `$.ui.cancelNotify(key)` (F-25). The
 * session's `Notification` hooks run first, then the channel writes. Velloc
 * draws on `desktop` alone, with no terminal channel and no host that raises
 * notifications, so the hooks run and the call resolves `{ isSent: false,
 * reason: 'no-surface' }`; a cancel resolves `{ isSent: false }`. Both are
 * raised as events (`ui.notify`, `ui.cancelNotify`): a hook above may rewrite
 * one, `{ deny }` it (the call rejects) or answer it.
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

/** What `$.ui.cancelNotify` resolves to: whether a host was handed it. */
export type UiCancelNotifyResult = { isSent: boolean }

/** The furthest a notification may be booked ahead: seven days. */
export const MAX_NOTIFY_DELAY_MS = 7 * 24 * 60 * 60 * 1000

export type UiNotifyChannel = 'iterm2' | 'iterm2_with_bell' | 'kitty' | 'ghostty' | 'terminal_bell'
export type UiNotifyReason = 'disabled' | 'no-channel' | 'no-surface' | 'refused'

/** "`{ isSent: true, channel }`, or `{ isSent: false, reason }`". */
export type UiNotifyResult =
  | { isSent: true; channel: UiNotifyChannel }
  | { isSent: false; reason: UiNotifyReason }

/** The `notification_type` the `Notification` hooks read for a plugin's notice. */
export const PLUGIN_NOTIFICATION_TYPE = 'plugin_notification'

/** What `$.ui.notify` needs: the session's `Notification` hooks for one
 *  notice, raised under the caller's `context` so its own hook is left out.
 *  Resolves once they ran; none run while the session is unbound. */
export type ModNotifyHost = {
  runHooks(notice: { message: string; title: string }, context: DispatchContext): Promise<void>
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

/** Core of `ui.cancelNotify`: no host holds a notification to take back. */
export function uiCancelNotifyCore(): UiCancelNotifyResult {
  return { isSent: false }
}

/** Whether a hook's answer is one `ui.notify` takes. */
export function isUiNotifyResult(value: unknown): value is UiNotifyResult {
  if (!isRecord(value)) return false
  if (value.isSent === true) return typeof value.channel === 'string' && CHANNELS.includes(value.channel)
  return value.isSent === false && typeof value.reason === 'string' && REASONS.includes(value.reason)
}

/** Core of `ui.notify`: the hooks, then no channel on this surface. */
export async function uiNotifyCore(
  e: unknown,
  call: { plugin: string; context: DispatchContext },
  host: ModNotifyHost | undefined,
): Promise<UiNotifyResult> {
  const text = isRecord(e) && typeof e.text === 'string' ? e.text : ''
  const title = isRecord(e) && typeof e.title === 'string' && e.title !== '' ? e.title : call.plugin
  if (host) await host.runHooks({ message: text, title }, call.context)
  return { isSent: false, reason: 'no-surface' }
}

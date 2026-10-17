/**
 * `$.ui.notify(text, { title })` (F-25): "Their `Notification` hooks run
 * first, reading `plugin_notification`, then the channel writes." Velloc draws
 * on `desktop` alone, with no terminal channel to write to, so the hooks run
 * and the call resolves `{ isSent: false, reason: 'no-surface' }`. Raised as
 * `ui.notify`: a hook above may rewrite it, `{ deny }` it (the call rejects)
 * or answer it.
 */

import type { DispatchContext } from './modTypes'

/** The event's `e`: "`title` the plugin's name when left out or empty". */
export type UiNotifyArgs = { text: string; title?: string }

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

/** `e` from the call's arguments; each refusal names the field. */
export function uiNotifyArgsOf(text: unknown, options: unknown): UiNotifyArgs {
  if (typeof text !== 'string') throw new TypeError('$.ui.notify(text): text must be a string')
  if (options !== undefined && !isRecord(options)) throw new TypeError('$.ui.notify(text, options): options must be { title? }')
  const title = isRecord(options) ? options.title : undefined
  if (title !== undefined && typeof title !== 'string') throw new TypeError('$.ui.notify: title must be a string')
  return { text, ...(title !== undefined ? { title } : {}) }
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

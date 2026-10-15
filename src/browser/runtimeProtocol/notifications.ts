/**
 * The `notifications` topic — what the runtime needs a user told about; each client
 * decides how to show it. Delta-only: a later subscriber gets only later ones.
 */
import type { TopicId } from './frames'

export const NOTIFICATIONS_TOPIC: TopicId = 'notifications'

/** The event `type` on the topic: a turn ending, or a session's mod (hooks
 *  module) that was refused, failed to load or was given up on (F-25). */
export const NOTIFICATION_KINDS = ['turnEnd', 'modState'] as const
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]

export type RuntimeNotification = {
  /** The body text, already in the user's language. */
  message: string
  /** The bold first line — a session title for `turnEnd`. */
  title?: string
  /**
   * Stable category key (`turn_complete`). A host builds its notification id
   * from it, so repeats of one kind replace each other instead of stacking.
   */
  notificationType: string
  /** The session it is about, when it is about one. */
  sessionId?: string
  /**
   * The desktop panel that owns the session, when the runtime knows one (the
   * window that opened it). Every desktop window hears every notification
   * and each used to ask the host for its own OS toast — N windows, N toasts,
   * and the unfocused ones' calls escaped the host's focus suppression. The
   * owning panel alone asks (`notificationIsForPanel`); a client that is not
   * a desktop window ignores it.
   */
  panelId?: string
  /**
   * A `modState` notification's data: the plugin, what became of its hooks
   * module and why. A client that knows the kind composes the line from these
   * in the user's language; `message` is the English fallback.
   */
  mod?: {
    plugin: string
    state: 'loaded' | 'refused' | 'failed' | 'crashed' | 'dead'
    reason?: string
  }
}

export function isRuntimeNotification(value: unknown): value is RuntimeNotification {
  if (!value || typeof value !== 'object') return false
  const notification = value as Record<string, unknown>
  return (
    typeof notification.message === 'string' &&
    typeof notification.notificationType === 'string' &&
    (notification.title === undefined || typeof notification.title === 'string') &&
    (notification.sessionId === undefined || typeof notification.sessionId === 'string') &&
    (notification.panelId === undefined || typeof notification.panelId === 'string') &&
    (notification.mod === undefined || isModNotificationData(notification.mod))
  )
}

function isModNotificationData(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const mod = value as Record<string, unknown>
  return (
    typeof mod.plugin === 'string' &&
    ['loaded', 'refused', 'failed', 'crashed', 'dead'].includes(mod.state as string) &&
    (mod.reason === undefined || typeof mod.reason === 'string')
  )
}

/**
 * Whether the desktop panel `panelId` is the one to turn `notification` into
 * a host toast: the owning panel when the runtime named one, else any panel
 * (a notification about no session, or a session the runtime opened for no
 * particular window).
 */
export function notificationIsForPanel(notification: RuntimeNotification, panelId: string): boolean {
  return notification.panelId === undefined || notification.panelId === panelId
}

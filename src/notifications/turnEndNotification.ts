import type { DesktopAlert } from './desktopNotify'

// Builds the turn-end "your turn" desktop notification: the host supplies the
// branded header, `title` is the session title (omitted before one exists), the
// body is "{product} is waiting for your input" with `productName` injected.
export function buildTurnEndNotification(
  productName: string,
  sessionTitle: string | undefined,
): DesktopAlert {
  const title = sessionTitle?.trim()
  return {
    message: `${productName} is waiting for your input`,
    ...(title ? { title } : {}),
    notificationType: 'turn_complete',
  }
}

/**
 * The `notification_type` the `Notification` hooks (F-7) are told for the
 * turn-end nudge: `idle_prompt`, the hook-facing name for "waiting for the
 * user's input", so a `Notification` hook matcher on `idle_prompt` fires
 * here. The host's own category key stays `turn_complete`.
 */
export const TURN_END_HOOK_NOTIFICATION_TYPE = 'idle_prompt'

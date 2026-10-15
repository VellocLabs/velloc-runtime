// User-attention notifications. Nexus runs in a browser, not a terminal, so
// the dispatch mechanism is injected as a
// `sink`: the SharedWorker wires a sink that calls the host bridge's
// `ui.showNotification` action, which surfaces a native OS notification via
// the browser's NotificationDisplayService. The host decides whether to
// actually display it (it suppresses notifications while the Nexus window
// is focused).

export type DesktopAlert = {
  message: string
  title?: string
  // Stable category key (e.g. "turn_complete"). The host uses it to build
  // the notification id so repeated notifications of the same kind replace
  // each other instead of stacking.
  notificationType: string
}

// The injected dispatch mechanism. Resolves with `{ ok: true }` and never rejects;
// transport / host-out-of-sync failures are absorbed by the sink itself.
export type NotificationSink = (
  opts: DesktopAlert,
) => Promise<{ ok: true }>

/**
 * Send a notification through the provided sink. The dispatch mechanism is
 * injected so this module stays free of transport details. Errors are
 * swallowed: a missing or stale host handler must never break the agent
 * loop.
 */
export async function raiseDesktopAlert(
  notif: DesktopAlert,
  sink: NotificationSink,
): Promise<void> {
  try {
    await sink(notif)
  } catch {
    // Host out of sync (handler missing) or transport down — ignore.
  }
}

/**
 * The guest's last-resort `window.error` / `unhandledrejection` logging. The ResizeObserver loop
 * notice is not a failure, so it is logged at debug level.
 */

/** The messages of the browser's ResizeObserver loop notice — Chromium's
 *  current wording and the older "loop limit exceeded". */
const RESIZE_OBSERVER_LOOP = /^ResizeObserver loop (completed with undelivered notifications|limit exceeded)\.?$/

/** Whether a window `error` event's message is the ResizeObserver loop
 *  notice rather than an error. */
export function isResizeObserverLoopNotice(message: unknown): boolean {
  return typeof message === 'string' && RESIZE_OBSERVER_LOOP.test(message.trim())
}

type ErrorLogger = Pick<Console, 'error' | 'debug'>

/** Log the guest's uncaught errors and rejections: the ResizeObserver loop
 *  notice at debug level, everything else as an error. */
export function installGuestWindowErrorLogging(target: Pick<Window, 'addEventListener'>, log: ErrorLogger = console): void {
  target.addEventListener('error', event => {
    const details = {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    }
    if (isResizeObserverLoopNotice(event.message)) {
      log.debug('[NexusTrace][GuestEntry] window.error (ResizeObserver loop notice, not an error)', details)
      return
    }
    log.error('[NexusTrace][GuestEntry] window.error', details)
  })
  target.addEventListener('unhandledrejection', event => {
    const reason = event.reason
    log.error('[NexusTrace][GuestEntry] unhandledrejection', {
      message: reason instanceof Error ? reason.message : String(reason),
    })
  })
}

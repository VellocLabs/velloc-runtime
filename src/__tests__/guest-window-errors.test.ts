/**
 * The guest's uncaught-error logging (`glic/main.tsx` →
 * `boot/guestWindowErrors.ts`): the browser's ResizeObserver loop notice
 * ("ResizeObserver loop completed with undelivered notifications") is not an
 * error — it was logged with `console.error` and read as a crash report. It
 * is logged at debug level; every other error, and every rejection, as an
 * error.
 */
import { describe, expect, it, vi } from 'vitest'
import { installGuestWindowErrorLogging, isResizeObserverLoopNotice } from '../browser/boot/guestWindowErrors'

function fakeWindow() {
  const listeners = new Map<string, (event: unknown) => void>()
  return {
    target: { addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener) },
    fire: (type: string, event: unknown) => listeners.get(type)?.(event),
  }
}

describe('the ResizeObserver loop notice', () => {
  it("is told apart by the browser's wording, current and older; nothing else matches", () => {
    expect(isResizeObserverLoopNotice('ResizeObserver loop completed with undelivered notifications.')).toBe(true)
    expect(isResizeObserverLoopNotice('ResizeObserver loop limit exceeded')).toBe(true)
    expect(isResizeObserverLoopNotice('Uncaught TypeError: x is undefined')).toBe(false)
    expect(isResizeObserverLoopNotice('ResizeObserver loop completed with undelivered notifications. and more')).toBe(false)
    expect(isResizeObserverLoopNotice(undefined)).toBe(false)
  })

  it('is logged at debug level, not as an error; a real error and a rejection are errors', () => {
    const log = { error: vi.fn(), debug: vi.fn() }
    const { target, fire } = fakeWindow()
    installGuestWindowErrorLogging(target as never, log)
    fire('error', {
      message: 'ResizeObserver loop completed with undelivered notifications.',
      filename: 'https://beta.velloc.app/v1/?nexus=1',
      lineno: 0,
      colno: 0,
    })
    expect(log.error).not.toHaveBeenCalled()
    expect(log.debug).toHaveBeenCalledTimes(1)
    fire('error', { message: 'Uncaught TypeError: boom', filename: 'app.js', lineno: 3, colno: 9 })
    expect(log.error).toHaveBeenCalledWith('[NexusTrace][GuestEntry] window.error', {
      message: 'Uncaught TypeError: boom',
      filename: 'app.js',
      lineno: 3,
      colno: 9,
    })
    fire('unhandledrejection', { reason: new Error('lost') })
    expect(log.error).toHaveBeenLastCalledWith('[NexusTrace][GuestEntry] unhandledrejection', { message: 'lost' })
  })
})

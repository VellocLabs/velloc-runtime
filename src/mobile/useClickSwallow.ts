/**
 * The click that ends a gesture (F-24): a swipe or a long press also produces a click at
 * whatever it lands on. Arm the guard when the gesture is recognised and spread
 * `onClickCapture` on its container, and that click is swallowed instead of activating the
 * element. A gesture whose end is seen later holds the guard until `release`; one that ends
 * as it is recognised uses `armForGesture`. Either way the guard is dropped in the task after
 * the one that dispatches the click, and the gesture's lift drops it wherever it lands.
 */
import { useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react'

export type ClickSwallow = {
  /** Hold the next click back until `release`. */
  arm: () => void
  /** Hold back the click that ends the gesture being handled right now. */
  armForGesture: () => void
  /** Drop the guard now: a new gesture is starting. */
  disarm: () => void
  /** Drop the guard after the current task, past the click the gesture dispatches. */
  release: () => void
  onClickCapture: (event: ReactMouseEvent) => void
}

export function useClickSwallow(): ClickSwallow {
  const armed = useRef(false)
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  const releaseRef = useRef<() => void>(() => {})

  const onWindowPointerEnd = useCallback(() => releaseRef.current(), [])

  const detach = useCallback(() => {
    window.removeEventListener('pointerup', onWindowPointerEnd, true)
    window.removeEventListener('pointercancel', onWindowPointerEnd, true)
  }, [onWindowPointerEnd])

  const release = useCallback(() => {
    detach()
    if (!armed.current) return
    if (pending.current !== null) clearTimeout(pending.current)
    pending.current = setTimeout(() => {
      pending.current = null
      armed.current = false
    }, 0)
  }, [detach])

  releaseRef.current = release

  const arm = useCallback(() => {
    armed.current = true
    // The lift can land on another element, such as a sheet that opened over the gesture,
    // so the guard is also dropped from the window rather than from the gesture alone.
    window.addEventListener('pointerup', onWindowPointerEnd, true)
    window.addEventListener('pointercancel', onWindowPointerEnd, true)
  }, [onWindowPointerEnd])

  const armForGesture = useCallback(() => {
    arm()
    release()
  }, [arm, release])

  const disarm = useCallback(() => {
    detach()
    if (pending.current !== null) {
      clearTimeout(pending.current)
      pending.current = null
    }
    armed.current = false
  }, [detach])

  const onClickCapture = useCallback((event: ReactMouseEvent) => {
    if (!armed.current) return
    detach()
    armed.current = false
    event.preventDefault()
    event.stopPropagation()
  }, [detach])

  useEffect(() => () => {
    detach()
    if (pending.current !== null) clearTimeout(pending.current)
  }, [detach])

  return { arm, armForGesture, disarm, release, onClickCapture }
}

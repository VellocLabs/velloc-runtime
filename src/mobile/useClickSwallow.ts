/**
 * The click that ends a gesture (F-24): a swipe or a long press also produces a click at
 * whatever it lands on. Arm the guard when the gesture is recognised and spread
 * `onClickCapture` on its container, and that click is swallowed instead of activating the
 * element. Arming releases the guard in the task after the one that dispatches the click, so
 * a gesture the browser ends without one cannot swallow a later click.
 */
import { useCallback, useRef, type MouseEvent as ReactMouseEvent } from 'react'

export type ClickSwallow = {
  arm: () => void
  disarm: () => void
  onClickCapture: (event: ReactMouseEvent) => void
}

export function useClickSwallow(): ClickSwallow {
  const armed = useRef(false)

  const arm = useCallback(() => {
    armed.current = true
    setTimeout(() => {
      armed.current = false
    }, 0)
  }, [])

  const disarm = useCallback(() => {
    armed.current = false
  }, [])

  const onClickCapture = useCallback((event: ReactMouseEvent) => {
    if (!armed.current) return
    armed.current = false
    event.preventDefault()
    event.stopPropagation()
  }, [])

  return { arm, disarm, onClickCapture }
}

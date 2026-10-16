/**
 * Dismissal for a surface drawn over the chat (F-9): Escape, or a press
 * outside it, calls `onDismiss` while `active`. Returns the capture handler
 * the surface spreads on its root — React bubbles through portals, so a press
 * in one of its portaled menus still counts as inside. Presses on an element
 * matching `ignoreSelector` (the toggle that opened it, which closes it
 * through its own click) are ignored.
 */
import * as React from 'react'

export function useOverlayDismiss(
  active: boolean,
  onDismiss: () => void,
  ignoreSelector: string,
): { onPointerDownCapture: () => void } {
  const pressInsideRef = React.useRef(false)
  const onDismissRef = React.useRef(onDismiss)
  onDismissRef.current = onDismiss

  React.useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onDismissRef.current()
    }
    const onPress = (event: PointerEvent) => {
      const inside = pressInsideRef.current
      pressInsideRef.current = false
      const target = event.target instanceof Element ? event.target : null
      if (inside || target?.closest(ignoreSelector)) return
      onDismissRef.current()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPress)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPress)
    }
  }, [active, ignoreSelector])

  return React.useMemo(
    () => ({
      onPointerDownCapture: () => {
        pressInsideRef.current = true
      },
    }),
    [],
  )
}

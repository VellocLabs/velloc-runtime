/**
 * The room the phone covers at the bottom of the page, as the conversation
 * view's `--thread-bottom-inset` (F-24): the soft keyboard's height while
 * it is up, else the bottom safe area (the home indicator).
 */
import { useEffect, useState } from 'react'

type VisualViewportLike = { height: number; offsetTop: number }

/**
 * Contract: the layout viewport's height left uncovered below the visual
 * viewport, in whole px, never negative. A browser that already shrinks the
 * layout for the keyboard reports 0.
 */
export function keyboardInsetPx(layoutHeight: number, viewport: VisualViewportLike | null | undefined): number {
  if (!viewport) return 0
  return Math.max(0, Math.round(layoutHeight - viewport.height - viewport.offsetTop))
}

/** The CSS value for `--thread-bottom-inset`. */
export function threadBottomInset(keyboardPx: number): string {
  return keyboardPx > 0 ? `${keyboardPx}px` : 'env(safe-area-inset-bottom, 0px)'
}

function readKeyboardInset(): number {
  if (typeof window === 'undefined') return 0
  return keyboardInsetPx(document.documentElement.clientHeight, window.visualViewport)
}

/** Follows the visual viewport; the value to set as `--thread-bottom-inset`. */
export function useThreadBottomInset(): string {
  const [keyboardPx, setKeyboardPx] = useState(readKeyboardInset)
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return undefined
    // The keyboard animates over many frames; one state update per frame is the
    // most this single custom property can use.
    let frame = 0
    const update = () => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        setKeyboardPx(readKeyboardInset())
      })
    }
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    update()
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [])
  return threadBottomInset(keyboardPx)
}

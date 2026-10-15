import * as React from 'react'

import type { MainContentsLayoutPayload } from '../bridge/protocol/ui'
import type { ShellChannel } from '../runtimeClient/shellChannel'

/**
 * Reports the active session's webview_area placeholder rect (guest CSS px) to the runtime
 * (`shell.publishLayout`), which positions the native contents view over it. Deduped module-wide (one
 * native view). Only the `active` instance reports; deactivating posts nothing; unmounting the active
 * instance posts `{visible:false}`.
 */

let lastSentJson = ''

/**
 * Publish one layout frame on the runtime connection (`shell.publishLayout`). Deduped: the observers
 * below fire far more often than the geometry changes.
 */
export function postMainContentsLayout(
  shell: ShellChannel | null | undefined,
  payload: MainContentsLayoutPayload,
): void {
  if (!shell) return
  const json = JSON.stringify(payload)
  if (json === lastSentJson) return
  lastSentJson = json
  shell.publishLayout(payload)
}

/**
 * Measures an element into the wire payload. Zero-size (display:none /
 * collapsed) measures as `{visible:false}`. Exported for unit tests.
 */
export function computeMainContentsLayout(
  el: HTMLElement,
): MainContentsLayoutPayload {
  const r = el.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) {
    return { visible: false }
  }
  return {
    visible: true,
    rect: {
      left: Math.round(r.left),
      top: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height),
    },
  }
}

export function useMainContentsLayout(
  ref: React.RefObject<HTMLElement | null>,
  shell: ShellChannel | null | undefined,
  active: boolean,
): void {
  const portRef = React.useRef(shell)
  portRef.current = shell
  const activeRef = React.useRef(active)
  activeRef.current = active

  React.useEffect(() => {
    if (!active) return
    const el = ref.current
    if (!el) return

    let rafId: number | null = null

    const flush = () => {
      rafId = null
      postMainContentsLayout(portRef.current, computeMainContentsLayout(el))
    }
    const schedule = () => {
      if (rafId === null) rafId = requestAnimationFrame(flush)
    }

    // The element's own size covers splitter drags; window resize covers
    // viewport-driven offset shifts (the area is pinned to the right
    // edge, so sidebar resizes never move it — no MutationObserver
    // needed).
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    window.addEventListener('resize', schedule)
    schedule()

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      ro.disconnect()
      window.removeEventListener('resize', schedule)
    }
  }, [ref, active])

  // Unmount-only: if this instance was the live reporter, blank the
  // native view — the placeholder it tracked no longer exists. Distinct
  // from the observe effect above so a mere `active` flip (session
  // switch, section still mounted) does NOT hide-then-show.
  React.useEffect(() => {
    return () => {
      if (activeRef.current) {
        postMainContentsLayout(portRef.current, { visible: false })
      }
    }
  }, [])
}

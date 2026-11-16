/**
 * Tells the runtime when this page is used, whether it is visible and whether
 * its window is active (`presence.reportActivity`), which moves the
 * render-cache purge (P-3). Input is reported at most once per
 * `CLIENT_ACTIVITY_REPORT_MS`; a visibility or activation change at once.
 */
import { useEffect } from 'react'
import type { SessionListChannel } from '../runtimeClient/sessionListChannel'

export const CLIENT_ACTIVITY_REPORT_MS = 30_000

const INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel'] as const

export type ClientActivityTarget = {
  doc: Pick<Document, 'visibilityState' | 'hasFocus' | 'addEventListener' | 'removeEventListener'>
  /** Receives `focus` and `blur` when the window gains or loses activation. */
  win: Pick<Window, 'addEventListener' | 'removeEventListener'>
  now: () => number
  /** Runs `fn` after the current event, once the focus has settled. */
  defer?: (fn: () => void) => void
}

/** Starts reporting; returns the stop function. */
export function startClientActivityReport(
  channel: Pick<SessionListChannel, 'request'>,
  target: ClientActivityTarget,
): () => void {
  const { doc, win, now } = target
  const defer = target.defer ?? (fn => setTimeout(fn, 0))
  let lastInputReport = Number.NEGATIVE_INFINITY
  let stopped = false
  const visible = (): boolean => doc.visibilityState !== 'hidden'
  // Focus inside a frame of this page keeps `hasFocus` true: the window is still active.
  const active = (): boolean => doc.hasFocus()
  let reportedActive = active()
  const report = (): void => {
    reportedActive = active()
    channel.request('presence.reportActivity', { visible: visible(), active: reportedActive })
  }
  const onInput = (): void => {
    const at = now()
    if (at - lastInputReport < CLIENT_ACTIVITY_REPORT_MS) return
    lastInputReport = at
    report()
  }
  const onVisibility = (): void => {
    lastInputReport = now()
    report()
  }
  const onFocusChange = (): void => {
    defer(() => {
      if (stopped || active() === reportedActive) return
      lastInputReport = now()
      report()
    })
  }
  report()
  lastInputReport = now()
  doc.addEventListener('visibilitychange', onVisibility)
  win.addEventListener('focus', onFocusChange)
  win.addEventListener('blur', onFocusChange)
  for (const type of INPUT_EVENTS) doc.addEventListener(type, onInput, { capture: true, passive: true })
  return () => {
    stopped = true
    doc.removeEventListener('visibilitychange', onVisibility)
    win.removeEventListener('focus', onFocusChange)
    win.removeEventListener('blur', onFocusChange)
    for (const type of INPUT_EVENTS) doc.removeEventListener(type, onInput, { capture: true })
  }
}

export function useClientActivityReport(channel: SessionListChannel | undefined): void {
  useEffect(() => {
    if (!channel || typeof document === 'undefined' || typeof window === 'undefined') return
    return startClientActivityReport(channel, { doc: document, win: window, now: () => Date.now() })
  }, [channel])
}

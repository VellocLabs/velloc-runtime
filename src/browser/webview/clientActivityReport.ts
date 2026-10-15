/**
 * Tells the runtime when this page is used and whether it is visible
 * (`presence.reportActivity`), which postpones the render-cache purge (P-3).
 * Input is reported at most once per `CLIENT_ACTIVITY_REPORT_MS`; a visibility
 * change is reported at once.
 */
import { useEffect } from 'react'
import type { SessionListChannel } from '../runtimeClient/sessionListChannel'

export const CLIENT_ACTIVITY_REPORT_MS = 30_000

const INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel'] as const

export type ClientActivityTarget = {
  doc: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
  now: () => number
}

/** Starts reporting; returns the stop function. */
export function startClientActivityReport(
  channel: Pick<SessionListChannel, 'request'>,
  target: ClientActivityTarget,
): () => void {
  const { doc, now } = target
  let lastInputReport = Number.NEGATIVE_INFINITY
  const visible = (): boolean => doc.visibilityState !== 'hidden'
  const report = (): void => {
    channel.request('presence.reportActivity', { visible: visible() })
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
  report()
  lastInputReport = now()
  doc.addEventListener('visibilitychange', onVisibility)
  for (const type of INPUT_EVENTS) doc.addEventListener(type, onInput, { capture: true, passive: true })
  return () => {
    doc.removeEventListener('visibilitychange', onVisibility)
    for (const type of INPUT_EVENTS) doc.removeEventListener(type, onInput, { capture: true })
  }
}

export function useClientActivityReport(channel: SessionListChannel | undefined): void {
  useEffect(() => {
    if (!channel || typeof document === 'undefined') return
    return startClientActivityReport(channel, { doc: document, now: () => Date.now() })
  }, [channel])
}

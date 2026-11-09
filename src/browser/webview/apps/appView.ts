/**
 * The app on screen (F-40): the shown session is an app's and its A2UI pane
 * is open, nothing covering the session area; its topbar icon reads as
 * pressed. Once another session, app or page such as Settings covers it, its
 * pane closes, so its UI is gone and the icon builds it again. Each change
 * goes to the runtime (`mods.appView`), which raises the app module's
 * `app.show`, `app.layout` and `app.hide`.
 */

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'

import { closePane, hasPane, type SessionPaneRecord } from '../layout/paneLayout'
import type { AppViewLayout, ModsAppViewPayload } from '../../runtimeProtocol/modApps'
import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'

/** The app on screen: its session, its template type and how its pane is drawn. */
export type ShownApp = { sessionId: string; type: string; layout: AppViewLayout }

/** The app on screen, or null: the shown session is an app's, its A2UI pane is open, and nothing covers the session area. */
export function shownAppOf(args: {
  sessionId: string | undefined
  templateType: string | undefined
  appTypes: ReadonlySet<string>
  record: SessionPaneRecord
  /** A page such as Settings covers the session area. */
  covered: boolean
}): ShownApp | null {
  const { sessionId, templateType, appTypes, record, covered } = args
  if (covered || !sessionId || templateType === undefined || !appTypes.has(templateType)) return null
  if (!hasPane(record.layout, 'a2ui')) return null
  return { sessionId, type: templateType, layout: record.maximized === 'a2ui' ? 'full' : 'beside' }
}

/** Whether going from `before` to `now` leaves `before`'s app under something else, so its UI is torn down. */
export function appCoveredBy(before: ShownApp | null, now: ShownApp | null, activeSessionId: string | undefined, covered: boolean): boolean {
  if (!before || now?.sessionId === before.sessionId) return false
  return covered || activeSessionId !== before.sessionId
}

/**
 * Tracks the app on screen: closes a covered app's pane and reports every
 * change to the runtime. Returns the template type of the app on screen, for
 * its pressed icon.
 */
export function useShownApp(args: {
  sessionId: string | undefined
  templateType: string | undefined
  appTypes: ReadonlySet<string>
  record: SessionPaneRecord
  covered: boolean
  updatePaneRecord: (fn: (prev: SessionPaneRecord) => SessionPaneRecord, sessionId?: string) => void
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined
  /** The connection is up; a link that comes back reports the app on screen again, as its old connection's close closed it. */
  linkReady: boolean
}): string | undefined {
  const { sessionId, templateType, appTypes, record, covered, updatePaneRecord, runtimeConnection, linkReady } = args
  const next = shownAppOf({ sessionId, templateType, appTypes, record, covered })
  const shownKey = next ? `${next.sessionId}\n${next.type}\n${next.layout}` : ''
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the shown app's fields
  const shown = useMemo(() => next, [shownKey])
  const beforeRef = useRef<ShownApp | null>(null)
  useLayoutEffect(() => {
    const before = beforeRef.current
    beforeRef.current = shown
    if (appCoveredBy(before, shown, sessionId, covered)) {
      updatePaneRecord(prev => closePane(prev, 'a2ui'), before!.sessionId)
    }
  }, [shown, sessionId, covered, updatePaneRecord])
  const reportedRef = useRef<ShownApp | null>(null)
  const sendingRef = useRef<Promise<void>>(Promise.resolve())
  useEffect(() => {
    const before = reportedRef.current
    reportedRef.current = shown
    if (!runtimeConnection || !linkReady) return
    const reports: ModsAppViewPayload[] = []
    if (before && before.sessionId !== shown?.sessionId) reports.push({ sessionId: before.sessionId, layout: null })
    if (shown) reports.push({ sessionId: shown.sessionId, layout: shown.layout })
    if (reports.length === 0) return
    // Reports go out one at a time, across changes, so the runtime keeps the last one.
    sendingRef.current = sendingRef.current
      .then(async () => {
        const connection = await runtimeConnection()
        for (const report of reports) await connection.request('mods.appView', report)
      })
      .catch(() => undefined)
  }, [shown, runtimeConnection, linkReady])
  return shown?.type
}

import * as React from 'react'

import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'
import type { RouteKey, TopicId } from '../../runtimeProtocol'
import {
  CUSTOMIZE_PAGE_CAPABILITY,
  CUSTOMIZE_PAGE_STATUS_TOPIC,
  readCustomizePageState,
} from '../../../customize/customizePageProtocol'
import { customizeUrl, segmentOfPath, type CustomizeSegment } from './customizeRoutes'

export type CustomizeTabState = {
  /** The page the segmented control shows as current. */
  segment: CustomizeSegment
  /** The utility tab, once the runtime has opened or found it. */
  tabId: number | null
  /**
   * True when the page cannot show: the last `show` failed, or the runtime
   * reports no host port. Clears on a successful `show`.
   */
  unavailable: boolean
  /** A pick on the segmented control: shows it and loads its page in the tab. */
  selectSegment: (segment: CustomizeSegment) => void
  /** Asks the runtime to show the tab again, from a fresh connection. */
  retry: () => void
}

const ignore = () => {
  /* a runtime answer that no longer matters: the screen closed or the host lacks the tab */
}

/**
 * The Customize screen's utility tab (F-35). While `open`, the runtime is
 * asked to show this window's `customize` tab (opened, or reused where it
 * is), and `customizePage/status` moves the control when the page's own
 * navigation changes its path. A pick on the control navigates the tab.
 * When the host port comes back after `available: false`, the tab is shown
 * again without a retry.
 */
export function useCustomizeTab(
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined,
  open: boolean,
): CustomizeTabState {
  const [segment, setSegment] = React.useState<CustomizeSegment>('skills')
  const [tabId, setTabId] = React.useState<number | null>(null)
  const [showFailed, setShowFailed] = React.useState(false)
  const [hostMissing, setHostMissing] = React.useState(false)
  const [attempt, setAttempt] = React.useState(0)
  const segmentRef = React.useRef(segment)
  segmentRef.current = segment

  React.useEffect(() => {
    if (!open) return
    if (!runtimeConnection) {
      setShowFailed(true)
      return
    }
    let live = true
    let unsubscribe: (() => void) | null = null
    let missing = false
    const show = (conn: RuntimeConnection) =>
      conn
        .request(`${CUSTOMIZE_PAGE_CAPABILITY}.show` as RouteKey, { url: customizeUrl(segmentRef.current) })
        .then(
          () => {
            if (live) setShowFailed(false)
          },
          () => {
            if (live) setShowFailed(true)
          },
        )
    void runtimeConnection()
      .then(conn => {
        if (!live) return
        unsubscribe = conn.subscribe<unknown>(CUSTOMIZE_PAGE_STATUS_TOPIC as TopicId, event => {
          const state = readCustomizePageState(event.payload)
          if (!state || !live) return
          const back = missing && state.available
          missing = !state.available
          setHostMissing(missing)
          setTabId(state.tabId ?? null)
          const next = state.path !== undefined ? segmentOfPath(state.path) : null
          if (next) setSegment(next)
          if (back) void show(conn)
        })
        return show(conn)
      })
      .catch(() => {
        if (live) setShowFailed(true)
      })
    return () => {
      live = false
      unsubscribe?.()
      setTabId(null)
      setHostMissing(false)
    }
  }, [runtimeConnection, open, attempt])

  const selectSegment = React.useCallback(
    (next: CustomizeSegment) => {
      setSegment(next)
      if (!runtimeConnection) return
      void runtimeConnection()
        .then(conn =>
          conn.request(`${CUSTOMIZE_PAGE_CAPABILITY}.navigate` as RouteKey, { url: customizeUrl(next) }),
        )
        .catch(ignore)
    },
    [runtimeConnection],
  )

  const retry = React.useCallback(() => {
    setShowFailed(false)
    setAttempt(n => n + 1)
  }, [])

  return { segment, tabId, unavailable: showFailed || hostMissing, selectSegment, retry }
}

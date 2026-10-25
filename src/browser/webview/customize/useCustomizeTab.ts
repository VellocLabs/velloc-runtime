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
  /** A pick on the segmented control: shows it and loads its page in the tab. */
  selectSegment: (segment: CustomizeSegment) => void
}

const ignore = () => {
  /* a runtime answer that no longer matters: the screen closed or the host lacks the tab */
}

/**
 * The Customize screen's utility tab (F-35). While `open`, the runtime is
 * asked to show this window's `customize` tab (opened, or reused where it
 * is), and `customizePage/status` moves the control when the page's own
 * navigation changes its path. A pick on the control navigates the tab.
 */
export function useCustomizeTab(
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined,
  open: boolean,
): CustomizeTabState {
  const [segment, setSegment] = React.useState<CustomizeSegment>('skills')
  const [tabId, setTabId] = React.useState<number | null>(null)
  const segmentRef = React.useRef(segment)
  segmentRef.current = segment

  React.useEffect(() => {
    if (!open || !runtimeConnection) return
    let live = true
    let unsubscribe: (() => void) | null = null
    void runtimeConnection()
      .then(conn => {
        if (!live) return
        unsubscribe = conn.subscribe<unknown>(CUSTOMIZE_PAGE_STATUS_TOPIC as TopicId, event => {
          const state = readCustomizePageState(event.payload)
          if (!state || !live) return
          setTabId(state.tabId ?? null)
          const next = state.path !== undefined ? segmentOfPath(state.path) : null
          if (next) setSegment(next)
        })
        return conn.request(`${CUSTOMIZE_PAGE_CAPABILITY}.show` as RouteKey, {
          url: customizeUrl(segmentRef.current),
        })
      })
      .catch(ignore)
    return () => {
      live = false
      unsubscribe?.()
      setTabId(null)
    }
  }, [runtimeConnection, open])

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

  return { segment, tabId, selectSegment }
}

import * as React from 'react'

import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'
import type { RouteKey, TopicId } from '../../runtimeProtocol'
import {
  CUSTOMIZE_PAGE_CAPABILITY,
  CUSTOMIZE_PAGE_STATUS_TOPIC,
  readCustomizePageState,
} from '../../../customize/customizePageProtocol'
import type { DirectoryPageItem } from '../../../customize/directoryOffer'
import { directoryUrl } from './customizeRoutes'

export type CustomizeTabState = {
  /** The utility tab, once the runtime has opened or found it. */
  tabId: number | null
  /**
   * True when the page cannot show: the last `show` failed, or the runtime
   * reports no host port. Clears on a successful `show`.
   */
  unavailable: boolean
  /** The plugin or connector the page shows, as the runtime publishes it. */
  pageItem: DirectoryPageItem | null
  /** Installs the page item `id`. */
  addPageItem: (id: number) => void
  /** Asks the runtime to show the tab again, from a fresh connection. */
  retry: () => void
}

const ignore = () => {
  /* a runtime answer that no longer matters: the screen closed or the host lacks the tab */
}

/**
 * The Customize screen's utility tab (F-35). While `open`, the runtime is
 * asked to show this window's `customize` tab at the directory's start page
 * (opened, or reused where it is), and `customizePage/status` carries the
 * item the page shows. It is shown again on each open, when the host port
 * returns and when the page turns visible (a window reopened from the tray
 * has none of the old tabs).
 */
export function useCustomizeTab(
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined,
  open: boolean,
): CustomizeTabState {
  const [tabId, setTabId] = React.useState<number | null>(null)
  const [showFailed, setShowFailed] = React.useState(false)
  const [hostMissing, setHostMissing] = React.useState(false)
  const [attempt, setAttempt] = React.useState(0)
  const [pageItem, setPageItem] = React.useState<DirectoryPageItem | null>(null)

  React.useEffect(() => {
    if (!open) return
    if (!runtimeConnection) {
      setShowFailed(true)
      return
    }
    let live = true
    let unsubscribe: (() => void) | null = null
    let missing = false
    let connected: RuntimeConnection | null = null
    const onVisibility = () => {
      if (live && connected && document.visibilityState === 'visible') void show(connected)
    }
    const show = (conn: RuntimeConnection) =>
      conn
        .request(`${CUSTOMIZE_PAGE_CAPABILITY}.show` as RouteKey, { url: directoryUrl() })
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
        connected = conn
        unsubscribe = conn.subscribe<unknown>(CUSTOMIZE_PAGE_STATUS_TOPIC as TopicId, event => {
          const state = readCustomizePageState(event.payload)
          if (!state || !live) return
          const back = missing && state.available
          missing = !state.available
          setHostMissing(missing)
          setTabId(state.tabId ?? null)
          setPageItem(state.pageItem ?? null)
          if (back) void show(conn)
        })
        return show(conn)
      })
      .catch(() => {
        if (live) setShowFailed(true)
      })
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      live = false
      document.removeEventListener('visibilitychange', onVisibility)
      unsubscribe?.()
      setTabId(null)
      setHostMissing(false)
      setPageItem(null)
    }
  }, [runtimeConnection, open, attempt])

  const addPageItem = React.useCallback(
    (id: number) => {
      if (!runtimeConnection) return
      void runtimeConnection()
        .then(conn => conn.request(`${CUSTOMIZE_PAGE_CAPABILITY}.addPageItem` as RouteKey, { id }))
        .catch(ignore)
    },
    [runtimeConnection],
  )

  const retry = React.useCallback(() => {
    setShowFailed(false)
    setAttempt(n => n + 1)
  }, [])

  return { tabId, unavailable: showFailed || hostMissing, pageItem, addPageItem, retry }
}

import * as React from 'react'

import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'
import type { RouteKey, TopicId } from '../../runtimeProtocol'
import {
  CUSTOMIZE_PAGE_CAPABILITY,
  CUSTOMIZE_PAGE_STATUS_TOPIC,
  readCustomizePageState,
  type CustomizeAddRequest,
  type CustomizeMarketplaceDescription,
} from '../../../customize/customizePageProtocol'
import type { DirectoryPageItem } from '../../../customize/directoryOffer'
import { directoryPageUrl, directoryUrl } from './customizeRoutes'

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
  /** Whether the page has an earlier entry of its own to go back to. */
  canGoBack: boolean
  /** The page's own add button asking to add the page item; a new `seq` is a new ask. */
  addRequest: CustomizeAddRequest | null
  /** Installs the page item `id`. */
  addPageItem: (id: number) => void
  /** One entry back in the page's own history. */
  goBack: () => void
  /** The directory's start page. */
  goHome: () => void
  /** A page of the directory site, by path. */
  openPage: (path: string) => void
  /** The directory's details for a marketplace's plugins; empty when it cannot say. */
  describeMarketplace: (marketplace: string) => Promise<CustomizeMarketplaceDescription>
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
  const [canGoBack, setCanGoBack] = React.useState(false)
  const [addRequest, setAddRequest] = React.useState<CustomizeAddRequest | null>(null)

  React.useEffect(() => {
    if (!open) return
    if (!runtimeConnection) {
      setShowFailed(true)
      return
    }
    let live = true
    let unsubscribe: (() => void) | null = null
    let missing = false
    let staleSeq: number | null = null
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
          setCanGoBack(state.canGoBack ?? false)
          // An ask already standing when the screen subscribed was made to a
          // screen that is gone; only later asks are shown.
          if (staleSeq === null) staleSeq = state.addRequest?.seq ?? 0
          const ask = state.addRequest && state.addRequest.seq > staleSeq ? state.addRequest : null
          setAddRequest(current => (ask && current?.seq === ask.seq ? current : ask))
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
      setCanGoBack(false)
      setAddRequest(null)
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

  const send = React.useCallback(
    (action: 'navigate' | 'back', payload: Record<string, unknown>) => {
      if (!runtimeConnection) return
      void runtimeConnection()
        .then(conn => conn.request(`${CUSTOMIZE_PAGE_CAPABILITY}.${action}` as RouteKey, payload))
        .catch(ignore)
    },
    [runtimeConnection],
  )
  const goBack = React.useCallback(() => send('back', {}), [send])
  const goHome = React.useCallback(() => send('navigate', { url: directoryUrl() }), [send])
  const openPage = React.useCallback((path: string) => send('navigate', { url: directoryPageUrl(path) }), [send])

  const describeMarketplace = React.useCallback(
    async (marketplace: string): Promise<CustomizeMarketplaceDescription> => {
      if (!runtimeConnection) return { plugins: {} }
      const conn = await runtimeConnection()
      const result = (await conn.request(`${CUSTOMIZE_PAGE_CAPABILITY}.describeMarketplace` as RouteKey, {
        marketplace,
      })) as Partial<CustomizeMarketplaceDescription> | undefined
      return { plugins: result?.plugins && typeof result.plugins === 'object' ? result.plugins : {} }
    },
    [runtimeConnection],
  )

  const retry = React.useCallback(() => {
    setShowFailed(false)
    setAttempt(n => n + 1)
  }, [])

  return {
    tabId,
    unavailable: showFailed || hostMissing,
    pageItem,
    canGoBack,
    addRequest,
    addPageItem,
    goBack,
    goHome,
    openPage,
    describeMarketplace,
    retry,
  }
}

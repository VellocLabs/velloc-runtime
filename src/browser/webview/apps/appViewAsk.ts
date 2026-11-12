/**
 * What an app's background module asked of the pages (F-40, `$.app.view`):
 * the app opened, or its pane closed. This page carries out an ask it has
 * not seen, meant for every page or for its own connection.
 * Contract: an ask from before the page loaded or while its link was down
 * is never carried out: the runtime withholds it, and one already there at
 * the first read is skipped.
 */

import { useEffect, useRef } from 'react'

import { closePane, type SessionPaneRecord } from '../layout/paneLayout'
import { useContributionsSnapshot } from '../mods/modContributionsView'
import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'
import type { ContributedApp } from '../../runtimeProtocol/modContributions'

export type AppViewAsk = { type: string; want: 'open' | 'closed'; client?: string }

/** The asks a page has seen, by app; `take` answers the ones that are new. */
export class AppViewAsks {
  private seen: Map<string, number> | null = null

  take(apps: readonly Pick<ContributedApp, 'appId' | 'type' | 'view'>[]): AppViewAsk[] {
    const first = this.seen === null
    const seen = (this.seen ??= new Map<string, number>())
    const out: AppViewAsk[] = []
    for (const app of apps) {
      const view = app.view
      if (!view || view.seq <= (seen.get(app.appId) ?? Number.NEGATIVE_INFINITY)) continue
      seen.set(app.appId, view.seq)
      if (!first) out.push({ type: app.type, want: view.want, ...(view.client !== undefined ? { client: view.client } : {}) })
    }
    return out
  }

  /** The link dropped: what comes after it is compared afresh, so a runtime whose clock went back is still heard. */
  forget(): void {
    this.seen?.clear()
  }
}

/** Whether an ask is this page's to carry out: one for every page, or for the connection the page holds now. */
export async function appViewAskIsMine(
  ask: Pick<AppViewAsk, 'client'>,
  runtimeConnection: (() => Promise<Pick<RuntimeConnection, 'welcome'>>) | undefined,
): Promise<boolean> {
  if (ask.client === undefined) return true
  if (!runtimeConnection) return false
  try {
    return (await runtimeConnection()).welcome?.connectionId === ask.client
  } catch {
    return false
  }
}

/**
 * Carries out the module's asks: `open` as a press on the app's icon opens
 * it, `closed` by closing the A2UI pane of the app while it is the one on
 * screen (an app not on screen has no pane to close).
 */
export function useAppViewAsks(args: {
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined
  openApp: (type: string) => void
  /** The template type of the app on screen. */
  shownAppType: string | undefined
  updatePaneRecord: (fn: (prev: SessionPaneRecord) => SessionPaneRecord) => void
}): void {
  const snapshot = useContributionsSnapshot()
  const latest = useRef(args)
  latest.current = args
  const asks = useRef<AppViewAsks | null>(null)
  const { runtimeConnection } = args
  useEffect(() => {
    if (!runtimeConnection) return
    let live = true
    let unwatch: (() => void) | undefined
    void runtimeConnection().then(
      conn => {
        if (!live) return
        unwatch = conn.watchLinkState(state => {
          if (state.status !== 'ready') asks.current?.forget()
        })
      },
      () => {},
    )
    return () => {
      live = false
      unwatch?.()
    }
  }, [runtimeConnection])
  useEffect(() => {
    if (!snapshot) return
    for (const ask of (asks.current ??= new AppViewAsks()).take(snapshot.apps ?? [])) {
      void appViewAskIsMine(ask, latest.current.runtimeConnection).then(mine => {
        if (!mine) return
        const now = latest.current
        if (ask.want === 'open') now.openApp(ask.type)
        else if (now.shownAppType === ask.type) now.updatePaneRecord(prev => closePane(prev, 'a2ui'))
      })
    }
  }, [snapshot])
}

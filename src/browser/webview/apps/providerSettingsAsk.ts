/**
 * Where a router's settings app asked the Models settings to open (F-27,
 * `$.provider.openSettings`). This page carries out an ask it has not seen,
 * meant for every page or for its own connection.
 * Contract: an ask from before the page loaded or while its link was down
 * is never carried out: the runtime withholds it, and one already there at
 * the first read is skipped.
 */

import { useEffect, useRef, useState } from 'react'

import { useContributionsSnapshot } from '../mods/modContributionsView'
import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'
import type { ContributedApp, ModelsSettingsTarget } from '../../runtimeProtocol/modContributions'
import { appViewAskIsMine } from './appViewAsk'
import type { ModelsLandingRequest } from '../settings/sections/models/modelsPageLanding'

export type ProviderSettingsAsk = { target: ModelsSettingsTarget; client?: string }

/** The asks a page has seen, by app; `take` answers the ones that are new. */
export class ProviderSettingsAsks {
  private seen: Map<string, number> | null = null

  take(apps: readonly Pick<ContributedApp, 'appId' | 'settingsAsk'>[]): ProviderSettingsAsk[] {
    const first = this.seen === null
    const seen = (this.seen ??= new Map<string, number>())
    const out: ProviderSettingsAsk[] = []
    for (const app of apps) {
      const ask = app.settingsAsk
      if (!ask || ask.seq <= (seen.get(app.appId) ?? Number.NEGATIVE_INFINITY)) continue
      seen.set(app.appId, ask.seq)
      if (!first) out.push({ target: ask.target, ...(ask.client !== undefined ? { client: ask.client } : {}) })
    }
    return out
  }

  /** The link dropped: what comes after it is compared afresh. */
  forget(): void {
    this.seen?.clear()
  }
}

/** Hands each new ask that is this page's to `open`. */
export function useProviderSettingsAsks(args: {
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined
  open: (target: ModelsSettingsTarget) => void
}): void {
  const snapshot = useContributionsSnapshot()
  const latest = useRef(args)
  latest.current = args
  const asks = useRef<ProviderSettingsAsks | null>(null)
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
    for (const ask of (asks.current ??= new ProviderSettingsAsks()).take(snapshot.apps ?? [])) {
      void appViewAskIsMine(ask, latest.current.runtimeConnection).then(mine => {
        if (mine) latest.current.open(ask.target)
      })
    }
  }, [snapshot])
}

/**
 * The shell's side of an ask: Settings opens on Models, and the request the
 * Models page lands by is returned. `onModels` is false once Settings shows
 * another section or is closed, which drops the request so a Models page
 * mounted later does not replay it.
 */
export function useModelsLandingAsks(args: {
  runtimeConnection: (() => Promise<RuntimeConnection>) | undefined
  onModels: boolean
  openModels: () => void
}): ModelsLandingRequest | null {
  const [request, setRequest] = useState<ModelsLandingRequest | null>(null)
  const seq = useRef(0)
  const latest = useRef(args)
  latest.current = args
  useProviderSettingsAsks({
    runtimeConnection: args.runtimeConnection,
    open: target => {
      seq.current += 1
      setRequest({ target, seq: seq.current })
      latest.current.openModels()
    },
  })
  const { onModels } = args
  useEffect(() => {
    if (!onModels) setRequest(null)
  }, [onModels])
  return request
}

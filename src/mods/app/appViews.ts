/**
 * Where each app is on screen (F-40), across every client that shows it: an
 * app is shown while one client reports it, laid out as the client that
 * changed last reports. Each change answers the events it raises on the
 * app's background module, in order. Contract: `client` is a connection id;
 * a client shows one session of an app at once (a new report replaces it).
 */

import type { AppViewLayout } from '../../browser/runtimeProtocol/modApps'

export type { AppViewLayout }

/** What the module is told the app looks like now. */
export type AppView = { sessionId: string; layout: AppViewLayout }

export type AppViewEvent =
  | { event: 'app.show'; payload: { appId: string } & AppView }
  | { event: 'app.layout'; payload: { appId: string } & AppView }
  | { event: 'app.hide'; payload: { appId: string; sessionId: string } }

type Shown = AppView & { seq: number }

export class AppViews {
  private readonly apps = new Map<string, Map<string, Shown>>()
  private seq = 0

  /** The app's view as its module knows it, or null when no client shows it. */
  current(appId: string): AppView | null {
    let latest: Shown | undefined
    for (const shown of this.apps.get(appId)?.values() ?? []) {
      if (!latest || shown.seq > latest.seq) latest = shown
    }
    return latest ? { sessionId: latest.sessionId, layout: latest.layout } : null
  }

  /** `client` shows `sessionId` of app `appId` in `layout`, or no longer shows it (null). */
  set(appId: string, sessionId: string, client: string, layout: AppViewLayout | null): AppViewEvent[] {
    return this.change([appId], () => {
      const clients = this.apps.get(appId)
      if (layout === null) {
        if (clients?.get(client)?.sessionId === sessionId) clients.delete(client)
        return
      }
      const before = clients?.get(client)
      if (before && before.sessionId === sessionId && before.layout === layout) return
      ;(clients ?? this.apps.set(appId, new Map()).get(appId)!).set(client, { sessionId, layout, seq: ++this.seq })
    })
  }

  /** A client's connection closed: it shows nothing. */
  clientGone(client: string): AppViewEvent[] {
    const touched = [...this.apps].filter(([, clients]) => clients.has(client)).map(([appId]) => appId)
    return this.change(touched, () => {
      for (const appId of touched) this.apps.get(appId)!.delete(client)
    })
  }

  /** The app's session ended: no client shows it any more. */
  sessionGone(appId: string, sessionId: string): AppViewEvent[] {
    return this.change([appId], () => {
      const clients = this.apps.get(appId)
      for (const [client, shown] of clients ?? []) if (shown.sessionId === sessionId) clients!.delete(client)
    })
  }

  private change(appIds: readonly string[], apply: () => void): AppViewEvent[] {
    const before = appIds.map(appId => this.current(appId))
    apply()
    const out: AppViewEvent[] = []
    appIds.forEach((appId, i) => {
      if (this.apps.get(appId)?.size === 0) this.apps.delete(appId)
      const was = before[i]!
      const now = this.current(appId)
      if (!was && now) out.push({ event: 'app.show', payload: { appId, ...now } })
      else if (was && !now) out.push({ event: 'app.hide', payload: { appId, sessionId: was.sessionId } })
      else if (was && now && (was.layout !== now.layout || was.sessionId !== now.sessionId)) {
        out.push({ event: 'app.layout', payload: { appId, ...now } })
      }
    })
    return out
  }
}

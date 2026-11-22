/**
 * The realm's app surfaces (F-40), one entry per open app session: what the
 * `mods/app/<sessionId>` topic serves as its snapshot, the changes it
 * publishes, and the build `mods.buildApp` runs. Written by each session's
 * app surface host; read by the mods capability. No compiler and no fs here,
 * so the capability loads it cheaply.
 */

import type { AppSurfaceDelta, AppSurfaceState, ModsAppActionResult, ModsBuildAppResult } from '../../browser/runtimeProtocol/modApps'
import { appViewsClientGone, dispatchAppSessionGone, dispatchAppView } from './appActionBus'
import type { AppViewLayout } from './appViews'

export type AppBuild = () => Promise<ModsBuildAppResult>
export type AppActor = (action: string, context: unknown) => Promise<ModsAppActionResult>

/** The data of a board whose app's script holds it, read when a page needs the board whole. */
export type AppSurfaceLiveData = Required<Pick<AppSurfaceState, 'dataSeq' | 'dataAt'>> & { data: unknown }

/**
 * `delta`: what changed since the state before, when that is all a holder of
 * it needs. `live`: the state carries no data, which `appSurfaceBoard` reads.
 */
type Listener = (sessionId: string, state: AppSurfaceState | null, delta?: AppSurfaceDelta, live?: boolean) => void

const boards = new Map<string, AppSurfaceState>()
const liveData = new Map<string, () => Promise<AppSurfaceLiveData>>()
const listeners = new Set<Listener>()
const builders = new Map<string, AppBuild>()
const actors = new Map<string, AppActor>()
/** What each client reports it shows of a session's app, kept until it reports otherwise or its connection closes. */
const views = new Map<string, Map<string, AppViewLayout>>()

/** The app state of `sessionId`; null when the session is not an open app's. */
export function appSurfaceState(sessionId: string): AppSurfaceState | null {
  return boards.get(sessionId) ?? null
}

/**
 * The board of `sessionId` whole: the state, with the data its app's script
 * holds read in. A read that fails gives the board with a data error.
 */
export async function appSurfaceBoard(sessionId: string): Promise<AppSurfaceState | null> {
  const board = boards.get(sessionId)
  const load = liveData.get(sessionId)
  if (!board || !load) return board ?? null
  try {
    const { dataPatches: _patches, ...rest } = board
    return { ...rest, ...(await load()) }
  } catch (error) {
    const message = `the app's data could not be read: ${error instanceof Error ? error.message : String(error)}`
    return { ...board, errors: [...(board.errors ?? []), { kind: 'data', message }] }
  }
}

/** Records a session's app state and tells the listeners; null forgets it. `loadData`: the state carries no data, and this reads it. */
export function setAppSurfaceState(
  sessionId: string,
  state: AppSurfaceState | null,
  delta?: AppSurfaceDelta,
  loadData?: () => Promise<AppSurfaceLiveData>,
): void {
  const before = boards.get(sessionId)
  if (state && loadData) liveData.set(sessionId, loadData)
  else liveData.delete(sessionId)
  if (state) boards.set(sessionId, state)
  else if (!boards.delete(sessionId)) return
  if (before && (!state || state.appId !== before.appId)) dispatchAppSessionGone(before.appId, sessionId)
  if (state && state.appId !== before?.appId) {
    for (const [client, layout] of views.get(sessionId) ?? []) dispatchAppView(state.appId, sessionId, client, layout)
  }
  for (const listener of [...listeners]) {
    try {
      listener(sessionId, state, state && before ? delta : undefined, state !== null && loadData !== undefined)
    } catch (error) {
      console.error('[mods/app] app listener failed', error)
    }
  }
}

export function onAppSurfaceChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Records how `sessionId`'s app is built. The result forgets it while it is
 * still this build, and says whether it was.
 */
export function setAppBuilder(sessionId: string, build: AppBuild): () => boolean {
  builders.set(sessionId, build)
  return () => {
    if (builders.get(sessionId) !== build) return false
    builders.delete(sessionId)
    return true
  }
}

/** Builds `sessionId`'s app; undefined when the session is not an open app's. */
export function buildRegisteredApp(sessionId: string): Promise<ModsBuildAppResult> | undefined {
  return builders.get(sessionId)?.()
}

/** Records how `sessionId`'s app takes a surface action of the person's; the result forgets it while it is still this one. */
export function setAppActor(sessionId: string, act: AppActor): () => boolean {
  actors.set(sessionId, act)
  return () => {
    if (actors.get(sessionId) !== act) return false
    actors.delete(sessionId)
    return true
  }
}

/** Offers `action` to `sessionId`'s app; undefined when the session is not an open app's. */
export function runRegisteredAppAction(sessionId: string, action: string, context: unknown): Promise<ModsAppActionResult> | undefined {
  return actors.get(sessionId)?.(action, context)
}

/**
 * `client` shows `sessionId`'s app in `layout`, or no longer shows it (null).
 * Passed on to the app's module once the session is an open app's; a report
 * that comes first waits for it.
 */
export function viewRegisteredApp(sessionId: string, client: string, layout: AppViewLayout | null): void {
  const clients = views.get(sessionId)
  if (layout === null) {
    if (!clients?.delete(client)) return
    if (clients.size === 0) views.delete(sessionId)
  } else {
    if (clients?.get(client) === layout) return
    ;(clients ?? views.set(sessionId, new Map()).get(sessionId)!).set(client, layout)
  }
  const appId = boards.get(sessionId)?.appId
  if (appId) dispatchAppView(appId, sessionId, client, layout)
}

/** Passes every held report of an open app's session on again, for a dispatch seated after they came. */
export function replayAppViews(): void {
  for (const [sessionId, clients] of views) {
    const appId = boards.get(sessionId)?.appId
    if (appId) for (const [client, layout] of clients) dispatchAppView(appId, sessionId, client, layout)
  }
}

/** A client's connection closed: it shows no app. */
export function appViewClientGone(client: string): void {
  for (const [sessionId, clients] of views) {
    if (clients.delete(client) && clients.size === 0) views.delete(sessionId)
  }
  appViewsClientGone(client)
}

/** Copies an app's seed into its folder again and rebuilds its page (`$.app.reseed()`). */
export type AppReseed = () => Promise<void>

const reseeders = new Map<string, { appId: string; reseed: AppReseed }>()

/** Records how `sessionId`'s app of `appId` is seeded again; the result forgets it while it is still this one. */
export function setAppReseeder(sessionId: string, appId: string, reseed: AppReseed): () => boolean {
  const entry = { appId, reseed }
  reseeders.set(sessionId, entry)
  return () => {
    if (reseeders.get(sessionId) !== entry) return false
    reseeders.delete(sessionId)
    return true
  }
}

/** Seeds every open session of `appId` again; undefined when none is open. Rejects with the first failure. */
export function reseedRegisteredApp(appId: string): Promise<void> | undefined {
  const runs = [...reseeders.values()].filter(entry => entry.appId === appId).map(entry => entry.reseed())
  if (runs.length === 0) return undefined
  return Promise.all(runs).then(() => undefined)
}

/** Refreshes `sessionId`'s app: draws it again and raises `app.show`; `reinstall` copies the seed first. */
export type AppRefresh = (reinstall: boolean) => Promise<ModsBuildAppResult>

const refreshers = new Map<string, AppRefresh>()

/** Records how `sessionId`'s app is refreshed; the result forgets it while it is still this one. */
export function setAppRefresher(sessionId: string, refresh: AppRefresh): () => boolean {
  refreshers.set(sessionId, refresh)
  return () => {
    if (refreshers.get(sessionId) !== refresh) return false
    refreshers.delete(sessionId)
    return true
  }
}

/** Refreshes `sessionId`'s app; undefined when the session is not an open app's. */
export function refreshRegisteredApp(sessionId: string, reinstall: boolean): Promise<ModsBuildAppResult> | undefined {
  return refreshers.get(sessionId)?.(reinstall)
}

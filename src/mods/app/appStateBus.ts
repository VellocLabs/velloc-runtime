/**
 * The realm's live app states (F-40). An app's script holds its state; here
 * is, by app id, where a reader asks for it whole, and the listeners each
 * batch of patches reaches: the open sessions' surface hosts. The value
 * itself is never kept here. One per realm, as the surface registry is.
 */

import type { AppDataPatch } from '../../browser/runtimeProtocol/modApps'

/** `owner` names the relay of one running script; `version` counts its batches. */
export type AppStateSource = {
  owner: number
  version(): number
  /** The state whole, as of `version`. */
  read(): Promise<{ version: number; value: unknown }>
}

export type AppStateEvent = {
  appId: string
  owner: number
  version: number
  /** What took the state from the version before to this one; absent when it has to be read whole. */
  patches?: readonly AppDataPatch[]
  /** The script stopped: the state is the data file's again. */
  gone?: true
}

type Listener = (event: AppStateEvent) => void

const live = new Map<string, AppStateSource>()
const listeners = new Map<string, Set<Listener>>()

const tell = (event: AppStateEvent): void => {
  for (const listener of [...(listeners.get(event.appId) ?? [])]) listener(event)
}

/** A script now holds the state of `appId`. */
export function holdAppState(appId: string, source: AppStateSource): void {
  live.set(appId, source)
}

export function publishAppState(event: AppStateEvent): void {
  tell(event)
}

/** Where the state of `appId` is read while a script holds it. */
export function liveAppState(appId: string): AppStateSource | undefined {
  return live.get(appId)
}

/** The script of `owner` is gone: its source goes, a successor's stays. */
export function clearAppState(appId: string, owner: number): void {
  const source = live.get(appId)
  if (source?.owner !== owner) return
  live.delete(appId)
  tell({ appId, owner, version: source.version(), gone: true })
}

export function onAppState(appId: string, listener: Listener): () => void {
  let set = listeners.get(appId)
  if (!set) {
    set = new Set()
    listeners.set(appId, set)
  }
  set.add(listener)
  return () => {
    const current = listeners.get(appId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) listeners.delete(appId)
  }
}

export function resetAppStateBusForTests(): void {
  live.clear()
  listeners.clear()
}

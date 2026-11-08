/**
 * The realm's live app states (F-40): what each app's background module
 * last published, by app id, and the listeners each batch reaches — the
 * open sessions' surface hosts. One per realm, as the surface registry is.
 */

import type { AppDataPatch } from '../../browser/runtimeProtocol/modApps'

/** `owner` names the document that publishes it; `version` counts that document's batches. */
export type AppStateSnapshot = { owner: number; version: number; value: unknown }

export type AppStateEvent = AppStateSnapshot & {
  appId: string
  /** The patches that took the state from the version before to this one. */
  patches: readonly AppDataPatch[]
}

type Listener = (event: AppStateEvent) => void

const live = new Map<string, AppStateSnapshot>()
const listeners = new Map<string, Set<Listener>>()

export function publishAppState(event: AppStateEvent): void {
  live.set(event.appId, { owner: event.owner, version: event.version, value: event.value })
  for (const listener of [...(listeners.get(event.appId) ?? [])]) listener(event)
}

/** The state of `appId` while a background module holds one. */
export function liveAppState(appId: string): AppStateSnapshot | undefined {
  return live.get(appId)
}

/** The module of `owner` is gone: its live state goes, a successor's stays. */
export function clearAppState(appId: string, owner: number): void {
  if (live.get(appId)?.owner === owner) live.delete(appId)
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

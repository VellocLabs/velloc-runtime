/**
 * The realm's app surfaces (F-40), one entry per open app session: what the
 * `mods/app/<sessionId>` topic serves as its snapshot, the changes it
 * publishes, and the build `mods.buildApp` runs. Written by each session's
 * app surface host; read by the mods capability. No compiler and no fs here,
 * so the capability loads it cheaply.
 */

import type { AppSurfaceState, ModsAppActionResult, ModsBuildAppResult } from '../../browser/runtimeProtocol/modApps'

export type AppBuild = () => Promise<ModsBuildAppResult>
export type AppActor = (action: string, context: unknown) => Promise<ModsAppActionResult>

type Listener = (sessionId: string, state: AppSurfaceState | null) => void

const boards = new Map<string, AppSurfaceState>()
const listeners = new Set<Listener>()
const builders = new Map<string, AppBuild>()
const actors = new Map<string, AppActor>()

/** The app state of `sessionId`; null when the session is not an open app's. */
export function appSurfaceState(sessionId: string): AppSurfaceState | null {
  return boards.get(sessionId) ?? null
}

/** Records a session's app state and tells the listeners; null forgets it. */
export function setAppSurfaceState(sessionId: string, state: AppSurfaceState | null): void {
  if (state) boards.set(sessionId, state)
  else if (!boards.delete(sessionId)) return
  for (const listener of [...listeners]) {
    try {
      listener(sessionId, state)
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

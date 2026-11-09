/**
 * UI ⇄ Runtime protocol — `mods/app/<sessionId>` (F-40): the app session's
 * surfaces as its entry file last built. The runtime reads and builds the
 * files; a page draws what it is sent. Session-bound and `observe`: a connection sees the
 * topic of a session in its scope alone. The payload is `null` for a session
 * that is not an app's.
 */

import type { TopicId } from './frames'
import { isTopicSegment } from './topics'

export const MODS_APP_TOPIC_PREFIX = 'mods/app/'
export const MODS_APP_STATE_EVENT = 'state'

export type AppSurfaceErrorKind = 'build' | 'data'

/** Why the newest build or data file is not what the page draws; English, for the model and logs. */
export type AppSurfaceError = { kind: AppSurfaceErrorKind; message: string }

/** One build of the app's entry file: its text and the surfaces it draws, in order. */
export type AppSurfaceBuild = { body: string; hash: string; surfaceIds: string[] }

/** One change to the app's data: an RFC 6901 pointer from the data's root (`""` the root) and its new value, or a removal when `value` is absent. */
export type AppDataPatch = { path: string; value?: unknown }

export type AppSurfaceState = {
  appId: string
  /** The latest successful build; null before one has succeeded. */
  surface: AppSurfaceBuild | null
  /** The data file's value, set under `/data` on each of the app's surfaces. */
  data?: unknown
  /** When the data file was last written (epoch ms). */
  dataAt?: number
  /** Counts the data changes this host published; with `data`. */
  dataSeq?: number
  /** The patches that took the data of the board with `dataSeq === from` to this one; absent when the data was read whole. */
  dataPatches?: { from: number; patches: AppDataPatch[] }
  /** The app's background module is handling an action of the person's (`mods.appAction`). */
  refreshing: boolean
  /** The latest build failed, or the data file could not be read. */
  errors?: AppSurfaceError[]
  /** Files the person edited that a newer seed would have replaced. */
  seedConflicts?: string[]
  /** The surface actions the manifest names as the plugin's own: the page offers each to `mods.appAction` before the model. */
  localActions?: string[]
}

/** `mods.buildApp`: build the app's entry file again and redraw it. */
export type ModsBuildAppPayload = { sessionId: string }

export type ModsBuildAppResult = { ok: true; surfaceIds: string[] } | { ok: false; message: string }

/** `mods.appAction`: an action on one of the app's own surfaces, offered to the app's background module. */
export type ModsAppActionPayload = { sessionId: string; action: string; context?: unknown }

/** `handled`: the module took the action; false sends it to the model as any surface action. */
export type ModsAppActionResult = { handled: boolean }

const ACTION_NAME = /^[A-Za-z0-9_-]{1,64}$/
/** The bytes an action's context may take on the wire, as UTF-8 JSON. */
export const APP_ACTION_CONTEXT_MAX_BYTES = 64 * 1024
const contextEncoder = new TextEncoder()

export function modsAppTopic(sessionId: string): TopicId {
  if (!isTopicSegment(sessionId)) {
    throw new RangeError(`[protocol] topic sessionId must be non-empty and contain no '/': ${JSON.stringify(sessionId)}`)
  }
  return `${MODS_APP_TOPIC_PREFIX}${sessionId}`
}

/** The session of a `mods/app/<sessionId>` id; undefined for anything else. */
export function modsAppTopicSession(id: string): string | undefined {
  if (!id.startsWith(MODS_APP_TOPIC_PREFIX)) return undefined
  const rest = id.slice(MODS_APP_TOPIC_PREFIX.length)
  return isTopicSegment(rest) ? rest : undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A page's check of a delivered payload (null is a session with no app). */
export function isAppSurfaceState(value: unknown): value is AppSurfaceState {
  if (!isRecord(value)) return false
  if (typeof value.appId !== 'string' || typeof value.refreshing !== 'boolean') return false
  const surface = value.surface
  if (surface !== null) {
    if (!isRecord(surface) || typeof surface.body !== 'string' || typeof surface.hash !== 'string') return false
    const ids = surface.surfaceIds
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every(id => typeof id === 'string')) return false
  }
  if (value.dataAt !== undefined && typeof value.dataAt !== 'number') return false
  if (value.dataSeq !== undefined && typeof value.dataSeq !== 'number') return false
  if (value.dataPatches !== undefined) {
    const patches = value.dataPatches
    if (!isRecord(patches) || typeof patches.from !== 'number' || !Array.isArray(patches.patches)) return false
    if (!patches.patches.every(p => isRecord(p) && typeof p.path === 'string')) return false
  }
  if (value.errors !== undefined) {
    if (!Array.isArray(value.errors)) return false
    const ok = value.errors.every(e => isRecord(e) && (e.kind === 'build' || e.kind === 'data') && typeof e.message === 'string')
    if (!ok) return false
  }
  if (value.seedConflicts !== undefined && !(Array.isArray(value.seedConflicts) && value.seedConflicts.every(p => typeof p === 'string'))) {
    return false
  }
  if (value.localActions !== undefined && !(Array.isArray(value.localActions) && value.localActions.every(p => typeof p === 'string'))) {
    return false
  }
  return true
}

export function isModsBuildAppPayload(value: unknown): value is ModsBuildAppPayload {
  return isRecord(value) && typeof value.sessionId === 'string' && value.sessionId.length > 0
}

/** Security: the action name has the manifest's form and the context is bounded JSON; anything else is refused at the wire. */
export function isModsAppActionPayload(value: unknown): value is ModsAppActionPayload {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || value.sessionId.length === 0) return false
  if (typeof value.action !== 'string' || !ACTION_NAME.test(value.action)) return false
  if (value.context === undefined) return true
  try {
    const json = JSON.stringify(value.context)
    return json !== undefined && contextEncoder.encode(json).byteLength <= APP_ACTION_CONTEXT_MAX_BYTES
  } catch {
    return false
  }
}

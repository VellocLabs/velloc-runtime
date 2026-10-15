/**
 * Client auto-update on the runtime protocol (F-30). Clients read topic
 * `appUpdate/status` (`observe`; versions and a phase, nothing personal) and
 * ask `appUpdate.relaunch` at `full`: it restarts the desktop app on the host,
 * which a remote client must not do to the person sitting at it.
 */
import type { ScopeMode } from '../browser/runtimeProtocol'

export const APP_UPDATE_CAPABILITY = 'appUpdate'
export const APP_UPDATE_STATUS_TOPIC = 'appUpdate/status'
/** The `type` of the snapshot and of every delta. */
export const APP_UPDATE_STATUS_EVENT = 'state'

export const APP_UPDATE_ACTION_SCOPES = {
  relaunch: 'full',
} as const satisfies Record<string, ScopeMode>
export type AppUpdateAction = keyof typeof APP_UPDATE_ACTION_SCOPES

export const APP_UPDATE_PHASES = ['idle', 'checking', 'downloading', 'installing', 'ready', 'failed'] as const
export type AppUpdatePhase = (typeof APP_UPDATE_PHASES)[number]

/**
 * The whole state, published on every change. `available` is false while this
 * runtime has no update service (dev origin, non-Windows host, older host).
 * `target` is the version being fetched, installed, or waiting for a restart.
 */
export type AppUpdateState = {
  available: boolean
  phase?: AppUpdatePhase
  current?: string
  target?: string
  checkedAt?: number
  lastError?: string
}

/** `relaunch` takes nothing; anything else is refused. */
export function isAppUpdateRelaunchPayload(value: unknown): boolean {
  if (value === undefined || value === null) return true
  return typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0
}

const OPTIONAL_STRINGS = ['current', 'target', 'lastError'] as const

/** A payload from the topic that is the shape a page reads, or null. */
export function readAppUpdateState(value: unknown): AppUpdateState | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.available !== 'boolean') return null
  const state: AppUpdateState = { available: v.available }
  if (v.phase !== undefined) {
    if (typeof v.phase !== 'string' || !(APP_UPDATE_PHASES as readonly string[]).includes(v.phase)) return null
    state.phase = v.phase as AppUpdatePhase
  }
  for (const key of OPTIONAL_STRINGS) {
    if (v[key] === undefined) continue
    if (typeof v[key] !== 'string') return null
    state[key] = v[key] as string
  }
  if (v.checkedAt !== undefined) {
    if (typeof v.checkedAt !== 'number') return null
    state.checkedAt = v.checkedAt
  }
  return state
}

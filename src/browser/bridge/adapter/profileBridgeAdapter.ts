/**
 * Worker-side handlers for the `profile` bridge namespace; owns the `profile`
 * section of `~/.velloc/settings.json`. Read at session boot, NOT applied live:
 * a change takes effect on the next session.
 */

import type {
  ProfileBridgeActionMap,
  ProfileFieldValues,
  NexusProfileStringKey,
  BrowserBridgeRequest,
  BrowserBridgeResponse,
} from '../protocol'
import type { RuntimeFs } from '../../../utils/fs/runtimeFs'
import type { NexusProfileSettings } from '../../../settings/settingsTypes'
import {
  readUserLayer,
  updateProfileSettings,
} from '../../../settings/settingsStore'

export type ProfileAdapterContext = {
  /** User home directory the settings file anchors to. Resolved upstream
   *  via `resolveSettingsRoot` — the same chain features/agent use, so
   *  every JS-side capability writes into the SAME `settings.json`. */
  homeDir: string
  /** The same `processFs()` the rest of nexus uses. */
  fs: RuntimeFs
  /**
   * Fire after a successful `setField` write; broadcasts `profile.changed` to
   * WebUI ports. No live-engine fan-out. Optional so unit tests don't have to wire it.
   */
  broadcastChanged?: (payload: { values: ProfileFieldValues }) => void
}

export type ProfileAction = keyof ProfileBridgeActionMap

/**
 * Defaults for unset fields — all empty strings, so the React form always
 * has a concrete value to bind its controlled inputs to.
 */
const PROFILE_DEFAULTS: ProfileFieldValues = {
  fullName: '',
  callName: '',
  workRole: '',
}

function mergeWithDefaults(
  user: NexusProfileSettings | undefined,
): ProfileFieldValues {
  return {
    fullName: user?.fullName ?? PROFILE_DEFAULTS.fullName,
    callName: user?.callName ?? PROFILE_DEFAULTS.callName,
    workRole: user?.workRole ?? PROFILE_DEFAULTS.workRole,
  }
}

// --- individual handlers (typed; tested directly by unit tests) ---------

async function handleSnapshot(
  ctx: ProfileAdapterContext,
): Promise<ProfileBridgeActionMap['snapshot']['result']> {
  const { settings, source } = await readUserLayer(ctx.homeDir, ctx.fs)
  return {
    values: mergeWithDefaults(settings.profile),
    source,
  }
}

async function handleSetField(
  payload: ProfileBridgeActionMap['setField']['payload'],
  ctx: ProfileAdapterContext,
): Promise<ProfileBridgeActionMap['setField']['result']> {
  const updated = await updateProfileSettings(ctx.homeDir, ctx.fs, prev => {
    const next: NonNullable<typeof prev> = { ...(prev ?? {}) }
    for (const [k, v] of Object.entries(payload.patch)) {
      // `undefined` leaves the prior value untouched (sparse-patch convention).
      if (v === undefined) continue
      const key = k as NexusProfileStringKey
      // `null` OR `''` clears the field — an unset text field shouldn't
      // persist an empty shell (keeps settings.json sparse and lets a
      // future default apply).
      if (v === null || v === '') {
        delete next[key]
      } else if (typeof v === 'string') {
        next[key] = v
      }
    }
    // Strip the section entirely when the user has cleared every field —
    // keeps the on-disk file sparse.
    if (Object.keys(next).length === 0) return undefined
    return next
  })
  const values = mergeWithDefaults(updated.profile)
  ctx.broadcastChanged?.({ values })
  return {
    ok: true,
    values,
  }
}

// Exported for unit tests that want to call the handlers directly without
// constructing a fake bridge request envelope.
export const profileHandlers = {
  snapshot: handleSnapshot,
  setField: handleSetField,
}

/**
 * Dispatch a `profile/*` bridge request to its handler. Same envelope
 * shape as `handleAgentBridgeRequest`. Per-handler runtime errors are
 * caught here and surfaced as `{ ok: false, error }` — the WebUI sees a
 * graceful failure response instead of a bridge transport timeout.
 */
export async function handleProfileBridgeRequest(
  request: BrowserBridgeRequest,
  ctx: ProfileAdapterContext,
): Promise<BrowserBridgeResponse> {
  const action = request.route.action as ProfileAction
  try {
    let result: unknown
    switch (action) {
      case 'snapshot':
        result = await handleSnapshot(ctx)
        break
      case 'setField':
        result = await handleSetField(
          request.payload as ProfileBridgeActionMap['setField']['payload'],
          ctx,
        )
        break
      default: {
        const _exhaustive: never = action
        return {
          id: request.id,
          route: request.route,
          ok: false,
          error: {
            code: 'unknown_action',
            message: `Unknown profile action: ${String(_exhaustive)}`,
          },
        }
      }
    }
    return {
      id: request.id,
      route: request.route,
      ok: true,
      result,
    } as BrowserBridgeResponse
  } catch (e) {
    return {
      id: request.id,
      route: request.route,
      ok: false,
      error: {
        code: 'profile_handler_error',
        message: e instanceof Error ? e.message : String(e),
      },
    }
  }
}

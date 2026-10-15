/**
 * Worker-side handlers for the `features` bridge namespace, served by JS in the
 * SharedWorker rather than a C++ adapter. Boot calls `installStockSkills()`,
 * `seedAppStateFromSettings` and `registerFeaturesBridgeHandlers(register)`.
 */

import type {
  BrowserBridgeRequest,
  BrowserBridgeResponse,
  FeaturesBridgeActionMap,
} from '../protocol'
import type { WorkingState } from '../../../runtime/RuntimeTypes'
import type { RuntimeFs } from '../../../utils/fs/runtimeFs'
import {
  FEATURE_CATALOG_VERSION,
  getFeatureCatalog,
} from '../../../skillLibrary/builtinSkills'
import { readUserLayer, updateFeatures } from '../../../settings/settingsStore'

export type FeaturesAdapterContext = {
  /** User home directory the settings file anchors to. Resolved once at
   *  worker boot via `resolveSettingsHomeDir(runtimeConfig)`; the file
   *  lives at `${homeDir}/.velloc/settings.json` (user-scope / global,
   *  applies across every project the user opens). */
  homeDir: string
  /** The same `processFs()` the rest of nexus uses. */
  fs: RuntimeFs
  /** Standard WorkingState mutator. Used by `setEnabled` to flip the live
   *  `enabledFeatures` map after writing the file. */
  setAppState: (updater: (prev: WorkingState) => WorkingState) => void
}

export type FeaturesAction = keyof FeaturesBridgeActionMap

// --- individual handlers (typed; tested directly by unit tests) ---------

async function handleCatalog(): Promise<FeaturesBridgeActionMap['catalog']['result']> {
  return {
    features: getFeatureCatalog().slice(),
    registryVersion: FEATURE_CATALOG_VERSION,
  }
}

async function handleSnapshot(
  ctx: FeaturesAdapterContext,
): Promise<FeaturesBridgeActionMap['snapshot']['result']> {
  const { settings, source } = await readUserLayer(ctx.homeDir, ctx.fs)
  return {
    enabled: settings.features ?? {},
    source,
  }
}

async function handleSetEnabled(
  payload: FeaturesBridgeActionMap['setEnabled']['payload'],
  ctx: FeaturesAdapterContext,
): Promise<FeaturesBridgeActionMap['setEnabled']['result']> {
  const updated = await updateFeatures(ctx.homeDir, ctx.fs, prev => {
    const next: Record<string, boolean> = { ...prev }
    for (const [id, value] of Object.entries(payload.patch)) {
      if (value === null) {
        delete next[id]
      } else if (typeof value === 'boolean') {
        next[id] = value
      }
      // Unknown value types (a misbehaving caller) are silently ignored
      // — we don't reject the whole patch over one bad entry.
    }
    return next
  })
  const effective = updated.features ?? {}
  // Flip live state so any `isEnabled(appState)` consumer (e.g. a
  // bundled skill) reflects the change on the very next call.
  ctx.setAppState(prev => ({ ...prev, enabledFeatures: effective }))
  return { ok: true, effective }
}

// Exported for unit tests that want to call the handlers directly without
// constructing a fake bridge request envelope.
export const featuresHandlers = {
  catalog: handleCatalog,
  snapshot: handleSnapshot,
  setEnabled: handleSetEnabled,
}

/**
 * Dispatch a `features/*` request in the `{ id, ok, result }` envelope. Throws
 * only on a malformed action; handler errors become `{ ok: false, error }`.
 */
export async function handleFeaturesBridgeRequest(
  request: BrowserBridgeRequest,
  ctx: FeaturesAdapterContext,
): Promise<BrowserBridgeResponse> {
  const action = request.route.action as FeaturesAction
  try {
    let result: unknown
    switch (action) {
      case 'catalog':
        result = await handleCatalog()
        break
      case 'snapshot':
        result = await handleSnapshot(ctx)
        break
      case 'setEnabled':
        result = await handleSetEnabled(
          request.payload as FeaturesBridgeActionMap['setEnabled']['payload'],
          ctx,
        )
        break
      default: {
        // Exhaustiveness — `action` should be `never` here when the
        // switch is complete. If a future action is added the compiler
        // flags this branch.
        const _exhaustive: never = action
        return {
          id: request.id,
          route: request.route,
          ok: false,
          error: {
            code: 'unknown_action',
            message: `Unknown features action: ${String(_exhaustive)}`,
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
        code: 'features_handler_error',
        message: e instanceof Error ? e.message : String(e),
      },
    }
  }
}

/**
 * Seed `appState.enabledFeatures` from the user-scope settings file.
 * Call once during runtime boot (after homeDir + fs are ready, before
 * the first model call). Idempotent — repeated calls just re-load the
 * same file.
 */
export async function seedAppStateFromSettings(
  setAppState: (updater: (prev: WorkingState) => WorkingState) => void,
  ctx: { homeDir: string; fs: RuntimeFs },
): Promise<void> {
  const { settings } = await readUserLayer(ctx.homeDir, ctx.fs)
  const enabled = settings.features ?? {}
  setAppState(prev => ({ ...prev, enabledFeatures: enabled }))
}

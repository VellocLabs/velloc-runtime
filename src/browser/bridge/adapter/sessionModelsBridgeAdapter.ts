/**
 * Worker-side handlers for the `sessionModels` bridge namespace; owns the
 * `modelTiers` and `sessionModelPolicy` sections of `~/.velloc/settings.json`.
 * Writes re-validate in `updateSessionModelSettings`: a malformed entry is dropped.
 */

import type {
  SessionModelsBridgeActionMap,
  BrowserBridgeRequest,
  BrowserBridgeResponse,
} from '../protocol'
import type { RuntimeFs } from '../../../utils/fs/runtimeFs'
import type { NexusSettingsV1 } from '../../../settings/settingsTypes'
import {
  readUserLayer,
  updateSessionModelSettings,
  type SessionModelSettingsPatch,
} from '../../../settings/settingsStore'
import type { SessionModelsFieldValues } from '../protocol/sessionModels'
import {
  clearPinFailures,
  getPinFailureHealth,
} from '../../../models/pinFailureLog'
import type {
  ModelTierSlot,
  SessionModelPolicyType,
} from '../../../settings/settingsTypes'
import { resolveModelId } from '../../../config/nexusModelConfig/modelEntryResolution'
import { providerModelName } from '../../../config/nexusModelConfig/providerModelPool'
import { getAutoTierModel } from '../../../engine/contextWindow'

export type SessionModelsAdapterContext = {
  /** User home directory the settings file anchors to (same chain
   *  features/agent/profile/memory use — one `settings.json`). */
  homeDir: string
  /** The same `processFs()` the rest of nexus uses. */
  fs: RuntimeFs
  /**
   * Fire after a successful `setField` write. The registration site
   * broadcasts `sessionModels.changed` to attached WebUI ports (cross-tab
   * consistency) AND fans the full sections out to running sessions'
   * `engine.applySessionModelSettings` (live routing). Optional so unit
   * tests don't have to wire it.
   */
  broadcastChanged?: (payload: { values: SessionModelsFieldValues }) => void
}

export type SessionModelsAction = keyof SessionModelsBridgeActionMap

/** Sections as stored (sparse), with both keys always present so the React
 *  form binds without null-checks — an absent slot/kind renders as
 *  Auto / Default. */
function toFieldValues(settings: NexusSettingsV1): SessionModelsFieldValues {
  return {
    modelTiers: settings.modelTiers ?? {},
    sessionModelPolicy: settings.sessionModelPolicy ?? {},
  }
}

// --- individual handlers (typed; tested directly by unit tests) ---------

async function handleSnapshot(
  ctx: SessionModelsAdapterContext,
): Promise<SessionModelsBridgeActionMap['snapshot']['result']> {
  const { settings } = await readUserLayer(ctx.homeDir, ctx.fs)
  const values = toFieldValues(settings)
  const hasAny =
    Object.keys(values.modelTiers).length > 0 ||
    Object.keys(values.sessionModelPolicy).length > 0
  return {
    values,
    source: hasAny ? 'file' : 'default',
    // Runtime pin health rides the snapshot: the adapter shares the
    // SharedWorker realm with the engines whose fallbacks record it.
    pinHealth: getPinFailureHealth(),
  }
}

const TIER_SLOTS: readonly ModelTierSlot[] = ['fast', 'balanced', 'best']

/** What Auto means per tier for a session on the given model — the same
 *  resolution a child session gets (`getAutoTierModel`), read where the
 *  provider listings live. */
function handleAutoTiers(
  payload: SessionModelsBridgeActionMap['autoTiers']['payload'],
): SessionModelsBridgeActionMap['autoTiers']['result'] {
  const tiers: SessionModelsBridgeActionMap['autoTiers']['result']['tiers'] = {}
  const sessionModelId = resolveModelId(payload.providerId, payload.modelId)
  for (const slot of TIER_SLOTS) {
    const modelId = getAutoTierModel(payload.providerId, payload.modelId, slot)
    if (!modelId || modelId === sessionModelId) continue
    const label = providerModelName(payload.providerId, modelId)
    tiers[slot] = { modelId, ...(label ? { label } : {}) }
  }
  return { tiers }
}

async function handleSetField(
  payload: SessionModelsBridgeActionMap['setField']['payload'],
  ctx: SessionModelsAdapterContext,
): Promise<SessionModelsBridgeActionMap['setField']['result']> {
  const updated = await updateSessionModelSettings(
    ctx.homeDir,
    ctx.fs,
    payload.patch as SessionModelSettingsPatch,
  )
  // Every patched key means "the user acted on this pin" — set OR cleared —
  // so its failure history must not haunt the new value.
  clearPinFailures({
    modelTiers: Object.keys(payload.patch.modelTiers ?? {}) as ModelTierSlot[],
    sessionModelPolicy: Object.keys(
      payload.patch.sessionModelPolicy ?? {},
    ) as SessionModelPolicyType[],
  })
  const values = toFieldValues(updated)
  ctx.broadcastChanged?.({ values })
  return {
    ok: true,
    values,
  }
}

// Exported for unit tests that want to call the handlers directly without
// constructing a fake bridge request envelope.
export const sessionModelsHandlers = {
  snapshot: handleSnapshot,
  autoTiers: handleAutoTiers,
  setField: handleSetField,
}

/**
 * Dispatch a `sessionModels/*` bridge request to its handler. Same envelope
 * shape as `handleMemoryBridgeRequest`. Per-handler runtime errors are caught
 * here and surfaced as `{ ok: false, error }` instead of a transport timeout.
 */
export async function handleSessionModelsBridgeRequest(
  request: BrowserBridgeRequest,
  ctx: SessionModelsAdapterContext,
): Promise<BrowserBridgeResponse> {
  const action = request.route.action as SessionModelsAction
  try {
    let result: unknown
    switch (action) {
      case 'snapshot':
        result = await handleSnapshot(ctx)
        break
      case 'autoTiers':
        result = handleAutoTiers(
          request.payload as SessionModelsBridgeActionMap['autoTiers']['payload'],
        )
        break
      case 'setField':
        result = await handleSetField(
          request.payload as SessionModelsBridgeActionMap['setField']['payload'],
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
            message: `Unknown sessionModels action: ${String(_exhaustive)}`,
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
        code: 'session_models_handler_error',
        message: e instanceof Error ? e.message : String(e),
      },
    }
  }
}

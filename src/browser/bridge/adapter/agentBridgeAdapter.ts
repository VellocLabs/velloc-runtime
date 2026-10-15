/**
 * Worker-side handlers for the `agent` bridge namespace; owns the `agent`
 * section of `~/.velloc/settings.json` (runtime defaults merged with sparse
 * overrides). Main UI sessions ignore the legacy `maxTurns` field.
 */

import type {
  AgentBridgeActionMap,
  AgentChangedPayload,
  AgentGlobalModel,
  BrowserBridgeRequest,
  BrowserBridgeResponse,
} from '../protocol'
import type { RuntimeFs } from '../../../utils/fs/runtimeFs'
import {
  readUserLayer,
  updateAgentSettings,
} from '../../../settings/settingsStore'

export type AgentAdapterContext = {
  /** User home directory the settings file anchors to. Resolved upstream
   *  via `resolveSettingsHomeDir(runtimeConfig)` or the `fs.userHome`
   *  direct-bridge fallback — same chain the features handler uses, so
   *  every JS-side capability writes into the SAME `settings.json`. */
  homeDir: string
  /** The same `processFs()` the rest of nexus uses. */
  fs: RuntimeFs
  /**
   * Fire after a successful `setField` / `setModel` write: the registration site
   * broadcasts `nexus.agent.changed` and pushes `worker.applyRuntimeSettings` to
   * active session workers. Optional so unit tests don't have to wire it.
   */
  broadcastChanged?: (payload: AgentChangedPayload) => void
}

export type AgentAction = keyof AgentBridgeActionMap

/**
 * Runtime defaults for the persisted fields. `log` and `trace` default OFF;
 * `maxTurns` mirrors the agent-loop's built-in default.
 */
type EffectiveValues = {
  maxTurns: number
  log: boolean
  trace: boolean
}

type AgentUserOverrides = {
  maxTurns?: number
  log?: boolean
  trace?: boolean
}

const AGENT_RUNTIME_DEFAULTS: EffectiveValues = {
  maxTurns: 10000,
  log: false,
  trace: false,
}

function mergeWithDefaults(user: AgentUserOverrides | undefined): EffectiveValues {
  return {
    maxTurns: user?.maxTurns ?? AGENT_RUNTIME_DEFAULTS.maxTurns,
    log: user?.log ?? AGENT_RUNTIME_DEFAULTS.log,
    trace: user?.trace ?? AGENT_RUNTIME_DEFAULTS.trace,
  }
}

function overriddenMap(
  user: AgentUserOverrides | undefined,
): AgentBridgeActionMap['snapshot']['result']['overridden'] {
  if (!user) return {}
  const out: AgentBridgeActionMap['snapshot']['result']['overridden'] = {}
  if (user.maxTurns !== undefined) out.maxTurns = true
  if (user.log !== undefined) out.log = true
  if (user.trace !== undefined) out.trace = true
  return out
}

// --- individual handlers (typed; tested directly by unit tests) ---------

async function handleSnapshot(
  ctx: AgentAdapterContext,
): Promise<AgentBridgeActionMap['snapshot']['result']> {
  const { settings, source } = await readUserLayer(ctx.homeDir, ctx.fs)
  const user = settings.agent
  return {
    values: mergeWithDefaults(user),
    overridden: overriddenMap(user),
    // `source` distinguishes "file existed when we loaded" from "no
    // file yet, returning defaults". A finer-grained "agent section
    // present" check isn't needed today — the file's existence is the
    // user-visible signal ("have I saved anything?").
    source,
    ...(user?.model ? { model: user.model } : {}),
  }
}

async function handleSetField(
  payload: AgentBridgeActionMap['setField']['payload'],
  ctx: AgentAdapterContext,
): Promise<AgentBridgeActionMap['setField']['result']> {
  const updated = await updateAgentSettings(ctx.homeDir, ctx.fs, prev => {
    // Build the next user-overrides object by layering the patch on
    // top of the prior value. `null` in the patch deletes the field
    // (reverts to runtime default); `undefined` in the patch leaves
    // the prior value untouched (sparse patch convention).
    const next: NonNullable<typeof prev> = { ...(prev ?? {}) }
    for (const [k, v] of Object.entries(payload.patch)) {
      const key = k as keyof typeof next
      if (v === null) {
        delete next[key]
      } else if (v !== undefined) {
        // Type-narrowed write — TS can't see across the `Object.entries`
        // erasure, so the cast just re-establishes what the call site
        // already guaranteed via the protocol's payload type.
        ;(next as Record<string, unknown>)[key as string] = v
      }
    }
    // Strip the section entirely when the user has cleared every
    // override — keeps the on-disk file sparse so a future default
    // change applies to users who never touched these toggles.
    if (Object.keys(next).length === 0) return undefined
    return next
  })
  const values = mergeWithDefaults(updated.agent)
  // `model` rides along: every `agent.changed` states the global default as
  // of this write, so a page mirroring it never has to re-read.
  // Fan-out hook: cross-tab WebUI re-render + live in-worker engine
  // overlay. See `AgentAdapterContext.broadcastChanged` for the two
  // consumers. Synchronous from the handler's POV — the registration
  // site owns the async fan-out and any logging.
  ctx.broadcastChanged?.({ values, model: updated.agent?.model ?? null })
  return {
    ok: true,
    values,
  }
}

function parseGlobalModel(raw: unknown): AgentGlobalModel {
  const model = raw as Partial<Record<keyof AgentGlobalModel, unknown>> | null
  if (
    !model ||
    typeof model !== 'object' ||
    typeof model.providerId !== 'string' ||
    !model.providerId ||
    typeof model.modelId !== 'string' ||
    !model.modelId ||
    (model.thinkingTier !== undefined && typeof model.thinkingTier !== 'string')
  ) {
    throw new Error('agent/setModel: model needs a providerId and a modelId')
  }
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    ...(model.thinkingTier ? { thinkingTier: model.thinkingTier } : {}),
  }
}

/**
 * The GLOBAL default a new session starts on (`agent.model`) — the runtime is
 * its one writer, and every write is published (`agent.changed`), so every
 * page and remote client mirrors the same value instead of the one it read at
 * boot (F-12, "The global default").
 */
async function handleSetModel(
  payload: AgentBridgeActionMap['setModel']['payload'],
  ctx: AgentAdapterContext,
): Promise<AgentBridgeActionMap['setModel']['result']> {
  const model = parseGlobalModel(payload?.model)
  const updated = await updateAgentSettings(ctx.homeDir, ctx.fs, prev => ({
    ...(prev ?? {}),
    model,
  }))
  ctx.broadcastChanged?.({ values: mergeWithDefaults(updated.agent), model })
  return { ok: true, model }
}

// Exported for unit tests that want to call the handlers directly without
// constructing a fake bridge request envelope.
export const agentHandlers = {
  snapshot: handleSnapshot,
  setField: handleSetField,
  setModel: handleSetModel,
}

/**
 * Dispatch an `agent/*` bridge request to its handler. Same envelope
 * shape as `handleFeaturesBridgeRequest`. Per-handler runtime errors
 * are caught here and surfaced as `{ ok: false, error }` — the WebUI
 * sees a graceful failure response instead of a bridge transport
 * timeout.
 */
export async function handleAgentBridgeRequest(
  request: BrowserBridgeRequest,
  ctx: AgentAdapterContext,
): Promise<BrowserBridgeResponse> {
  const action = request.route.action as AgentAction
  try {
    let result: unknown
    switch (action) {
      case 'snapshot':
        result = await handleSnapshot(ctx)
        break
      case 'setField':
        result = await handleSetField(
          request.payload as AgentBridgeActionMap['setField']['payload'],
          ctx,
        )
        break
      case 'setModel':
        result = await handleSetModel(
          request.payload as AgentBridgeActionMap['setModel']['payload'],
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
            message: `Unknown agent action: ${String(_exhaustive)}`,
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
        code: 'agent_handler_error',
        message: e instanceof Error ? e.message : String(e),
      },
    }
  }
}

/**
 * Worker-side handlers for the `mcpSettings` bridge namespace; sole writer of
 * the `mcp` section in `~/.velloc/settings.json`. Every successful write
 * broadcasts `mcpSettings.changed` (the worker MCP pool reloads on it).
 */

import type {
  BrowserBridgeRequest,
  BrowserBridgeResponse,
  McpSettingsBridgeActionMap,
  NexusMcpServerConfig,
} from '../protocol'
import type { RuntimeFs } from '../../../utils/fs/runtimeFs'
import {
  readUserLayer,
  updateMcpSettings,
} from '../../../settings/settingsStore'
import {
  pruneMcpServerSecrets,
  discardMcpServerSecrets,
  sealMcpServerSecrets,
  type McpSecretsStore,
} from '../../../mcp/mcpServerSecrets'

/**
 * Context shape used by every action. `broadcastChanged` is supplied
 * by the WebUI bridge registration site so the handler doesn't
 * directly depend on the SharedWorker manager's port set.
 */
export type McpSettingsAdapterContext = {
  homeDir: string
  fs: RuntimeFs
  /** Push the new effective `servers` map to every attached WebUI
   *  port. Called after every successful write. Optional so unit
   *  tests can omit it; production wires it via the registry. */
  broadcastChanged?: (
    payload: { servers: Record<string, NexusMcpServerConfig> },
  ) => void
  /** The host `secrets` store an http server's credential headers move
   *  into (`mcpServerSecrets.ts`). Absent: a credential header is refused
   *  rather than written in plaintext. */
  secrets?: McpSecretsStore
  /** The worker MCP client's pre-save probe (`workerServers.ts`). Absent:
   *  `testConnect` errors and the form saves without a probe. */
  testConnect?: (
    config: NexusMcpServerConfig,
  ) => Promise<McpSettingsBridgeActionMap['testConnect']['result']>
}

export type McpSettingsAction = keyof McpSettingsBridgeActionMap

// ---------------------------------------------------------------------------
// Validation — runtime guard against malformed configs from a
// misbehaving caller. The on-disk normaliser drops bad entries
// silently, but the WebUI client is the user-facing contract — we
// give the user a clear error envelope rather than silently writing
// a half-valid config and leaving them confused why the server
// "isn't there."
// ---------------------------------------------------------------------------

function validateServerConfig(config: NexusMcpServerConfig): string | null {
  if (!config || typeof config !== 'object') {
    return 'config must be an object'
  }
  const isStdio = config.transport === 'stdio'
    || (config.transport === undefined && config.command !== undefined)
  const isHttp = config.transport === 'http'
    || (config.transport === undefined && config.url !== undefined)

  if (isStdio) {
    if (typeof config.command !== 'string' || config.command.length === 0) {
      return 'stdio transport requires a non-empty `command`'
    }
  } else if (isHttp) {
    if (typeof config.url !== 'string' || config.url.length === 0) {
      return 'http transport requires a non-empty `url`'
    }
  } else {
    return "transport is required and must be 'stdio' or 'http'"
  }
  return null
}

function validateId(id: unknown): string | null {
  if (typeof id !== 'string' || id.length === 0) {
    return '`id` must be a non-empty string'
  }
  // No whitespace, no path separators — settings.json keys aren't
  // path-bound, but the chat panel sometimes uses ids in tool names
  // (`mcp__<id>__<tool>`), so disallowing weird chars prevents
  // user-confusion at the model-prompt boundary.
  if (/[\s/\\]/.test(id)) {
    return '`id` must not contain whitespace, `/`, or `\\`'
  }
  return null
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleList(
  ctx: McpSettingsAdapterContext,
): Promise<McpSettingsBridgeActionMap['list']['result']> {
  const { settings, source } = await readUserLayer(ctx.homeDir, ctx.fs)
  return {
    servers: settings.mcp?.servers ?? {},
    source,
  }
}

async function handleUpsert(
  payload: McpSettingsBridgeActionMap['upsert']['payload'],
  ctx: McpSettingsAdapterContext,
): Promise<McpSettingsBridgeActionMap['upsert']['result']> {
  const idError = validateId(payload.id)
  if (idError) {
    throw new Error(idError)
  }
  const configError = validateServerConfig(payload.config)
  if (configError) {
    throw new Error(configError)
  }
  // Credential headers go to the host store first; settings.json only ever
  // sees their placeholders.
  // A new value never overwrites a stored one (it takes a fresh name), so a
  // settings write that fails leaves the saved config's secrets intact and
  // only what this save wrote to discard.
  const sealed = await sealMcpServerSecrets(payload.id, payload.config, ctx.secrets)
  let updated: Awaited<ReturnType<typeof updateMcpSettings>>
  try {
    updated = await updateMcpSettings(ctx.homeDir, ctx.fs, prev => {
      const next: NonNullable<typeof prev> = {
        servers: { ...(prev?.servers ?? {}) },
      }
      next.servers[payload.id] = sealed.config
      return next
    })
  } catch (error) {
    await discardMcpServerSecrets(sealed.written, ctx.secrets)
    throw error
  }
  await pruneMcpServerSecrets(payload.id, sealed.referenced, ctx.secrets)
  const servers = updated.mcp?.servers ?? {}
  ctx.broadcastChanged?.({ servers })
  return { ok: true, servers }
}

async function handleRemove(
  payload: McpSettingsBridgeActionMap['remove']['payload'],
  ctx: McpSettingsAdapterContext,
): Promise<McpSettingsBridgeActionMap['remove']['result']> {
  const idError = validateId(payload.id)
  if (idError) {
    throw new Error(idError)
  }
  // Read current state to detect the no-op case BEFORE calling the
  // updater — keeps the broadcast in lockstep with actual disk writes
  // (an idempotent remove of an unknown id shouldn't ping all open
  // settings tabs to re-render).
  const { settings: current } = await readUserLayer(ctx.homeDir, ctx.fs)
  const currentServers = current.mcp?.servers
  if (!currentServers || !(payload.id in currentServers)) {
    return { ok: true, servers: currentServers ?? {} }
  }

  const updated = await updateMcpSettings(ctx.homeDir, ctx.fs, prev => {
    const nextServers = { ...(prev?.servers ?? {}) }
    delete nextServers[payload.id]
    if (Object.keys(nextServers).length === 0) {
      // Clearing the last entry drops the whole section — keeps the
      // file sparse for the "nothing configured" state. The
      // generic `updateSectionInSource` honours `undefined` returns.
      return undefined
    }
    return { servers: nextServers }
  })
  await pruneMcpServerSecrets(payload.id, new Set(), ctx.secrets)
  const servers = updated.mcp?.servers ?? {}
  ctx.broadcastChanged?.({ servers })
  return { ok: true, servers }
}

async function handleTestConnect(
  payload: McpSettingsBridgeActionMap['testConnect']['payload'],
  ctx: McpSettingsAdapterContext,
): Promise<McpSettingsBridgeActionMap['testConnect']['result']> {
  if (!ctx.testConnect) {
    throw new Error('This host cannot run MCP servers.')
  }
  return ctx.testConnect(payload.config)
}

export const mcpSettingsHandlers = {
  list: handleList,
  upsert: handleUpsert,
  remove: handleRemove,
  testConnect: handleTestConnect,
}

export async function handleMcpSettingsBridgeRequest(
  request: BrowserBridgeRequest,
  ctx: McpSettingsAdapterContext,
): Promise<BrowserBridgeResponse> {
  const action = request.route.action as McpSettingsAction
  try {
    let result: unknown
    switch (action) {
      case 'list':
        result = await handleList(ctx)
        break
      case 'upsert':
        result = await handleUpsert(
          request.payload as McpSettingsBridgeActionMap['upsert']['payload'],
          ctx,
        )
        break
      case 'remove':
        result = await handleRemove(
          request.payload as McpSettingsBridgeActionMap['remove']['payload'],
          ctx,
        )
        break
      case 'testConnect':
        result = await handleTestConnect(
          request.payload as McpSettingsBridgeActionMap['testConnect']['payload'],
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
            message: `Unknown mcpSettings action: ${String(_exhaustive)}`,
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
        code: 'mcp_settings_handler_error',
        message: e instanceof Error ? e.message : String(e),
      },
    }
  }
}

/**
 * A session's MCP pool (F-10): settings-configured servers run in the worker over the host's
 * primitives when served, else the browser-transport-only pool. Security: only servers
 * settings.json names may reach loopback / the LAN (`allowPrivateNetwork`); a plugin's server
 * may not.
 */

import type { BrowserBridgeTransport } from '../bridge/browserBridgeProtocol'
import type { BrowserHostManifest } from '../bridge/protocol/manifest'
import type { PluginContributions } from '../../pluginHost'
import type { TemplateConfig } from '../../prompting/templateParsing'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import { readUserLayer, wipeSettingsMemos } from '../../settings/settingsStore'
import { templateAllowsMcp } from '../../prompting/templateRegistry'
import { acquireSessionMCPPool, createWorkerMcpOperations } from '../../mcp'
import { MCPPool } from '../../mcp/pool'
import { settingsMcpServerIds, type McpServerOriginSources } from '../../mcp/serverOrigin'
import {
  pluginMcpOwnersInScope,
  pluginMcpServersInScope,
  pluginNativeMcpServersInScope,
  sessionMcpScopeOf,
} from '../../mcp/sessionMcpScope'
import { getMcpHost, hostServesWorkerMcp } from '../../mcp/mcpHost'
import { undoWhenScopeEnds } from '../../mods/modSlotRegistry'

export type SessionMcpPoolInput = {
  settingsHome: () => string
  appAgentRun: string | undefined
  templateType: string
  sessionTemplate: { config?: TemplateConfig } | undefined
  resolvedOptions: {
    bridgeTransport: BrowserBridgeTransport
    hostManifest?: BrowserHostManifest
  }
  runtimeConfig: { createUUID(): string }
  pluginContributions: PluginContributions
  options: {
    onBootStage?: (stage: 'connectingTools') => void
    runtimeScopeSignal?: AbortSignal
  }
  resolvedSessionId: string
  resolvedCwd: string
  installedFs: RuntimeFs
}

/** Opens (or joins) the session's pool; the lease is released when the runtime scope ends. */
export async function openSessionMcpPool(input: SessionMcpPoolInput) {
  const {
    settingsHome,
    appAgentRun,
    templateType,
    sessionTemplate,
    resolvedOptions,
    runtimeConfig,
    pluginContributions,
    options,
    resolvedSessionId,
    resolvedCwd,
    installedFs,
  } = input

  // MCP pool settings source — same bridge-`homeDir` fallback as the boot
  // overlays (see `settingsHome`); `null` → only the plugin stdio servers.
  const settingsHomeDir: string | null = (() => {
    try {
      return settingsHome()
    } catch {
      return null
    }
  })()
  // Security: the MCP sources this type takes (F-25). `plugin` confines the
  // session to the plugin that owns its type: that plugin's servers and
  // registered tools alone, no settings.json server, no project server file,
  // no other plugin's server. Decided here, where the root pool is built, so
  // the loops under the session inherit the same pool.
  const mcpScope = appAgentRun
    ? (await import('../../mods/app/appRunTools')).appRunMcpScope(templateType)
    : sessionMcpScopeOf(templateType, sessionTemplate?.config)
  // Shared by every runtime reading this settings home: a pool outlives the
  // runtime that created it, and that runtime's bridge still asks this set.
  // A plugin-scoped session never reads settings.json, so its set stays empty
  // and none of its servers reaches loopback or the LAN.
  const userConfiguredMcpServerIds =
    mcpScope.kind === 'plugin' ? new Set<string>() : settingsMcpServerIds(settingsHomeDir ?? '')
  const sessionMcpHost = {
    transport: resolvedOptions.bridgeTransport,
    manifest: resolvedOptions.hostManifest,
  }
  const nativeMcpBridge = hostServesWorkerMcp(resolvedOptions.hostManifest)
    ? createWorkerMcpOperations({
        resolveHost: () => {
          const host = getMcpHost()
          if (!host) return sessionMcpHost
          return { transport: host.transport, manifest: host.manifest ?? sessionMcpHost.manifest }
        },
        createRequestId: () => runtimeConfig.createUUID(),
        allowPrivateNetwork: serverId => userConfiguredMcpServerIds.has(serverId),
      })
    : undefined
  // The MCP pool reads its settings server list from
  // `~/.velloc/settings.json` (mcp.servers section); each server's full
  // config travels inline through `connect()`. The plugin list follows
  // plugin reloads.
  let pluginNativeMcpServers = pluginNativeMcpServersInScope(
    mcpScope,
    pluginContributions.nativeMcpServers,
    pluginContributions.mcpServerPlugins,
  )
  const mergePluginNativeMcpServers = (
    settingsEntries: typeof pluginContributions.nativeMcpServers,
  ) => {
    const taken = new Set(settingsEntries.map(entry => entry.id))
    const pluginEntries: typeof pluginContributions.nativeMcpServers = []
    for (const entry of pluginNativeMcpServers) {
      if (taken.has(entry.id)) {
        console.warn(
          `[mcp] Plugin native server "${entry.id}" skipped — a native server with that name is already configured.`,
        )
        continue
      }
      taken.add(entry.id)
      pluginEntries.push(entry)
    }
    return [...settingsEntries, ...pluginEntries]
  }
  const loadNativeMcpServers = async () => {
    // Security: a plugin-scoped session lists its owner's stdio servers only;
    // settings.json is not read.
    if (!settingsHomeDir || mcpScope.kind === 'plugin') return mergePluginNativeMcpServers([])
    try {
      // This callback's contract is "re-read the LATEST disk state"
      // (see MCPPoolOptions.loadNativeServers): the pool-refresh
      // paths exist for servers added since the worker last read
      // settings.json — including writes from OUTSIDE this worker
      // (a file edit, a CLI). The settings cache only invalidates
      // on in-process writes, so drop it first or the re-read
      // returns the frozen first-boot list and the refresh is a
      // silent no-op.
      wipeSettingsMemos()
      const { settings } = await readUserLayer(
        settingsHomeDir,
        installedFs,
      )
      const settingsServers = settings.mcp?.servers ?? {}
      userConfiguredMcpServerIds.clear()
      for (const id of Object.keys(settingsServers)) userConfiguredMcpServerIds.add(id)
      const settingsEntries = Object.entries(settingsServers).map(([id, raw]) => ({
        id,
        config: {
          transport: raw.transport,
          command: raw.command,
          args: raw.args,
          env: raw.env,
          url: raw.url,
          headers: raw.headers,
          cwd: raw.cwd,
        },
      }))
      return mergePluginNativeMcpServers(settingsEntries)
    } catch (e) {
      console.warn(
        `[mcp] failed to load servers from settings.json: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
      return mergePluginNativeMcpServers([])
    }
  }
  // Boot-welcome milestone: entering the MCP-server connect — the longest
  // single step of the runtime build when servers are configured (spawn +
  // handshake per server). Fired BEFORE the await so the footer moves the
  // moment the wait starts.
  options.onBootStage?.('connectingTools')
  // One pool per top-level session: a sub-agent or fork names its spawner
  // (`modParentSessionId`), a teammate its lead (`spawnerSessionId`).
  const mcpParentSessionId =
    (resolvedOptions as { modParentSessionId?: string }).modParentSessionId ??
    ((resolvedOptions as { isTeammate?: boolean }).isTeammate === true
      ? (resolvedOptions as { spawnerSessionId?: string }).spawnerSessionId
      : undefined)
  // Security: a `noExecution` type takes nothing from the MCP pool, structurally, since MCP tools
  // bypass the template allowlist and a stdio server spawns OS processes. It holds no session pool
  // and starts no server; an empty pool that never connects stands in.
  const allowsMcp = templateAllowsMcp(sessionTemplate?.config)
  const mcpLease = allowsMcp
    ? await acquireSessionMCPPool({
        sessionId: resolvedSessionId,
        parentSessionId: mcpParentSessionId,
        cwd: resolvedCwd,
        fs: installedFs,
        extraServers: pluginMcpServersInScope(
          mcpScope,
          pluginContributions.mcpServers,
          pluginContributions.mcpServerPlugins,
        ),
        projectServers: mcpScope.kind !== 'plugin',
        nativeBridge: nativeMcpBridge,
        loadNativeServers: loadNativeMcpServers,
      })
    : undefined
  if (mcpLease) undoWhenScopeEnds(mcpLease.release, options.runtimeScopeSignal)
  const mcpPool = mcpLease?.pool ?? new MCPPool({ cwd: resolvedCwd, fs: installedFs })
  const mcpOrigins: McpServerOriginSources = {
    settingsIds: userConfiguredMcpServerIds,
    pluginServers: pluginMcpOwnersInScope(mcpScope, pluginContributions.mcpServerPlugins),
    projectNames: mcpPool.projectServerNames,
  }
  return {
    settingsHomeDir,
    mcpScope,
    allowsMcp,
    mcpLease,
    mcpPool,
    mcpOrigins,
    /** A plugin reload's stdio servers, under the scope the pool was built with. */
    setPluginNativeServers(contributions: Pick<PluginContributions, 'nativeMcpServers' | 'mcpServerPlugins'>): void {
      pluginNativeMcpServers = pluginNativeMcpServersInScope(
        mcpScope,
        contributions.nativeMcpServers,
        contributions.mcpServerPlugins,
      )
    },
  }
}

/**
 * Bridge namespace: `mcpSettings` — MCP server configs in the `mcp` section of
 * `~/.velloc/settings.json`. `upsert` overwrites by `id` and rejects a malformed
 * config (`webui_handler_error`); `remove` is idempotent.
 * Security: `upsert` moves an http server's credential headers into the host
 * `secrets` store, persisting `{{secret:mcp:…}}` placeholders; `remove` deletes them.
 * `mcpSettings.changed` `{servers}` follows every successful write.
 */

import type { NexusMcpServerConfig } from '../../../settings/settingsTypes'
import type { PluginMcpServerListing } from '../../../pluginHost/pluginMcpServerList'
import type { McpToolSummary } from '../../../mcp/toolSummary'

export type { PluginMcpServerListing } from '../../../pluginHost/pluginMcpServerList'

/** Re-export for convenience — the WebUI protocol uses the same
 *  server-config shape that settings.json persists. */
export type { NexusMcpServerConfig } from '../../../settings/settingsTypes'

export type McpSettingsBridgeActionMap = {
  list: {
    payload: Record<string, never>
    result: {
      /** Sparse map keyed by server id. Empty `{}` means "no servers
       *  configured" — the UI shows the "Add server" empty state. */
      servers: Record<string, NexusMcpServerConfig>
      /** `'file'` once the settings file has an `mcp` section,
       *  `'default'` before the first write (so the UI can distinguish
       *  "user has saved nothing" from "user explicitly removed all"). */
      source: 'file' | 'default'
      /** The servers the person's enabled user-scope plugins declare, read
       *  only: a plugin's servers are turned off with the plugin. Absent
       *  when the host cannot list them. */
      pluginServers?: PluginMcpServerListing[]
    }
  }
  upsert: {
    payload: {
      id: string
      config: NexusMcpServerConfig
    }
    result: {
      ok: true
      /** Effective `servers` map after the upsert — saves the UI one
       *  round-trip. */
      servers: Record<string, NexusMcpServerConfig>
    }
  }
  remove: {
    payload: { id: string }
    result: {
      ok: true
      servers: Record<string, NexusMcpServerConfig>
    }
  }
  testConnect: {
    payload: { config: NexusMcpServerConfig }
    result: {
      ok: boolean
      serverName?: string
      serverVersion?: string
      toolCount?: number
      tools?: McpToolSummary[]
      /** The server's initialize `instructions`, bounded (F-10). */
      instructions?: string
      error?: string
    }
  }
}

import { createContext, useContext } from 'react'
import type { SessionMcpServerView } from '@/browser/worker/workerProtocol'
import type { McpAuthControls } from '@/browser/webview/mcpAuthView'

/**
 * The thread's MCP servers, from the session snapshot (`mcpServers`), for
 * the card stack's Connectors card and its server detail view. Provided by
 * `AssistantUiThread`; empty on hosts and session types without MCP.
 */
export type SessionConnectors = {
  servers: readonly SessionMcpServerView[]
  /** Opens the MCP settings page; absent where settings cannot open. */
  openMcpSettings?: () => void
  /** Server sign-in (F-10); absent where the page has no runtime connection. */
  auth?: McpAuthControls
}

const NO_CONNECTORS: SessionConnectors = { servers: [] }

export const SessionConnectorsContext = createContext<SessionConnectors>(NO_CONNECTORS)

export function useSessionConnectors(): SessionConnectors {
  return useContext(SessionConnectorsContext)
}

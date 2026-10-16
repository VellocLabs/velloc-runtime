import { createContext, useContext } from 'react'
import type { SessionMcpServerView } from '@/browser/worker/workerProtocol'

/**
 * The thread's MCP servers, from the session snapshot (`mcpServers`), for
 * the card stack's Connectors card. Provided by `AssistantUiThread`; empty
 * on hosts and session types without MCP.
 */
export const SessionConnectorsContext = createContext<readonly SessionMcpServerView[]>([])

export function useSessionConnectors(): readonly SessionMcpServerView[] {
  return useContext(SessionConnectorsContext)
}

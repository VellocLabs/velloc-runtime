/**
 * Recognizes an MCP server's "sign in first" answer (HTTP 401) on both
 * tracks (F-10): the SDK's HTTP error carries `code: 401`, the worker track
 * reports `HTTP 401: …` (`describeMcpFailure`).
 */
import { launchTransportKind, type NexusMcpServerLaunchConfig } from './nativeBridge'
import type { MCPServerConfig } from './types'

export function isMcpUnauthorized(error: unknown): boolean {
  if (typeof error === 'string') return /^HTTP 401\b/.test(error)
  if (!error || typeof error !== 'object') return false
  if ((error as { code?: unknown }).code === 401) return true
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && /^HTTP 401\b/.test(message)
}

/** The error a call to a server that needs a sign-in answers with. */
export function mcpSignInRequiredMessage(serverName: string): string {
  return (
    `MCP server "${serverName}" needs the person to sign in before its tools can be used. `
    + 'They can sign in from the Connectors card or Settings → MCP servers.'
  )
}

/** The URL a server's sign-in belongs to: http servers only. */
export function mcpSignInUrl(server: {
  config?: MCPServerConfig
  nativeConfig?: NexusMcpServerLaunchConfig
}): string | undefined {
  if (server.config?.type === 'http') return server.config.url
  const native = server.nativeConfig
  if (native?.url && launchTransportKind(native) === 'http') return native.url
  return undefined
}

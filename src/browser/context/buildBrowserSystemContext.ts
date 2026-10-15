import type { ServerLink } from '../../runtime/RuntimeTypes'
import type { BrowserContextSnapshot } from '../bridge/BrowserHostBridge'

export type BuildBrowserSystemContextParams = {
  snapshot: BrowserContextSnapshot
  mcpClients: ServerLink[]
}

export function buildBrowserSystemContext({
  snapshot,
  mcpClients,
}: BuildBrowserSystemContextParams): Record<string, string> {
  // Only locale and timezone go here: tool lists, snapshots, tabs and actor
  // state are per-turn or already sent elsewhere (tools[], the per-input browser
  // context attachment, tool results) and would break prompt caching.
  const context: Record<string, string> = {}

  if (snapshot.session.locale) {
    context.locale = snapshot.session.locale
  }
  if (snapshot.session.timezone) {
    context.timezone = snapshot.session.timezone
  }

  if (snapshot.workspace) {
    context.browserWorkspace = [
      ...(snapshot.workspace.workspaceName
        ? [`Workspace: ${snapshot.workspace.workspaceName}`]
        : []),
      ...(snapshot.workspace.projectName
        ? [`Project: ${snapshot.workspace.projectName}`]
        : []),
      ...(snapshot.workspace.source
        ? [`Source: ${snapshot.workspace.source}`]
        : []),
      ...(snapshot.workspace.workspaceId
        ? [`Workspace ID: ${snapshot.workspace.workspaceId}`]
        : []),
    ].join('\n')
  }

  if (mcpClients.length > 0) {
    context.mcpClients = mcpClients
      .map(client => client.name ?? 'unknown')
      .join(', ')
  }

  return context
}

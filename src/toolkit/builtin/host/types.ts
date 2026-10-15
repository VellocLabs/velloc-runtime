import type { HostedToolDefinition } from '../../../browser/bridge/protocol/manifest'

/** The three host API families a host tool is served by. */
export type HostToolCapability = 'files' | 'exec' | 'browser'

/** The host action behind a tool: `files.read`, `exec.bash`, `browser.click`. */
export type HostToolRoute = {
  capability: HostToolCapability
  action: string
}

/**
 * A host tool as the runtime defines it: the model-facing definition (name,
 * description, schema, flags — exactly what the host's catalog used to serve)
 * plus the host action its call is forwarded to. `host` never reaches the
 * model; `serializeToolsForModel` reads only the definition fields.
 */
export type HostToolDefinition = HostedToolDefinition & {
  host: HostToolRoute
}

/** Which shells the host can run (`exec.listShells`). */
export type HostShells = {
  bash: boolean
  powershell: boolean
}

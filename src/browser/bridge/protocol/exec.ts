// `exec` capability — the host actions behind the shell tools (C++
// `NexusExecBridgeAdapter`, declarations under api/declarations/exec/), plus
// `listShells`, which tells the runtime which shells the host can run so it
// offers only those tools.
import type { HostToolCallPayload, HostToolCallResult } from './files'

export type ExecBridgeActionMap = {
  bash: { payload: HostToolCallPayload; result: HostToolCallResult }
  powerShell: { payload: HostToolCallPayload; result: HostToolCallResult }
  listShells: {
    payload: Record<string, never>
    result: { bash: boolean; powershell: boolean }
  }
}

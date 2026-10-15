/**
 * agentRuntimeBody — the real SharedWorker runtime, loaded by the entry stub
 * (`agentRuntime.sharedworker.ts`) through `import()` so its chunk is eligible
 * for V8 code cache (see agentRuntimeConnectGate.ts for the why).
 *
 * Nothing here may run before the entry's `onconnect` is installed; the stub
 * guarantees that by importing this module only after wiring the gate.
 */
import { SharedWorkerSessionManager } from './SharedWorkerSessionManager'
import { AgentRuntimeWorker } from './AgentRuntimeWorker'
import type { PortAcceptor } from './agentRuntimeConnectGate'

/** Build the session manager and return the acceptor the gate hands ports to. */
export function startAgentRuntime(): PortAcceptor {
  const manager = new SharedWorkerSessionManager({
    createWorker: (options) => new AgentRuntimeWorker(options),
  })
  return (port) => manager.handleConnect(port)
}

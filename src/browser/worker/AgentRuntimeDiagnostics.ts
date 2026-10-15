import { getSessionTracer } from '../../utils/sessionTrace'
import { installCallModelTraceEmitter } from './agentRuntimeBootstrap'
import { setModelUploadTraceEnabled } from '../../engine/turn/modelTrace'
import { setWorkerLogCaptureSource } from '../../utils/workerLogBuffer'
import type { RuntimeScope } from './agentRuntimeScope'
import type { AgentRuntimeWorkerInitPayload } from './workerProtocol'

/**
 * Applies page-computed diagnostic gates to the persistent worker realm and
 * owns the current runtime scope's call-model trace lease.
 */
export class AgentRuntimeDiagnostics {
  constructor(private readonly emitCallModelLog: (message: string) => void) {}

  apply(
    payload: AgentRuntimeWorkerInitPayload,
    scope: RuntimeScope | null,
  ): void {
    const enabled = payload.traceModelRequests === true
    setModelUploadTraceEnabled(enabled)
    getSessionTracer().setEnabled(enabled)
    setWorkerLogCaptureSource('tracer', enabled)
    if (!scope) {
      return
    }
    if (payload.logCallModel && !scope.callModelTraceDispose) {
      scope.callModelTraceDispose = installCallModelTraceEmitter(
        this.emitCallModelLog,
      )
    } else if (!payload.logCallModel && scope.callModelTraceDispose) {
      scope.callModelTraceDispose()
      scope.callModelTraceDispose = undefined
    }
  }
}

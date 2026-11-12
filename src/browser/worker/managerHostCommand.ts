/**
 * Contract: one shell command run on the host from the runtime manager, with
 * no session runtime built, as the host Bash action keyed to `sessionId`, in
 * the folder `cwd` (never the session's own, which may be the checkout being
 * removed or not exist yet). Resolves `ok: false` on a non-zero exit, a
 * refusal or no host port, with the host's rendered error; never throws.
 * Security: callers pass only runtime-built commands (quoted paths and refs);
 * this is not a surface for arbitrary input. (F-36)
 */
import type { DirectPortBridgeTransport } from '../bridge/DirectPortBridgeTransport'
import { hostRouteFor } from '../../toolkit/builtin/host'
import { renderHostErrorText } from '../../toolkit/builtin/host/resultText'
import { unwrapToString, type HostCommandRunner } from '../../utils/agentWorktree'

export type ManagerHostCommandDeps = {
  getTransport(): DirectPortBridgeTransport | null
  createRequestId(): string
}

export function managerHostCommand(deps: ManagerHostCommandDeps, sessionId: string, cwd: string): HostCommandRunner {
  return async command => {
    const transport = deps.getTransport()
    const route = hostRouteFor('Bash')
    if (!transport || !route) return { ok: false, stdout: 'no host port to run git on' }
    try {
      const response = (await transport.request({
        id: deps.createRequestId(),
        route: { namespace: 'nexus', capability: route.capability, action: route.action } as never,
        payload: { command, cwd } as never,
        context: { sessionId },
      })) as { ok: true; result: unknown } | { ok: false; error?: { code?: string; message?: string; data?: unknown } }
      if (!response.ok) {
        const { code, message, data } = response.error ?? {}
        return { ok: false, stdout: (code && renderHostErrorText('Bash', code, data)) || message || 'refused' }
      }
      const text = unwrapToString(response.result)
      return { ok: true, stdout: text === '(no output)' ? '' : text }
    } catch (err) {
      return { ok: false, stdout: err instanceof Error ? err.message : String(err) }
    }
  }
}

/**
 * The desktop page's restart gate for the background updater, on `window.__nexusRestartGate`; it asks
 * `runtime.getRestartReadiness`. Installed only by the unscoped desktop boot; absent = never reload,
 * and every failure answers `false`. Beside it, `window.__nexusRuntimeRetire` asks
 * `runtime.retireForUpdate`: the runtime outlasts this page, so the updater ends it before the
 * reload that applies a staged build. (P-2)
 */

import type { RuntimeConnection } from '../runtimeClient/RuntimeConnection'

type ReadinessConnection = Pick<RuntimeConnection, 'request'>

export type RestartGate = () => Promise<boolean>

export function createUpdateRestartGate(
  connection: () => Promise<ReadinessConnection>,
): RestartGate {
  return async () => {
    try {
      const answer = (await (await connection()).request(
        'runtime.getRestartReadiness',
      )) as { ready?: unknown } | null | undefined
      return !!answer && answer.ready === true
    } catch {
      return false
    }
  }
}

/** Resolves `true` once the runtime has agreed to end; `false` when it is busy or unreachable. */
export type RuntimeRetire = () => Promise<boolean>

export function createRuntimeRetire(connection: () => Promise<ReadinessConnection>): RuntimeRetire {
  return async () => {
    try {
      const answer = (await (await connection()).request(
        'runtime.retireForUpdate',
      )) as { retired?: unknown } | null | undefined
      return !!answer && answer.retired === true
    } catch {
      return false
    }
  }
}

type GateTarget = { __nexusRestartGate?: RestartGate; __nexusRuntimeRetire?: RuntimeRetire }

export function installUpdateRestartGate(
  connection: () => Promise<ReadinessConnection>,
  target: GateTarget = globalThis as GateTarget,
): void {
  target.__nexusRestartGate = createUpdateRestartGate(connection)
  target.__nexusRuntimeRetire = createRuntimeRetire(connection)
}

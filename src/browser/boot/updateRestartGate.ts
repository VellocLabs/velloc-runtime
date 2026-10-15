/**
 * The desktop page's restart gate for the background updater, on `window.__nexusRestartGate`; it asks
 * `runtime.getRestartReadiness`. Installed only by the unscoped desktop boot; absent = never reload,
 * and every failure answers `false`.
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

export function installUpdateRestartGate(
  connection: () => Promise<ReadinessConnection>,
  target: { __nexusRestartGate?: RestartGate } = globalThis as { __nexusRestartGate?: RestartGate },
): void {
  target.__nexusRestartGate = createUpdateRestartGate(connection)
}

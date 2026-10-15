/**
 * Leaf indirection (avoids an import cycle) for teammate spawning: the manager
 * registers via `setTeammateSpawner`; the tool reads `getTeammateSpawner()`,
 * null when none is registered.
 */

import type { SpawnTeammateParams } from './teamTypes'

/**
 * Thrown by a spawner when the lead already has a RUNNING teammate under the
 * same display name. Two live teammates answering to one name would make
 * `SendMessage` / `Shutdown` — which address by that name — ambiguous, so the
 * second spawn is refused and the model told to pick another name (or to
 * message / shut down the one it has). Distinct from a null return, which
 * means the runtime cannot spawn anyone yet.
 */
export class TeammateNameInUseError extends Error {
  constructor(readonly displayName: string) {
    super(
      `A teammate named ${JSON.stringify(displayName)} is already running. Message it with SendMessage, Shutdown it first, or pick another name.`,
    )
    this.name = 'TeammateNameInUseError'
  }
}

/** Returns the new teammate sessionId, or null if it couldn't spawn. Throws
 *  `TeammateNameInUseError` for a duplicate live display name. */
export type TeammateSpawner = (params: SpawnTeammateParams) => string | null

let spawner: TeammateSpawner | null = null

export function setTeammateSpawner(fn: TeammateSpawner | null): void {
  spawner = fn
}

export function getTeammateSpawner(): TeammateSpawner | null {
  return spawner
}

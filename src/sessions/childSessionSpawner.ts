/**
 * Leaf indirection for starting a child session: the manager registers the
 * spawner at boot, the `SpawnSession` tool reads it, and neither imports the
 * other. Null when no manager is registered. (F-36)
 */

import type { ChildSessionRequest } from './childSessionSpec'
import type { BrowserLlmSelection } from '../browser/bridge/protocol/nexus_llm'
import type { SessionMode } from '../permissions/sessionModes'

/** Makes the child's worktree; the tool supplies it with the git capability of
 *  the calling turn. Runs once the session is registered, with the family
 *  name the runtime allocated (the default branch and directory carry it), so
 *  a failure leaves the session on record as not started. */
export type ChildWorktreePrepare = (name: string) => Promise<
  | { ok: true; cwd: string; repoRoot: string }
  | { ok: false; reason: string }
>

export type ChildSessionSpawnParams = {
  parentSessionId: string
  request: ChildSessionRequest
  /** The provider against which an explicit model was validated. */
  providerId?: string
  /** Reasoning tier pinned for `request.model`, when one was checked. */
  thinkingTier?: string
  /** Present when the request's isolation is `worktree`. */
  prepareWorktree?: ChildWorktreePrepare
  /** Routine provenance carried across the start (see `SubAgentSpawnParams`). */
  routineOriginId?: string
  /** The proposal this start comes from; absent for a direct start, which
   *  gets a task id of its own. */
  taskId?: string
  /** The relation recorded on the child; absent is `side_session`. */
  kind?: 'side_session' | 'hand_off'
}

export type ChildSessionSpawnOutcome =
  | {
      ok: true
      sessionId: string
      name: string
      sharedCheckout: boolean
      /** The directory the child works in. */
      cwd?: string
      /** Set when the session is on record but could not start. */
      startFailed?: string
    }
  | { ok: false; reason: string }

/** Starts a child session. Null when the runtime cannot start one yet (no
 *  UI session has booted). */
export type ChildSessionSpawner = (
  params: ChildSessionSpawnParams,
) => Promise<ChildSessionSpawnOutcome | null>

export type ParentSelectionGetter = (sessionId: string) => BrowserLlmSelection | null

let parentSelectionGetter: ParentSelectionGetter | null = null

export function setParentSelectionGetter(fn: ParentSelectionGetter | null): void {
  parentSelectionGetter = fn
}

/** Read the parent's live worker selection, never a UI init or global default. */
export function getParentSelection(sessionId: string): BrowserLlmSelection | null {
  const selection = parentSelectionGetter?.(sessionId)
  return selection ? { ...selection } : null
}

export type ParentPermissionModeGetter = (sessionId: string) => SessionMode | null

let parentPermissionModeGetter: ParentPermissionModeGetter | null = null

export function setParentPermissionModeGetter(fn: ParentPermissionModeGetter | null): void {
  parentPermissionModeGetter = fn
}

export function getParentPermissionMode(sessionId: string): SessionMode | null {
  return parentPermissionModeGetter?.(sessionId) ?? null
}

let spawner: ChildSessionSpawner | null = null

export function setChildSessionSpawner(fn: ChildSessionSpawner | null): void {
  spawner = fn
}

export function getChildSessionSpawner(): ChildSessionSpawner | null {
  return spawner
}

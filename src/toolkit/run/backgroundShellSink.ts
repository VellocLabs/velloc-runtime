/**
 * Module-level sink for BACKGROUND-shell launches, registered by the one
 * SharedWorker manager (tools must not import it). The launch carries
 * `spawnerSessionId` so the `local_bash` task is scoped to the owning session.
 * Default is a no-op.
 */

import type { NexusShellInvokeParams } from '../../browser/bridge/protocol/ui'

export type BackgroundShellLaunch = {
  /** The persistent child's id (`shell.spawn` with `persist` → `persistentId`,
   *  via the {@link BackgroundShellSpawner}) — the task's NATIVE id (the
   *  `shell.persistentKill` handle + the registry map key). */
  shellId: string
  /** Prefixed public task id (`b…`, from `mintTaskHandle('local_bash')`) minted
   *  by the Bash tool — the model/drawer/TaskOutput/TaskStop handle. The manager
   *  indexes `taskId → shellId`. Omitted → the manager mints one. */
  taskId?: string
  /** The host-readable output file path the model can inspect with Read. */
  spoolPath?: string
  /** The command line the model ran. Drawer display label for the task. */
  command: string
  /**
   * The owning LLM session that launched the shell. Used to scope the
   * `local_bash` task to that session in the drawer (per-session filtering) and
   * to cascade-stop the poll when the session closes — same as a sub-agent's
   * `spawnerSessionId`.
   */
  spawnerSessionId?: string
  /** The Bash tool_use id, for correlation with the inline conversation card. */
  callRef?: string
  /** Invoke parameters captured at launch (effective timeout, background mode,
   *  cwd, description) — surfaced read-only in the Background Tasks detail view. */
  params?: NexusShellInvokeParams
  /** The launching caller reads the result itself: register the task already
   *  acknowledged, so it is never delivered (see HOST_RESULT_ACKNOWLEDGED). */
  resultAcknowledged?: boolean
  /** The public task id of the SuperShell invocation whose script started this
   *  shell (see HOST_SUPER_SHELL_TASK_ID). The Background Tasks drawer shows the
   *  invocation under Super Shell instead of listing its steps under Shell. */
  superShellTaskId?: string
  /** Kill the child this long after launch and report a timeout (a forced
   *  background leading `sleep` keeps its timeout as a kill). */
  killAfterMs?: number
}

/** One background command the Bash / PowerShell tool hands to the worker. */
export type BackgroundShellSpawnRequest = {
  tool: 'Bash' | 'PowerShell'
  command: string
  /** Host-native absolute working directory. */
  cwd: string
  /** Absolute path of the task's output file — the child's log. */
  logPath: string
}

/**
 * The worker's background-shell registry, as the Bash tool sees it: it starts
 * the child (`shell.spawn` with `persist`) and answers the id the tool then
 * reports through {@link notifyBackgroundShellLaunched}. Registered by the
 * manager; `null` everywhere else (mock host, unit tests), where the tool
 * keeps dispatching to the host as before.
 */
export type BackgroundShellSpawner = {
  /** The host serves the persistent-shell primitives (manifest). */
  canSpawn(): boolean
  /** Whether `canSpawn` is settled: false while the host port or its
   *  manifest is not known yet (a reload, a port swap). Absent = settled. */
  isKnown?(): boolean
  /** Throws `<CODE>: <message>` when the host refuses the start. */
  spawn(request: BackgroundShellSpawnRequest): Promise<{ shellId: string }>
}

/**
 * Security: in-process-only key a NESTED Bash caller (SuperShell) sets to label the
 * task with the model's own command. A Symbol, so model JSON cannot spoof it and it
 * never reaches the host. Display only, never an authorization input.
 */
export const HOST_DISPLAY_COMMAND: unique symbol = Symbol('velloc.hostDisplayCommand')

/**
 * In-process-only key (same Symbol rule as {@link HOST_DISPLAY_COMMAND}) a
 * NESTED Bash caller sets to `true` when it consumes the background task's
 * result itself (SuperShell awaits every step). The task is then registered
 * already acknowledged, so its completion is never delivered as a
 * `<task-notification>` — not even when it finishes before the caller gets the
 * task id back (PostToolUse hooks run between the spawn and that return).
 */
export const HOST_RESULT_ACKNOWLEDGED: unique symbol = Symbol('velloc.hostResultAcknowledged')

/**
 * In-process-only key (same Symbol rule as {@link HOST_DISPLAY_COMMAND}) a
 * SuperShell step sets to its invocation's public task id, so the resulting
 * `local_bash` task records which script started it. Display only — the drawer
 * files the step under its invocation rather than under Shell; it never decides
 * delivery, permissions or stopping.
 */
export const HOST_SUPER_SHELL_TASK_ID: unique symbol = Symbol('velloc.hostSuperShellTaskId')

type BackgroundShellSink = (launch: BackgroundShellLaunch) => void
type BackgroundShellResultAcknowledger = (shellId: string) => void

let sink: BackgroundShellSink | null = null
let acknowledgeSink: BackgroundShellResultAcknowledger | null = null
let spawner: BackgroundShellSpawner | null = null

/** How long a Bash call waits for the host to be known before it settles
 *  for running without the worker's background registry. */
export const SHELL_SPAWNER_KNOWN_WAIT_MS = 5_000
const SHELL_SPAWNER_KNOWN_POLL_MS = 50

/** Wait until the spawner's `canSpawn` is settled (or the wait / the call
 *  ends). Resolves either way; the caller reads `canSpawn` after. */
export async function waitForShellSpawnerKnown(
  target: BackgroundShellSpawner,
  signal?: AbortSignal,
  timeoutMs = SHELL_SPAWNER_KNOWN_WAIT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (target.isKnown && !target.isKnown() && !signal?.aborted && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, SHELL_SPAWNER_KNOWN_POLL_MS))
  }
}

/** Register the spawner. The manager calls this in its init; `null` clears. */
export function setBackgroundShellSpawner(next: BackgroundShellSpawner | null): void {
  spawner = next
}

/** The registered spawner, or null outside a manager. */
export function getBackgroundShellSpawner(): BackgroundShellSpawner | null {
  return spawner
}

/** Register the sink. The manager calls this in its init; pass `null` to clear. */
export function setBackgroundShellSink(next: BackgroundShellSink | null): void {
  sink = next
}

/** Register the result acknowledger. The manager calls this in its init. */
export function setBackgroundShellResultAcknowledger(
  next: BackgroundShellResultAcknowledger | null,
): void {
  acknowledgeSink = next
}

/** Invoked by the Bash tool once a background launch has its shell id. */
export function notifyBackgroundShellLaunched(launch: BackgroundShellLaunch): void {
  sink?.(launch)
}

/** Invoked by BashOutput when the model explicitly reads a terminal result. */
export function acknowledgeBackgroundShellResult(shellId: string): void {
  acknowledgeSink?.(shellId)
}

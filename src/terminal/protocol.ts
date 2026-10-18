/**
 * The `terminal` capability's wire shapes (F-31): what the runtime publishes
 * on the `terminals` and `terminal/<id>` topics and what the five actions
 * take and answer. Shared by the runtime (publisher) and the pane (client);
 * pure types and constants, no behaviour.
 *
 * Security: every action and both topics are `full` scope — a terminal runs
 * programs on the host as the person and shows whatever they print.
 */

export const TERMINAL_CAPABILITY = 'terminal'

export const TERMINAL_ACTIONS = ['create', 'write', 'resize', 'restart', 'close'] as const
export type TerminalAction = (typeof TERMINAL_ACTIONS)[number]

/** `terminal.write` refuses more than this per call; clients split larger pastes. */
export const TERMINAL_WRITE_MAX_BYTES = 64 * 1024
/** Console size bounds, inclusive, for `create` and `resize`. */
export const TERMINAL_SIZE_MIN = 1
export const TERMINAL_SIZE_MAX = 1000
/** The runtime keeps at most this much decoded output per terminal, in memory. */
export const TERMINAL_SCROLLBACK_BYTES = 512 * 1024

/** A shell the host can start; `id` is the host's tool id (`pwsh`, `powershell`, `cmd`, `bash`). */
export type TerminalShellInfo = {
  id: string
  version: string | null
}

export type TerminalState =
  | { kind: 'starting' }
  | { kind: 'running' }
  | { kind: 'exited'; exitCode: number | null }
  | { kind: 'failed'; message: string }

/** One row of the `terminals` topic. */
export type TerminalRow = {
  id: string
  sessionId: string
  shell: string
  /** From the shell's OSC 0/2 title sequence, else the shell id. */
  title: string
  state: TerminalState
}

/** The `terminals` topic: snapshot, and the `state` delta carries the whole object again. */
export type TerminalsState = {
  /** False without a terminal service or without the host's `shell.spawn.pty` primitive. */
  available: boolean
  shells: TerminalShellInfo[]
  terminals: TerminalRow[]
}

/** The `terminal/<id>` topic's snapshot. */
export type TerminalSnapshot = {
  cols: number
  rows: number
  title: string
  state: TerminalState
  /** The decoded output kept so far, oldest first. */
  scrollback: string
}

/** The `terminal/<id>` topic's deltas, by event `type`. */
export type TerminalOutputDelta = { data: string }
export type TerminalResizeDelta = { cols: number; rows: number }
export type TerminalTitleDelta = { title: string }
export type TerminalStateDelta = { state: TerminalState }

export const TERMINAL_DELTA_TYPES = ['output', 'resize', 'title', 'state'] as const
export type TerminalDeltaType = (typeof TERMINAL_DELTA_TYPES)[number]

export type TerminalCreatePayload = {
  sessionId: string
  /** One of the topic's `shells`; default the first of pwsh, powershell, cmd. */
  shell?: string
  cols: number
  rows: number
}
export type TerminalCreateResult = { id: string }

export type TerminalWritePayload = { id: string; data: string }
export type TerminalResizePayload = { id: string; cols: number; rows: number }
export type TerminalRestartPayload = { id: string }
export type TerminalClosePayload = { id: string }

export function isTerminalState(value: unknown): value is TerminalState {
  if (typeof value !== 'object' || value === null) return false
  const kind = (value as { kind?: unknown }).kind
  switch (kind) {
    case 'starting':
    case 'running':
      return true
    case 'exited': {
      const code = (value as { exitCode?: unknown }).exitCode
      return code === null || typeof code === 'number'
    }
    case 'failed':
      return typeof (value as { message?: unknown }).message === 'string'
    default:
      return false
  }
}

export function isTerminalSize(cols: unknown, rows: unknown): cols is number {
  return [cols, rows].every(
    n =>
      typeof n === 'number' &&
      Number.isInteger(n) &&
      n >= TERMINAL_SIZE_MIN &&
      n <= TERMINAL_SIZE_MAX,
  )
}

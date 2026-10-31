/**
 * The `terminal` capability's wire shapes (F-31): what the runtime publishes
 * on the `terminals`, `terminal/<id>` and `terminal-run/<runId>` topics and
 * what the seven actions take and answer. Shared by the runtime (publisher) and the pane (client);
 * pure types and constants, no behaviour.
 *
 * Security: every action and both topics are `full` scope — a terminal runs
 * programs on the host as the person and shows whatever they print.
 */

export const TERMINAL_CAPABILITY = 'terminal'

export const TERMINAL_ACTIONS = ['create', 'write', 'resize', 'restart', 'close', 'rescanClis', 'run'] as const
export type TerminalAction = (typeof TERMINAL_ACTIONS)[number]

/** Every action is `full`: each one starts, drives or ends a program running on the host as the person. */
export const TERMINAL_ACTION_SCOPES: Record<TerminalAction, 'full'> = {
  create: 'full',
  write: 'full',
  resize: 'full',
  restart: 'full',
  close: 'full',
  rescanClis: 'full',
  run: 'full',
}

/** The host manifest primitive that covers `shell.spawn`'s `pty` input and `shell.resize`. */
export const TERMINAL_PTY_PRIMITIVE = 'shell.spawn.pty'

/** `terminal.write` refuses more than this per call; clients split larger pastes. */
export const TERMINAL_WRITE_MAX_BYTES = 64 * 1024
/** Console size bounds, inclusive, for `create` and `resize`. */
export const TERMINAL_SIZE_MIN = 1
export const TERMINAL_SIZE_MAX = 1000
/** `terminal.run` refuses a longer command line. */
export const TERMINAL_RUN_COMMAND_MAX = 4096
/** Output lines a run keeps; older lines are dropped and the run says it was cut. */
export const TERMINAL_RUN_OUTPUT_MAX_LINES = 2000
/** History lines the runtime's mirror of a terminal's screen keeps above it, in memory. */
export const TERMINAL_HISTORY_LINES = 5_000

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
  /** Set when the terminal runs a coding-agent CLI (F-34) instead of a shell; `shell` is then that id too. */
  cli?: string
  /** From the shell's OSC 0/2 title sequence, else the shell id. */
  title: string
  state: TerminalState
}

/** The `terminals` topic: snapshot, and the `state` delta carries the whole object again. */
export type TerminalsState = {
  /** False without a terminal service or without the host's `shell.spawn.pty` primitive. */
  available: boolean
  shells: TerminalShellInfo[]
  /** The coding-agent CLIs the host has (F-34), found by file lookups; empty until probed. */
  clis: string[]
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
  /**
   * Run a coding-agent CLI instead of a shell (F-34); exclusive with `shell`.
   * `continue` resumes the conversation the runtime recorded for the session.
   */
  cli?: { id: string; start: 'new' | 'continue' }
  cols: number
  rows: number
}
export type TerminalCreateResult = { id: string }

export type TerminalWritePayload = { id: string; data: string }
export type TerminalResizePayload = { id: string; cols: number; rows: number }
export type TerminalRestartPayload = { id: string }
export type TerminalClosePayload = { id: string }

/** Run one command line in the session's terminal, starting the default shell when it has none. */
export type TerminalRunPayload = { sessionId: string; command: string }
/** `id` is the terminal it was typed into; `runId` names its `terminal-run/<runId>` topic. */
export type TerminalRunResult = { id: string; runId: string }

/**
 * The `terminal-run/<runId>` topic: snapshot and every `state` delta carry
 * the whole object. `running` until the shell's prompt is back (`done`), or
 * until the terminal exits, closes, clears its history or takes another run
 * (`ended`). `output` is the screen's text below the typed command, without
 * the returned prompt.
 */
export type TerminalRunState = {
  terminalId: string
  command: string
  status: 'running' | 'done' | 'ended'
  output: string
  /** Lines were dropped from the start of `output`. */
  truncated: boolean
}

/**
 * Security: the command line `terminal.run` accepts — one line, non-blank,
 * within TERMINAL_RUN_COMMAND_MAX, and no control (Cc), format (Cf) or line /
 * paragraph separator (Zl, Zp) characters — so the text typed into the shell
 * is exactly the text the person saw and clicked: a control character could
 * press keys the card never showed, and a format character (bidi override or
 * isolate, zero-width) could make the card show one order of text while the
 * shell receives another.
 */
export function isRunnableCommand(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= TERMINAL_RUN_COMMAND_MAX &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
  )
}

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

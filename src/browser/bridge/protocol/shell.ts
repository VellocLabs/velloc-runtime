/** `shell` bridge capability: the streaming / persistent / pseudoconsole spawns below, `resize` and `env`. */

/**
 * The streaming surface (F-25): `shell.spawn` output arrives as base64
 * `shell.onStreamOutput` events (decode with a streaming `TextDecoder`), exit as
 * one `shell.onStreamExit`; `writeStdin` / `closeStdin` / `streamKill` drive it.
 */
export type BridgeShellSpawnShellForm = {
  /** The shell tool id the command line runs with: bash, sh, pwsh or powershell. */
  shell: 'bash' | 'sh' | 'pwsh' | 'powershell'
  command: string
  file?: never
  args?: never
}

/**
 * The argv form: `file` (a tool id or an absolute path, resolved against the
 * service's command allowlist like the native MCP stdio commands) runs with
 * `args` verbatim — no shell. Manifest primitive `shell.spawn.argv`; an
 * older host refuses it as a missing `shell`.
 */
export type BridgeShellSpawnArgvForm = {
  file: string
  args?: string[]
  shell?: never
  command?: never
}

export type BridgeShellSpawnPayload = (
  | BridgeShellSpawnShellForm
  | BridgeShellSpawnArgvForm
) & {
  cwd?: string
  env?: Record<string, string>
  /** Text written to stdin right after launch. (Not `stdin`: a CRT macro on
   *  Windows that breaks the generated C++ struct.) */
  stdinText?: string
  /** Close stdin right after launch (after `stdinText`). */
  closeStdin?: boolean
  /**
   * Detach the child from this connection: it outlives the guest, its
   * stdout/stderr are APPENDED to `logPath` (absolute; no stream events),
   * and `shell.persistentList` / `persistentKill` find it again. The result
   * is then `{ persistentId }`. Manifest primitive `shell.spawn.persist` —
   * an older host would ignore the field and run a connection-bound child,
   * so never send it without that entry.
   */
  persist?: { logPath: string }
  /**
   * Run the child under a pseudoconsole of this size (F-31): its merged console
   * output arrives as `onStreamOutput` with `stream: 'stdout'` only, and
   * `shell.resize` changes the size. With `pty` the host refuses `persist`,
   * `stdinText` and `closeStdin` (`INVALID_ARGS`), as it does `cols` / `rows`
   * outside 1..1000. Manifest primitive `shell.spawn.pty` — an older host would
   * ignore the field and run a pipe child, so never send it without that entry.
   */
  pty?: BridgeShellPtySize
}

/** Console size for a pseudoconsole child; both 1..1000. */
export type BridgeShellPtySize = { cols: number; rows: number }

export type BridgeShellSpawnResult =
  | { streamId: string; persistentId?: never }
  | { persistentId: string; streamId?: never }

/** One persistent child as `shell.persistentList` reports it. */
export type BridgeShellPersistentRecord = {
  id: string
  command: string
  logPath: string
  startedMs: number
  running: boolean
  exitCode?: number
  signal?: number
  killed?: boolean
  timedOut?: boolean
  endedMs?: number
  durationMs?: number
}

export type BridgeShellStreamFoundResult = { found: boolean }

export type BridgeShellOnStreamOutputPayload = {
  streamId: string
  stream: 'stdout' | 'stderr'
  /** The chunk's raw bytes, base64. */
  dataBase64: string
}

export type BridgeShellOnStreamExitPayload = {
  streamId: string
  /** -1 when the child died without a code (a signal, a lost pipe). */
  exitCode: number
  signal?: number
  timedOut: boolean
  killed: boolean
  durationMs: number
}

export type ShellBridgeActionMap = {
  spawn: {
    payload: BridgeShellSpawnPayload
    result: BridgeShellSpawnResult
  }
  writeStdin: {
    payload: { streamId: string; data: Uint8Array }
    result: BridgeShellStreamFoundResult
  }
  closeStdin: {
    payload: { streamId: string }
    result: BridgeShellStreamFoundResult
  }
  streamKill: {
    payload: { streamId: string }
    result: BridgeShellStreamFoundResult
  }
  /**
   * Resize the console of a pseudoconsole child (F-31). `found: false` for an
   * unknown or exited stream; a pipe child answers `found: true` and nothing
   * happens. Covered by the `shell.spawn.pty` primitive.
   */
  resize: {
    payload: { streamId: string } & BridgeShellPtySize
    result: BridgeShellStreamFoundResult
  }
  /** Host-pushed EVENTS of a streaming child (never requested). */
  onStreamOutput: {
    payload: BridgeShellOnStreamOutputPayload
    result: never
  }
  onStreamExit: {
    payload: BridgeShellOnStreamExitPayload
    result: never
  }
  /** The persistent children of this browser profile, newest first (64). */
  persistentList: {
    payload: Record<string, never>
    result: { shells: BridgeShellPersistentRecord[] }
  }
  persistentKill: {
    payload: { id: string }
    result: { found: boolean; wasRunning: boolean }
  }
  /** Browser-process environment, read-only, at most 64 names. */
  env: {
    payload: { names: string[] }
    result: { values: Record<string, string | null> }
  }
}

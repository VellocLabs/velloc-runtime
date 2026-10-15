/**
 * Shell formatting helpers — pure functions for background shell output.
 *
 * These are stateless formatting/classification functions used by the
 * BackgroundShellCoordinator and task summary builders.
 */
import { stripAnsiControlSequences } from '../../utils/ansi'

/**
 * One observation of a background shell, as the worker's registry assembles
 * it: the persistent child's record (`shell.persistentList`) plus the tail of
 * its log file. Worker-owned — it used to be the C++ `shell.status` reply,
 * whose field names it keeps so the classification below is unchanged.
 * `stdout` carries the whole log tail (stdout and stderr interleaved, as the
 * host appended them); `stderr` stays empty.
 */
export type ShellRunObservation = {
  found: boolean
  running: boolean
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  exitCode?: number
  signal?: number
  timedOut?: boolean
  killed?: boolean
  durationMs?: number
}

/** Combine a status poll's stdout/stderr into one display blob. */
export function joinShellOutput(s: ShellRunObservation): string {
  const parts: string[] = []
  if (s.stdout) parts.push(stripAnsiControlSequences(s.stdout))
  if (s.stderr) parts.push(stripAnsiControlSequences(s.stderr))
  const joined = parts.join('\n')
  // The host caps how much captured output a status read returns (keeping the
  // TAIL — C++ `ReadCapped`). Mark the elision
  // (`[NKB of earlier output omitted]`) so the model
  // reads this as a partial view instead of misreading a capped build log as
  // "the command stopped early" — that misread cost real turns re-running
  // builds. The marker also lands in the persisted `.output` mirror.
  if (joined && (s.stdoutTruncated || s.stderrTruncated)) {
    return `[earlier output omitted]\n${joined}`
  }
  return joined
}

/** One-line fallback summary when a shell exits with no captured output. */
export function formatShellExit(s: ShellRunObservation): string {
  if (s.timedOut) return 'Command timed out.'
  if (s.killed) return 'Killed.'
  if (s.exitCode === 0) return 'Completed.'
  if (typeof s.exitCode === 'number') return `Command exited with code ${s.exitCode}.`
  if (typeof s.signal === 'number') return `Terminated by signal ${s.signal}.`
  return 'Completed.'
}

export function formatShellSummary(s: ShellRunObservation): string {
  const output = joinShellOutput(s)
  const exit = formatShellExit(s)
  if (output && exit !== 'Completed.') return `${output}\n${exit}`
  return output || exit
}

/** Classify a terminal observation into a task status. `timedOut` first, then `killed` before
 *  `exitCode`/`signal`: a user Stop always leaves a nonzero code or signal. */
export function classifyShellExit(
  s: ShellRunObservation,
): 'success' | 'error' | 'stopped' {
  if (s.timedOut) return 'error'
  if (s.killed) return 'stopped'
  if (typeof s.exitCode === 'number' && s.exitCode !== 0) return 'error'
  if (typeof s.signal === 'number') return 'error'
  return 'success'
}

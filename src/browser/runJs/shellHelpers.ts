/**
 * Contract: SuperShell's worker-side `bash()`, sugar over one `callShell`
 * round-trip; SuperShellInvocation runs the command through the Bash tool's
 * permission pipeline, and nothing here executes anything.
 *   - an exit resolves `{ stdout, stderr, exitCode, truncated }`; a non-zero exit
 *     throws `ShellRunFailure` (kind `failed`) unless `nothrow`;
 *   - a timeout, cancel, refusal or start failure always throws `ShellRunFailure`
 *     with that `kind`, whatever `nothrow` says;
 *   - `truncated` true means stdout/stderr hold only the tail.
 * Ops resolve `{ result } | { error }`; `ShellRunFailure` is rebuilt from `error`.
 */

import { stripAnsiControlSequences } from '../../utils/ansi'
import type { RunJsShellOp } from './runJsProtocol'

export type ShellCall = (
  op: RunJsShellOp,
  payload: Record<string, unknown>,
) => Promise<unknown>

export type ShellErrorKind = 'failed' | 'timeout' | 'cancelled' | 'denied' | 'start_failed' | 'invalid'

export type BashOptions = {
  /** Directory to run in, absolute or relative to the invocation's default
   *  directory. Absent → the default directory (fixed when SuperShell started). */
  cwd?: string
  /** Text fed to the command's standard input. */
  stdin?: string
  /** Kill the command after this many MILLISECONDS. Absent → no limit. */
  timeout?: number
  /** Resolve instead of throwing when the command exits non-zero. Does not
   *  apply to timeout / cancelled / denied / start_failed. */
  nothrow?: boolean
  /** Start the command and return a handle immediately (dev servers, watch
   *  processes). The process outlives the script unless stopped. */
  background?: boolean
}

export type BashResult = { stdout: string; stderr: string; exitCode: number; truncated: boolean }

export type BackgroundHandle = {
  taskId: string
  waitFor(pattern: RegExp | string, options?: { timeout?: number }): Promise<string>
  stop(): Promise<void>
}

type ErrorRecord = {
  kind: ShellErrorKind
  message: string
  exitCode: number | null
  stdout: string
  stderr: string
  truncated: boolean
}

/** The error a `bash()` call throws. `kind` says why; `exitCode` is the real
 *  exit code or null when the command never produced one. */
export class ShellRunFailure extends Error {
  readonly kind: ShellErrorKind
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
  constructor(record: ErrorRecord) {
    super(record.message)
    this.name = 'ShellError'
    this.kind = record.kind
    this.exitCode = record.exitCode
    this.stdout = record.stdout
    this.stderr = record.stderr
    this.truncated = record.truncated
  }
}

/** Lines of output quoted into a `failed` or `timeout` error message... */
const ERROR_TAIL_LINES = 20
/** ...and at most this many characters of them: one minified line must not
 *  make the message as long as the output. */
export const ERROR_TAIL_MAX_CHARS = 2_000
/** Characters of the command a message or step line names. */
const COMMAND_TEXT_MAX_CHARS = 160

/** A command on one line, at most COMMAND_TEXT_MAX_CHARS long — how messages and
 *  the tool result name it. The script and the log keep the command whole. */
export function oneLineCommand(command: string): string {
  const flat = command.replace(/\s*\n\s*/g, ' ').trim()
  return flat.length > COMMAND_TEXT_MAX_CHARS ? `${flat.slice(0, COMMAND_TEXT_MAX_CHARS - 3)}...` : flat
}

function tailLines(text: string, count: number): string {
  const lines = text.replace(/\s+$/, '').split(/\r?\n/)
  return lines.slice(-count).join('\n')
}

/** The end of a command's output as an error message quotes it: stderr, or
 *  stdout when stderr is empty, without terminal escapes, within
 *  ERROR_TAIL_LINES lines and ERROR_TAIL_MAX_CHARS characters (a line cut by the
 *  character cap is dropped, unless it is the only one). The message is what the
 *  model reads when the error ends the script — the tool result does not carry
 *  command output — so it must say where the command stopped. The error's own
 *  `stdout`/`stderr` stay byte-exact. */
function errorOutputTail(stdout: string, stderr: string): string {
  const err = stripAnsiControlSequences(stderr)
  const tail = tailLines(err.trim() ? err : stripAnsiControlSequences(stdout), ERROR_TAIL_LINES)
  if (tail.length <= ERROR_TAIL_MAX_CHARS) return tail
  const kept = tail.slice(-ERROR_TAIL_MAX_CHARS)
  const lineStart = kept.indexOf('\n')
  return lineStart >= 0 ? kept.slice(lineStart + 1) : `...${kept}`
}

/** A host error record as thrown: a timed-out command's message gains the end
 *  of its output, like a failed one's. */
function withOutputTail(record: ErrorRecord): ErrorRecord {
  if (record.kind !== 'timeout') return record
  const tail = errorOutputTail(record.stdout, record.stderr)
  return tail ? { ...record, message: `${record.message}\n${tail}` } : record
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** `waitFor` without an explicit timeout gives up after this long. */
export const DEFAULT_WAIT_FOR_TIMEOUT_MS = 120_000

/** One `readLines` reply (superShellRunner `ReadLinesResult`). */
type ReadLinesChunk = {
  lines: string[]
  offset: number
  ended: boolean
  status: string
  exitCode: number | null
  logPath: string
}

/** A `waitFor` pattern as a line predicate. A RegExp is rebuilt without the
 *  stateful `g`/`y` flags, which would make repeated `test` calls skip matches.
 *  Anything but a RegExp or a string is a `ShellRunFailure` of kind `invalid`. */
function lineMatcher(pattern: unknown): (line: string) => boolean {
  if (pattern instanceof RegExp) {
    const rx = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''))
    return line => rx.test(line)
  }
  if (typeof pattern === 'string') {
    return line => line.includes(pattern)
  }
  throw new ShellRunFailure({
    kind: 'invalid',
    message: 'waitFor(pattern): pattern must be a RegExp or a string.',
    exitCode: null,
    stdout: '',
    stderr: '',
    truncated: false,
  })
}

/** Unwrap a `{ result } | { error }` record, rebuilding ShellRunFailure. */
async function unwrap(response: Promise<unknown>): Promise<unknown> {
  const record = (await response) as { result?: unknown; error?: ErrorRecord } | null
  if (record && record.error) throw new ShellRunFailure(withOutputTail(record.error))
  return record ? record.result : undefined
}

export function createShellHelpers(callShell: ShellCall): {
  bash: (command: string, options?: BashOptions) => Promise<BashResult | BackgroundHandle>
} {
  async function bash(
    command: string,
    options: BashOptions = {},
  ): Promise<BashResult | BackgroundHandle> {
    if (typeof command !== 'string' || command.trim().length === 0) {
      throw new TypeError('bash(command): command must be a non-empty string.')
    }
    if (options === null || typeof options !== 'object') {
      throw new TypeError('bash(command, options): options must be an object.')
    }
    if (options.cwd !== undefined && (typeof options.cwd !== 'string' || options.cwd.length === 0)) {
      throw new TypeError('bash(command, { cwd }): cwd must be a non-empty string.')
    }
    if (options.stdin !== undefined && typeof options.stdin !== 'string') {
      throw new TypeError('bash(command, { stdin }): stdin must be a string.')
    }
    if (options.timeout !== undefined && !isPositiveFinite(options.timeout)) {
      throw new TypeError(
        'bash(command, { timeout }): timeout must be a positive number of milliseconds.',
      )
    }
    const common = {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    }

    if (options.background) {
      const { taskId } = (await unwrap(
        callShell('run', { command, options: { background: true, ...common } }),
      )) as { taskId: string }
      return {
        taskId,
        async waitFor(pattern, waitOptions = {}) {
          const matches = lineMatcher(pattern)
          if (waitOptions === null || typeof waitOptions !== 'object') {
            throw new TypeError('waitFor(pattern, options): options must be an object.')
          }
          if (waitOptions.timeout !== undefined && !isPositiveFinite(waitOptions.timeout)) {
            throw new TypeError(
              'waitFor(pattern, { timeout }): timeout must be a positive number of milliseconds.',
            )
          }
          const timeoutMs = waitOptions.timeout ?? DEFAULT_WAIT_FOR_TIMEOUT_MS
          const deadline = Date.now() + timeoutMs
          // The SharedWorker only READS the log (`readLines`); every line is
          // matched here, in the script's worker, so a pathological pattern
          // burns this script's own time budget and nobody else's.
          let offset = 0
          for (;;) {
            const chunk = (await unwrap(
              callShell('readLines', { taskId, offset, waitMs: Math.max(0, deadline - Date.now()) }),
            )) as ReadLinesChunk
            offset = chunk.offset
            for (const line of chunk.lines) {
              if (matches(line)) return line
            }
            if (chunk.ended) {
              throw new ShellRunFailure({
                kind: 'failed',
                message: `waitFor: background task ${taskId} ended (${chunk.status}${
                  chunk.exitCode !== null ? `, exit ${chunk.exitCode}` : ''
                }) before its output matched. Full output: ${chunk.logPath}`,
                exitCode: chunk.exitCode,
                stdout: '',
                stderr: '',
                truncated: false,
              })
            }
            if (Date.now() >= deadline) {
              throw new ShellRunFailure({
                kind: 'timeout',
                message: `waitFor: no matching output from background task ${taskId} within ${Math.round(
                  timeoutMs / 1000,
                )}s. The task is still running; its full output is in ${chunk.logPath}.`,
                exitCode: null,
                stdout: '',
                stderr: '',
                truncated: false,
              })
            }
          }
        },
        async stop() {
          await unwrap(callShell('stop', { taskId }))
        },
      }
    }

    const result = (await unwrap(
      callShell('run', {
        command,
        options: {
          ...common,
          ...(options.timeout !== undefined ? { timeoutMs: options.timeout } : {}),
        },
      }),
    )) as BashResult
    if (result.exitCode !== 0 && !options.nothrow) {
      const tail = errorOutputTail(result.stdout, result.stderr)
      const head = `Command failed (exit ${result.exitCode}): ${oneLineCommand(command)}`
      throw new ShellRunFailure({
        kind: 'failed',
        message: tail ? `${head}\n${tail}` : head,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
      })
    }
    return result
  }

  return { bash }
}

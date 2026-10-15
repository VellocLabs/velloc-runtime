/**
 * SuperShell's executor, the SharedWorker side of `bash()`. Security: each step is
 * ONE nested Bash call through `runNestedTool`, so every gate and hook sees
 * `{ command, cwd }`; only the input handed to the host (`prepareCall`) is wrapped to
 * record the exit code and split the logs. No state carries between steps. Bash only.
 */

import type { Message } from '../../runtime/RuntimeTypes'
import type { PermissionDecider } from '../permissionVerdict'
import type { ToolCallContext } from '../toolCallContext'
import type { SubAgentController, SubAgentSnapshot } from '../../team/subAgentController'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import { runNestedTool } from './exec'
import { parseBashCdCommand } from './glic/bashCwdInterceptor'
import { SHELL_TOOL_ID } from '../../prompting/processToolNames'
import {
  HOST_DISPLAY_COMMAND,
  HOST_RESULT_ACKNOWLEDGED,
  HOST_SUPER_SHELL_TASK_ID,
} from '../run/backgroundShellSink'
import { joinRuntimePath, resolveRuntimePath } from '../../utils/runtimePaths'
import { oneLineCommand } from '../../browser/runJs/shellHelpers'
import {
  getConversationSessionDirectoryPath,
  resolveSessionStorageBase,
} from '../../utils/conversationStoragePaths'

/** Characters of stdout/stderr handed to the script per stream. The full
 *  output always stays in the step's log files; past this cap the script gets
 *  the TAIL (where build/test verdicts live) and `truncated: true`. */
export const MAX_CAPTURE_BYTES = 8 * 1024 * 1024

/** A foreground step is awaited in chunks of this size — `setTimeout` cannot
 *  hold an unbounded delay, and a step has no wall-clock limit of its own. */
const WAIT_CHUNK_MS = 10 * 60 * 1000

/** Characters of each stream a step RECORD keeps (what the tool result quotes
 *  for a failed step). The script itself receives up to MAX_CAPTURE_BYTES. */
export const STEP_RECORD_TAIL_CHARS = 16_000

const READ_LINES_POLL_MS = 250

/** Bytes (or characters, without `fs.readRange`) of a background log handed to
 *  the script per `readLines` op. */
export const READ_LINES_CHUNK = 1024 * 1024

/** Longest a single `readLines` op waits for new output before it returns
 *  empty-handed; the script's `waitFor` loop keeps its own deadline. */
const MAX_READ_LINES_WAIT_MS = 10 * 60 * 1000

/** The Bash tool's no-timeout-cap sentinel: an explicit-background command sent
 *  with this `timeout` runs to completion instead of being killed at the host's
 *  default. Duplicated from host/shellArgs.ts `SHELL_NO_TIMEOUT_CAP_SENTINEL_MS`
 *  rather than imported, so this module does not pull the hosted-tool builder
 *  (and its import graph) into the tool registry; a unit test pins the two
 *  equal. */
export const NO_TIMEOUT_CAP_SENTINEL_MS = 2_147_483_647

// ── the data contract with the worker ───────────────────────────────────────

/** Why a `bash()` call did not produce a normal result. `failed` (a non-zero
 *  exit) is decided worker-side from a normal result; every other kind reaches
 *  the worker as an explicit error record and always throws, `nothrow` or not. */
export type ShellErrorKind = 'failed' | 'timeout' | 'cancelled' | 'denied' | 'start_failed' | 'invalid'

export type ShellErrorData = {
  kind: ShellErrorKind
  message: string
  /** The command's real exit code, or null when it never produced one. */
  exitCode: number | null
  stdout: string
  stderr: string
  truncated: boolean
}

export type ShellRunResult = {
  stdout: string
  stderr: string
  exitCode: number
  truncated: boolean
}

/** What every `shell`-noun op resolves with. Plain data on purpose: it crosses
 *  a structured clone, which does not preserve an Error's custom fields, so the
 *  worker rebuilds `ShellRunFailure` from `error`. */
export type ShellOpResponse = { result: unknown } | { error: ShellErrorData }

// ── step records (what the model's result lists) ────────────────────────────

export type ForegroundStepRecord = {
  kind: 'run'
  command: string
  /** The step's number — its log folder in the run directory. */
  step: number
  cwd: string
  durationMs: number
  /** `exited` = the command ran to an exit code (zero or not). */
  outcome: 'exited' | 'timeout' | 'cancelled' | 'start_failed'
  exitCode: number | null
  stdout: string
  stderr: string
  truncated: boolean
  stdoutPath: string
  stderrPath: string
}

export type BackgroundStepRecord = {
  kind: 'background'
  command: string
  cwd: string
  taskId: string
  logPath: string
}

export type NotRunStepRecord = {
  kind: 'notRun'
  command: string
  reason: string
}

export type StepRecord = ForegroundStepRecord | BackgroundStepRecord | NotRunStepRecord

// ── pure helpers ────────────────────────────────────────────────────────────

/** POSIX single-quote: everything inside is literal. */
export function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** A host path in a form Git Bash and POSIX bash both accept. Only a Windows
 *  path (drive letter or UNC) has its backslashes turned into slashes: on a
 *  POSIX host a backslash is an ordinary file-name character. */
export function toBashPath(path: string): string {
  return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(path) ? path.replace(/\\/g, '/') : path
}

/**
 * The host command for a foreground step (`stepDir` must exist). A `trap EXIT`
 * records the exit code; `pipefail` is on the outer pipeline only, so `exitCode` is
 * the status of the command STRING.
 */
export function buildForegroundWrapper(params: {
  command: string
  stepDir: string
  cwd: string
  hasStdin: boolean
}): string {
  const dir = toBashPath(params.stepDir)
  const stdin = params.hasStdin ? '"$__ss_d/in"' : '/dev/null'
  return [
    `__ss_d=${posixQuote(dir)}`,
    'set -o pipefail',
    '{',
    `trap ${posixQuote('printf %s "$?" >"$__ss_d/ec"')} EXIT`,
    'set +o pipefail',
    `cd ${posixQuote(toBashPath(params.cwd))} || { printf x >"$__ss_d/cwderr"; exit 1; }`,
    `eval ${posixQuote(params.command)}`,
    `} <${stdin} 2>"$__ss_d/err" | tee "$__ss_d/out"`,
  ].join('\n')
}

/**
 * The command the host runs for a `background: true` step. stdout and stderr
 * are merged in order and `tee`d to `logPath`, so `waitFor` can scan the
 * COMPLETE output history rather than the host's bounded live tail; outer
 * `pipefail` keeps the task's exit code the command's.
 */
export function buildBackgroundWrapper(params: {
  command: string
  cwd: string
  logPath: string
  stdinPath?: string
}): string {
  const stdin = params.stdinPath ? posixQuote(toBashPath(params.stdinPath)) : '/dev/null'
  return [
    'set -o pipefail',
    '{',
    'set +o pipefail',
    `cd ${posixQuote(toBashPath(params.cwd))} || exit 1`,
    `eval ${posixQuote(params.command)}`,
    `} <${stdin} 2>&1 | tee ${posixQuote(toBashPath(params.logPath))}`,
  ].join('\n')
}

const SIMPLE_ASSIGNMENT = String.raw`[A-Za-z_][A-Za-z0-9_]*(?:=[^\s;&|<>()$\`'"\\]*)?`
const PURE_EXPORT_RX = new RegExp(
  String.raw`^\s*(?:export|unset)\s+${SIMPLE_ASSIGNMENT}(?:\s+${SIMPLE_ASSIGNMENT})*\s*;?\s*$`,
)

/**
 * A command whose ONLY effect is shell state that a fresh process discards —
 * a lone `cd <dir>`, or a lone `export`/`unset` of plain names. Running one as
 * its own `bash()` does nothing for later commands, and a model that expects it
 * to runs the next command in the wrong place. Deliberately strict: it never
 * flags `cd x && make` or `export A=1; cmd`, and it does not try to recognise
 * every equivalent spelling — it is a misuse guard, not a boundary.
 */
export function stateOnlyCommandHint(command: string): string | null {
  if (parseBashCdCommand(command) !== null) {
    return (
      '`cd` in its own bash() call has no effect: every bash() runs in a fresh process. ' +
      'Pass { cwd } to the commands that need that directory.'
    )
  }
  if (PURE_EXPORT_RX.test(command)) {
    return (
      '`export`/`unset` in its own bash() call has no effect: every bash() runs in a fresh process. ' +
      'Put the assignment in the command that needs it (`VAR=value command`).'
    )
  }
  return null
}

/** The task id in a background shell result (`{ task_id, status: 'running' }`,
 *  JSON-serialized by runNestedTool), or null for any other shape. A PostToolUse
 *  hook note runNestedTool appends after the JSON (`<json>\n<note>`) is ignored:
 *  the command has started either way. */
export function parseLaunchedTaskId(data: string): string | null {
  const candidates = [data]
  for (let at = data.indexOf('\n'); at >= 0; at = data.indexOf('\n', at + 1)) {
    candidates.push(data.slice(0, at))
  }
  for (const text of candidates) {
    try {
      const parsed = JSON.parse(text) as { task_id?: unknown }
      if (parsed && typeof parsed.task_id === 'string' && parsed.task_id.length > 0) {
        return parsed.task_id
      }
    } catch {
      /* not JSON (or not only JSON) */
    }
  }
  return null
}

/** What a `readLines` op resolves with: the COMPLETE lines a background task's
 *  log gained past `offset`, and where the next read starts. `ended` = the task
 *  is no longer running AND its log was read to the end (its unterminated last
 *  line included). */
export type ReadLinesResult = {
  lines: string[]
  offset: number
  ended: boolean
  status: SubAgentSnapshot['status'] | 'unknown'
  exitCode: number | null
  logPath: string
}

const NEWLINE = 0x0a

function splitLines(text: string): string[] {
  return text.split('\n').map(line => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

/**
 * The complete lines of `text` from its start, and how many units (bytes or
 * characters — whatever `text`'s source counts in) they consumed. A line still
 * being written (no newline yet) is left for a later read, unless `final` (the
 * writer has exited) or it alone fills `limit` (a line longer than one read is
 * handed out in pieces rather than re-read forever). Exported for unit tests.
 */
export function takeCompleteLines(
  units: Uint8Array | string,
  final: boolean,
  limit: number,
): { lines: string[]; consumed: number } {
  const lastNewline =
    typeof units === 'string' ? units.lastIndexOf('\n') : units.lastIndexOf(NEWLINE)
  const decode = (end: number): string =>
    typeof units === 'string'
      ? units.slice(0, end)
      : new TextDecoder('utf-8').decode(units.subarray(0, end))
  if (lastNewline >= 0) {
    return { lines: splitLines(decode(lastNewline)), consumed: lastNewline + 1 }
  }
  if (units.length > 0 && (final || units.length >= limit)) {
    return { lines: splitLines(decode(units.length)), consumed: units.length }
  }
  return { lines: [], consumed: 0 }
}

/** The directory holding one invocation's step logs:
 *  `<project dir>/<session>/supershell/<runId>`. */
export function superShellRunDir(context: ToolCallContext, runId: string): string {
  const { homeDir, projectRoot, sessionId, sessionStorageBase } = context.options
  const basePath =
    resolveSessionStorageBase({
      storageBase: sessionStorageBase,
      homeDir,
      projectRoot,
    }) ?? joinRuntimePath(projectRoot, '.velloc')
  return joinRuntimePath(
    getConversationSessionDirectoryPath(basePath, sessionId),
    'supershell',
    runId,
  )
}

async function readTextIfExists(fs: RuntimeFs, path: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path, { encoding: 'utf-8' })
  } catch {
    return undefined
  }
}

/** Read a captured stream, keeping the TAIL past `MAX_CAPTURE_BYTES`. */
async function readCapture(
  fs: RuntimeFs,
  path: string,
): Promise<{ text: string; truncated: boolean }> {
  let size = 0
  try {
    size = (await fs.stat(path)).size
  } catch {
    return { text: '', truncated: false }
  }
  if (size > MAX_CAPTURE_BYTES && fs.readRange) {
    const { buffer, bytesRead } = await fs.readRange(path, {
      offset: size - MAX_CAPTURE_BYTES,
      length: MAX_CAPTURE_BYTES,
    })
    return {
      text: new TextDecoder('utf-8').decode(buffer.subarray(0, bytesRead)),
      truncated: true,
    }
  }
  const text = (await readTextIfExists(fs, path)) ?? ''
  if (text.length > MAX_CAPTURE_BYTES) {
    return { text: text.slice(-MAX_CAPTURE_BYTES), truncated: true }
  }
  return { text, truncated: false }
}

async function removeQuietly(fs: RuntimeFs, paths: string[]): Promise<void> {
  for (const path of paths) {
    try {
      await fs.unlink(path)
    } catch {
      /* absent or already gone */
    }
  }
}

function errorData(
  kind: ShellErrorKind,
  message: string,
  extra: Partial<Omit<ShellErrorData, 'kind' | 'message'>> = {},
): ShellErrorData {
  return {
    kind,
    message,
    exitCode: extra.exitCode ?? null,
    stdout: extra.stdout ?? '',
    stderr: extra.stderr ?? '',
    truncated: extra.truncated ?? false,
  }
}

/** Thrown inside the executor; converted to a `ShellOpResponse` error record at
 *  the op boundary. */
class StepError extends Error {
  constructor(readonly data: ShellErrorData) {
    super(data.message)
    this.name = 'StepError'
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// ── the invocation ──────────────────────────────────────────────────────────

export type InvocationEnvironment = {
  context: ToolCallContext
  canUseTool: PermissionDecider
  invokingRow: Message
  controller: SubAgentController
  fs: RuntimeFs
  /** Where every step starts unless it passes `cwd`. Fixed for the invocation. */
  defaultCwd: string
  runDir: string
  /** Aborted when the whole invocation is stopped (user Stop, TaskStop). A
   *  foreground wait handing the invocation to the background does NOT abort it. */
  signal: AbortSignal
}

type ForegroundEntry = { command: string; cancelledByInvocation: boolean }

export class SuperShellInvocation {
  readonly steps: StepRecord[] = []
  private stepSeq = 0
  private readonly foreground = new Map<string, ForegroundEntry>()
  /** Foreground commands between their `bash()` call and their launched task. */
  private readonly starting: string[] = []
  private readonly backgroundTaskIds = new Set<string>()
  private readonly pending = new Set<Promise<unknown>>()
  private closed = false
  private markClosing!: () => void
  /** Resolves when the script ends or the invocation is stopped — whichever is
   *  first. A command still in its gates (a permission prompt, hooks) stops
   *  waiting on them then. */
  private readonly closing = new Promise<void>(resolve => (this.markClosing = resolve))
  /** This invocation's public task id, once the task is registered. */
  private ownerTaskId: string | null = null

  constructor(private readonly env: InvocationEnvironment) {
    if (env.signal.aborted) this.markClosing()
    else env.signal.addEventListener('abort', () => this.markClosing(), { once: true })
  }

  get defaultCwd(): string {
    return this.env.defaultCwd
  }

  /** The run's directory: one numbered folder of logs per step, plus any text a
   *  result saved whole. */
  get runDir(): string {
    return this.env.runDir
  }

  /** Save `text` as `name` in this run's directory (next to the step logs), for
   *  a result that quotes only part of it. Resolves the file's path once it is
   *  written, or why it could not be. */
  async saveRunFile(name: string, text: string): Promise<{ path: string } | { error: string }> {
    const path = joinRuntimePath(this.env.runDir, name)
    try {
      await this.env.fs.mkdir(this.env.runDir)
      await this.env.fs.writeFile(path, text)
      return { path }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** The invocation's own `local_supershell` task id. Every step launched after
   *  this carries it to its `local_bash` task (HOST_SUPER_SHELL_TASK_ID), so the
   *  drawer lists the step under this invocation instead of under Shell. The
   *  task is registered after the invocation is built and before the script
   *  runs, so every step sees it. */
  setOwnerTaskId(taskId: string): void {
    this.ownerTaskId = taskId
  }

  /** Task ids of the `background: true` processes this invocation started. */
  get detachedJobIds(): readonly string[] {
    return [...this.backgroundTaskIds]
  }

  /** The foreground commands in progress right now — including ones still
   *  starting (awaiting a permission answer or their launch). */
  get runningCommands(): readonly string[] {
    return [...this.starting, ...[...this.foreground.values()].map(entry => entry.command)]
  }

  /** Answer one `shell`-noun op. Never rejects: every failure is a record. */
  handle(op: string, payload: Record<string, unknown>): Promise<ShellOpResponse> {
    const work = this.dispatch(op, payload).then(
      result => ({ result }) as ShellOpResponse,
      err =>
        ({
          error:
            err instanceof StepError
              ? err.data
              : errorData('start_failed', err instanceof Error ? err.message : String(err)),
        }) as ShellOpResponse,
    )
    this.pending.add(work)
    void work.finally(() => this.pending.delete(work))
    return work
  }

  /**
   * The script ended (returned or threw). No new command may start; every
   * foreground command still running is cancelled and recorded as such.
   * Background processes the script started keep running as independent
   * tasks. Resolves with the commands that had to be cancelled — a non-empty
   * list means the workflow did NOT complete.
   */
  async finish(): Promise<string[]> {
    this.closed = true
    this.markClosing()
    // A command still preparing or in its gates will now never start (launch
    // refuses it), and the script did not wait for it: not completed either.
    const cancelled: string[] = [...this.starting]
    for (const [taskId, entry] of this.foreground) {
      entry.cancelledByInvocation = true
      cancelled.push(entry.command)
      this.env.controller.stop(taskId)
    }
    await Promise.allSettled([...this.pending])
    return cancelled
  }

  /** The whole invocation was stopped: cancel foreground commands AND the
   *  background processes it started. */
  async stop(): Promise<void> {
    for (const taskId of this.backgroundTaskIds) this.env.controller.stop(taskId)
    await this.finish()
  }

  private async dispatch(op: string, payload: Record<string, unknown>): Promise<unknown> {
    if (this.closed || this.env.signal.aborted) {
      throw new StepError(
        errorData('cancelled', 'SuperShell has finished or was stopped; no new commands can start.'),
      )
    }
    if (op === 'run') {
      const command = typeof payload.command === 'string' ? payload.command : ''
      const opts = (payload.options ?? {}) as Record<string, unknown>
      return opts.background === true
        ? this.runBackground(command, opts)
        : this.runForeground(command, opts)
    }
    const taskId = typeof payload.taskId === 'string' ? payload.taskId : ''
    if (!this.backgroundTaskIds.has(taskId)) {
      throw new StepError(errorData('invalid', `No background task ${taskId} was started by this script.`))
    }
    if (op === 'readLines') {
      const offset = payload.offset
      if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
        throw new StepError(errorData('invalid', 'readLines: offset must be a non-negative integer.'))
      }
      const waitMs =
        typeof payload.waitMs === 'number' && Number.isFinite(payload.waitMs) && payload.waitMs > 0
          ? Math.min(payload.waitMs, MAX_READ_LINES_WAIT_MS)
          : 0
      return this.readLines(taskId, offset, waitMs)
    }
    if (op === 'stop') {
      this.env.controller.stop(taskId)
      return null
    }
    throw new StepError(errorData('invalid', `Unknown SuperShell operation: ${op}`))
  }

  private resolveCwd(opts: Record<string, unknown>): string {
    return typeof opts.cwd === 'string' && opts.cwd.length > 0
      ? resolveRuntimePath(this.env.defaultCwd, opts.cwd)
      : this.env.defaultCwd
  }

  /** Refuse a lone `cd`/`export` (recorded as not run), then prepare the step
   *  directory and optional stdin file. */
  private async prepareStep(
    command: string,
    opts: Record<string, unknown>,
  ): Promise<{ index: number; stepDir: string; cwd: string; stdinPath?: string }> {
    const cwd = this.resolveCwd(opts)
    const hint = stateOnlyCommandHint(command)
    if (hint) {
      this.steps.push({ kind: 'notRun', command, reason: hint })
      throw new StepError(errorData('invalid', hint))
    }
    const index = ++this.stepSeq
    const stepDir = joinRuntimePath(this.env.runDir, String(index))
    await this.env.fs.mkdir(stepDir)
    let stdinPath: string | undefined
    if (typeof opts.stdin === 'string') {
      stdinPath = joinRuntimePath(stepDir, 'in')
      await this.env.fs.writeFile(stdinPath, opts.stdin)
    }
    return { index, stepDir, cwd, stdinPath }
  }

  /** Run the nested Bash call and return the launched task id and the directory
   *  it runs in. The gates see `{ command, cwd }`; the host gets the wrapper
   *  built for the cwd the gates and PreToolUse hooks settled on — a hook that
   *  rewrites `cwd` moves the host's working directory AND the wrapper's `cd`
   *  together, never one without the other. */
  private async launch(
    command: string,
    cwd: string,
    buildHostCommand: (modelCommand: string, cwd: string) => string,
    /** The script awaits this step's result itself (a foreground step): the
     *  task is registered already acknowledged, so it never becomes a
     *  <task-notification>. A background step's result stays deliverable. */
    consumesResult: boolean,
  ): Promise<{ taskId: string; cwd: string }> {
    let refusal: StepError | undefined
    const refuse = (): StepError => {
      if (!refusal) {
        const message = 'SuperShell has finished or was stopped before this command could start.'
        this.steps.push({ kind: 'notRun', command, reason: message })
        refusal = new StepError(errorData('cancelled', message))
      }
      return refusal
    }
    if (this.closed || this.env.signal.aborted) throw refuse()
    let gatePassed = false
    let finalCwd = cwd
    const nested = runNestedTool(
      SHELL_TOOL_ID,
      { command, cwd, run_in_background: true },
      this.env.context,
      this.env.canUseTool,
      this.env.invokingRow,
      {
        prepareCall: finalInput => {
          // The gates may have waited on a permission prompt the user answered
          // AFTER this invocation was stopped or finished: an approval then must
          // not start the command.
          if (this.closed || this.env.signal.aborted) throw refuse()
          gatePassed = true
          const modelCommand = typeof finalInput.command === 'string' ? finalInput.command : command
          if (typeof finalInput.cwd === 'string' && finalInput.cwd.length > 0) {
            finalCwd = resolveRuntimePath(this.env.defaultCwd, finalInput.cwd)
          }
          return {
            ...finalInput,
            cwd: finalCwd,
            command: buildHostCommand(modelCommand, finalCwd),
            run_in_background: true,
            timeout: NO_TIMEOUT_CAP_SENTINEL_MS,
            [HOST_DISPLAY_COMMAND]: modelCommand,
            ...(consumesResult ? { [HOST_RESULT_ACKNOWLEDGED]: true } : {}),
            ...(this.ownerTaskId ? { [HOST_SUPER_SHELL_TASK_ID]: this.ownerTaskId } : {}),
          }
        },
      },
    )
    // Do not wait on the gates past the invocation's end: an unanswered prompt
    // would hold finish()/stop() open. Once past the gates the host spawn is
    // already under way — wait for its task id so the caller can stop it.
    const CLOSED = Symbol('closed')
    const raced = await Promise.race([nested, this.closing.then((): typeof CLOSED => CLOSED)])
    if (raced === CLOSED && !gatePassed) {
      void nested.catch(() => {})
      throw refuse()
    }
    const res = raced === CLOSED ? await nested : raced
    if (res.answeredByHook) {
      // A plugin's tool.call hook answered the step itself: no command ran,
      // so there is no task to wait on. Its answer is the reason.
      this.steps.push({ kind: 'notRun', command, reason: res.data })
      throw new StepError(errorData('denied', `Command was not run: a plugin hook answered it: ${res.data}`))
    }
    if (!res.ok) {
      this.steps.push({ kind: 'notRun', command, reason: res.data })
      throw new StepError(errorData('denied', `Command was not run: ${res.data}`))
    }
    const taskId = parseLaunchedTaskId(res.data)
    if (!taskId) {
      throw new StepError(
        errorData('start_failed', `Command did not start as a task (the host returned: ${res.data.slice(0, 200)}).`),
      )
    }
    return { taskId, cwd: finalCwd }
  }

  private async runForeground(command: string, opts: Record<string, unknown>): Promise<ShellRunResult> {
    const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : undefined
    let step!: number
    let stepDir!: string
    let cwd!: string
    let taskId: string
    // Running from the moment the script asked for it — preparing the step
    // directory included — so finish() never misses it.
    this.starting.push(command)
    try {
      let stdinPath: string | undefined
      ;({ index: step, stepDir, cwd, stdinPath } = await this.prepareStep(command, opts))
      ;({ taskId, cwd } = await this.launch(command, cwd, (modelCommand, runCwd) =>
        buildForegroundWrapper({ command: modelCommand, stepDir, cwd: runCwd, hasStdin: stdinPath !== undefined }),
      true,
      ))
    } catch (err) {
      // Every other StepError already recorded the command as not run; a plain
      // Error (a failed step-directory write, a disposed transport) did not.
      if (!(err instanceof StepError) || err.data.kind === 'start_failed') {
        const message = err instanceof StepError ? err.data.message : err instanceof Error ? err.message : String(err)
        if (step === undefined) {
          this.steps.push({ kind: 'notRun', command, reason: message })
        } else {
          this.recordForeground(command, cwd, Date.now(), step, stepDir, 'start_failed', null, { text: '', truncated: false }, { text: message, truncated: false })
        }
      }
      throw err
    } finally {
      this.starting.splice(this.starting.indexOf(command), 1)
    }
    // The command's clock starts at its launch: time spent preparing the step
    // and waiting on its gates (a permission prompt, hooks) is neither part of
    // its `timeout` nor of its `durationMs`.
    const startedAt = Date.now()

    const entry: ForegroundEntry = { command, cancelledByInvocation: false }
    this.foreground.set(taskId, entry)
    if (this.closed || this.env.signal.aborted) {
      // Its host spawn was under way when the invocation closed, after finish()
      // walked `foreground` (it counted the command among `starting`).
      entry.cancelledByInvocation = this.closed
      this.env.controller.stop(taskId)
    }
    // Acknowledge NOW, while the step's shell is still live: its result goes
    // back through the script, so it must never become a <task-notification>.
    // Acknowledging only after the wait returns loses a race once the invocation
    // runs in the background — the parent is idle, so the shell's delivery
    // flushes the moment it finishes, before this step reads its result.
    this.env.controller.acknowledgeResult?.(taskId)
    let snap: SubAgentSnapshot | null
    let timedOut = false
    try {
      snap = await this.awaitTask(taskId, startedAt, timeoutMs, () => (timedOut = true))
    } finally {
      this.foreground.delete(taskId)
    }
    this.env.controller.acknowledgeResult?.(taskId)

    const file = (name: string): string => joinRuntimePath(stepDir, name)
    const [ecText, cwdErr, stdout, stderr] = await Promise.all([
      readTextIfExists(this.env.fs, file('ec')),
      readTextIfExists(this.env.fs, file('cwderr')),
      readCapture(this.env.fs, file('out')),
      readCapture(this.env.fs, file('err')),
    ])
    await removeQuietly(this.env.fs, ['ec', 'cwderr', 'in'].map(file))

    const captured = { stdout: stdout.text, stderr: stderr.text, truncated: stdout.truncated || stderr.truncated }
    if (cwdErr !== undefined) {
      const message = `The working directory does not exist: ${cwd}`
      this.recordForeground(command, cwd, startedAt, step, stepDir,'start_failed', null, stdout, { text: message, truncated: false })
      throw new StepError(errorData('start_failed', message, captured))
    }
    if (timedOut) {
      this.recordForeground(command, cwd, startedAt, step, stepDir,'timeout', null, stdout, stderr)
      throw new StepError(
        errorData('timeout', `Command timed out after ${Math.round((timeoutMs ?? 0) / 1000)}s: ${oneLineCommand(command)}`, captured),
      )
    }
    if (entry.cancelledByInvocation || snap?.status === 'stopped' || this.env.signal.aborted) {
      this.recordForeground(command, cwd, startedAt, step, stepDir,'cancelled', null, stdout, stderr)
      throw new StepError(
        errorData(
          'cancelled',
          entry.cancelledByInvocation
            ? `Command was cancelled because the script finished before it did: ${oneLineCommand(command)}`
            : `Command was stopped before it finished: ${oneLineCommand(command)}`,
          captured,
        ),
      )
    }
    const parsed = ecText !== undefined ? Number.parseInt(ecText.trim(), 10) : Number.NaN
    const exitCode = Number.isFinite(parsed)
      ? parsed
      : typeof snap?.exitCode === 'number' && snap.exitCode >= 0
        ? snap.exitCode
        : null
    if (exitCode === null) {
      const message = `The command's exit status is unavailable: ${oneLineCommand(command)}`
      this.recordForeground(command, cwd, startedAt, step, stepDir,'start_failed', null, stdout, stderr)
      throw new StepError(errorData('start_failed', message, captured))
    }
    this.recordForeground(command, cwd, startedAt, step, stepDir,'exited', exitCode, stdout, stderr)
    return { ...captured, exitCode }
  }

  private recordForeground(
    command: string,
    cwd: string,
    startedAt: number,
    step: number,
    stepDir: string,
    outcome: ForegroundStepRecord['outcome'],
    exitCode: number | null,
    stdout: { text: string; truncated: boolean },
    stderr: { text: string; truncated: boolean },
  ): void {
    this.steps.push({
      kind: 'run',
      command,
      step,
      cwd,
      durationMs: Date.now() - startedAt,
      outcome,
      exitCode,
      // Only the tail: the result quotes the last lines of a failed step, and
      // the whole output stays in the log files. Holding up to 8 MB per stream
      // per step for the whole run would pin it in the shared SharedWorker.
      stdout: stdout.text.slice(-STEP_RECORD_TAIL_CHARS),
      stderr: stderr.text.slice(-STEP_RECORD_TAIL_CHARS),
      truncated: stdout.truncated || stderr.truncated,
      stdoutPath: joinRuntimePath(stepDir, 'out'),
      stderrPath: joinRuntimePath(stepDir, 'err'),
    })
  }

  /** Wait for a task to leave `running`; stop it at `timeoutMs` if given. */
  private async awaitTask(
    taskId: string,
    startedAt: number,
    timeoutMs: number | undefined,
    onTimeout: () => void,
  ): Promise<SubAgentSnapshot | null> {
    const deadline = timeoutMs !== undefined ? startedAt + timeoutMs : undefined
    const chunk = () =>
      deadline !== undefined ? Math.min(WAIT_CHUNK_MS, Math.max(0, deadline - Date.now())) : WAIT_CHUNK_MS
    let snap = await this.env.controller.waitForCompletion(taskId, chunk(), this.env.signal)
    while (snap && snap.status === 'running' && !this.env.signal.aborted) {
      if (deadline !== undefined && Date.now() >= deadline) {
        this.env.controller.stop(taskId)
        onTimeout()
        return this.env.controller.waitForCompletion(taskId, 5_000)
      }
      snap = await this.env.controller.waitForCompletion(taskId, chunk(), this.env.signal)
    }
    return snap
  }

  private async runBackground(
    command: string,
    opts: Record<string, unknown>,
  ): Promise<{ taskId: string }> {
    let logPath!: string
    let taskId: string
    let cwd: string
    try {
      const prepared = await this.prepareStep(command, opts)
      const { stepDir, stdinPath } = prepared
      logPath = joinRuntimePath(stepDir, 'out')
      ;({ taskId, cwd } = await this.launch(command, prepared.cwd, (modelCommand, runCwd) =>
        buildBackgroundWrapper({ command: modelCommand, cwd: runCwd, logPath, stdinPath }),
        false,
      ))
    } catch (err) {
      // Same rule as runForeground: every other StepError already recorded the
      // command as not run; a plain Error (a failed step-directory write, a
      // disposed transport) and a host that started no task did not — and a
      // script that swallows the throw would leave no trace of the attempt.
      if (!(err instanceof StepError) || err.data.kind === 'start_failed') {
        const message = err instanceof StepError ? err.data.message : err instanceof Error ? err.message : String(err)
        this.steps.push({ kind: 'notRun', command, reason: message })
      }
      throw err
    }
    this.backgroundTaskIds.add(taskId)
    this.steps.push({ kind: 'background', command, cwd, taskId, logPath })
    if (this.env.signal.aborted) {
      // Its host spawn was under way when the invocation was stopped, after
      // stop() walked `backgroundTaskIds`: it must not outlive the stop.
      this.env.controller.stop(taskId)
      throw new StepError(
        errorData('cancelled', `SuperShell was stopped while this command was starting; it was stopped too: ${command}`),
      )
    }
    return { taskId }
  }

  /**
   * New complete lines of a task log past `offset`, polling up to `waitMs`. Security:
   * no pattern matching here; a model-written RegExp runs in the script's own worker.
   */
  private async readLines(taskId: string, offset: number, waitMs: number): Promise<ReadLinesResult> {
    const record = this.steps.find(
      (s): s is BackgroundStepRecord => s.kind === 'background' && s.taskId === taskId,
    )!
    const deadline = Date.now() + waitMs
    for (;;) {
      if (this.env.signal.aborted || this.closed) {
        throw new StepError(errorData('cancelled', `waitFor was cancelled: the script was stopped.`))
      }
      // Snapshot BEFORE the read: a task that exits after it is seen running
      // is read to its end on the next call, never skipped.
      const snap = this.env.controller.getSnapshot(taskId)
      const running = snap?.status === 'running'
      const { lines, next, atEnd } = await this.readLogFrom(record.logPath, offset, !running)
      if (lines.length > 0 || !running || Date.now() >= deadline) {
        const exitCode = typeof snap?.exitCode === 'number' && snap.exitCode >= 0 ? snap.exitCode : null
        return {
          lines,
          offset: next,
          ended: !running && atEnd,
          status: snap?.status ?? 'unknown',
          exitCode,
          logPath: record.logPath,
        }
      }
      await sleep(Math.min(READ_LINES_POLL_MS, Math.max(0, deadline - Date.now())))
    }
  }

  /** One bounded read of a log from `offset`: its complete lines (every line,
   *  when `final`), where the next read starts, and whether it reached the end.
   *  Offsets are bytes with `fs.readRange`, characters without it. */
  private async readLogFrom(
    path: string,
    offset: number,
    final: boolean,
  ): Promise<{ lines: string[]; next: number; atEnd: boolean }> {
    const fs = this.env.fs
    if (fs.readRange) {
      let size = 0
      try {
        size = (await fs.stat(path)).size
      } catch {
        return { lines: [], next: offset, atEnd: true }
      }
      if (offset >= size) return { lines: [], next: offset, atEnd: true }
      const length = Math.min(READ_LINES_CHUNK, size - offset)
      const { buffer, bytesRead } = await fs.readRange(path, { offset, length })
      const bytes = buffer.subarray(0, Math.max(0, bytesRead))
      const reachesEnd = offset + bytes.length >= size
      const { lines, consumed } = takeCompleteLines(bytes, final && reachesEnd, READ_LINES_CHUNK)
      return { lines, next: offset + consumed, atEnd: reachesEnd && consumed === bytes.length }
    }
    const whole = await readTextIfExists(fs, path)
    if (whole === undefined || offset >= whole.length) {
      return { lines: [], next: offset, atEnd: true }
    }
    const text = whole.slice(offset, offset + READ_LINES_CHUNK)
    const reachesEnd = offset + text.length >= whole.length
    const { lines, consumed } = takeCompleteLines(text, final && reachesEnd, READ_LINES_CHUNK)
    return { lines, next: offset + consumed, atEnd: reachesEnd && consumed === text.length }
  }
}

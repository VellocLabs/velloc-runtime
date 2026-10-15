/**
 * SuperShell: a model-written script whose only capability is `bash()`. Security: it
 * runs in SuperEdit's hardened worker and each `bash()` is a nested Bash tool call
 * (rule engine, command safety, prompts, hooks), so it adds no execution capability
 * a Bash call does not have (F-21).
 */

import type { ModelReplyRow, Message } from '../../runtime/RuntimeTypes'
import type { PermissionDecider } from '../permissionVerdict'
import type { ToolCallContext } from '../toolCallContext'
import type { InputCheck } from '../toolContract'
import { declareTool, resolveToolByName, type ToolContract } from '../toolContract'
import { isRunJsAvailable, runJs, RunJsFailure } from '../../browser/runJs/RunJsBroker'
import { SUPER_SHELL_TOOL_NAME, type RunJsLogLine } from '../../browser/runJs/runJsProtocol'
import { SHELL_TOOL_ID } from '../../prompting/processToolNames'
import { getSubAgentController } from '../../team/subAgentController'
import { fsForContext } from '../../utils/fs/runtimeFs'
import { joinRuntimePath, normalizeRuntimePath } from '../../utils/runtimePaths'
import { oneLineCommand } from '../../browser/runJs/shellHelpers'
import { getLiveCwd } from './glic/bashCwdInterceptor'
import {
  notifySuperShellFinished,
  notifySuperShellStarted,
} from '../../backgroundTasks/superShellTaskSink'
import { formatScriptLocation } from './superEdit'
import {
  SuperShellInvocation,
  superShellRunDir,
  type StepRecord,
} from './superShellRunner'

export type SuperShellInput = {
  code?: string
  inputs?: Record<string, unknown>
  description?: string
  timeoutSec?: number
  waitSec?: number
}

export type SuperShellOutput = string

const DEFAULT_TIMEOUT_SEC = 30
const MIN_TIMEOUT_SEC = 1
const MAX_TIMEOUT_SEC = 600

/** How long the call waits inline before the invocation continues in the
 *  background — the Bash tool's default inline wait (2 minutes). */
const DEFAULT_WAIT_SEC = 120
const MIN_WAIT_SEC = 1
const MAX_WAIT_SEC = 600

/** Characters of the script's return value the result quotes. `return r.stdout`
 *  can hand back up to 8 MB; past this the full text is saved in the run
 *  directory and the result says where. */
export const RETURN_VALUE_MAX_CHARS = 40_000
/** Characters of the script's console output the result quotes, likewise. */
export const CONSOLE_MAX_CHARS = 10_000
/** Steps the execution record lists before it shows only its first and last
 *  STEPS_SHOWN_EACH_END: a loop of thousands of `bash()` calls must not make the
 *  record the size of the output it leaves out. The heading still counts them
 *  all, and a final result saves the whole record. */
export const STEPS_SHOWN_MAX = 60
const STEPS_SHOWN_EACH_END = 25
/** Command names a list of cancelled or running commands shows. */
const COMMANDS_LISTED_MAX = 20

function clampTimeoutMs(seconds: unknown): number {
  const s =
    typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : DEFAULT_TIMEOUT_SEC
  return Math.max(MIN_TIMEOUT_SEC, Math.min(MAX_TIMEOUT_SEC, Math.floor(s))) * 1000
}

/** Strict-mode tool calls send unset optionals as explicit `null`. */
function normalizeInput(input: SuperShellInput): SuperShellInput {
  return {
    code: input.code ?? undefined,
    inputs: input.inputs ?? undefined,
    description: input.description ?? undefined,
    timeoutSec: input.timeoutSec ?? undefined,
    waitSec: input.waitSec ?? undefined,
  }
}

async function checkInput(rawInput: SuperShellInput): Promise<InputCheck> {
  const input = normalizeInput(rawInput)
  if (typeof input.code !== 'string' || input.code.trim().length === 0) {
    return { result: false, message: 'Provide `code`: the script to run.', errorCode: 1 }
  }
  if (
    input.timeoutSec !== undefined &&
    (typeof input.timeoutSec !== 'number' || !Number.isFinite(input.timeoutSec))
  ) {
    return { result: false, message: '`timeoutSec` must be a number when provided.', errorCode: 2 }
  }
  if (
    input.waitSec !== undefined &&
    (typeof input.waitSec !== 'number' || !Number.isFinite(input.waitSec))
  ) {
    return { result: false, message: '`waitSec` must be a number when provided.', errorCode: 4 }
  }
  if (
    input.inputs !== undefined &&
    (typeof input.inputs !== 'object' || input.inputs === null || Array.isArray(input.inputs))
  ) {
    return {
      result: false,
      message: '`inputs` must be a plain object mapping names to data values when provided.',
      errorCode: 3,
    }
  }
  return { result: true }
}

function elapsedLabel(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  // Round FIRST, then split, so a rounded-up unit carries over: 59.96s is
  // `1m0s` (not `60.0s`) and 119.6s is `2m0s` (not `1m60s`).
  const tenths = Math.round(ms / 100)
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`
}

/** Commands as a bulleted list, at most COMMANDS_LISTED_MAX of them. */
function listCommands(commands: readonly string[], bullet: string): string {
  const shown = commands.slice(0, COMMANDS_LISTED_MAX).map(c => `${bullet}${oneLineCommand(c)}`)
  if (commands.length > shown.length) {
    shown.push(`${bullet}… and ${commands.length - shown.length} more`)
  }
  return shown.join('\n')
}

/**
 * The execution record the model reads: one line per step (what ran, how it ended,
 * duration, `#n`), never the output; log paths for failed or truncated steps. Past
 * STEPS_SHOWN_MAX only both ends are listed unless `showAll`.
 */
export function formatSteps(
  steps: readonly StepRecord[],
  defaultCwd: string,
  options: { runDir?: string; omittedNote?: string; showAll?: boolean } = {},
): string {
  const { runDir, omittedNote = '', showAll = false } = options
  if (steps.length === 0) return 'No commands were run.'
  // Compared normalized: a step's directory comes back from the Bash gates
  // resolved (`D:\proj`) while the default is the live cwd as written (`D:/proj`),
  // and the two must not read as different directories.
  const dirKey = (dir: string): string => {
    const normalized = normalizeRuntimePath(dir)
    return /^[A-Za-z]:|^\\\\/.test(normalized) ? normalized.toLowerCase() : normalized
  }
  const defaultKey = dirKey(defaultCwd)
  const dirs = new Map(steps.flatMap(s => (s.kind === 'notRun' ? [] : [[dirKey(s.cwd), s.cwd] as const])))
  const [sharedKey] = dirs.size === 1 ? [...dirs.keys()] : []
  const sharedCwd = sharedKey !== undefined ? dirs.get(sharedKey) : undefined
  const cwdInHeading = sharedKey !== undefined && sharedKey !== defaultKey
  const commands = steps.filter(s => s.kind !== 'background')
  const notOk = commands.filter(s => s.kind === 'notRun' || s.outcome !== 'exited' || s.exitCode !== 0)
  const notes = [
    ...(cwdInHeading ? [`all in ${sharedCwd}`] : []),
    ...(notOk.length > 0 ? [`${notOk.length} of ${commands.length} did not exit 0`] : []),
  ]
  const lines: string[] = [notes.length > 0 ? `Steps: ${notes.join('; ')}` : 'Steps:']
  const stepLines = (step: StepRecord): string[] => {
    const where =
      step.kind !== 'notRun' && !cwdInHeading && dirKey(step.cwd) !== defaultKey ? `  (in ${step.cwd})` : ''
    if (step.kind === 'background') {
      return [`▶ ${oneLineCommand(step.command)}  background task ${step.taskId}${where}`, `    output log: ${step.logPath}`]
    }
    if (step.kind === 'notRun') {
      return [`✗ ${oneLineCommand(step.command)}  not run: ${step.reason}`]
    }
    const status =
      step.outcome === 'exited' ? `exit ${step.exitCode}` : step.outcome.replace('_', ' ')
    const ok = step.outcome === 'exited' && step.exitCode === 0
    const out = [
      `${ok ? '✓' : '✗'} ${oneLineCommand(step.command)}  ${status}  ${elapsedLabel(step.durationMs)}${where}  #${step.step}`,
    ]
    if (!ok || step.truncated) {
      out.push(`    full output: ${step.stdoutPath} (stdout), ${step.stderrPath} (stderr)`)
    }
    if (step.truncated) {
      out.push('    (the script saw only the last 8 MB of this output; the log files are complete)')
    }
    return out
  }
  if (!showAll && steps.length > STEPS_SHOWN_MAX) {
    const omitted = steps.length - 2 * STEPS_SHOWN_EACH_END
    lines.push(...steps.slice(0, STEPS_SHOWN_EACH_END).flatMap(stepLines))
    lines.push(`… ${omitted} more steps not shown${omittedNote} …`)
    lines.push(...steps.slice(-STEPS_SHOWN_EACH_END).flatMap(stepLines))
  } else {
    lines.push(...steps.flatMap(stepLines))
  }
  if (runDir !== undefined && steps.some(s => s.kind === 'run')) {
    lines.push(
      `Every command's complete output: ${joinRuntimePath(runDir, '<#>', 'out')} (stdout) and err (stderr), where <#> is its step number.`,
    )
  }
  return lines.join('\n')
}

/** `text`, or its first `maxChars` characters with the whole of it saved as
 *  `fileName` in the run directory and a marker saying so — naming the file only
 *  once it is written, and saying why when it could not be. Cut by length only:
 *  nothing guesses what the text means. `what` names the text in the marker. */
async function capText(
  invocation: SuperShellInvocation,
  text: string,
  maxChars: number,
  fileName: string,
  what: string,
): Promise<string> {
  if (text.length <= maxChars) return text
  const saved = await invocation.saveRunFile(fileName, text)
  const where =
    'path' in saved ? `the full ${what} is in ${saved.path}` : `saving the full ${what} failed: ${saved.error}`
  return `${text.slice(0, maxChars)}\n[cut at ${maxChars} of ${text.length} characters; ${where}]`
}

/**
 * The model-visible result, built once per run: the headline (the return value,
 * or why the run ended), the execution record, then the console. `returned` is
 * the script's return value, quoted into the headline. Every part is bounded —
 * the return value and console by their caps, the record by STEPS_SHOWN_MAX, a
 * script error by its caller — so the inline result, TaskOutput and the
 * notification, which all carry this same text, stay bounded too.
 */
async function shellReport(
  invocation: SuperShellInvocation,
  headline: string,
  logs: RunJsLogLine[],
  returned?: string,
): Promise<string> {
  const value = returned !== undefined
    ? await capText(invocation, returned, RETURN_VALUE_MAX_CHARS, 'result.txt', 'return value')
    : ''
  const { steps, defaultCwd, runDir } = invocation
  let omittedNote = ''
  if (steps.length > STEPS_SHOWN_MAX) {
    const saved = await invocation.saveRunFile('steps.txt', formatSteps(steps, defaultCwd, { runDir, showAll: true }))
    omittedNote = 'path' in saved
      ? ` (the whole record is in ${saved.path})`
      : ` (saving the whole record failed: ${saved.error})`
  }
  const parts = [headline + value, formatSteps(steps, defaultCwd, { runDir, omittedNote })]
  if (logs.length > 0) {
    const text = await capText(
      invocation,
      logs.map(l => `[${l.level}] ${l.text}`).join('\n'),
      CONSOLE_MAX_CHARS,
      'console.txt',
      'console output',
    )
    parts.push(`--- console (${logs.length}) ---\n${text}`)
  }
  return parts.join('\n\n')
}

function cancelledHeadline(cancelled: readonly string[]): string {
  return (
    'SuperShell did not complete: the script returned while foreground commands were still running. ' +
    'Those commands were cancelled:\n' +
    listCommands(cancelled, '  - ') +
    '\nAwait every bash() call (or use { background: true } for processes meant to keep running).'
  )
}

type Outcome = {
  status: 'success' | 'error' | 'stopped'
  data: string
  /** The interrupt to rethrow when a foreground run was stopped by the turn. */
  abortError?: unknown
}

/** Steps finished so far plus the commands still running — TaskOutput's view of
 *  a running invocation. Exported for unit tests. */
export function formatProgress(invocation: SuperShellInvocation): string {
  const running = invocation.runningCommands
  if (invocation.steps.length === 0 && running.length === 0) {
    return 'No command has started yet.'
  }
  // A command running with none finished yet: "No commands were run." would
  // contradict the "Running now" list below it.
  const lines = [
    invocation.steps.length === 0
      ? 'No command has finished yet.'
      : formatSteps(invocation.steps, invocation.defaultCwd, { runDir: invocation.runDir }),
  ]
  if (running.length > 0) {
    lines.push(`Running now:\n${listCommands(running, '  ▶ ')}`)
  }
  return lines.join('\n\n')
}

function clampWaitMs(seconds: unknown): number {
  const s = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : DEFAULT_WAIT_SEC
  return Math.max(MIN_WAIT_SEC, Math.min(MAX_WAIT_SEC, Math.floor(s))) * 1000
}

const STOPPED_HEADLINE =
  'SuperShell was stopped. Its running commands and the background processes it started were stopped too.'

/** The headline when the session's runtime scope went away under the run. */
export const SCOPE_DISPOSED_HEADLINE =
  'SuperShell was stopped because the session that started it was closed or reloaded. ' +
  'Its running commands and the background processes it started were stopped too.'

/**
 * True where the tool-use context cannot outlive the call (in-process fork,
 * worker-hosted sub-agent, headless routine): the invocation never backgrounds there.
 */
export function cannotOutliveCall(context: ToolCallContext): boolean {
  const options = context.options as { sessionId?: string; isHeadless?: boolean }
  return (
    context.agentId !== undefined ||
    (options.sessionId ?? '').startsWith('subagent-') ||
    options.isHeadless === true
  )
}

/** Value equality for two args values that come from the same model-args JSON
 *  parse (so key order is stable); a stringify throw degrades to reference
 *  equality. */
function sameArgsValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  try {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  } catch {
    return false
  }
}

/** Call ids already resolved per assistant message (findSuperShellToolCallId). */
const claimedSuperShellCallIds = new WeakMap<object, Set<string>>()

/**
 * This invocation's tool CALL id (its drawer row key); with several calls, the one
 * whose args equal this input. '' when nothing matches, rather than a guess.
 */
export function findSuperShellToolCallId(invokingRow: Message, input: SuperShellInput): string {
  const content = (invokingRow as ModelReplyRow)?.message?.content
  if (!Array.isArray(content)) return ''
  const calls: Array<{ id: string; args: SuperShellInput | undefined }> = []
  for (const part of content) {
    const rec = part && typeof part === 'object' ? (part as Record<string, unknown>) : null
    if (!rec) continue
    const name = typeof rec.name === 'string' ? rec.name : rec.toolName
    if (name !== SUPER_SHELL_TOOL_NAME) continue
    const id = typeof rec.id === 'string' ? rec.id : rec.toolCallId
    if (typeof id !== 'string' || id.length === 0) continue
    calls.push({ id, args: (rec.args ?? rec.input) as SuperShellInput | undefined })
  }
  if (calls.length === 1) return calls[0]!.id
  // Identical calls in one message: each invocation claims the first matching
  // call no earlier invocation of this message took, so two runs never share
  // one id.
  let claimed = claimedSuperShellCallIds.get(invokingRow as object)
  if (!claimed) {
    claimed = new Set()
    claimedSuperShellCallIds.set(invokingRow as object, claimed)
  }
  for (const { id, args } of calls) {
    if (
      !claimed.has(id) &&
      args &&
      args.code === input.code &&
      args.description === input.description &&
      args.timeoutSec === input.timeoutSec &&
      args.waitSec === input.waitSec &&
      sameArgsValue(args.inputs, input.inputs)
    ) {
      claimed.add(id)
      return id
    }
  }
  return ''
}

/** Run the script to its end and turn every ending into an Outcome. Never
 *  rejects. */
async function executeScript(
  invocation: SuperShellInvocation,
  code: string,
  input: SuperShellInput,
  stop: AbortController,
  stoppedHeadline: () => string,
): Promise<Outcome> {
  try {
    const { result, logs } = await runJs({
      code,
      mode: 'shell',
      timeoutMs: clampTimeoutMs(input.timeoutSec),
      inputs: input.inputs ?? {},
      signal: stop.signal,
      onShellCall: (op, payload) => invocation.handle(op, payload),
    })
    const cancelled = await invocation.finish()
    if (cancelled.length > 0) {
      const headline =
        cancelledHeadline(cancelled) + (result !== null ? `\n\nThe script's return value:\n` : '')
      return { status: 'error', data: await shellReport(invocation, headline, logs, result ?? undefined) }
    }
    return {
      status: 'success',
      data: await shellReport(invocation, '', logs, result ?? '(no return value)'),
    }
  } catch (err) {
    const logs = err instanceof RunJsFailure ? err.logs : []
    if (stop.signal.aborted) {
      await invocation.stop()
      return {
        status: 'stopped',
        data: await shellReport(invocation, stoppedHeadline(), logs),
        abortError: err,
      }
    }
    await invocation.finish()
    // A script may throw any text it likes; it is capped like a return value.
    const message = await capText(
      invocation,
      err instanceof Error ? err.message : String(err),
      RETURN_VALUE_MAX_CHARS,
      'error.txt',
      'error message',
    )
    const location = err instanceof RunJsFailure ? err.location : undefined
    const headline = location
      ? `SuperShell error: ${message}\n${formatScriptLocation(code, location)}`
      : `SuperShell error: ${message}`
    return { status: 'error', data: await shellReport(invocation, headline, logs) }
  }
}

async function call(
  rawInput: SuperShellInput,
  context: ToolCallContext,
  canUseTool: PermissionDecider,
  invokingRow: Message,
): Promise<{ data: SuperShellOutput; isError?: boolean }> {
  const input = normalizeInput(rawInput)
  const code = input.code ?? ''

  if (context.options.untrustedReadRoot) {
    return { data: 'Denied: this session cannot run commands.', isError: true }
  }
  if (!isRunJsAvailable()) {
    return {
      data: 'SuperShell is unavailable: no execution worker is attached (the app UI must be open).',
      isError: true,
    }
  }
  if (!resolveToolByName(context.options.tools, SHELL_TOOL_ID)) {
    return {
      data: 'SuperShell is unavailable: it runs commands through the Bash tool, which this session does not have.',
      isError: true,
    }
  }
  const controller = getSubAgentController()
  if (!controller) {
    return {
      data: 'SuperShell is unavailable: background task tracking is not running in this runtime.',
      isError: true,
    }
  }

  // Every step goes through THIS context's permission queue and scope-bound
  // transport; once its runtime scope is disposed they reject every call.
  const scopeSignal = context.options.runtimeScopeSignal
  if (scopeSignal?.aborted) {
    return {
      data: 'SuperShell cannot start: the session that called it was closed or reloaded.',
      isError: true,
    }
  }

  // The invocation's own stop signal. While the call is inline a turn interrupt
  // stops it; once it continues in the background only TaskStop, the drawer, a
  // later session Stop, closing the session, or its runtime scope being
  // disposed does.
  const stop = new AbortController()
  const turnSignal = context.cancelSource?.signal
  const onTurnAbort = () => stop.abort()
  if (turnSignal?.aborted) stop.abort()
  else turnSignal?.addEventListener('abort', onTurnAbort, { once: true })
  let scopeDisposed = false
  const onScopeDisposed = () => {
    scopeDisposed = true
    stop.abort()
  }
  scopeSignal?.addEventListener('abort', onScopeDisposed, { once: true })

  const defaultCwd = getLiveCwd(context)
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const invocation = new SuperShellInvocation({
    context,
    canUseTool,
    invokingRow,
    controller,
    fs: fsForContext(context),
    defaultCwd,
    runDir: superShellRunDir(context, runId),
    signal: stop.signal,
  })

  const taskId = notifySuperShellStarted({
    spawnerSessionId: context.options.sessionId || undefined,
    toolCallId: findSuperShellToolCallId(invokingRow, rawInput) || undefined,
    description: input.description,
    code,
    inputs: input.inputs,
    startedAt: Date.now(),
    progress: () => formatProgress(invocation),
    stop: () => stop.abort(),
  })
  // Before the script runs: every step's shell task then records this
  // invocation, and the drawer lists the steps under it rather than under Shell.
  if (taskId) invocation.setOwnerTaskId(taskId)

  // `detached` and `settled` are decided on the single JS thread, so exactly one
  // of "returned inline" / "handed its task id to the model" happens, and the
  // finish notification's `deliver` agrees with it.
  let detached = false
  let settled = false
  const run = executeScript(invocation, code, input, stop, () =>
    scopeDisposed ? SCOPE_DISPOSED_HEADLINE : STOPPED_HEADLINE,
  ).then(outcome => {
    settled = true
    scopeSignal?.removeEventListener('abort', onScopeDisposed)
    if (taskId) {
      notifySuperShellFinished({
        taskId,
        status: outcome.status,
        resultText: outcome.data,
        finishedAt: Date.now(),
        deliver: detached,
      })
    }
    return outcome
  })

  const toResult = (outcome: Outcome): { data: string; isError?: boolean } => {
    // Only the turn's own interrupt unwinds as an abort. A Stop from the drawer
    // or TaskStop, or a disposed scope, reports what ran and why it stopped.
    if (outcome.status === 'stopped') {
      if (turnSignal?.aborted) throw outcome.abortError ?? new Error('SuperShell was interrupted.')
      return { data: outcome.data, isError: true }
    }
    return outcome.status === 'success' ? { data: outcome.data } : { data: outcome.data, isError: true }
  }

  try {
    if (!taskId || cannotOutliveCall(context)) {
      // No task tracking (mock host): nothing could deliver a background result.
      // A fork / background sub-agent / headless run: its context dies with
      // this call, so the run stays inline to its end (the caller's turn waits;
      // its interrupt still stops the run).
      return toResult(await run)
    }
    const waitMs = clampWaitMs(input.waitSec)
    const ended = await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => {
        if (settled) return
        detached = true
        resolve(false)
      }, waitMs)
      void run.then(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    if (ended && !detached) return toResult(await run)
    turnSignal?.removeEventListener('abort', onTurnAbort)
    return {
      data:
        `SuperShell is still running after ${Math.round(waitMs / 1000)}s and continues in the background with ID: ${taskId}. ` +
        `You will be notified when it completes. Use TaskOutput with this ID to see its progress or wait for its result, ` +
        `and TaskStop to stop it (that also stops the commands and background processes it started).\n\n` +
        `Progress so far:\n${formatProgress(invocation)}`,
    }
  } finally {
    if (!detached) turnSignal?.removeEventListener('abort', onTurnAbort)
  }
}

// The model-facing API contract — the only SuperShell prose on the wire
// (`description({})`, see SuperEditTool for the same arrangement).
export const SUPER_SHELL_TOOL_DESCRIPTION = [
  'Orchestrate shell commands from a JavaScript script: run a sequence of commands — with the checks between them — in one call, with each command\'s own exit code and output available to the script.',
  '',
  'The script is an async function body: `await` and `return` work, `console.*` is captured, and the return value is reported first. Put long text (stdin payloads, large arguments) in `inputs` and read it as `inputs.<name>`.',
  '',
  'Call `bash()` once per command and keep sequencing, conditions, loops and output processing in JavaScript; a command string with `&&`, `|` or `;` reports one status for the whole string, which hides which part failed.',
  '',
  'Every `bash()` is a fresh process started in the directory SuperShell began in, or in `cwd` when given. Nothing carries between calls: a `cd` or `export` inside a command affects only that command. Pass `{ cwd }` for another directory instead of starting the command with `cd dir &&`; put variables in the command (`VAR=value cmd`).',
  '',
  '```ts',
  `// Run one command and wait for it. exitCode is the status of the command string.
// truncated: true means stdout/stderr hold only the last 8 MB — do not treat them as complete.
// Throws ShellError (kind, exitCode, stdout, stderr, truncated):
//   kind 'failed'   non-zero exit — unless { nothrow: true }
//   kind 'timeout' | 'cancelled' | 'denied' | 'start_failed' | 'invalid' — ALWAYS, even with nothrow
function bash(command: string, options?: { cwd?: string; stdin?: string; timeout?: number /* ms */; nothrow?: boolean }): Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean }>

// Start a long-running process (dev server, watcher) and return at once. It keeps running
// after the script ends, as a background task (TaskOutput / TaskStop), unless you stop() it.
// waitFor scans the process's whole output so far, then follows it, and resolves with the first
// matching line; it throws if the process exits first or nothing matches in time (default 120000 ms).
function bash(command: string, options: { background: true; cwd?: string; stdin?: string }): Promise<{ taskId: string; waitFor(pattern: RegExp | string, options?: { timeout?: number }): Promise<string>; stop(): Promise<void> }>

const inputs: Record<string, unknown>`,
  '```',
  '',
  'Example: { "inputs": { "wt": "nexus_web" }, "code": "const o = { cwd: inputs.wt }; await bash(\'git add src/a.ts\', o); const tsc = await bash(\'npx tsc --noEmit\', { ...o, nothrow: true }); if (tsc.exitCode !== 0) return tsc.stdout.split(\'\\\\n\').filter(l => l.includes(\'error TS\')).slice(0, 20); return (await bash(\'npx vitest run\', { ...o, nothrow: true })).exitCode" }',
  '',
  'Stop a background process in `finally`, so a failing step does not leave it running: `const srv = await bash(\'npx vite --port 5177\', { background: true }); try { await srv.waitFor(/ready in/); await bash(\'npx playwright test\'); } finally { await srv.stop(); }`',
  '',
  'Some commands report an ordinary outcome through a non-zero exit (grep with no match, `git diff --exit-code`): use { nothrow: true } for them.',
  '',
  'Await every `bash()` call. If the script returns while a command is still running, that command is cancelled and SuperShell reports the run as not completed.',
  '',
  'You do not need to predict how long the script takes. If it is still running after `waitSec` (default 120 s), the call returns a task ID and the script keeps running in the background — its commands continue in order. You are notified when it completes; use TaskOutput to see its progress or wait for its result, and TaskStop to stop it, which also stops the processes it started. Inside a sub-agent the call instead waits until the script finishes.',
  '',
  'Command output goes to your script, not into the result. The result reports what ran — each command\'s exit status, duration and step number, how many did not exit 0, and the error that ended the script, if one did (a command that throws quotes the end of its output) — and names the folder where every command\'s complete output is kept, by step number. Return what the next decision needs: a verdict, the lines you picked out, or a command\'s whole output when you need all of it (`return r.stdout`). A script that completes normally needs no return value. A return value longer than 40,000 characters, or console output longer than 10,000, is cut, and the whole of it is saved to a file the result names.',
  '',
  'Every command goes through the same permission checks as a Bash call. Commands have no terminal and no interactive input.',
  '',
  'Batch related steps in one script when the next actions are predetermined or can be chosen in code from the results — a separate `bash()` per step, not one SuperShell call per command. Return control when the next step needs your judgment, a file edit, or a decision from the user.',
  '',
  'Environment: the script itself is ECMAScript only — no DOM, Node.js, network or filesystem APIs; `bash()` is its only way to act. `timeoutSec` limits the script\'s own JavaScript; time spent waiting for commands does not count.',
].join('\n')

export const SuperShellTool: ToolContract<SuperShellInput, SuperShellOutput> = declareTool({
  name: SUPER_SHELL_TOOL_NAME,
  discoveryHint: 'orchestrate a sequence of shell commands from a script with per-command results',
  argsSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'JavaScript to execute, using the script API given in this tool’s description.',
      },
      inputs: {
        type: 'object',
        description:
          'Data values the script reads as `inputs.<name>`. Put stdin payloads and other long ' +
          'text HERE — they reach the script as runtime values, never parsed as JavaScript.',
      },
      description: {
        type: 'string',
        description: 'Brief user-facing description of what this run will do.',
      },
      waitSec: {
        type: 'number',
        minimum: MIN_WAIT_SEC,
        maximum: MAX_WAIT_SEC,
        default: DEFAULT_WAIT_SEC,
        description:
          'How long to wait for the script before it continues in the background and this call ' +
          'returns its task id (seconds).',
      },
      timeoutSec: {
        type: 'number',
        minimum: MIN_TIMEOUT_SEC,
        maximum: MAX_TIMEOUT_SEC,
        default: DEFAULT_TIMEOUT_SEC,
        description:
          'Limit on the script’s own JavaScript time, in seconds. Time spent waiting for ' +
          'commands (and their permission prompts) does not count.',
      },
    },
    // Same reasoning as SuperEdit: a required `inputs` keeps the data channel in
    // view during generation, where long text would otherwise land in `code`.
    required: ['code', 'inputs'],
    additionalProperties: false,
  },
  // Model (empty input) → the full contract; permission dialog (real input) →
  // the call's own one-line description. See SuperEditTool.
  description: async (input: SuperShellInput) =>
    input?.description?.trim() || SUPER_SHELL_TOOL_DESCRIPTION,
  checkInput: checkInput,
  call,
})

/**
 * run_js broker: the `runjs` profile of the isolated-worker kernel, SharedWorker
 * side (F-21). Defines the script init (`RunJsScriptInit`), the closed noun table
 * (`fs` for SuperEdit, `shell` for SuperShell, each permission-gated by the calling
 * tool's handler in the owning scope) and `RunJsFailure`.
 */

import {
  isKernelAvailable,
  KERNEL_SPAWN_ACK_TIMEOUT_MS,
  KERNEL_STARTUP_TIMEOUT_MS,
  KernelRunFailure,
  resetKernelForTests,
  runOnce,
  setKernelControlPort,
  type KernelNounHandler,
} from '../workerKernel/IsolatedWorkerKernel'
import {
  RUN_JS_FS_NOUN,
  RUN_JS_SHELL_NOUN,
  RUN_JS_WORKER_KIND,
  type RunJsFsOp,
  type RunJsLogLine,
  type RunJsMode,
  type RunJsScriptInit,
  type RunJsShellOp,
} from './runJsProtocol'

/** Runs one `workspace` facade primitive for the script (permission-gated in
 *  the owning scope — see SuperEditTool.handleScriptFsOp/commitOverlay). Rejection errors carry
 *  a DOMException `.name` the worker rehydrates for the script. */
export type RunJsFsHandler = (
  op: RunJsFsOp,
  payload: Record<string, unknown>,
) => Promise<unknown>

/** Runs one SuperShell command primitive for a `shell`-mode script (see
 *  SuperShellTool). Rejection errors carry a `.name` the worker rethrows. */
export type RunJsShellHandler = (
  op: RunJsShellOp,
  payload: Record<string, unknown>,
) => Promise<unknown>

export type RunJsRunOptions = {
  code: string
  /** Cap on the SCRIPT's own execution; on expiry the worker is terminated and
   *  the run rejects with a timeout error. It starts when the script starts
   *  (`k.started`), not when the run is requested, and pauses for every
   *  nested filesystem call — startup and permission prompts are covered by
   *  their own deadlines (STARTUP_TIMEOUT_MS / the commit ask), never by this. */
  timeoutMs: number
  /** The project root's basename — the script's `workspace.name`. */
  workspaceName?: string
  /** Data values exposed to the script as `inputs` — carried by structured
   *  clone the whole way, never parsed as source (runJsProtocol.ts
   *  RunJsScriptInit). */
  inputs?: Record<string, unknown>
  /** Cancels the run (worker terminated) when the owning turn is interrupted. */
  signal?: AbortSignal
  /** The script surface to build worker-side. Absent → `'edit'`. */
  mode?: RunJsMode
  onFsCall?: RunJsFsHandler
  /** Services `bash()` for a `shell`-mode script. Like a filesystem call, the
   *  execution clock is PAUSED while one is in flight: a command's own runtime
   *  (and any permission prompt it raises) is not the script's JavaScript. */
  onShellCall?: RunJsShellHandler
  onLog?: (line: RunJsLogLine) => void
}

export type RunJsRunResult = {
  /** The script's serialized return value, or null. */
  result: string | null
  logs: RunJsLogLine[]
}

/** A run_js rejection that still carries the console lines the script streamed
 *  before it failed (script throw, timeout, worker crash, interrupt) — the
 *  tool surfaces them so the model can see how far its script got. A script
 *  throw may also carry `location`: SCRIPT-relative line/column already
 *  adjusted worker-side (see runJsWorkerCore.ts) — the tool uses it to quote
 *  the offending source line. */
export class RunJsFailure extends Error {
  readonly logs: RunJsLogLine[]
  readonly location?: { line: number; column: number }
  /** The SCRIPT error's name (`SyntaxError`, `TypeError`, …), forwarded from
   *  the worker. Deliberately NOT `name` — this class sets that to
   *  `RunJsFailure`, and collapsing the two would lose whichever is written
   *  second. Absent when the failure is not a script throw at all (timeout,
   *  worker crash, transport death). */
  readonly scriptErrorName?: string
  /** The script never PARSED (worker `parseFailed`) — as opposed to a
   *  SyntaxError it threw while running. */
  readonly scriptParseFailed: boolean
  constructor(
    message: string,
    logs: RunJsLogLine[],
    stack?: string,
    location?: { line: number; column: number },
    scriptErrorName?: string,
    scriptParseFailed = false,
  ) {
    super(message)
    this.name = 'RunJsFailure'
    if (stack) this.stack = stack
    this.logs = logs
    this.location = location
    this.scriptErrorName = scriptErrorName
    this.scriptParseFailed = scriptParseFailed
  }
}

/** How long a spawn may go unacknowledged before the run fails fast — the
 *  kernel's deadline, re-exported under the name run_js's tests and docs use. */
export const SPAWN_ACK_TIMEOUT_MS = KERNEL_SPAWN_ACK_TIMEOUT_MS

/** How long the whole STARTUP phase may take — the kernel's deadline (arm to
 *  `k.started`: worker creation, module load, `hardenWorkerRealm` and the
 *  wrapper-offset probe). */
export const STARTUP_TIMEOUT_MS = KERNEL_STARTUP_TIMEOUT_MS

/** Cap on the console lines a run RETAINS — a script that logs in a tight loop
 *  must not grow the broker's memory without bound. Past either budget further
 *  lines are dropped and ONE `… N more lines dropped` marker is appended when
 *  the run settles. Exported so the tests state the same caps. */
export const RUN_JS_MAX_LOG_LINES = 2_000
/** Companion byte-ish budget (UTF-16 code units of retained text). */
export const RUN_JS_MAX_LOG_CHARS = 512 * 1024

/** Attach the control channel to the window. The port is the kernel's — one
 *  control port serves every profile — and PortMessageRouter hands it straight
 *  to `setKernelControlPort`; this alias exists for run_js's own tests. */
export function setRunJsControlPort(port: MessagePort): void {
  setKernelControlPort(port)
}

export function isRunJsAvailable(): boolean {
  return isKernelAvailable()
}

/** Test seam: reset module state between unit tests. */
export function resetRunJsBrokerForTests(): void {
  resetKernelForTests()
}

/** What a script reads when it calls a noun its run was not given a handler
 *  for (a SuperEdit run has no `shell`; a SuperShell run has no `fs`). */
function unavailableNounMessage(noun: string): string {
  if (noun === RUN_JS_FS_NOUN) return 'workspace is not available in this run.'
  if (noun === RUN_JS_SHELL_NOUN) return 'Commands are not available in this run.'
  return `${noun} is not available in this run.`
}

/**
 * Run a script in a fresh DedicatedWorker. Resolves with the script's
 * serialized result + captured logs, or rejects (script error, timeout, abort,
 * worker crash). Always tears the worker down.
 */
export async function runJs(opts: RunJsRunOptions): Promise<RunJsRunResult> {
  const init: RunJsScriptInit = {
    code: opts.code,
    workspaceName: opts.workspaceName,
    inputs: opts.inputs,
    ...(opts.mode ? { mode: opts.mode } : {}),
  }
  try {
    return await runOnce({
      kind: RUN_JS_WORKER_KIND,
      init,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      label: 'run_js',
      nestedCallLabel: 'workspace / bash',
      logBudget: { lines: RUN_JS_MAX_LOG_LINES, chars: RUN_JS_MAX_LOG_CHARS },
      // The CLOSED noun table: a script can reach these two and nothing else,
      // and only the one its tool supplied a handler for.
      nouns: {
        [RUN_JS_FS_NOUN]: opts.onFsCall as KernelNounHandler | undefined,
        [RUN_JS_SHELL_NOUN]: opts.onShellCall as KernelNounHandler | undefined,
      },
      unavailable: unavailableNounMessage,
      onLog: opts.onLog,
    })
  } catch (err) {
    if (err instanceof KernelRunFailure) {
      throw new RunJsFailure(
        err.message,
        err.logs,
        err.remoteStack,
        err.location,
        err.errorName,
        err.parseFailed,
      )
    }
    throw err
  }
}

/**
 * Contract: the `program` mode of the `runjs` kernel profile (F-21), SharedWorker
 * side. A caller hands over a script and a table of nouns it serves itself; the
 * script runs in a fresh run_js worker and can reach those nouns and nothing
 * else. The table is closed per run: a noun the caller did not list, or a
 * method a listed noun does not have, is refused `NotSupportedError` before the
 * caller's handler runs. Every other rule — startup deadlines, the execution
 * clock paused while a noun call is in flight, the log budget, drain, abort —
 * is the kernel's (`runOnce`).
 */

import { runOnce, KernelRunFailure, type KernelLogBudget, type KernelNounHandler } from '../workerKernel/IsolatedWorkerKernel'
import {
  programNounProblem,
  RUN_JS_WORKER_KIND,
  type RunJsLogLine,
  type RunJsProgramNouns,
  type RunJsScriptInit,
} from './runJsProtocol'
import { RUN_JS_MAX_LOG_CHARS, RUN_JS_MAX_LOG_LINES, RunJsFailure } from './RunJsBroker'

/** Serves one method of one noun for the script. `args` are the script's
 *  arguments as structured-cloned; the resolved value goes back the same way.
 *  A rejection's `name` and `message` reach the script. */
export type ProgramNounHandler = (method: string, args: unknown[]) => Promise<unknown>

export type ProgramNoun = {
  methods: readonly string[]
  handler: ProgramNounHandler
}

export type RunProgramOptions = {
  code: string
  nouns: Readonly<Record<string, ProgramNoun>>
  /** Data the script reads as `inputs` — structured-cloned, never parsed as source. */
  inputs?: Record<string, unknown>
  /** See `RunJsScriptInit.prelude`. */
  prelude?: string
  /** See `RunJsScriptInit.deterministic`. */
  deterministic?: boolean
  /** Cap on the script's own execution (prelude included); paused while a
   *  noun call is in flight. */
  timeoutMs: number
  logBudget?: KernelLogBudget
  signal?: AbortSignal
  onLog?: (line: RunJsLogLine) => void
  /** How the run names itself in its error messages. Default `program`. */
  label?: string
}

export type RunProgramResult = {
  /** The script's return value, parsed back from JSON; null for `undefined`. */
  value: unknown
  logs: RunJsLogLine[]
}

/** Run one `program`-mode script. Resolves with its return value and logs;
 *  rejects with a `RunJsFailure` (a throw, a timeout, an abort, a worker crash). */
export async function runProgram(opts: RunProgramOptions): Promise<RunProgramResult> {
  const label = opts.label ?? 'program'
  const programNouns: RunJsProgramNouns = Object.create(null)
  const table: Record<string, KernelNounHandler> = Object.create(null)
  for (const [noun, entry] of Object.entries(opts.nouns)) {
    const problem = programNounProblem(noun, entry.methods)
    if (problem) throw new TypeError(`${label}: ${problem}`)
    const methods = [...entry.methods]
    programNouns[noun] = methods
    table[noun] = (op, payload) => {
      if (!methods.includes(op)) {
        const error = new Error(`${noun}.${op} is not a method of ${noun} (it has: ${methods.join(', ')})`)
        error.name = 'NotSupportedError'
        return Promise.reject(error)
      }
      const args = Array.isArray(payload.args) ? payload.args : []
      return entry.handler(op, args)
    }
  }
  const init: RunJsScriptInit = {
    code: opts.code,
    mode: 'program',
    programNouns,
    ...(opts.inputs !== undefined ? { inputs: opts.inputs } : {}),
    ...(opts.prelude !== undefined ? { prelude: opts.prelude } : {}),
    ...(opts.deterministic ? { deterministic: true } : {}),
  }
  try {
    const run = await runOnce({
      kind: RUN_JS_WORKER_KIND,
      init,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      label,
      nestedCallLabel: Object.keys(programNouns).join(' / ') || undefined,
      logBudget: opts.logBudget ?? { lines: RUN_JS_MAX_LOG_LINES, chars: RUN_JS_MAX_LOG_CHARS },
      nouns: table,
      onLog: opts.onLog,
    })
    return { value: run.result === null ? null : JSON.parse(run.result), logs: run.logs }
  } catch (err) {
    if (err instanceof KernelRunFailure) {
      throw new RunJsFailure(err.message, err.logs, err.remoteStack, err.location, err.errorName, err.parseFailed)
    }
    throw err
  }
}

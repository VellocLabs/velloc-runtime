/**
 * Contract: `$.script.run` — a mod runs a script in the kernel's `program` mode
 * (F-21) with a noun table it serves itself (F-25). The mod's worker keeps the
 * functions; only noun and method names cross, and each call the script makes
 * comes back to that worker as a `mod.serve` of a run-scoped noun
 * (`scriptNounKey`). The mod executes no dynamic code itself: the script runs
 * in the run_js worker, whose frame allows eval and whose realm has nothing
 * but the granted nouns.
 *
 * Security: the run is attributed to the calling plugin — its nouns are served
 * by the calling seat only, and every `$` call a noun method makes is that
 * plugin's own, through the usual chain. The call's signal ends the run and
 * every served method still in flight.
 */

import { programNounProblem, type RunJsLogLine } from '../browser/runJs/runJsProtocol'
import { RunJsFailure } from '../browser/runJs/RunJsBroker'
import type { ProgramNoun, RunProgramOptions, RunProgramResult } from '../browser/runJs/runProgram'
import { scriptNounKey } from './modWire'

/** The execution clock when the call names none — the script's own time,
 *  paused while a noun call is in flight. */
export const SCRIPT_RUN_DEFAULT_TIMEOUT_MS = 60_000
/** The longest `timeoutMs` a call may ask for. */
export const SCRIPT_RUN_MAX_TIMEOUT_MS = 10 * 60_000

/** `e` of `script.run`, as hooks above see and may rewrite it. */
export type ModScriptRunInput = {
  code: string
  /** Noun name → method names; the functions stay in the calling worker. */
  nouns: Record<string, string[]>
  inputs?: Record<string, unknown>
  prelude?: string
  deterministic?: boolean
  timeoutMs?: number
}

export type ModScriptLogLine = RunJsLogLine

export type ModScriptRunError = { name: string; message: string; line?: number; column?: number }

/** What `$.script.run` resolves to. A script that throws, times out or is
 *  stopped is `{ ok: false }`; a call that cannot start (bad input, no
 *  execution worker) rejects instead. */
export type ModScriptRunResult =
  | { ok: true; value: unknown; logs: ModScriptLogLine[] }
  | { ok: false; error: ModScriptRunError; logs: ModScriptLogLine[] }

/** Who is running the script and where its nouns are served. */
export type ModScriptCaller = {
  plugin: string
  /** The calling module's seat; its worker holds the noun functions. */
  seat?: string
  /** The worker's id for this run's noun table. */
  token: string
  signal?: AbortSignal
}

export type ModScriptHost = {
  run(input: ModScriptRunInput, by: ModScriptCaller): Promise<ModScriptRunResult>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function refuse(message: string): never {
  throw new TypeError(`$.script.run: ${message}`)
}

/** `e` from the call's argument, checked; the worker's `token` is left out. */
export function scriptRunInputOf(arg: unknown): ModScriptRunInput {
  if (!isRecord(arg)) refuse('takes { code, nouns, inputs?, prelude?, deterministic?, timeoutMs? }')
  if (typeof arg.code !== 'string') refuse('code must be a string')
  if (!isRecord(arg.nouns)) refuse('nouns must be an object of noun tables')
  const nouns: Record<string, string[]> = {}
  for (const [noun, methods] of Object.entries(arg.nouns)) {
    if (!Array.isArray(methods)) refuse(`nouns.${noun} is not a table of methods`)
    const problem = programNounProblem(noun, methods)
    if (problem) refuse(problem)
    nouns[noun] = [...(methods as string[])]
  }
  if (arg.inputs !== undefined && !isRecord(arg.inputs)) refuse('inputs must be an object')
  if (arg.prelude !== undefined && typeof arg.prelude !== 'string') refuse('prelude must be a string')
  if (arg.deterministic !== undefined && typeof arg.deterministic !== 'boolean') refuse('deterministic must be a boolean')
  if (
    arg.timeoutMs !== undefined &&
    (typeof arg.timeoutMs !== 'number' || !Number.isFinite(arg.timeoutMs) || arg.timeoutMs <= 0)
  ) {
    refuse('timeoutMs must be a positive number')
  }
  return {
    code: arg.code,
    nouns,
    ...(arg.inputs !== undefined ? { inputs: arg.inputs as Record<string, unknown> } : {}),
    ...(arg.prelude !== undefined ? { prelude: arg.prelude as string } : {}),
    ...(arg.deterministic !== undefined ? { deterministic: arg.deterministic as boolean } : {}),
    ...(arg.timeoutMs !== undefined ? { timeoutMs: arg.timeoutMs as number } : {}),
  }
}

/** The worker's run token from the call's raw argument. */
export function scriptTokenOf(arg: unknown): string {
  const token = isRecord(arg) ? arg.token : undefined
  if (typeof token !== 'string' || token === '') refuse('the call carries no run token')
  return token
}

export function isScriptRunResult(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.logs)) return false
  if (value.ok === true) return 'value' in value
  return value.ok === false && isRecord(value.error) && typeof value.error.name === 'string'
}

export type ModScriptHostDeps = {
  runProgram: (opts: RunProgramOptions) => Promise<RunProgramResult>
  /** Serve one method of the run's noun in the calling worker. */
  serve: (by: ModScriptCaller, noun: string, method: string, args: unknown[]) => Promise<unknown>
}

export function createModScriptHost(deps: ModScriptHostDeps): ModScriptHost {
  return {
    async run(input, by) {
      const nouns: Record<string, ProgramNoun> = {}
      for (const [noun, methods] of Object.entries(input.nouns)) {
        nouns[noun] = {
          methods,
          handler: (method, args) => deps.serve(by, scriptNounKey(by.token, noun), method, args),
        }
      }
      try {
        const run = await deps.runProgram({
          code: input.code,
          nouns,
          ...(input.inputs !== undefined ? { inputs: input.inputs } : {}),
          ...(input.prelude !== undefined ? { prelude: input.prelude } : {}),
          ...(input.deterministic ? { deterministic: true } : {}),
          timeoutMs: Math.min(input.timeoutMs ?? SCRIPT_RUN_DEFAULT_TIMEOUT_MS, SCRIPT_RUN_MAX_TIMEOUT_MS),
          ...(by.signal ? { signal: by.signal } : {}),
          label: `$.script.run (${by.plugin})`,
        })
        return { ok: true, value: run.value, logs: run.logs }
      } catch (err) {
        if (!(err instanceof RunJsFailure)) throw err
        const name = by.signal?.aborted ? 'AbortError' : (err.scriptErrorName ?? 'Error')
        return {
          ok: false,
          error: {
            name,
            message: err.message,
            ...(err.location ? { line: err.location.line, column: err.location.column } : {}),
          },
          logs: err.logs,
        }
      }
    },
  }
}

/**
 * Contract: the `runjs` profile of the isolated-worker kernel (F-21); realms,
 * frames and deadlines are in `workerKernel/kernelProtocol.ts`. Holds the script
 * init (`RunJsScriptInit`) and the two nouns: `fs` (`edit` mode, SuperEdit's
 * `workspace` facade) and `shell` (`shell` mode, SuperShell's `bash()`). There is
 * no tool proxy; RunJsBroker's closed noun table grants only these two.
 * Imported by all three realms: keep it free of runtime imports. nexus_web-internal
 * shapes, so changes need no `NEXUS_INTERFACE_VERSION` bump.
 */

import type { KernelLogLine } from '../workerKernel/kernelProtocol'

/** One captured `console.*` line from the executed script. */
export type RunJsLogLine = KernelLogLine

/** The kernel `kind` of a run_js worker — what `KernelWindowHost` registers its
 *  spawner under and what `RunJsBroker` asks for. */
export const RUN_JS_WORKER_KIND = 'runjs'

/** The two nouns a run_js script's worker may call (`k.call.noun`). */
export const RUN_JS_FS_NOUN = 'fs'
export const RUN_JS_SHELL_NOUN = 'shell'

/** The script surfaces a runJs worker can build. They are disjoint on
 *  purpose: `edit` (SuperEdit) gets the workspace facade and no command
 *  execution; `shell` (SuperShell) gets `bash` and no workspace facade;
 *  `program` gets neither — only the nouns its caller names in
 *  `programNouns`, each served by that caller (F-21 `program` mode). */
export type RunJsMode = 'edit' | 'shell' | 'program'

/** Contract: the nouns of a `program`-mode run — noun name → method names.
 *  The worker builds one frozen object per noun, each method a call that
 *  round-trips to the caller's handler; the script receives the object as a
 *  parameter of that name. Names are identifiers that are not reserved
 *  (`RUN_JS_PROGRAM_RESERVED_NAMES`). */
export type RunJsProgramNouns = Record<string, readonly string[]>

/** Names a `program`-mode run binds itself, so no noun or prelude export may
 *  take them: `console` and `inputs` as in every mode, `Date` and `Math`
 *  for the deterministic shadows. */
export const RUN_JS_PROGRAM_RESERVED_NAMES: readonly string[] = Object.freeze([
  'console',
  'inputs',
  'Date',
  'Math',
])

/** The `sourceURL` the prelude is compiled under, so a frame inside it never
 *  reads as the script's own `<anonymous>` line. */
export const RUN_JS_PRELUDE_SOURCE_URL = 'velloc-program-prelude.js'

const PROGRAM_IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/** Whether `name` can be bound as a parameter of a `program`-mode script. */
export function isProgramIdentifier(name: string): boolean {
  return PROGRAM_IDENTIFIER.test(name)
}

/** Why `noun` with `methods` cannot be granted to a `program`-mode script, or
 *  null. Checked by the broker before a worker is spent and again in the
 *  worker. */
export function programNounProblem(noun: string, methods: readonly unknown[]): string | null {
  if (!isProgramIdentifier(noun)) return `noun "${noun}" is not an identifier`
  if (RUN_JS_PROGRAM_RESERVED_NAMES.includes(noun)) return `noun "${noun}" is a name the run binds itself`
  if (!Array.isArray(methods) || methods.length === 0) return `noun "${noun}" names no method`
  for (const method of methods) {
    if (typeof method !== 'string' || !isProgramIdentifier(method)) {
      return `noun "${noun}": method "${String(method)}" is not an identifier`
    }
  }
  return null
}

/**
 * The profile's `init` — what a run_js worker is told to run. It travels by
 * structured clone end-to-end (broker → window → worker postMessage).
 */
export type RunJsScriptInit = {
  code: string
  /** The project root's basename — the `name` of the script's `workspace`
   *  handle. */
  workspaceName?: string
  /** Caller-supplied DATA VALUES for the script, exposed as its `inputs`
   *  binding. Because the whole init is structured-cloned, the values are
   *  handed to the script as runtime values and are NEVER parsed as JavaScript
   *  source — file content full of backticks / quotes / backslashes / `${}`
   *  cannot break the script parse. Absent → the script's `inputs` is `{}`. */
  inputs?: Record<string, unknown>
  /** Which script surface the worker builds. Absent → `'edit'` (SuperEdit's
   *  workspace facade), so a SuperShell script that somehow arrives without it
   *  fails fast with `bash is not defined` rather than gaining a filesystem it
   *  was never meant to have. */
  mode?: RunJsMode
  /** `program` mode only: the caller's nouns (`RunJsProgramNouns`). */
  programNouns?: RunJsProgramNouns
  /** `program` mode only: JavaScript evaluated before the script with the
   *  nouns, `console`, `inputs`, `Date` and `Math` in scope. It returns an
   *  object; each own property whose name is an identifier becomes one more
   *  parameter of the script. */
  prelude?: string
  /** `program` mode only: `Date.now()`, `Math.random()`, `Date()` and
   *  `new Date()` with no argument throw in the prelude and the script — the
   *  shadows are parameters, so the names in scope are covered and
   *  `globalThis.Date` is not. */
  deterministic?: boolean
}

// ── the `fs` noun: workspace facade ops ──

/** Security: the `fs` noun's ops behind the `workspace` facade. `payload.path` is
 *  root-relative; the facade's name validation runs in the script's realm and is
 *  not the containment check: SuperEditTool.resolveFsPaths resolves against the
 *  root, rejects escapes, and gates through the hosted Read/Write permission
 *  pipeline. `payload.root` (optional, absolute) anchors a `getDirectory` tree.
 *  A failure carries a DOMException `error.name` the facade rethrows. */
export type RunJsFsOp =
  | 'stat'
  | 'readdir'
  | 'readFile'
  | 'writeFile'
  | 'mkdir'
  | 'remove'
  // Native rename/move (fs.rename, base::Move host-side). The ONE two-path
  // primitive: payload carries `newPath` (+ optional `newRoot`) alongside the
  // usual `path`/`root`, and the broker write-gates BOTH resolved paths. An
  // older host without fs.rename rejects it NotSupportedError, which
  // fileHelpers.move catches to fall back to its copy+delete path.
  | 'move'

// ── the `shell` noun: SuperShell ops ──

/** Contract: the `shell` noun's ops, served by SuperShellTool through the Bash
 *  tool's full permission pipeline; the worker executes nothing. A failure
 *  rethrows as an `Error` named `error.name`.
 *   - `run` `{ command, options }` → `{ stdout, stderr, exitCode }`, or
 *     `{ taskId }` when `options.background` is set.
 *   - `readLines` `{ taskId, offset, waitMs }` → complete lines past `offset`,
 *     the next offset, and whether the task ended; waits up to `waitMs`.
 *     `waitFor` matches the pattern worker-side on top of it.
 *   - `stop` `{ taskId }` → null. */
export type RunJsShellOp = 'run' | 'readLines' | 'stop'

/** The tool name, shared by the broker's recursion guard and the tool definition.
 *  PascalCase like the other first-party tools; no other spelling is accepted. */
export const SUPER_EDIT_TOOL_NAME = 'SuperEdit'

/** SuperShell's tool name — the `shell`-mode counterpart of SuperEdit. See
 *  SuperShellTool. */
export const SUPER_SHELL_TOOL_NAME = 'SuperShell'

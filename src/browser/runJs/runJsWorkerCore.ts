/**
 * run_js worker core, apart from `runJs.worker.ts` so it unit-tests with an
 * explicit `peer`. `edit` mode (SuperEdit) gets the `workspace`/`getDirectory`
 * facade, the file helpers and `console`; `shell` mode (SuperShell) gets `bash`
 * and `console`, no filesystem; neither has a tool proxy. Everything flows out
 * over `peer` via kernelWorkerClient: `k.log`, `k.call`, `k.done`, `k.error`.
 */

import {
  createKernelWorkerClient,
  type KernelPeer,
} from '../workerKernel/kernelWorkerClient'
import {
  RUN_JS_FS_NOUN,
  RUN_JS_SHELL_NOUN,
  type RunJsFsOp,
  type RunJsMode,
  type RunJsShellOp,
} from './runJsProtocol'
import { createFileHelpers } from './fileHelpers'
import { createShellHelpers } from './shellHelpers'
import {
  createGetDirectory,
  createWorkspaceFacade,
  domError,
} from './workspaceFacade'

/** Minimal duplex port shape — a real `MessagePort` satisfies it, and tests can
 *  pass one end of a `MessageChannel`. */
export type RunJsPeer = KernelPeer

// `new Function` / AsyncFunction constructor — the async variant so the script
// can use `await` and `return`.
const AsyncFunction = Object.getPrototypeOf(async function () {})
  .constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>

/** The injected script globals, in construction order. ONE list feeds both
 *  the real AsyncFunction and the line-offset probe below — the offset is
 *  only valid when the parameter list is identical. `inputs` is the
 *  caller-supplied DATA object (structured-cloned across the pipe, defaulted
 *  to `{}`): it reaches the script as a runtime VALUE through this parameter,
 *  so its strings are never part of the parsed source — content full of
 *  backticks / quotes / `${}` cannot produce a script syntax error. */
const SCRIPT_GLOBALS = [
  'console',
  'workspace',
  'getDirectory',
  'readTextFile',
  'writeTextFile',
  'replaceTextFile',
  'readFileBytes',
  'writeFileBytes',
  'move',
  'inputs',
] as const

/** The `shell`-mode (SuperShell) globals, in construction order. Disjoint from
 *  the edit surface above: a SuperShell script can run commands and nothing
 *  else — no `workspace` facade, no file helpers. */
const SHELL_SCRIPT_GLOBALS = ['console', 'bash', 'inputs'] as const

/** First `<anonymous>:LINE:COL` coordinates in a stack, or null. In V8 the
 *  first frame after the message is the throw site, and dynamic-Function code
 *  reports as `<anonymous>` — for an error thrown by an awaited facade call,
 *  the first such frame is the script's own await line, which is exactly the
 *  line the model needs. */
function parseAnonymousFrame(
  stack: string | undefined,
): { line: number; column: number } | null {
  const m = stack ? /<anonymous>:(\d+):(\d+)/.exec(stack) : null
  return m ? { line: Number(m[1]), column: Number(m[2]) } : null
}

/**
 * Derive the line offset the AsyncFunction wrapper prepends to the script
 * body — AT RUNTIME, not as a hard-coded V8 constant. A probe with the SAME
 * constructor and the SAME parameter list throws on its first body line;
 * whatever line the engine reports for it, minus one, is the offset. Returns
 * null when stacks are unusable here (then errors fall back to message-only).
 */
async function deriveWrapperLineOffset(
  globals: readonly string[],
): Promise<number | null> {
  try {
    const probe = new AsyncFunction(
      ...globals,
      'throw new Error("__runjs_offset_probe__")',
    )
    try {
      await probe()
    } catch (err) {
      const loc = parseAnonymousFrame((err as Error)?.stack)
      if (loc && loc.line >= 1) return loc.line - 1
    }
  } catch {
    /* fall through */
  }
  return null
}

/** Script-relative error location: the first dynamic-code frame, shifted back
 *  by the wrapper offset. Null when unparseable or out of range. */
function extractScriptLocation(
  err: unknown,
  wrapperOffset: number | null,
): { line: number; column: number } | null {
  if (wrapperOffset === null) return null
  const loc = parseAnonymousFrame((err as Error)?.stack)
  if (!loc) return null
  const line = loc.line - wrapperOffset
  return line >= 1 ? { line, column: loc.column } : null
}

/** Serialize the script's return value to a model-facing string, or null when
 *  it returned nothing meaningful. */
export function serializeResult(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/**
 * Run one script to completion, reporting everything over `peer`. Never throws —
 * a script error is reported as a `k.error` message.
 */
export function runScriptInWorker(
  code: string,
  peer: RunJsPeer,
  workspaceName?: string,
  inputs?: Record<string, unknown>,
  mode: RunJsMode = 'edit',
): void {
  // The kernel's worker side: the one `call` primitive every facade below is
  // sugar over, plus `started` / `log` / `done` / `error`.
  const kernel = createKernelWorkerClient(peer)

  const record = (level: string) => (...args: unknown[]): void => {
    const text = args
      .map(a => {
        if (typeof a === 'string') return a
        try {
          return JSON.stringify(a)
        } catch {
          return String(a)
        }
      })
      .join(' ')
    kernel.log(level, text)
  }
  const captured = Object.create(globalThis.console) as Console
  captured.log = record('log')
  captured.info = record('info')
  captured.warn = record('warn')
  captured.error = record('error')
  captured.debug = record('debug')

  // `workspace` — the FileSystemDirectoryHandle-shaped facade; every
  // primitive round-trips to the broker, which permission-gates and executes
  // it (see workspaceFacade.ts + SuperEditTool.handleScriptFsOp/commitOverlay).
  // A failure comes back as a DOMException NAME the facade rethrows as a
  // platform-shaped exception.
  const callFs = (
    op: RunJsFsOp,
    payload: Record<string, unknown>,
  ): Promise<unknown> =>
    kernel.call(RUN_JS_FS_NOUN, op, payload, error =>
      domError(
        error.name ?? 'Error',
        error.message ?? 'filesystem operation failed',
      ),
    )

  const drainAndReport = async (): Promise<void> => {
    // See `KernelWorkerClient.drain`: a call the script forgot to await may be
    // the first step of a helper chain, so this waits for the chains, not just
    // the calls in flight at return time.
    const atReturn = await kernel.drain()
    if (atReturn > 0) {
      kernel.log(
        'warn',
        `run_js: ${atReturn} nested call(s) (workspace / bash) were still in flight when the script returned (missing await?) — waited for them to complete.`,
      )
    }
  }
  const workspace = createWorkspaceFacade(workspaceName ?? 'workspace', callFs)
  const getDirectory = createGetDirectory(callFs)
  const {
    readTextFile,
    writeTextFile,
    replaceTextFile,
    readFileBytes,
    writeFileBytes,
    move,
  } = createFileHelpers(callFs)

  // `bash` — SuperShell's one primitive; every call round-trips to the broker,
  // which permission-gates and runs the command (see SuperShellTool). A
  // failure is rethrown as an `Error` carrying the broker's error name.
  const callShell = (
    op: RunJsShellOp,
    payload: Record<string, unknown>,
  ): Promise<unknown> =>
    kernel.call(RUN_JS_SHELL_NOUN, op, payload, error => {
      const err = new Error(error.message ?? 'command failed')
      err.name = error.name ?? 'Error'
      return err
    })
  const { bash } = createShellHelpers(callShell)

  void (async () => {
    // Derived BEFORE the script runs — cheap (one thrown probe), and the
    // offset is a property of the engine + parameter list, not of the script.
    const globals = mode === 'shell' ? SHELL_SCRIPT_GLOBALS : SCRIPT_GLOBALS
    const wrapperOffset = await deriveWrapperLineOffset(globals)
    // Startup is over; the script is about to run. The kernel arms the
    // execution clock HERE, so worker creation, module load and realm
    // hardening never eat into the caller's `timeoutSec`.
    kernel.started()
    // Built in its OWN try: a script that fails here never PARSED. A
    // SyntaxError thrown while the script RUNS (`JSON.parse` on bad data, a
    // `new RegExp` with an unbalanced group) carries the same name, and only
    // the parse failure is answered by moving text into `inputs` — so the
    // phase rides the error message as `parseFailed`, not the name.
    let fn: (...args: unknown[]) => Promise<unknown>
    try {
      fn = new AsyncFunction(...globals, code)
    } catch (err) {
      kernel.error({
        message: err instanceof Error ? err.message : String(err),
        ...(err instanceof Error && err.name ? { name: err.name } : {}),
        parseFailed: true,
        stack: err instanceof Error ? err.stack : undefined,
      })
      return
    }
    try {
      // Defaulted so `inputs.foo` on a run that supplied nothing reads as
      // `undefined` instead of throwing on an undefined base.
      const value =
        mode === 'shell'
          ? await fn(captured, bash, inputs ?? {})
          : await fn(
              captured,
              workspace,
              getDirectory,
              readTextFile,
              writeTextFile,
              replaceTextFile,
              readFileBytes,
              writeFileBytes,
              move,
              inputs ?? {},
            )
      await drainAndReport()
      kernel.done(serializeResult(value))
    } catch (err) {
      await drainAndReport()
      const location = extractScriptLocation(err, wrapperOffset)
      kernel.error({
        message: err instanceof Error ? err.message : String(err),
        // The script error's constructor name (`SyntaxError`, `TypeError`, …).
        // It cannot be recovered downstream: the broker rejects with a
        // `RunJsFailure`, whose own `name` is `RunJsFailure`. SuperEdit reads
        // it to classify the failure; see `parseFailed` above for why the name
        // alone does not say the script never parsed.
        ...(err instanceof Error && err.name ? { name: err.name } : {}),
        stack: err instanceof Error ? err.stack : undefined,
        // SCRIPT-relative coordinates of the failing frame — the wrapper's
        // line offset is already subtracted, so raw V8 stack numbers never
        // leak. The tool quotes the offending source line back to the model.
        ...(location ? { line: location.line, column: location.column } : {}),
      })
    } finally {
      // `done`/`error` is posted only once every nested call — including the
      // follow-up steps of an un-awaited helper chain — has landed
      // (`drainAndReport`). Anything still pending here was issued after that
      // (a script timer, say); it is rejected so a dangling `.then` chain
      // cannot keep issuing calls against a finished run.
      kernel.rejectPending(noun =>
        noun === RUN_JS_SHELL_NOUN
          ? new Error('run_js finished before this command resolved')
          : new Error('run_js finished before this filesystem call resolved'),
      )
    }
  })()
}

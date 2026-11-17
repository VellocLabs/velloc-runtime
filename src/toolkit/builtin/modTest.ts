// ModTest: runs a mod folder's own `*.test.*` files (F-25), for the model. The
// same runner answers `/plugins test <folder>` for the person.

import type { ToolContract, InputCheck } from '../toolContract'
import type { ToolCallContext } from '../toolCallContext'
import { declareTool } from '../toolContract'
import { fsForContext } from '../../utils/fs/runtimeFs'
import { resolveRuntimePath } from '../../utils/runtimePaths'
import {
  formatModTestReport,
  runModTests,
  type ModTestFs,
  type ModTestReport,
  type ModTestWorker,
} from '../../mods/testKit/modTestRunner'
import { modRoster, openDevModsAsk } from '../../mods/modSlotRegistry'
import type { DevModsAnswer } from '../../mods/devModsFolder'
import { ModValidateTool, allowedFolderAsks, modFolderReadGate, type ModValidateAsks } from './modValidate'

export const MOD_TEST_TOOL_NAME = 'ModTest'

export type ModTestInput = { folder: string }

type GateContext = Parameters<typeof modFolderReadGate>[0]

/** A fresh sandboxed mod worker, as a slot opens one. */
export async function openModTestWorker(): Promise<ModTestWorker> {
  const [{ openInstance, KERNEL_SPAWN_ACK_TIMEOUT_MS }, { MOD_WORKER_KIND }, { SANDBOX_READY_TIMEOUT_MS }] = await Promise.all([
    import('../../browser/workerKernel/IsolatedWorkerKernel'),
    import('../../mods/modTypes'),
    import('../../browser/workerKernel/SandboxedWorkerHost'),
  ])
  return openInstance({
    kind: MOD_WORKER_KIND,
    init: { plugin: 'test' },
    label: 'mod test',
    name: 'test',
    spawnAckTimeoutMs: SANDBOX_READY_TIMEOUT_MS + KERNEL_SPAWN_ACK_TIMEOUT_MS,
  })
}

/** Why a run did not start: the person did not allow it, or nobody could be asked. */
export type ModTestRefusal = { refused: 'declined' | 'cannotAsk'; folder: string }

export type RunFolderTestsOptions = {
  /** Which read asks the folder's reads may pass. */
  asks: ModValidateAsks
  openWorker?: () => Promise<ModTestWorker>
  signal?: AbortSignal
  /** The dev-folder question; `openDevModsAsk` unless a test replaces it. */
  ask?: (sessionId: string, folders: readonly string[], signal: AbortSignal | undefined, purpose: 'test') => Promise<DevModsAnswer>
}

/** Whether a person can be asked from here: the session's own loop, not a
 *  sub-agent or teammate, and a page draws the session (its roster is not
 *  empty), so the dev-folder question has somewhere to appear. */
function canAskFrom(context: GateContext): boolean {
  const sessionId = context.options.sessionId ?? ''
  return (
    context.agentId === undefined &&
    context.options.mods?.agentId === undefined &&
    context.options.teammateName === undefined &&
    sessionId !== '' &&
    !sessionId.startsWith('subagent-') &&
    !sessionId.startsWith('teammate-') &&
    modRoster(sessionId).length > 0
  )
}

/**
 * Security: running a folder's tests runs its code, so it follows the dev
 * folder's rule (F-25): unasked only in `bypassPermissions`; refused in
 * `dontAsk` or where nobody can be asked; asked in every other mode, with the
 * dev folder's question.
 */
async function allowRun(
  folder: string,
  context: GateContext,
  options: RunFolderTestsOptions,
): Promise<ModTestRefusal['refused'] | undefined> {
  const mode = context.readAppState?.().permissionRules?.mode
  if (mode === 'bypassPermissions') return undefined
  if (mode === 'dontAsk' || !canAskFrom(context)) return 'cannotAsk'
  const ask = options.ask ?? openDevModsAsk
  const answer = await ask(context.options.sessionId, [folder], options.signal, 'test')
  return answer === 'on' ? undefined : 'declined'
}

/**
 * Run the tests of `folder` (relative to the session's cwd), once the run is
 * allowed. Security: every read (each folder listed, each file compiled)
 * passes the session's read gate first; the tests run in a mod worker against
 * the kit's mock `$`.
 */
export async function runFolderTestsForSession(
  folder: string,
  context: GateContext,
  options: RunFolderTestsOptions,
): Promise<ModTestReport | ModTestRefusal> {
  const absolute = resolveRuntimePath(context.options.cwd, folder).replace(/\\/g, '/')
  const signal = options.signal ?? context.cancelSource?.signal
  const refused = await allowRun(absolute, context, { ...options, ...(signal ? { signal } : {}) })
  if (refused) return { refused, folder: absolute }
  signal?.throwIfAborted()
  const openWorker = options.openWorker ?? openModTestWorker
  const base = fsForContext(context as ToolCallContext)
  const gate = modFolderReadGate(context, options.asks)
  const fs: ModTestFs = {
    readFile: async (path, options) => {
      await gate(path)
      return base.readFile(path, options) as Promise<string>
    },
    readdir: async path => {
      await gate(path)
      return base.readdir(path)
    },
  }
  return runModTests({ folder: absolute, fs, openWorker, ...(signal ? { signal } : {}) })
}

/** A refused run as the model reads it. */
export const MOD_TEST_REFUSED_TEXT: Record<ModTestRefusal['refused'], string> = {
  declined: 'The tests did not run: the person did not allow running this folder\'s code.',
  cannotAsk: 'The tests did not run: running a folder\'s code needs the person\'s permission, and nobody can be asked here (the Don\'t ask mode, or no page shows this session).',
}

const DESCRIPTION = [
  "Run a mod's own tests: every *.test.ts / *.test.js file under the plugin folder (dot folders and node_modules skipped).",
  '',
  `A test file imports test, describe, expect, mock and loadPlugin from the API module's /testing path. loadPlugin(register, { store, state, env, messages, now }) gives a plugin whose $ is a mock: fire(event, e) runs its hooks, on(event, hook) adds the hook below it, calls(which) lists the $ calls it made, stub(which, answer) answers one, clock.advance(ms) moves its timers, mount('desktop', component, props) draws a ui.render component and lets the test press, select, input and find in it.`,
  '',
  'Each file runs in a sandboxed mod worker of its own; nothing a test does reaches the session, the network or the disk. A case may take 10 s, a file 60 s.',
  '',
  'Running the tests runs the folder\'s code, so the person is asked first, as for loading a dev mods folder; in the Bypass permissions mode they run unasked, and where nobody can be asked they do not run.',
  '',
  'Reports each case as passed or failed, with the failure and its source file and line, then the totals.',
].join('\n')

export const ModTestTool: ToolContract<ModTestInput, string> = declareTool({
  name: MOD_TEST_TOOL_NAME,
  discoveryHint: "run a mod or plugin folder's *.test.ts / *.test.js files",
  argsSchema: {
    type: 'object',
    properties: {
      folder: {
        type: 'string',
        description: 'The plugin folder: the one holding the plugin manifest and hooks/. Absolute, or relative to the working directory.',
      },
    },
    required: ['folder'],
  },
  description: async () => DESCRIPTION,
  parallelSafe: () => true,
  readsOnly: () => true,
  async checkInput(input: ModTestInput): Promise<InputCheck> {
    if (typeof input.folder !== 'string' || input.folder.trim() === '') {
      return { result: false, message: 'folder is required and must be a non-empty path.', errorCode: 1 }
    }
    return { result: true }
  },
  // The folder's Read permission, as for a validation.
  selfVerdict: (input: ModTestInput, context: ToolCallContext) => ModValidateTool.selfVerdict!(input, context),
  async call(input: ModTestInput, context: ToolCallContext) {
    const asks = await allowedFolderAsks(resolveRuntimePath(context.options.cwd, input.folder), context)
    const result = await runFolderTestsForSession(input.folder, context, { asks })
    if ('refused' in result) return { data: MOD_TEST_REFUSED_TEXT[result.refused], isError: true }
    return { data: formatModTestReport(result) }
  },
})

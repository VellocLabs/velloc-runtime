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
import { ModValidateTool, modFolderReadGate } from './modValidate'

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

/**
 * Run the tests of `folder` (relative to the session's cwd). Security: every
 * read (each folder listed, each file compiled) passes the session's read
 * gate first; the tests run in a mod worker against the kit's mock `$`.
 */
export function runFolderTestsForSession(
  folder: string,
  context: GateContext,
  askAllowed: boolean,
  openWorker: () => Promise<ModTestWorker> = openModTestWorker,
  signal: AbortSignal | undefined = context.cancelSource?.signal,
): Promise<ModTestReport> {
  const absolute = resolveRuntimePath(context.options.cwd, folder).replace(/\\/g, '/')
  const base = fsForContext(context as ToolCallContext)
  const gate = modFolderReadGate(context, askAllowed)
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

const DESCRIPTION = [
  "Run a mod's own tests: every *.test.ts / *.test.js file under the plugin folder (dot folders and node_modules skipped).",
  '',
  `A test file imports test, describe, expect, mock and loadPlugin from the API module's /testing path. loadPlugin(register, { store, state, env, messages, now }) gives a plugin whose $ is a mock: fire(event, e) runs its hooks, on(event, hook) adds the hook below it, calls(which) lists the $ calls it made, stub(which, answer) answers one, clock.advance(ms) moves its timers, mount('desktop', component, props) draws a ui.render component and lets the test press, select, input and find in it.`,
  '',
  'Each file runs in a sandboxed mod worker of its own; nothing a test does reaches the session, the network or the disk. A case may take 10 s, a file 60 s.',
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
    const report = await runFolderTestsForSession(input.folder, context, false)
    return { data: formatModTestReport(report) }
  },
})

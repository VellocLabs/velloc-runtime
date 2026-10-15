/**
 * A tool's nested steps are raised as `tool.call` (F-25): a SuperShell `bash()` step or an `exec` command goes
 * through `runNestedTool`, so a mod guarding `{ tool: 'Bash' }` sees it like the model's own Bash call.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkingState, ModelReplyRow } from '../runtime/RuntimeTypes'
import { declareTool } from '../toolkit/toolContract'
import { type ToolCallContext } from '../toolkit/toolCallContext'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import { runNestedTool } from '../toolkit/builtin/exec'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

/** A mod runtime over real module text. `registerBody` is `register`'s body. */
async function mods(registerBody: string) {
  const reports: string[] = []
  const modules: ModModuleRef[] = [{ plugin: 'guard', path: 'guard/hooks/register.js' }]
  const runtime = new ModRuntime({
    modules,
    readModule: async () => `export function register(on) {\n${registerBody}\n}`,
    openWorker: async (): Promise<ModWorkerHandle> => {
      const channel = new MessageChannel()
      open.push(channel.port1, channel.port2)
      installModWorkerHost(channel.port2)
      let settle!: (closed: { reason: 'closed' | 'crashed' }) => void
      const closed = new Promise<{ reason: 'closed' | 'crashed' }>(resolve => {
        settle = resolve
      })
      return { port: channel.port1, closed, close: () => settle({ reason: 'closed' }) }
    },
    session: { id: () => 'session-1', cwd: () => '/work/project' },
    report: line => reports.push(line),
  })
  runtimes.push(runtime)
  await runtime.ready
  return runtime
}

/** A context with one tool, `Bash`, recording what it ran. */
function world(runtime: ModRuntime | undefined) {
  let appState: WorkingState = createEmptyAppState()
  const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
    appState = updater(appState)
  }
  const ran: Record<string, unknown>[] = []
  const tool = declareTool({
    name: 'Bash',
    argsSchema: { type: 'object' as const, properties: {} },
    description: async () => 'Runs a command',
    readsOnly: () => false,
    call: async (args: Record<string, unknown>) => {
      ran.push(args)
      return { data: { output: `ran ${String(args.command)}`, exit_code: 0 } }
    },
  })
  const context: ToolCallContext = createNoopToolUseContext({
    tools: [tool],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState,
    setAppState,
    sessionId: 'sess-nested',
  })
  context.writeAppState = setAppState
  context.readAppState = () => appState
  if (runtime) context.options.mods = runtime
  return { context, ran }
}

const PARENT = {
  type: 'assistant',
  uuid: 'assistant-outer',
  message: { role: 'assistant', content: [] },
} as unknown as ModelReplyRow

const allow = async () => ({ behavior: 'allow' as const })

function step(context: ToolCallContext, command: string) {
  return runNestedTool('Bash', { command }, context, allow, PARENT)
}

describe('a nested step raised as tool.call', () => {
  it('a hook denying the Bash call refuses the step: the tool never runs, the reason is what the caller reads', async () => {
    const runtime = await mods(
      `on('tool.call', { tool: 'Bash' }, ($, e) => ({ deny: 'NO_BASH ' + e.command }))`,
    )
    const { context, ran } = world(runtime)
    const outcome = await step(context, 'rm -rf build')
    expect(outcome).toEqual({ ok: false, data: 'NO_BASH rm -rf build' })
    expect(ran).toEqual([])
  })

  it('e is the step\'s arguments with the tool and an id of its own; a rewrite is what runs', async () => {
    const runtime = await mods(`
      on('tool.call', { tool: 'Bash' }, ($, e, next) =>
        next({ ...e, command: e.command + ' --dry-run', seen: [e.tool, typeof e.tool_use_id] }))
    `)
    const { context, ran } = world(runtime)
    const outcome = await step(context, 'make')
    expect(ran).toHaveLength(1)
    expect(ran[0]).toMatchObject({ command: 'make --dry-run', seen: ['Bash', 'string'] })
    expect(outcome.ok).toBe(true)
    expect(JSON.parse(outcome.data)).toEqual({ output: 'ran make --dry-run', exit_code: 0 })
    expect(outcome.answeredByHook).toBeUndefined()
  })

  it('a hook answering with its own result answers the step, and says so', async () => {
    const runtime = await mods(`on('tool.call', { tool: 'Bash' }, () => ({ result: 'CACHED' }))`)
    const { context, ran } = world(runtime)
    const outcome = await step(context, 'npm test')
    expect(ran).toEqual([])
    expect(outcome).toMatchObject({ ok: true, data: 'CACHED', answeredByHook: true })
  })

  it('core relayed unchanged is the run itself; a hook\'s context is appended to what the caller reads', async () => {
    const runtime = await mods(`
      on('tool.call', { tool: 'Bash' }, async ($, e, next) => ({ ...(await next(e)), context: ['NOTE_FROM_MOD'] }))
    `)
    const { context, ran } = world(runtime)
    const outcome = await step(context, 'ls')
    expect(ran).toHaveLength(1)
    expect(outcome.ok).toBe(true)
    expect(outcome.answeredByHook).toBeUndefined()
    expect(outcome.data.endsWith('\nNOTE_FROM_MOD')).toBe(true)
  })

  it('a hook on another tool leaves the step alone; so does a session without mods', async () => {
    const runtime = await mods(`on('tool.call', { tool: 'Write' }, () => ({ deny: 'NO_WRITE' }))`)
    for (const r of [runtime, undefined]) {
      const { context, ran } = world(r)
      const outcome = await step(context, 'pwd')
      expect(outcome.ok).toBe(true)
      expect(ran).toHaveLength(1)
    }
  })
})

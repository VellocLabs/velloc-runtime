/**
 * `tool.call` end to end below the browser (real `runToolUse`, `ModRuntime`, module text): `next(e)` runs the hooks
 * beneath, then core; `{ deny: reason }` refuses, `{ result }` answers; a hook returning while its `next` is
 * pending aborts what runs beneath.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkingState, ModelReplyRow, Message } from '../runtime/RuntimeTypes'
import type { QueryRuntimeDeps } from '../runtime/interfaces/QueryRuntimeDeps'
import { declareTool, type ToolContract } from '../toolkit/toolContract'
import { type ToolCallContext } from '../toolkit/toolCallContext'
import { executeToolCall, type DeferredMessageUpdate } from '../toolkit/run/executeToolCall'
import { raisesToolCall } from '../toolkit/run/toolCallThroughMods'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import { attachInProcessHook } from '../lifecycleHooks/sessionScopedHooks'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import {
  isToolCallResult,
  toolCallArgsOf,
  toolCallContextOf,
  toolCallEventOf,
} from '../mods/toolCallEvent'
import { AskPersonTool } from '../toolkit/builtin/askUser'

let uuid = 0
const RUNTIME_DEPS = { uuid: () => `uuid-${++uuid}` } as QueryRuntimeDeps

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

/** A mod runtime over real module text. `source` is the body of `register`. */
function mods(registerBody: string, options: { budgetMs?: number } = {}) {
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
    ...(options.budgetMs !== undefined ? { budgetMs: options.budgetMs } : {}),
  })
  runtimes.push(runtime)
  return { runtime, reports }
}

type Calls = { args: Record<string, unknown>; aborted: () => boolean }[]

/** A context with one tool, `Shell`, that records what it ran with. */
function world(
  runtime: ModRuntime | undefined,
  toolOptions: {
    call?: (args: Record<string, unknown>, context: ToolCallContext) => Promise<unknown>
    readsOnly?: boolean
    extraTools?: ToolContract[]
    /** The tool's own permission check asks the user. */
    asks?: boolean
  } = {},
) {
  let appState: WorkingState = createEmptyAppState()
  const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
    appState = updater(appState)
  }
  const calls: Calls = []
  const tool = declareTool({
    name: 'Shell',
    argsSchema: { type: 'object' as const, properties: {} },
    description: async () => 'Runs a command',
    readsOnly: () => toolOptions.readsOnly === true,
    ...(toolOptions.asks
      ? { selfVerdict: async () => ({ behavior: 'ask' as const, message: 'Run it?' }) }
      : {}),
    call: async (args: Record<string, unknown>, context: ToolCallContext) => {
      calls.push({ args, aborted: () => context.cancelSource.signal.aborted })
      if (toolOptions.call) return (await toolOptions.call(args, context)) as never
      return { data: { ok: true, ran: args.command } }
    },
  })
  const context = createNoopToolUseContext({
    tools: [tool, ...(toolOptions.extraTools ?? [])],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState,
    setAppState: setAppState,
    sessionId: 'sess-mods',
  })
  context.writeAppState = setAppState
  context.readAppState = () => appState
  if (runtime) context.options.mods = runtime
  return { context, calls, writeAppState: setAppState }
}

function assistant(toolName: string, toolCallId: string): ModelReplyRow {
  return {
    type: 'assistant',
    uuid: `assistant-${toolCallId}`,
    message: {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId, toolName, args: {} }],
    },
  }
}

async function run(
  context: ToolCallContext,
  args: Record<string, unknown>,
  toolName = 'Shell',
  toolCallId = 'tc-1',
): Promise<DeferredMessageUpdate[]> {
  const updates: DeferredMessageUpdate[] = []
  for await (const update of executeToolCall(
    { type: 'tool-call', toolCallId, toolName, args },
    assistant(toolName, toolCallId),
    async () => ({ behavior: 'allow' }),
    context,
    RUNTIME_DEPS,
  )) {
    updates.push(update)
  }
  return updates
}

/** The call's tool_result, as the transcript and the model have it. */
function resultOf(update: DeferredMessageUpdate | undefined) {
  const message = update?.message as
    | (Message & {
        toolUseResult?: string
        toolCallDetail?: { args?: unknown; result?: unknown; isError?: boolean }
        message: { content: Array<{ type: string; result?: unknown; isError?: boolean }> }
      })
    | undefined
  const block = message?.message.content[0]
  return {
    text: message?.toolUseResult,
    modelReads: block?.result,
    isError: block?.isError === true,
    stored: message?.toolCallDetail?.result,
    args: message?.toolCallDetail?.args,
  }
}

describe('tool.call — the shapes', () => {
  it('builds e from the arguments, with the reserved keys over them', () => {
    expect(toolCallEventOf('Bash', 'tu-1', { command: 'ls', tool: 'shadowed' })).toEqual({
      command: 'ls',
      tool: 'Bash',
      tool_use_id: 'tu-1',
    })
    expect(toolCallEventOf('Bash', 'tu-1', {}, 'agent-7')).toEqual({
      tool: 'Bash',
      tool_use_id: 'tu-1',
      agentId: 'agent-7',
    })
    expect(toolCallEventOf('Bash', 'tu-1', {}, '')).not.toHaveProperty('agentId')
  })

  it('reads the arguments back out of what arrived at core', () => {
    const original = { command: 'ls' }
    expect(
      toolCallArgsOf(
        { command: 'ls -la', timeout: 5, tool: 'Other', tool_use_id: 'x', agentId: 'y', consent: 'z' },
        original,
      ),
    ).toEqual({ command: 'ls -la', timeout: 5 })
    // An argument of the tool's own that a reserved key shadowed is put back.
    expect(toolCallArgsOf({ tool: 'Bash', q: 1 }, { tool: 'hammer', q: 0 })).toEqual({
      tool: 'hammer',
      q: 1,
    })
    // A rewrite core cannot read runs the call as it was.
    expect(toolCallArgsOf('nope', original)).toBe(original)
    expect(toolCallArgsOf(null, original)).toBe(original)
    expect(toolCallArgsOf([1], original)).toBe(original)
  })

  it.each([
    [{ deny: 'no' }, true],
    [{ deny: '' }, true],
    [{ result: 1 }, true],
    [{ result: undefined }, true],
    [{ ref: 3, result: undefined, isError: true }, true],
    [{ ref: 3 }, true],
    [{ deny: 5 }, false],
    [{}, false],
    [{ text: 'only text' }, false],
    ['a string', false],
    [null, false],
    [undefined, false],
    [[{ result: 1 }], false],
  ])('%j is an answer: %s', (value, expected) => {
    expect(isToolCallResult(value)).toBe(expected)
  })

  it('keeps only the non-empty strings of context', () => {
    expect(toolCallContextOf({ result: 1, context: ['a', '', 3, 'b'] })).toEqual(['a', 'b'])
    expect(toolCallContextOf({ result: 1 })).toEqual([])
    expect(toolCallContextOf({ result: 1, context: 'a' })).toEqual([])
  })
})

describe('tool.call — a session without a hook on it is untouched', () => {
  it('runs the tool directly when no runtime is set', async () => {
    const { context, calls } = world(undefined)
    const updates = await run(context, { command: 'ls' })
    expect(updates).toHaveLength(1)
    expect(resultOf(updates[0]).stored).toEqual({ ok: true, ran: 'ls' })
    expect(calls).toHaveLength(1)
  })

  it('runs the tool directly when the mods hook other events only', async () => {
    const { runtime } = mods(`on('prompt.submit', ($, e, next) => next(e))`)
    await runtime.ready
    expect(runtime.hasToolCallHooks()).toBe(false)
    const { context, calls } = world(runtime)
    const updates = await run(context, { command: 'ls' })
    expect(resultOf(updates[0]).stored).toEqual({ ok: true, ran: 'ls' })
    expect(calls).toHaveLength(1)
  })
})

describe('tool.call — a hook around the call', () => {
  it('passes the call on: core runs and its messages are used verbatim', async () => {
    const { runtime, reports } = mods(`on('tool.call', ($, e, next) => next(e))`)
    const direct = await run(world(undefined).context, { command: 'ls' })
    const { context, calls } = world(runtime)
    const updates = await run(context, { command: 'ls' })
    expect(calls.map(call => call.args)).toEqual([{ command: 'ls' }])
    expect(updates).toHaveLength(1)
    expect(resultOf(updates[0])).toEqual(resultOf(direct[0]))
    expect(reports).toEqual([])
  })

  it('shows the hook the call: the tool, its id, the arguments beside them', async () => {
    const { runtime } = mods(`on('tool.call', ($, e) => ({ result: e }))`)
    const { context, calls } = world(runtime)
    const updates = await run(context, { command: 'ls', timeout: 3 })
    expect(resultOf(updates[0]).stored).toEqual({
      command: 'ls',
      timeout: 3,
      tool: 'Shell',
      tool_use_id: 'tc-1',
    })
    expect(calls).toHaveLength(0)
  })

  it('carries agentId in a sub-agent loop', async () => {
    const { runtime } = mods(`on('tool.call', ($, e) => ({ result: e.agentId }))`)
    const { context } = world(runtime)
    context.agentId = 'agent-7'
    expect(resultOf((await run(context, {}))[0]).stored).toBe('agent-7')
  })

  it('rewrites the arguments; the reserved keys are pinned', async () => {
    const { runtime } = mods(`
      on('tool.call', ($, e, next) =>
        next({ ...e, command: e.command.trim(), tool: 'Other', tool_use_id: 'forged', agentId: 'forged' }))
    `)
    const { context, calls } = world(runtime)
    const updates = await run(context, { command: '  ls  ' })
    expect(calls.map(call => call.args)).toEqual([{ command: 'ls' }])
    const result = resultOf(updates[0])
    expect(result.stored).toEqual({ ok: true, ran: 'ls' })
    // The transcript records what ran, under the call's own id.
    expect(result.args).toEqual({ command: 'ls' })
    expect((updates[0]!.message as { toolCallDetail?: { toolCallId?: string; toolName?: string } }).toolCallDetail)
      .toMatchObject({ toolCallId: 'tc-1', toolName: 'Shell' })
  })

  it('denies: the model reads the text as an error result and the tool never runs', async () => {
    const { runtime } = mods(`
      on('tool.call', { tool: 'Shell' }, ($, e, next) =>
        /rm -rf/.test(e.command) ? { deny: 'guard: not here.' } : next(e))
    `)
    const { context, calls } = world(runtime)
    const denied = await run(context, { command: 'rm -rf /' })
    expect(denied).toHaveLength(1)
    expect(resultOf(denied[0])).toMatchObject({
      text: 'guard: not here.',
      modelReads: 'guard: not here.',
      isError: true,
    })
    expect(calls).toHaveLength(0)
    // …and the same hook lets another call through.
    const allowed = await run(context, { command: 'ls' }, 'Shell', 'tc-2')
    expect(resultOf(allowed[0]).stored).toEqual({ ok: true, ran: 'ls' })
    expect(calls).toHaveLength(1)
  })

  it('answers for itself: the result is recorded as the tool\'s, and the tool never runs', async () => {
    const { runtime } = mods(`on('tool.call', () => ({ result: { ok: true, cached: 'yes' } }))`)
    const { context, calls } = world(runtime)
    const updates = await run(context, { command: 'ls' })
    expect(updates).toHaveLength(1)
    const result = resultOf(updates[0])
    expect(result.stored).toEqual({ ok: true, cached: 'yes' })
    expect(result.isError).toBe(false)
    expect(JSON.parse(String(result.text))).toEqual({ ok: true, cached: 'yes' })
    expect(calls).toHaveLength(0)
  })

  it('a matcher on another tool does not see the call', async () => {
    const { runtime } = mods(`on('tool.call', { tool: 'Edit' }, () => ({ deny: 'never' }))`)
    const { context, calls } = world(runtime)
    const updates = await run(context, { command: 'ls' })
    expect(resultOf(updates[0]).isError).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('gives next(e) core\'s result: ref, result, text, and isReadOnly when the tool says so', async () => {
    const { runtime } = mods(`
      on('tool.call', async ($, e, next) => {
        const ran = await next(e)
        return { result: { saw: ran } }
      })
    `)
    const { context } = world(runtime, { readsOnly: true })
    const updates = await run(context, { command: 'ls' })
    const saw = (resultOf(updates[0]).stored as { saw: Record<string, unknown> }).saw
    expect(saw.ref).toBe(1)
    expect(saw.result).toEqual({ ok: true, ran: 'ls' })
    expect(JSON.parse(String(saw.text))).toEqual({ ok: true, ran: 'ls' })
    expect(saw.isReadOnly).toBe(true)
    expect(saw).not.toHaveProperty('isError')
  })

  it('gives next(e) isError when the tool threw, with the text the model read', async () => {
    const { runtime } = mods(`
      on('tool.call', async ($, e, next) => {
        const ran = await next(e)
        return { result: { isError: ran.isError, text: ran.text, hasReadOnly: 'isReadOnly' in ran } }
      })
    `)
    const { context } = world(runtime, {
      call: async () => {
        throw new Error('disk on fire')
      },
    })
    const updates = await run(context, { command: 'ls' })
    expect(resultOf(updates[0]).stored).toEqual({
      isError: true,
      text: 'Tool execution error: disk on fire',
      hasReadOnly: false,
    })
  })

  it('replaces the result after the tool ran; what else the run produced stands', async () => {
    const { runtime } = mods(`
      on('tool.call', async ($, e, next) => {
        const ran = await next(e)
        return { result: { ...ran.result, secret: '[redacted]' } }
      })
    `)
    const modifier = (context: ToolCallContext) => context
    const { context, calls } = world(runtime, {
      call: async () => ({
        data: { ok: true, secret: 'hunter2' },
        contextPatch: modifier,
        extraRows: [{ type: 'user', uuid: 'added', message: { role: 'user', content: 'added by the tool' } }],
      }),
    })
    const updates = await run(context, { command: 'cat .env' })
    expect(calls).toHaveLength(1)
    expect(updates).toHaveLength(2)
    expect(resultOf(updates[0]).stored).toEqual({ ok: true, secret: '[redacted]' })
    expect(JSON.stringify(updates[0]!.message)).not.toContain('hunter2')
    // The run happened: its context modifier and the message it added remain.
    expect(updates[0]!.contextPatch?.modifyContext).toBe(modifier)
    expect((updates[1]!.message as { uuid?: string }).uuid).toBe('added')
  })

  it('returns core\'s own object with context: the run verbatim, then one message only the model reads', async () => {
    const { runtime } = mods(`
      on('tool.call', async ($, e, next) => {
        const ran = await next(e)
        return { ...ran, context: ['lint: 2 warnings', '', 'run the formatter'] }
      })
    `)
    const direct = await run(world(undefined).context, { command: 'ls' })
    const { context } = world(runtime)
    const updates = await run(context, { command: 'ls' })
    expect(updates).toHaveLength(2)
    expect(resultOf(updates[0])).toEqual(resultOf(direct[0]))
    const note = updates[1]!.message as unknown as {
      isMeta?: boolean
      message: { content: unknown }
    }
    expect(note.isMeta).toBe(true)
    expect(JSON.stringify(note.message.content)).toContain('lint: 2 warnings\\n\\nrun the formatter')
  })

  it('a deny carries no context', async () => {
    const { runtime } = mods(`on('tool.call', () => ({ deny: 'no', context: ['ignored'] }))`)
    const updates = await run(world(runtime).context, { command: 'ls' })
    expect(updates).toHaveLength(1)
  })

  it('runs the tool again when a hook calls next again; the last run is the one used', async () => {
    const { runtime } = mods(`
      on('tool.call', async ($, e, next) => {
        const first = await next(e)
        return first.result.attempt === 1 ? next({ ...e, command: 'retry' }) : first
      })
    `)
    let attempt = 0
    const { context, calls } = world(runtime, {
      call: async args => ({ data: { attempt: ++attempt, ran: args.command } }),
    })
    const updates = await run(context, { command: 'first' })
    expect(calls.map(call => call.args.command)).toEqual(['first', 'retry'])
    expect(updates).toHaveLength(1)
    expect(resultOf(updates[0]).stored).toEqual({ attempt: 2, ran: 'retry' })
    expect(resultOf(updates[0]).args).toEqual({ command: 'retry' })
  })

  it('still runs the classic PreToolUse hooks, beneath the mod\'s', async () => {
    const { runtime } = mods(`
      on('tool.call', async ($, e, next) => {
        const ran = await next(e)
        return { result: { isError: ran.isError, text: ran.text } }
      })
    `)
    const { context, calls, writeAppState: setAppState } = world(runtime)
    attachInProcessHook(setAppState, 'sess-mods', 'PreToolUse', 'Shell', () => false, 'classic says no')
    const updates = await run(context, { command: 'ls' })
    expect(calls).toHaveLength(0)
    expect(resultOf(updates[0]).stored).toEqual({
      isError: true,
      text: 'Hook blocked: classic says no',
    })
  })

  it('classic.PreToolUse rides tool.call: beneath the mod\'s tool.call hook, a deny stops the tool, updatedInput is reported, not applied', async () => {
    const { runtime, reports } = mods(`
      on('tool.call', async ($, e, next) => {
        await $.ui.log('tool.call above')
        const ran = await next(e)
        await $.ui.log('tool.call below: ' + ran.isError)
        return ran
      })
      on('classic.PreToolUse', { tool: 'Shell' }, async ($, e, next) => {
        await $.ui.log('classic saw ' + JSON.stringify(e))
        const ran = await next(e)
        await $.ui.log('settings said ' + JSON.stringify(ran))
        if (e.command === 'rm -rf /') return { deny: 'not on my watch' }
        if (ran.deny) return { ...ran, deny: undefined }
        return { ...ran, updatedInput: { command: e.command + ' --safe' } }
      })
    `)
    const { context, calls, writeAppState: setAppState } = world(runtime)
    // A function hook sees no input: it blocks when told to.
    let settingsBlock = false
    attachInProcessHook(setAppState, 'sess-mods', 'PreToolUse', 'Shell', () => !settingsBlock, 'classic says no')
    const denied = await run(context, { command: 'rm -rf /' })
    expect(calls).toHaveLength(0)
    // The mod's tool.call hook handed core's result back: the engine's own
    // error tool_result, verbatim.
    expect(resultOf(denied[0]).stored).toBe('Hook blocked: not on my watch')
    expect(reports).toEqual([
      'guard: tool.call above',
      'guard: classic saw {"command":"rm -rf /","tool":"Shell","tool_use_id":"tc-1"}',
      'guard: settings said {"ref":1}',
      'guard: tool.call below: true',
    ])
    reports.length = 0
    // The permission flow checked `ls`; a rewrite here would run unchecked,
    // so the tool runs with what was checked and the answer is reported.
    const rewritten = await run(context, { command: 'ls' }, 'Shell', 'tc-2')
    expect(calls.map(c => c.args)).toEqual([{ command: 'ls' }])
    expect(resultOf(rewritten[0]).stored).toEqual({ ok: true, ran: 'ls' })
    expect(reports.some(l => l.includes('answered { updatedInput }'))).toBe(true)
    // The settings hook's block reaches the mod as `deny`, and the mod lifts it.
    settingsBlock = true
    reports.length = 0
    const lifted = await run(context, { command: 'ls -la' }, 'Shell', 'tc-3')
    expect(reports.filter(l => l.includes('settings said'))).toEqual(['guard: settings said {"deny":"classic says no","ref":1}'])
    // Lifted as it came: the branch that lifts a block rewrites nothing.
    expect(resultOf(lifted[0]).stored).toEqual({ ok: true, ran: 'ls -la' })
  })

  it('passes tool progress on while the hook is still waiting', async () => {
    const { runtime } = mods(`on('tool.call', ($, e, next) => next(e))`)
    const { context } = world(runtime)
    const tool = context.options.tools[0]!
    const original = tool.call
    tool.call = (async (args, toolContext, canUse, message, onProgress) => {
      onProgress?.({ toolUseID: 'p-1', data: { step: 1 } } as never)
      await sleep(120)
      return original(args, toolContext, canUse, message, onProgress)
    }) as typeof tool.call
    const updates = await run(context, { command: 'ls' })
    expect(updates).toHaveLength(2)
    expect((updates[0]!.message as { type?: string }).type).toBe('stream_event')
    expect(resultOf(updates[1]).stored).toEqual({ ok: true, ran: 'ls' })
  })

  it('waits on the pending chain without a polling timer: progress wakes it', async () => {
    const { runtime } = mods(`on('tool.call', ($, e, next) => next(e))`)
    const { context } = world(runtime)
    const tool = context.options.tools[0]!
    const original = tool.call
    let progressAt = 0
    tool.call = (async (args, toolContext, canUse, message, onProgress) => {
      await sleep(150)
      progressAt = Date.now()
      onProgress?.({ toolUseID: 'p-1', data: { step: 1 } } as never)
      await sleep(150)
      return original(args, toolContext, canUse, message, onProgress)
    }) as typeof tool.call
    const delays: number[] = []
    const realSetTimeout = globalThis.setTimeout
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      delays.push(ms ?? 0)
      return realSetTimeout(fn, ms, ...rest)
    }) as typeof setTimeout)
    try {
      const updates: Array<{ update: DeferredMessageUpdate; at: number }> = []
      for await (const update of executeToolCall(
        { type: 'tool-call', toolCallId: 'tc-1', toolName: 'Shell', args: { command: 'ls' } },
        assistant('Shell', 'tc-1'),
        async () => ({ behavior: 'allow' }),
        context,
        RUNTIME_DEPS,
      )) {
        updates.push({ update, at: Date.now() })
      }
      expect(updates).toHaveLength(2)
      expect(updates[0]!.at).toBeGreaterThanOrEqual(progressAt)
    } finally {
      spy.mockRestore()
    }
    // 300 ms pending under the old 50 ms poll was six of these.
    expect(delays.filter(ms => ms === 50)).toEqual([])
  })
})

describe('tool.call — when a hook is wrong', () => {
  it('a hook that throws is skipped: the call runs as if it were not there', async () => {
    const { runtime, reports } = mods(`on('tool.call', () => { throw new Error('boom') })`)
    const { context, calls } = world(runtime)
    const updates = await run(context, { command: 'ls' })
    expect(resultOf(updates[0]).stored).toEqual({ ok: true, ran: 'ls' })
    expect(calls).toHaveLength(1)
    expect(reports.join('\n')).toMatch(/guard: tool\.call hook failed: boom/)
  })

  it('a guard that paces its polling holds the call past the burst, and its deny stands', async () => {
    // Waits with a $ call per tick, as a guard holding a call in a pane does:
    // a quick start, then about one call per 12 ms, past the 512 of the burst.
    const { runtime, reports } = mods(`
      on('tool.call', { tool: 'Shell' }, async ($, e, next) => {
        for (let i = 0; i < 600; i++) {
          await $.session.id()
          if (i >= 500) await new Promise(resolve => setTimeout(resolve, 12))
        }
        return { deny: 'guard: nobody answered.' }
      })
    `)
    const { context, calls } = world(runtime)
    const updates = await run(context, { command: 'git push --force' })
    expect(calls).toHaveLength(0)
    expect(resultOf(updates[0])).toMatchObject({ text: 'guard: nobody answered.', isError: true })
    expect(reports).toEqual([])
  })

  it('a hook that answers a wrong shape is skipped', async () => {
    const { runtime, reports } = mods(`on('tool.call', () => ({ verdict: 'fine' }))`)
    const { context, calls } = world(runtime)
    const updates = await run(context, { command: 'ls' })
    expect(resultOf(updates[0]).stored).toEqual({ ok: true, ran: 'ls' })
    expect(calls).toHaveLength(1)
    expect(reports).toHaveLength(1)
  })

  it('a hook that returns while its next is pending aborts the run beneath', async () => {
    const { runtime } = mods(`
      on('tool.call', ($, e, next) => {
        void next(e).catch(() => {})
        return new Promise(resolve => setTimeout(() => resolve({ result: 'answered early' }), 60))
      })
    `)
    let finish!: () => void
    const finished = new Promise<void>(resolve => {
      finish = resolve
    })
    const { context, calls } = world(runtime, {
      call: async (_args, toolContext) => {
        await new Promise<void>(resolve =>
          toolContext.cancelSource.signal.addEventListener('abort', () => resolve()),
        )
        finish()
        return { data: 'ran to the end' }
      },
    })
    const updates = await run(context, { command: 'slow' })
    expect(resultOf(updates[0]).stored).toBe('answered early')
    await finished
    expect(calls[0]!.aborted()).toBe(true)
    // The turn itself was not interrupted.
    expect(context.cancelSource.signal.aborted).toBe(false)
  })

  it('an interrupted turn still gets the call\'s tool_result', async () => {
    const { runtime } = mods(`on('tool.call', ($, e, next) => new Promise(() => {}))`)
    const { context, calls } = world(runtime)
    setTimeout(() => context.cancelSource.abort(), 40)
    const updates = await run(context, { command: 'ls' })
    expect(updates).toHaveLength(1)
    expect(resultOf(updates[0])).toMatchObject({ text: 'Interrupted by user', isError: true })
    expect(calls).toHaveLength(0)
  })
})

describe('tool.call — the permission prompt is inside next', () => {
  it('a hook waits for the user without spending its budget, then sees the result', async () => {
    // The hook's whole budget is 80ms; the user takes 250ms to answer.
    const { runtime, reports } = mods(
      `
      on('tool.call', async ($, e, next) => {
        const ran = await next(e)
        return { ...ran, context: ['asked first'] }
      })
    `,
      { budgetMs: 80 },
    )
    const { context, calls } = world(runtime, { asks: true })
    let asked = 0
    context.requestToolUseConfirm = (async () => {
      asked += 1
      await sleep(250)
      return { behavior: 'allow' }
    }) as never
    const updates = await run(context, { command: 'ls' })
    expect(asked).toBe(1)
    expect(calls).toHaveLength(1)
    expect(resultOf(updates[0]).stored).toEqual({ ok: true, ran: 'ls' })
    expect(updates).toHaveLength(2)
    expect(reports).toEqual([])
  })

  it('a user\'s refusal reaches the hook as an errored result', async () => {
    const { runtime } = mods(`
      on('tool.call', async ($, e, next) => {
        const ran = await next(e)
        return { result: { isError: ran.isError === true } }
      })
    `)
    const { context, calls } = world(runtime, { asks: true })
    context.requestToolUseConfirm = (async () => ({ behavior: 'deny' })) as never
    const updates = await run(context, { command: 'ls' })
    expect(calls).toHaveLength(0)
    expect(resultOf(updates[0]).stored).toEqual({ isError: true })
  })

  it('a call that HALTS the loop is not an answer a hook can replace', async () => {
    // No interactive resolver: the ask suspends the loop (the legacy path).
    const { runtime } = mods(`
      on('tool.call', async ($, e, next) => {
        await next(e)
        return { deny: 'a hook answered' }
      })
    `)
    const { context, calls } = world(runtime, { asks: true })
    const updates = await run(context, { command: 'ls' })
    expect(updates).toEqual([{ pendingToolUse: { toolUseId: 'tc-1', toolName: 'Shell' } }])
    expect(calls).toHaveLength(0)
  })
})

describe('tool.call — what is never raised', () => {
  it('a tool the model was not offered: the refusal is the engine\'s, no hook answers for it', async () => {
    const { runtime } = mods(`on('tool.call', () => ({ result: 'a hook answered' }))`)
    const { context } = world(runtime)
    const updates = await run(context, {}, 'NoSuchTool')
    expect(resultOf(updates[0]).isError).toBe(true)
    expect(String(resultOf(updates[0]).text)).toContain('Unknown tool: NoSuchTool')
  })

  it('an interrupted turn: no hook runs', async () => {
    const { runtime } = mods(`on('tool.call', () => ({ result: 'a hook answered' }))`)
    const { context } = world(runtime)
    context.cancelSource.abort()
    const updates = await run(context, { command: 'ls' })
    expect(resultOf(updates[0])).toMatchObject({ text: 'Interrupted by user', isError: true })
  })

  it('a tool that halts for the user (requiresUserInteraction)', async () => {
    expect(raisesToolCall(AskPersonTool as unknown as ToolContract)).toBe(false)
    const { runtime } = mods(`on('tool.call', () => ({ deny: 'a hook answered' }))`)
    const asks = declareTool({
      name: 'Asks',
      argsSchema: { type: 'object' as const, properties: {} },
      description: async () => 'asks',
      haltsForUser: () => true,
      call: async () => ({ data: 'never' }),
    })
    const { context } = world(runtime, { extraTools: [asks as unknown as ToolContract] })
    const updates = await run(context, {}, 'Asks')
    // The loop is suspended on the call, exactly as without mods.
    expect(updates).toEqual([{ pendingToolUse: { toolUseId: 'tc-1', toolName: 'Asks' } }])
  })
})

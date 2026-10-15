/**
 * `tool.check` and `$.tool.check` (F-25): a mod's word on the engine's permission verdict (real `runToolUse`):
 * `next(e)` resolves to the engine's verdict; `allow` runs the tool, `ask` goes to the mode's decider, `deny`
 * refuses with the reason; `$.tool.check` runs the chain and executes nothing.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkingState, ModelReplyRow, Message } from '../runtime/RuntimeTypes'
import type { QueryRuntimeDeps } from '../runtime/interfaces/QueryRuntimeDeps'
import { declareTool, type ToolContract } from '../toolkit/toolContract'
import { type ToolCallContext } from '../toolkit/toolCallContext'
import {
  callToolForMod,
  checkToolForMod,
  listToolsForMods,
  executeToolCall,
  type DeferredMessageUpdate,
} from '../toolkit/run/executeToolCall'
import { TOOL_CHECK_DENIED_TEXT } from '../toolkit/run/toolCheckThroughMods'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import { implementedNouns } from '../mods/modNouns'
import { RAISED_EVENTS } from '../mods/modAdmission'
import { isToolCheckResult, toolCheckEventOf } from '../mods/toolCallEvent'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ToolCallMods } from '../mods/toolCallEvent'

let uuid = 0
let uniqueLoad = 0
const RUNTIME_DEPS = { uuid: () => `uuid-${++uuid}` } as QueryRuntimeDeps
const PROJ = '/work/project'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

type Calls = { tool: string; args: Record<string, unknown> }[]

type WorldOptions = {
  /** Shell's own `checkPermissions` asks. */
  asks?: boolean
  /** settings.json `permissions` rule lists. */
  ruleLists?: { allow: string[]; deny: string[]; ask: string[] }
  /** The interactive decider. Absent: an ask stages a pending entry and halts. */
  confirm?: (params: { permissionResult?: { message?: string } }) => Promise<unknown>
}

function tools(calls: Calls, options: WorldOptions): ToolContract[] {
  const make = (name: string, extra: Record<string, unknown> = {}) =>
    declareTool({
      name,
      argsSchema: { type: 'object' as const, properties: {} },
      description: async () => `${name} does its thing`,
      call: async (args: Record<string, unknown>) => {
        calls.push({ tool: name, args })
        return { data: { ok: true, tool: name, got: args } }
      },
      ...extra,
    }) as unknown as ToolContract
  return [
    make(
      'Shell',
      options.asks
        ? { selfVerdict: async () => ({ behavior: 'ask' as const, message: 'Run it?' }) }
        : {},
    ),
    make('Peek', { readsOnly: () => true }),
    make('Asks', { haltsForUser: () => true }),
    make('Write', {
      argsSchema: { type: 'object' as const, properties: { file_path: { type: 'string' as const } } },
      readsOnly: () => false,
      selfVerdict: async () => ({ behavior: 'allow' as const }),
    }),
  ]
}

/** A slot whose tools run through the real tool path. Each source is a
 *  `register` body; modules load in the order given. */
function world(modules: Record<string, string>, options: WorldOptions = {}) {
  const reports: string[] = []
  const calls: Calls = []
  let confirms = 0
  let appState: WorkingState = createEmptyAppState()
  if (options.ruleLists) {
    appState = {
      ...appState,
      permissionRules: { ...appState.permissionRules, ruleLists: options.ruleLists },
    }
  }
  const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
    appState = updater(appState)
  }
  const makeContext = (abortController: AbortController): ToolCallContext => {
    const context = createNoopToolUseContext({
      tools: tools(calls, options),
      platformCapabilities: new NoopPlatformCapabilities(),
      appState,
      setAppState,
      cwd: PROJ,
      projectRoot: PROJ,
      sessionId: 'sess-check',
    })
    context.writeAppState = setAppState
    context.readAppState = () => appState
    context.cancelSource = abortController
    context.options.mods = runtime
    if (options.confirm) {
      const confirm = options.confirm
      context.requestToolUseConfirm = (async (params: { permissionResult?: { message?: string } }) => {
        confirms += 1
        return confirm(params)
      }) as never
    }
    return context
  }
  const refs: ModModuleRef[] = Object.keys(modules).map(plugin => ({
    plugin,
    path: `${plugin}/hooks/register.js`,
  }))
  const runtime: ModRuntime = new ModRuntime({
    modules: refs,
    readModule: async path =>
      `export function register(on) {\n${modules[path.split('/')[0]!]}\n}\n// load ${++uniqueLoad}`,
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
    session: {
      id: () => 'sess-check',
      cwd: () => PROJ,
      tools: {
        list: () => listToolsForMods(makeContext(new AbortController())),
        call: (input, raise) =>
          callToolForMod({
            input,
            mods: runtime as ToolCallMods,
            context: raise.context,
            canUseTool: async () => ({ behavior: 'allow' }),
            callContext: makeContext(new AbortController()),
            deps: RUNTIME_DEPS,
          }),
        check: (input, raise) =>
          checkToolForMod({
            input,
            mods: runtime as ToolCallMods,
            context: raise.context,
            callContext: makeContext(new AbortController()),
          }),
      },
    },
    report: line => reports.push(line),
  })
  runtimes.push(runtime)

  /** The model's call of `toolName`, through the real tool path. */
  const run = async (
    args: Record<string, unknown>,
    toolName = 'Shell',
    toolCallId = 'tc-1',
  ): Promise<DeferredMessageUpdate[]> => {
    const updates: DeferredMessageUpdate[] = []
    const assistant: ModelReplyRow = {
      type: 'assistant',
      uuid: `assistant-${toolCallId}`,
      message: {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId, toolName, args: {} }],
      },
    }
    for await (const update of executeToolCall(
      { type: 'tool-call', toolCallId, toolName, args },
      assistant,
      async () => ({ behavior: 'allow' }),
      makeContext(new AbortController()),
      RUNTIME_DEPS,
    )) {
      updates.push(update)
    }
    return updates
  }

  return { runtime, reports, calls, run, confirms: () => confirms, appState: () => appState }
}

/** The JSON a mod logged with `$.ui.log(JSON.stringify(x))`, by plugin. */
function logged(reports: string[], plugin: string): unknown[] {
  return reports
    .filter(line => line.startsWith(`${plugin}: {`) || line.startsWith(`${plugin}: [`))
    .map(line => JSON.parse(line.slice(plugin.length + 2)))
}

/** The call's tool_result, as the transcript and the model have it. */
function resultOf(update: DeferredMessageUpdate | undefined) {
  const message = update?.message as
    | (Message & {
        toolUseResult?: string
        message: { content: Array<{ type: string; result?: unknown; isError?: boolean }> }
      })
    | undefined
  const block = message?.message.content[0]
  return { text: message?.toolUseResult, isError: block?.isError === true }
}

/** A hook that reads core's verdict through `next`, logs the question and the
 *  answer, and answers `decision` (or relays core's). */
const watcher = (decision?: string) => `
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    await $.ui.log(JSON.stringify({ e, verdict, origin: next.origin }))
    return ${decision ? `{ ...verdict, decision: '${decision}' }` : 'verdict'}
  })
`

describe('tool.check — the shapes', () => {
  it('is raised, and $.tool.check is served', () => {
    expect(RAISED_EVENTS).toContain('tool.check')
    expect(implementedNouns()).toContain('tool.check')
  })

  it('builds e from the tool, its input and the call id, which a query has not', () => {
    expect(toolCheckEventOf('Bash', { command: 'ls' }, 'tu-1')).toEqual({
      tool: 'Bash',
      input: { command: 'ls' },
      tool_use_id: 'tu-1',
    })
    expect(toolCheckEventOf('Bash', { command: 'ls' })).toEqual({ tool: 'Bash', input: { command: 'ls' } })
  })

  it('takes { decision } of the three, with reason and rule as strings; nothing else', () => {
    expect(isToolCheckResult({ decision: 'allow' })).toBe(true)
    expect(isToolCheckResult({ decision: 'deny', reason: 'no' })).toBe(true)
    expect(isToolCheckResult({ decision: 'ask', rule: 'Bash(ls:*)' })).toBe(true)
    expect(isToolCheckResult({ decision: 'maybe' })).toBe(false)
    expect(isToolCheckResult({ decision: 'deny', reason: 3 })).toBe(false)
    expect(isToolCheckResult({ allow: true })).toBe(false)
    expect(isToolCheckResult(undefined)).toBe(false)
  })
})

describe("tool.check — the model's call", () => {
  it('next(e) resolves to the engine\'s verdict: the tool\'s own ask, with its reason', async () => {
    const { runtime, reports, run, calls, confirms } = world(
      { watch: watcher() },
      { asks: true, confirm: async () => ({ behavior: 'allow' }) },
    )
    await runtime.ready
    await run({ command: 'ls' })
    const [seen] = logged(reports, 'watch') as Array<Record<string, unknown>>
    expect(seen!.e).toEqual({ tool: 'Shell', input: { command: 'ls' }, tool_use_id: 'tc-1' })
    expect(seen!.verdict).toEqual({ decision: 'ask', reason: 'Run it?' })
    // The model's own call: the engine raised it.
    expect(seen!.origin).toMatchObject({ plugin: 'engine' })
    // Relayed as is, the ask went to the decider, which allowed it.
    expect(confirms()).toBe(1)
    expect(calls).toEqual([{ tool: 'Shell', args: { command: 'ls' } }])
  })

  it('a hook allows what would ask: no prompt is shown and the tool runs', async () => {
    const { runtime, run, calls, confirms } = world(
      { opener: `on('tool.check', { tool: 'Shell' }, () => ({ decision: 'allow' }))` },
      { asks: true, confirm: async () => ({ behavior: 'deny' }) },
    )
    await runtime.ready
    const updates = await run({ command: 'ls' })
    expect(confirms()).toBe(0)
    expect(calls).toEqual([{ tool: 'Shell', args: { command: 'ls' } }])
    expect(resultOf(updates[0]).isError).toBe(false)
  })

  it('a hook allows what a settings ask rule would ask — and core reported the rule', async () => {
    const { runtime, reports, run, calls, confirms } = world(
      { opener: watcher('allow') },
      { ruleLists: { allow: [], deny: [], ask: ['Shell'] }, confirm: async () => ({ behavior: 'deny' }) },
    )
    await runtime.ready
    await run({ command: 'ls' })
    const [seen] = logged(reports, 'opener') as Array<{ verdict: { decision: string; rule?: string } }>
    // The rule as written in settings.json: the bare tool name.
    expect(seen!.verdict).toEqual({ decision: 'ask', reason: expect.any(String), rule: 'Shell' })
    expect(confirms()).toBe(0)
    expect(calls).toHaveLength(1)
  })

  it('a hook denies what would allow: the tool does not run, its reason is the model\'s error', async () => {
    const { runtime, run, calls } = world({
      guard: `on('tool.check', { tool: 'Peek' }, () => ({ decision: 'deny', reason: 'no peeking today' }))`,
    })
    await runtime.ready
    const updates = await run({ path: 'x' }, 'Peek')
    expect(calls).toHaveLength(0)
    const result = resultOf(updates[0])
    expect(result.isError).toBe(true)
    expect(result.text).toContain('no peeking today')
  })

  it('a deny without a reason is still a deny, with the engine\'s own line', async () => {
    const { runtime, run, calls } = world({
      guard: `on('tool.check', () => ({ decision: 'deny' }))`,
    })
    await runtime.ready
    const updates = await run({ path: 'x' }, 'Peek')
    expect(calls).toHaveLength(0)
    expect(resultOf(updates[0]).text).toContain(TOOL_CHECK_DENIED_TEXT)
  })

  it('a hook forces an ask on what would allow: the decider is asked, with the hook\'s reason', async () => {
    const messages: Array<string | undefined> = []
    const { runtime, run, calls, confirms } = world(
      { careful: `on('tool.check', { tool: 'Peek' }, () => ({ decision: 'ask', reason: 'Peek at it?' }))` },
      {
        confirm: async ({ permissionResult }) => {
          messages.push(permissionResult?.message)
          return { behavior: 'allow' }
        },
      },
    )
    await runtime.ready
    await run({ path: 'x' }, 'Peek')
    expect(confirms()).toBe(1)
    expect(messages).toEqual(['Peek at it?'])
    expect(calls).toHaveLength(1)
  })

  it('a forced ask the user denies does not run', async () => {
    const { runtime, run, calls } = world(
      { careful: `on('tool.check', () => ({ decision: 'ask' }))` },
      { confirm: async () => ({ behavior: 'deny' }) },
    )
    await runtime.ready
    const updates = await run({ path: 'x' }, 'Peek')
    expect(calls).toHaveLength(0)
    expect(resultOf(updates[0]).isError).toBe(true)
  })

  it('a forced ask with no decider installed halts the call, as any ask does', async () => {
    const { runtime, run, calls, appState } = world({
      careful: `on('tool.check', () => ({ decision: 'ask' }))`,
    })
    await runtime.ready
    const updates = await run({ path: 'x' }, 'Peek', 'tc-halt')
    expect(calls).toHaveLength(0)
    expect(updates.some(u => u.pendingToolUse?.toolUseId === 'tc-halt')).toBe(true)
    expect(appState().pendingPermissions?.['tc-halt']?.toolName).toBe('Peek')
  })

  it('a path-safety ask cannot be allowed away: the call asks as before, and the mod is told', async () => {
    const { runtime, reports, run, calls } = world({
      opener: `on('tool.check', { tool: 'Write' }, () => ({ decision: 'allow' }))`,
    })
    await runtime.ready
    const updates = await run({ file_path: `${PROJ}/.git/config` }, 'Write', 'tc-git')
    expect(calls).toHaveLength(0)
    expect(updates.some(u => u.pendingToolUse?.toolUseId === 'tc-git')).toBe(true)
    expect(reports).toContainEqual(
      expect.stringMatching(/^mods: tool\.check answered \{ allow \} for Write, but its ask is a path-safety check/),
    )
  })

  it('a hook that allows over a deny still meets the path-safety check the deny stopped before', async () => {
    const { runtime, reports, run, calls } = world(
      { opener: `on('tool.check', { tool: 'Write' }, () => ({ decision: 'allow' }))` },
      { ruleLists: { allow: [], deny: ['Write'], ask: [] } },
    )
    await runtime.ready
    const updates = await run({ file_path: `${PROJ}/.git/hooks/pre-commit` }, 'Write', 'tc-git-deny')
    expect(calls).toHaveLength(0)
    expect(updates.some(u => u.pendingToolUse?.toolUseId === 'tc-git-deny')).toBe(true)
    expect(reports).toContainEqual(
      expect.stringMatching(/^mods: tool\.check answered \{ allow \} for Write over core's deny, but the path-safety check asks/),
    )
  })

  it('a hook that allows over a deny on a safe path runs the tool ("any verdict in either direction")', async () => {
    const { runtime, run, calls } = world(
      { opener: `on('tool.check', { tool: 'Write' }, () => ({ decision: 'allow' }))` },
      { ruleLists: { allow: [], deny: ['Write'], ask: [] } },
    )
    await runtime.ready
    await run({ file_path: `${PROJ}/notes.txt` }, 'Write', 'tc-safe-deny')
    expect(calls).toHaveLength(1)
  })

  it('the same decision as core\'s leaves core\'s verdict as it was', async () => {
    const { runtime, run, calls, confirms } = world(
      { echo: `on('tool.check', () => ({ decision: 'ask', reason: 'mine' }))` },
      { asks: true, confirm: async () => ({ behavior: 'allow' }) },
    )
    await runtime.ready
    await run({ command: 'ls' })
    expect(confirms()).toBe(1)
    expect(calls).toHaveLength(1)
  })

  it('a hook answering a wrong shape is skipped: the engine\'s verdict stands', async () => {
    const { runtime, run, calls, confirms, reports } = world(
      { odd: `on('tool.check', () => ({ decision: 'maybe' }))` },
      { asks: true, confirm: async () => ({ behavior: 'allow' }) },
    )
    await runtime.ready
    await run({ command: 'ls' })
    expect(confirms()).toBe(1)
    expect(calls).toHaveLength(1)
    expect(reports.some(line => line.includes('odd') && /tool\.check/.test(line))).toBe(true)
  })

  it('a hook that throws is skipped: the engine\'s verdict stands', async () => {
    const { runtime, run, calls } = world({
      broken: `on('tool.check', () => { throw new Error('kaboom') })`,
    })
    await runtime.ready
    await run({ path: 'x' }, 'Peek')
    expect(calls).toHaveLength(1)
  })

  it('is not raised for a tool that halts for the user (the ones tool.call is not raised for)', async () => {
    const { runtime, reports, run } = world({ watch: watcher() })
    await runtime.ready
    await run({ question: 'why?' }, 'Asks', 'tc-ask')
    expect(logged(reports, 'watch')).toEqual([])
  })

  it('costs nothing when no hook selects it', async () => {
    const { runtime, run, calls } = world({ other: `on('prompt.submit', ($, e, next) => next(e))` })
    await runtime.ready
    expect(runtime.hasToolCheckHooks()).toBe(false)
    await run({ command: 'ls' })
    expect(calls).toHaveLength(1)
  })

  it('a plugin\'s own $.tool.call is decided through the chain too, under its call id', async () => {
    const { runtime, reports, calls } = world(
      {
        watch: watcher(),
        caller: `on('prompt.submit', async ($, e, next) => {
          try { await $.ui.log(JSON.stringify(await $.tool.call({ tool: 'Shell', command: 'ls' }))) }
          catch (error) { await $.ui.log(JSON.stringify({ threw: error.name, message: error.message })) }
          return next(e)
        })`,
      },
      { asks: true, confirm: async () => ({ behavior: 'allow' }) },
    )
    await runtime.ready
    await runtime.promptSubmit('go')
    const [seen] = logged(reports, 'watch') as Array<{ e: { tool_use_id?: string }; origin: { plugin?: string } }>
    expect(seen!.e.tool_use_id).toMatch(/^modtool_/)
    expect(seen!.origin).toMatchObject({ plugin: 'caller' })
    expect(calls).toHaveLength(1)
  })
})

describe('$.tool.check', () => {
  const checks = (input: string) => `
    on('prompt.submit', async ($, e, next) => {
      try { await $.ui.log(JSON.stringify(await $.tool.check(${input}))) }
      catch (error) { await $.ui.log(JSON.stringify({ threw: error.name, message: error.message })) }
      return next(e)
    })
  `

  it('answers the engine\'s verdict without running the tool or opening a dialog', async () => {
    const { runtime, reports, calls, confirms } = world(
      { asker: checks(`{ tool: 'Shell', input: { command: 'ls' } }`) },
      { asks: true, confirm: async () => ({ behavior: 'allow' }) },
    )
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(logged(reports, 'asker')).toEqual([{ decision: 'ask', reason: 'Run it?' }])
    expect(calls).toHaveLength(0)
    expect(confirms()).toBe(0)
  })

  it('answers allow for a tool nothing gates, and deny for a settings deny rule, naming it', async () => {
    const { runtime, reports } = world(
      {
        asker: `
          on('prompt.submit', async ($, e, next) => {
            await $.ui.log(JSON.stringify(await $.tool.check({ tool: 'Peek', input: {} })))
            await $.ui.log(JSON.stringify(await $.tool.check({ tool: 'Shell', input: { command: 'rm' } })))
            return next(e)
          })`,
      },
      { ruleLists: { allow: [], deny: ['Shell'], ask: [] } },
    )
    await runtime.ready
    await runtime.promptSubmit('go')
    const [peek, shell] = logged(reports, 'asker') as Array<Record<string, unknown>>
    expect(peek).toEqual({ decision: 'allow' })
    expect(shell).toEqual({
      decision: 'deny',
      reason: 'Permission denied by rule "Shell".',
      rule: 'Shell',
    })
  })

  it('runs through the other hooks, with no call id and the asking plugin as origin', async () => {
    const { runtime, reports, calls } = world({
      watch: watcher('deny'),
      asker: checks(`{ tool: 'Peek', input: { path: 'x' } }`),
    })
    await runtime.ready
    await runtime.promptSubmit('go')
    const [seen] = logged(reports, 'watch') as Array<{ e: Record<string, unknown>; origin: { plugin?: string } }>
    expect(seen!.e).toEqual({ tool: 'Peek', input: { path: 'x' } })
    expect(seen!.origin).toMatchObject({ plugin: 'asker' })
    // A deny with no reason of its own carries the engine's line for the model.
    expect(logged(reports, 'asker')).toEqual([{ decision: 'deny', reason: TOOL_CHECK_DENIED_TEXT }])
    expect(calls).toHaveLength(0)
  })

  it('is raised for the query even when no hook selects it (the chain is core alone)', async () => {
    const { runtime, reports } = world({ asker: checks(`{ tool: 'Peek' }`) })
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(logged(reports, 'asker')).toEqual([{ decision: 'allow' }])
  })

  it('rejects a tool nobody has, and a call without a tool name', async () => {
    const { runtime, reports } = world({
      asker: `
        on('prompt.submit', async ($, e, next) => {
          for (const input of [{ tool: 'Nope', input: {} }, { input: {} }]) {
            try { await $.ui.log(JSON.stringify(await $.tool.check(input))) }
            catch (error) { await $.ui.log(JSON.stringify({ threw: error.name, message: error.message })) }
          }
          return next(e)
        })`,
    })
    await runtime.ready
    await runtime.promptSubmit('go')
    const [nope, bare] = logged(reports, 'asker') as Array<{ threw: string; message: string }>
    expect(nope!.message).toContain('no tool is named "Nope"')
    expect(bare!.threw).toBe('TypeError')
  })
})

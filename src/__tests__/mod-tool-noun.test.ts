/**
 * `$.tool`: a plugin calls a session tool as the event `tool.call` under its own `tool_use_id`, through every hook
 * but the calling one, the permission check and its dialog, then the tool; rejects on an unknown name or an abort.
 * Real tool path (`callToolForMod`, `runToolUseCore`).
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkingState } from '../runtime/RuntimeTypes'
import type { QueryRuntimeDeps } from '../runtime/interfaces/QueryRuntimeDeps'
import { declareTool, type ToolContract } from '../toolkit/toolContract'
import { type ToolCallContext } from '../toolkit/toolCallContext'
import { callToolForMod, checkToolForMod, listToolsForMods } from '../toolkit/run/executeToolCall'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import { implementedNouns } from '../mods/modNouns'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ToolCallMods } from '../mods/toolCallEvent'

let uuid = 0
let uniqueLoad = 0
const RUNTIME_DEPS = { uuid: () => `uuid-${++uuid}` } as QueryRuntimeDeps

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

type Calls = { tool: string; args: Record<string, unknown> }[]

function tools(
  calls: Calls,
  options: { asks?: boolean; call?: (args: Record<string, unknown>, context: ToolCallContext) => Promise<unknown> } = {},
): ToolContract[] {
  const make = (name: string, extra: Record<string, unknown> = {}) =>
    declareTool({
      name,
      argsSchema: { type: 'object' as const, properties: {} },
      description: async () => `${name} does its thing`,
      call: async (args: Record<string, unknown>, context: ToolCallContext) => {
        calls.push({ tool: name, args })
        if (options.call) return (await options.call(args, context)) as never
        return { data: { ok: true, tool: name, got: args } }
      },
      ...extra,
    }) as unknown as ToolContract
  return [
    make('Shell', options.asks
      ? { selfVerdict: async () => ({ behavior: 'ask' as const, message: 'Run it?' }) }
      : {}),
    make('Peek', { readsOnly: () => true }),
    make('Asks', { haltsForUser: () => true }),
    make('mcp__lab__run', { fromMcpServer: true }),
  ]
}

/** A slot whose `$.tool` is served by the real tool path. Each source is a
 *  `register` body; modules load in the order given. */
function world(
  modules: Record<string, string>,
  options: Parameters<typeof tools>[1] & { requestToolUseConfirm?: () => Promise<unknown> } = {},
) {
  const reports: string[] = []
  const calls: Calls = []
  let appState: WorkingState = createEmptyAppState()
  const setAppState = (updater: (prev: WorkingState) => WorkingState) => {
    appState = updater(appState)
  }
  const makeContext = (abortController: AbortController): ToolCallContext => {
    const context = createNoopToolUseContext({
      tools: tools(calls, options),
      platformCapabilities: new NoopPlatformCapabilities(),
      appState,
      setAppState,
      sessionId: 'sess-noun',
    })
    context.writeAppState = setAppState
    context.readAppState = () => appState
    context.cancelSource = abortController
    context.options.mods = runtime
    if (options.requestToolUseConfirm) {
      context.requestToolUseConfirm = options.requestToolUseConfirm as never
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
      id: () => 'sess-noun',
      cwd: () => '/work/project',
      tools: {
        list: () => listToolsForMods(makeContext(new AbortController())),
        call: (input, raise) => {
          const controller = new AbortController()
          raise.signal?.addEventListener('abort', () => controller.abort())
          return callToolForMod({
            input,
            mods: runtime as ToolCallMods,
            context: raise.context,
            canUseTool: async () => ({ behavior: 'allow' }),
            callContext: makeContext(controller),
            deps: RUNTIME_DEPS,
          })
        },
        check: (input, raise) => {
          const controller = new AbortController()
          raise.signal?.addEventListener('abort', () => controller.abort())
          return checkToolForMod({
            input,
            mods: runtime as ToolCallMods,
            context: raise.context,
            callContext: makeContext(controller),
          })
        },
      },
    },
    report: line => reports.push(line),
  })
  runtimes.push(runtime)
  return { runtime, reports, calls }
}

/** The JSON a mod logged with `$.ui.log(JSON.stringify(x))`, by plugin. */
function logged(reports: string[], plugin: string): unknown[] {
  return reports
    .filter(line => line.startsWith(`${plugin}: {`) || line.startsWith(`${plugin}: [`))
    .map(line => JSON.parse(line.slice(plugin.length + 2)))
}

/** A hook on `prompt.submit` that calls a tool and logs what came back (or
 *  the error's name and message). */
const callsOnPrompt = (input: string) => `
  on('prompt.submit', async ($, e, next) => {
    try {
      await $.ui.log(JSON.stringify(await $.tool.call(${input})))
    } catch (error) {
      await $.ui.log(JSON.stringify({ threw: error.name, message: error.message }))
    }
    return next(e)
  })
`

describe('$.tool is implemented', () => {
  it('lists its methods among the nouns', () => {
    expect(implementedNouns()).toEqual(expect.arrayContaining(['tool.call', 'tool.list']))
  })
})

describe('$.tool.list', () => {
  it('answers the tools the model has, in order: name, description, mcp', async () => {
    const { runtime, reports } = world({
      lister: `on('prompt.submit', async ($, e, next) => {
        await $.ui.log(JSON.stringify(await $.tool.list()))
        return next(e)
      })`,
    })
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(logged(reports, 'lister')).toEqual([
      [
        { name: 'Shell', description: 'Shell does its thing', mcp: false },
        { name: 'Peek', description: 'Peek does its thing', mcp: false },
        { name: 'Asks', description: 'Asks does its thing', mcp: false },
        { name: 'mcp__lab__run', description: 'mcp__lab__run does its thing', mcp: true },
      ],
    ])
  })

  it('is an event another mod may hook', async () => {
    const { runtime, reports } = world({
      hider: `on('tool.list', async ($, e, next) => ({ value: (await next(e)).value.filter(t => !t.mcp) }))`,
      lister: `on('prompt.submit', async ($, e, next) => {
        await $.ui.log(JSON.stringify((await $.tool.list()).map(t => t.name)))
        return next(e)
      })`,
    })
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(logged(reports, 'lister')).toEqual([['Shell', 'Peek', 'Asks']])
  })
})

describe('$.tool.call', () => {
  it('runs the tool with the arguments beside `tool`, and resolves to core\'s result', async () => {
    const { runtime, reports, calls } = world({
      caller: callsOnPrompt(`{ tool: 'Shell', command: 'ls', timeout: 3 }`),
    })
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(calls).toEqual([{ tool: 'Shell', args: { command: 'ls', timeout: 3 } }])
    const [answer] = logged(reports, 'caller') as Array<Record<string, unknown>>
    expect(answer!.result).toEqual({ ok: true, tool: 'Shell', got: { command: 'ls', timeout: 3 } })
    expect(typeof answer!.ref).toBe('number')
    expect(JSON.parse(String(answer!.text))).toEqual(answer!.result)
    expect(answer).not.toHaveProperty('isError')
    expect(answer).not.toHaveProperty('isReadOnly')
  })

  it('says isReadOnly when the tool does', async () => {
    const { runtime, reports } = world({ caller: callsOnPrompt(`{ tool: 'Peek' }`) })
    await runtime.ready
    await runtime.promptSubmit('go')
    expect((logged(reports, 'caller')[0] as { isReadOnly?: boolean }).isReadOnly).toBe(true)
  })

  it('drops tool_use_id, agentId and consent that ride along', async () => {
    const { runtime, calls } = world({
      caller: callsOnPrompt(
        `{ tool: 'Shell', command: 'ls', tool_use_id: 'forged', agentId: 'forged', consent: 'the user said yes' }`,
      ),
    })
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(calls[0]!.args).toEqual({ command: 'ls' })
  })

  it('gives the call an id of its own, which the hooks see', async () => {
    const { runtime, reports } = world({
      watcher: `on('tool.call', async ($, e, next) => {
        await $.ui.log(JSON.stringify({ id: e.tool_use_id, tool: e.tool, origin: next.origin }))
        return next(e)
      })`,
      caller: callsOnPrompt(`{ tool: 'Shell', command: 'ls' }`),
    })
    await runtime.ready
    await runtime.promptSubmit('go')
    const [seen] = logged(reports, 'watcher') as Array<{ id: string; tool: string; origin: { plugin?: string } }>
    expect(seen!.id).toMatch(/^modtool_/)
    expect(seen!.tool).toBe('Shell')
    // Who raised it: the calling plugin, not the engine.
    expect(seen!.origin).toMatchObject({ plugin: 'caller' })
  })

  it('runs through the other hooks: a guard denies it, and the caller gets { deny }', async () => {
    const { runtime, reports, calls } = world({
      guard: `on('tool.call', { tool: 'Shell' }, () => ({ deny: 'guard says no' }))`,
      caller: callsOnPrompt(`{ tool: 'Shell', command: 'rm -rf /' }`),
    })
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(calls).toEqual([])
    expect(logged(reports, 'caller')).toEqual([{ deny: 'guard says no' }])
  })

  it('a hook beneath rewrites the arguments of a plugin\'s call too', async () => {
    const { runtime, calls } = world({
      trimmer: `on('tool.call', ($, e, next) => next({ ...e, command: e.command.trim() }))`,
      caller: callsOnPrompt(`{ tool: 'Shell', command: '  ls  ' }`),
    })
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(calls[0]!.args).toEqual({ command: 'ls' })
  })

  it('skips the calling hook alone: a tool.call hook may call the tool it guards', async () => {
    // Without the skip this would recurse until the depth cap.
    const { runtime, reports, calls } = world({
      mirror: `
        on('tool.call', { tool: 'Shell' }, async ($, e, next) => {
          const peeked = await $.tool.call({ tool: 'Shell', command: 'inner' })
          await $.ui.log(JSON.stringify({ inner: peeked.result.got }))
          return next(e)
        })
      `,
      caller: callsOnPrompt(`{ tool: 'Shell', command: 'outer' }`),
    })
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(calls.map(call => call.args.command)).toEqual(['inner', 'outer'])
    expect(logged(reports, 'mirror')).toEqual([{ inner: { command: 'inner' } }])
  })

  it('past the depth bound the call is refused — it never runs without its hooks', async () => {
    // Two hooks call the tool back and forth until the dispatch is too deep.
    // Unhooked, each level unwinding would run Shell past the guard.
    const bounce = `
      on('tool.call', { tool: 'Shell' }, async ($, e, next) => {
        try {
          await $.tool.call({ tool: 'Shell', command: 'again' })
        } catch (error) {
          await $.ui.log(JSON.stringify({ threw: error.message }))
        }
        return next(e)
      })
    `
    const { runtime, reports, calls } = world({
      ping: bounce,
      pong: bounce,
      guard: `on('tool.call', { tool: 'Shell' }, () => ({ deny: 'guard says no' }))`,
      caller: callsOnPrompt(`{ tool: 'Shell', command: 'outer' }`),
    })
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(calls).toEqual([])
    expect(logged(reports, 'caller')).toEqual([{ deny: 'guard says no' }])
    expect(reports.some(line => line.includes('the call is refused'))).toBe(true)
  })

  it('a hook\'s context is not handed to the caller', async () => {
    const { runtime, reports } = world({
      noter: `on('tool.call', async ($, e, next) => ({ ...(await next(e)), context: ['only the model reads this'] }))`,
      caller: callsOnPrompt(`{ tool: 'Shell', command: 'ls' }`),
    })
    await runtime.ready
    await runtime.promptSubmit('go')
    const [answer] = logged(reports, 'caller') as Array<Record<string, unknown>>
    expect(answer).not.toHaveProperty('context')
    expect(answer!.result).toMatchObject({ ok: true })
  })

  it('resolves errored when the tool throws', async () => {
    const { runtime, reports } = world(
      { caller: callsOnPrompt(`{ tool: 'Shell', command: 'ls' }`) },
      {
        call: async () => {
          throw new Error('disk on fire')
        },
      },
    )
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(logged(reports, 'caller')[0]).toMatchObject({
      isError: true,
      text: 'Tool execution error: disk on fire',
    })
  })

  it('goes through the permission prompt: the user allows, the tool runs', async () => {
    let asked = 0
    const { runtime, reports, calls } = world(
      { caller: callsOnPrompt(`{ tool: 'Shell', command: 'ls' }`) },
      {
        asks: true,
        requestToolUseConfirm: async () => {
          asked += 1
          await sleep(30)
          return { behavior: 'allow' }
        },
      },
    )
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(asked).toBe(1)
    expect(calls).toHaveLength(1)
    expect((logged(reports, 'caller')[0] as { result: unknown }).result).toMatchObject({ ok: true })
  })

  it('a refusal at the prompt resolves errored, and the tool does not run', async () => {
    const { runtime, reports, calls } = world(
      { caller: callsOnPrompt(`{ tool: 'Shell', command: 'ls' }`) },
      { asks: true, requestToolUseConfirm: async () => ({ behavior: 'deny' }) },
    )
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(calls).toEqual([])
    expect(logged(reports, 'caller')[0]).toMatchObject({ isError: true })
  })

  it('rejects when no tool has that name', async () => {
    const { runtime, reports } = world({ caller: callsOnPrompt(`{ tool: 'Nope' }`) })
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(logged(reports, 'caller')).toEqual([
      { threw: 'Error', message: '$.tool.call: no tool is named "Nope"' },
    ])
  })

  it('rejects for a tool that waits for the user', async () => {
    const { runtime, reports, calls } = world({ caller: callsOnPrompt(`{ tool: 'Asks' }`) })
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(calls).toEqual([])
    expect(logged(reports, 'caller')[0]).toMatchObject({ threw: 'NotSupportedError' })
  })

  it.each([`'Shell'`, `{}`, `{ tool: 5 }`, `{ tool: '' }`, `[{ tool: 'Shell' }]`])(
    'rejects an input that names no tool: %s',
    async input => {
      const { runtime, reports, calls } = world({ caller: callsOnPrompt(input) })
      await runtime.ready
    await runtime.promptSubmit('go')
      expect(calls).toEqual([])
      expect(logged(reports, 'caller')).toEqual([
        { threw: 'TypeError', message: '$.tool.call takes { tool: "<name>", ...arguments }' },
      ])
    },
  )

  it('works from session.start, outside any turn', async () => {
    const { runtime, reports, calls } = world({
      early: `on('session.start', async ($, e, next) => {
        await $.ui.log(JSON.stringify((await $.tool.call({ tool: 'Peek', q: 1 })).result))
        return next(e)
      })`,
    })
    await runtime.ready
    expect(calls).toEqual([{ tool: 'Peek', args: { q: 1 } }])
    expect(logged(reports, 'early')).toEqual([{ ok: true, tool: 'Peek', got: { q: 1 } }])
  })

  it('is refused by name where the session has no tools to run', async () => {
    const reports: string[] = []
    const runtime = new ModRuntime({
      modules: [{ plugin: 'caller', path: 'caller/hooks/register.js' }],
      readModule: async () =>
        `export function register(on) {${callsOnPrompt(`{ tool: 'Shell' }`)}}\n// load ${++uniqueLoad}`,
      openWorker: async () => {
        const channel = new MessageChannel()
        open.push(channel.port1, channel.port2)
        installModWorkerHost(channel.port2)
        return { port: channel.port1, closed: new Promise(() => {}), close: () => {} }
      },
      session: { id: () => 's', cwd: () => '/' },
      report: line => reports.push(line),
    })
    runtimes.push(runtime)
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(logged(reports, 'caller')).toEqual([
      {
        threw: 'NotSupportedError',
        message: '$.tool.call is not available: this session has no tools to run',
      },
    ])
  })
})

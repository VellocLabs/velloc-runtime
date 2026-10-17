/**
 * `$.tool.register` (F-25) — the spec checked, the full name, a registered
 * tool's core failing ("a call no hook answers fails"), the registry replacing
 * by name and forgetting a plugin's tools; where the tool waits (`isDeferred`:
 * behind ToolSearch unless `false`, in front with no ToolSearch); the noun
 * through a real `ModRuntime`: a guard rewrites the description but not the
 * name, a bad spec is refused by name, a host with no tools refuses it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ModNounHost } from '../mods/modNouns'
import {
  ModRegisteredTools,
  buildModTool,
  isModRegisteredTool,
  modToolFullName,
  modToolSpecOf,
  noHookAnsweredText,
} from '../mods/modRegisteredTools'
import {
  activateSkills,
  registerDeferrableSkills,
  registerExtensionToolUnits,
  shouldHideToolFromModel,
} from '../toolkit/run/deferredTools'
import { loadableTools, owningUnit } from '../toolkit/builtin/toolSearch/catalog'
import type { WorkingState } from '../runtime/RuntimeTypes'
import { admitToolCall } from '../toolkit/run/toolCallAdmission'
import type { QueryToolUseBlock } from '../runtime/interfaces/QueryRuntimeDeps'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

describe('the spec and the tool', () => {
  it('checks the spec field by field and fills the schema in', () => {
    expect(modToolSpecOf({ name: 'weather', description: 'Weather.' })).toEqual({
      name: 'weather',
      description: 'Weather.',
      inputSchema: { type: 'object' },
    })
    expect(modToolSpecOf({ name: 'w-2', description: 'x', inputSchema: { properties: { city: { type: 'string' } } } }).inputSchema).toEqual({
      type: 'object',
      properties: { city: { type: 'string' } },
    })
    // An unpaired surrogate half is drawn as U+FFFD.
    expect(modToolSpecOf({ name: 'w', description: 'a\uD800b' }).description).toBe('a�b')
    expect(() => modToolSpecOf({ name: 'has space', description: 'x' })).toThrow(/name must be/)
    expect(() => modToolSpecOf({ name: 'x'.repeat(65), description: 'x' })).toThrow(/name must be/)
    expect(() => modToolSpecOf({ name: 'w', description: '  ' })).toThrow(/description/)
    expect(() => modToolSpecOf({ name: 'w', description: 'x', inputSchema: { type: 'array' } })).toThrow(/inputSchema/)
    expect(() => modToolSpecOf('w')).toThrow(TypeError)
  })

  it('hands isDeferred on as the plugin gave it, and refuses anything but a boolean', () => {
    expect(modToolSpecOf({ name: 'w', description: 'x', isDeferred: false }).isDeferred).toBe(false)
    expect(modToolSpecOf({ name: 'w', description: 'x', isDeferred: true }).isDeferred).toBe(true)
    expect('isDeferred' in modToolSpecOf({ name: 'w', description: 'x' })).toBe(false)
    expect(() => modToolSpecOf({ name: 'w', description: 'x', isDeferred: 'yes' })).toThrow(
      '$.tool.register: isDeferred must be true, false or left out',
    )
    // Left out, the tool waits as an MCP server's would.
    expect(buildModTool('p', modToolSpecOf({ name: 'w', description: 'x' })).modDeferred).toBe(true)
    expect(buildModTool('p', modToolSpecOf({ name: 'w', description: 'x', isDeferred: true })).modDeferred).toBe(true)
    expect(buildModTool('p', modToolSpecOf({ name: 'w', description: 'x', isDeferred: false })).modDeferred).toBe(false)
  })

  it('a registered tool: the full name, the description and schema the model reads, a core that fails', async () => {
    const tool = buildModTool('mod-weather', modToolSpecOf({ name: 'weather', description: 'Weather.' }))
    expect(tool.name).toBe('mcp__mod-weather__weather')
    expect(modToolFullName('p', 'n')).toBe('mcp__p__n')
    expect(isModRegisteredTool(tool)).toBe(true)
    expect(tool.modPlugin).toBe('mod-weather')
    expect(tool.fromMcpServer).toBe(true)
    expect(tool.skill).toBeUndefined()
    expect(await tool.description({}, {} as never)).toBe('Weather.')
    expect(tool.argsSchema).toEqual({ type: 'object' })
    const result = await tool.call({}, {} as ToolCallContext, async () => ({ behavior: 'allow' }) as never, {} as never)
    expect(result.data).toEqual({ error: noHookAnsweredText('mod-weather', 'mcp__mod-weather__weather'), isError: true })
    expect(noHookAnsweredText('p', 'mcp__p__n')).toContain('no tool.call hook of p answered')
  })

  it('the registry replaces by name, forgets a plugin, and tells its listener', () => {
    const seen: string[][] = []
    const registry = new ModRegisteredTools(tools => seen.push(tools.map(t => `${t.modPlugin}:${t.name}`)))
    expect(registry.register(modToolSpecOf({ name: 'a', description: 'one' }), 'p')).toBe('mcp__p__a')
    registry.register(modToolSpecOf({ name: 'b', description: 'two' }), 'p')
    registry.register(modToolSpecOf({ name: 'a', description: 'one again' }), 'p')
    registry.register(modToolSpecOf({ name: 'a', description: 'other plugin' }), 'q')
    expect(registry.list().map(t => t.name)).toEqual(['mcp__p__a', 'mcp__p__b', 'mcp__q__a'])
    registry.forget('p')
    expect(registry.list().map(t => t.name)).toEqual(['mcp__q__a'])
    registry.forget('nobody')
    expect(seen).toHaveLength(5)
  })
})

describe('where a registered tool waits', () => {
  const waiting = buildModTool('mod-sea', modToolSpecOf({ name: 'tide', description: 'Tides.' }))
  const inFront = buildModTool('mod-sea', modToolSpecOf({ name: 'wave', description: 'Waves.', isDeferred: false }))
  const units = new Map([
    [waiting.name, waiting.modDeferred],
    [inFront.name, inFront.modDeferred],
  ])
  const state = (activeSkills: string[] = []) => ({ activeSkills }) as unknown as WorkingState

  it('behind ToolSearch unless it said false, each its own unit that ToolSearch loads by name', () => {
    const key = {}
    registerDeferrableSkills([{ name: 'browser', defaultDeferred: true }], key)
    registerExtensionToolUnits(units, key)
    expect(shouldHideToolFromModel(waiting, state(), key)).toBe(true)
    expect(shouldHideToolFromModel(inFront, state(), key)).toBe(false)
    expect(loadableTools([waiting, inFront], key).map(t => t.name)).toEqual([waiting.name])
    // ToolSearch `select:` activates the tool's own unit.
    expect(owningUnit(waiting, key)).toBe(waiting.name)
    let appState = state()
    activateSkills(write => (appState = write(appState)), [owningUnit(waiting, key)!], key)
    expect(shouldHideToolFromModel(waiting, appState, key)).toBe(false)
  })

  it('in front while nothing else waits, since no ToolSearch is offered to load it', () => {
    const key = {}
    registerDeferrableSkills([], key)
    registerExtensionToolUnits(units, key)
    expect(shouldHideToolFromModel(waiting, state(), key)).toBe(false)
    expect(loadableTools([waiting, inFront], key)).toEqual([])
  })

  it('in front in a loop whose tools hold no ToolSearch, though other units wait there', () => {
    const scoped = {}
    registerDeferrableSkills([{ name: 'browser', defaultDeferred: true }], scoped)
    registerExtensionToolUnits(units, scoped, [{ name: 'Read' }, waiting, inFront])
    expect(shouldHideToolFromModel(waiting, state(), scoped)).toBe(false)
    const offered = {}
    registerDeferrableSkills([{ name: 'browser', defaultDeferred: true }], offered)
    registerExtensionToolUnits(units, offered, [{ name: 'ToolSearch' }, waiting, inFront])
    expect(shouldHideToolFromModel(waiting, state(), offered)).toBe(true)
  })

  it("an extension's own call reaches a waiting tool; the model's call is refused until it is loaded", () => {
    const key = {}
    registerDeferrableSkills([{ name: 'browser', defaultDeferred: true }], key)
    registerExtensionToolUnits(units, key, [{ name: 'ToolSearch' }, waiting])
    const context = createNoopToolUseContext({
      tools: [waiting],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
      sessionId: 'sess-wait',
    })
    context.options.runtimeConfig = key as never
    const block = { type: 'tool-call', toolCallId: 't1', toolName: waiting.name, args: {} } as QueryToolUseBlock
    expect(admitToolCall(block, context).refusal?.content).toContain('ToolSearch')
    expect(admitToolCall(block, context, { fromExtension: true }).refusal).toBeUndefined()
  })

  it("a runtime's units are its own: a sibling runtime's registration leaves them be", () => {
    const mine = {}
    const sibling = {}
    registerDeferrableSkills([{ name: 'browser', defaultDeferred: true }], mine)
    registerDeferrableSkills([{ name: 'browser', defaultDeferred: true }], sibling)
    registerExtensionToolUnits(units, mine)
    registerExtensionToolUnits(new Map(), sibling)
    expect(shouldHideToolFromModel(waiting, state(), mine)).toBe(true)
    expect(shouldHideToolFromModel(waiting, state(), sibling)).toBe(false)
  })
})

describe('$.tool.register through the runtime', () => {
  let uniq = 0
  function world(modules: Record<string, string>, host: Partial<ModNounHost> = {}) {
    const reports: string[] = []
    const refs: ModModuleRef[] = Object.keys(modules).map(plugin => ({ plugin, path: `/plugins/${plugin}/hooks/register.js` }))
    const runtime = new ModRuntime({
      modules: refs,
      readModule: async path => `${modules[path.split('/')[2]!]}\n// load ${++uniq}`,
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
      session: { id: () => 's', cwd: () => '/work/project', ...host },
      report: line => reports.push(line),
    })
    runtimes.push(runtime)
    return { runtime, reports }
  }

  it('a mod registers at session.start; a guard rewrites the description, never the name; a bad spec is refused by name; the plugin unloading forgets its tools', async () => {
    const registry = new ModRegisteredTools(() => {})
    const forgotten: string[] = []
    const { runtime, reports } = world(
      {
        guard: `
          export function register(on) {
            on('tool.register', ($, e, next) => next({ ...e, name: 'hijacked', description: e.description + ' (reviewed)' }));
          }
        `,
        weather: `
          export function register(on) {
            on('session.start', async ($, e, next) => {
              const ok = await $.tool.register({ name: 'weather', description: 'Weather.', inputSchema: { properties: { city: { type: 'string' } } } });
              const bad = await $.tool.register({ name: 'no spaces here?', description: 'x' }).catch(err => err.name + ': ' + err.message);
              await $.ui.log(JSON.stringify({ ok, bad }));
              return next(e);
            });
            on('tool.call', { tool: 'mcp__weather__weather' }, ($, e) => ({ result: { city: e.city, temp: 21 } }));
          }
        `,
      },
      {
        tools: {
          list: async () => registry.list().map(t => ({ name: t.name, description: '', mcp: true })),
          call: async () => ({}),
          check: async () => ({ decision: 'allow' as const }),
          register: (spec, plugin) => registry.register(spec, plugin),
          forget: plugin => forgotten.push(plugin),
        },
      },
    )
    await runtime.ready
    const line = reports.find(r => r.startsWith('weather: {'))!
    expect(JSON.parse(line.slice('weather: '.length))).toEqual({
      ok: { tool: 'mcp__weather__weather' },
      bad: 'TypeError: $.tool.register: name must be letters, digits, "_" or "-", up to 64',
    })
    const [tool] = registry.list()
    expect(tool!.name).toBe('mcp__weather__weather')
    expect(await tool!.description({}, {} as never)).toBe('Weather. (reviewed)')
    expect(tool!.argsSchema).toEqual({ type: 'object', properties: { city: { type: 'string' } } })
    // A `tool.call` of the registered tool is the plugin's hook's to answer.
    expect(runtime.dispatcher.hasHooksFor('tool.call')).toBe(true)
    // The plugin removed from the slot's list: its tools go with it.
    await runtime.reconcile([{ plugin: 'guard', path: '/plugins/guard/hooks/register.js' }])
    expect(forgotten).toEqual(['weather'])
    // A teardown forgets every plugin's.
    runtime.dispose()
    expect(forgotten).toEqual(['weather', 'guard'])
  })

  it("a guard reads isDeferred on the event and may move the tool; a non-boolean is refused by name", async () => {
    const registry = new ModRegisteredTools(() => {})
    const { runtime, reports } = world(
      {
        guard: `
          export function register(on) {
            on('tool.register', async ($, e, next) => {
              await $.ui.log('saw ' + e.isDeferred);
              return next(e.name === 'pinned' ? { ...e, isDeferred: false } : e);
            });
          }
        `,
        sea: `
          export function register(on) {
            on('session.start', async ($, e, next) => {
              await $.tool.register({ name: 'tide', description: 'Tides.', isDeferred: true });
              await $.tool.register({ name: 'pinned', description: 'Pinned.' });
              const bad = await $.tool.register({ name: 'x', description: 'y', isDeferred: 1 }).catch(err => err.message);
              await $.ui.log(bad);
              return next(e);
            });
          }
        `,
      },
      {
        tools: {
          list: async () => [],
          call: async () => ({}),
          check: async () => ({ decision: 'allow' as const }),
          register: (spec, plugin) => registry.register(spec, plugin),
          forget: () => {},
        },
      },
    )
    await runtime.ready
    expect(reports).toEqual([
      'guard: saw true',
      'guard: saw undefined',
      'sea: $.tool.register: isDeferred must be true, false or left out',
    ])
    expect(registry.list().map(t => `${t.name}: ${t.modDeferred}`)).toEqual([
      'mcp__sea__tide: true',
      'mcp__sea__pinned: false',
    ])
  })

  it('a host that does not list tools refuses the noun by name', async () => {
    const { runtime, reports } = world({
      probe: `
        export function register(on) {
          on('prompt.submit', async ($, e, next) => {
            await $.ui.log(await $.tool.register({ name: 'x', description: 'y' }).catch(err => err.name + ': ' + err.message));
            return next(e);
          });
        }
      `,
    })
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(reports).toEqual(['probe: NotSupportedError: $.tool.register is not available: this session has no tools to run'])
  })
})

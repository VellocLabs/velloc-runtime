/**
 * `$.tool.register` (F-25) — the spec checked, the full name
 * `mcp__<plugin>__<name>`, a registered tool's core failing ("a call no
 * hook answers fails"), the registry replacing by name and forgetting a
 * plugin's tools; the noun through a real `ModRuntime`: a mod registers, a
 * guard hooking `tool.register` rewrites the description but not the name,
 * a bad spec is refused by name, a host that does not list tools refuses it.
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

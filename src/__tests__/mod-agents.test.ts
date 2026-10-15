/**
 * `$.agent` (F-25): the spec checked into the Agent tool's definition (`<plugin>:<name>`, `source: 'plugin'`), the
 * spawn arguments and Agent tool input, the agent id and a denial read off the tool's text; through a real
 * `ModRuntime`: register at `session.start`, a guard rewriting the description, spawn/list over a fake host, and
 * the refusals.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ModNounHost } from '../mods/modNouns'
import {
  ModRegisteredAgents,
  agentIdOfLaunch,
  agentInfoOf,
  agentToolInputOf,
  buildModAgentDefinition,
  denialOfLaunch,
  isModRegisteredAgent,
  modAgentFullName,
  modAgentSpawnArgsOf,
  modAgentSpecOf,
  type ModAgentHost,
} from '../mods/modAgents'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

describe('the spec and the definition', () => {
  it('checks the spec field by field and keeps the fields it does not name', () => {
    const spec = modAgentSpecOf({
      name: 'runner',
      description: 'Runs a spec',
      prompt: 'You run specs.',
      tools: ['Read', 'Bash'],
      model: 'haiku',
      effort: 'low',
      permissionMode: 'plan',
      maxTurns: 4,
      skills: ['s1'],
      omitInstructionFiles: true,
    })
    expect(spec).toEqual({
      name: 'runner',
      description: 'Runs a spec',
      prompt: 'You run specs.',
      tools: ['Read', 'Bash'],
      model: 'haiku',
      effort: 'low',
      permissionMode: 'plan',
      maxTurns: 4,
      skills: ['s1'],
      omitInstructionFiles: true,
    })
    expect(() => modAgentSpecOf({ name: 'a b', description: 'x', prompt: 'y' })).toThrow(/name must be/)
    expect(() => modAgentSpecOf({ name: 'a', description: '', prompt: 'y' })).toThrow(/description/)
    expect(() => modAgentSpecOf({ name: 'a', description: 'x', prompt: ' ' })).toThrow(/prompt/)
    expect(() => modAgentSpecOf({ name: 'a', description: 'x', prompt: 'y', tools: 'Read' })).toThrow(/tools/)
    expect(() => modAgentSpecOf({ name: 'a', description: 'x', prompt: 'y', effort: 'huge' })).toThrow(/effort/)
    expect(() => modAgentSpecOf({ name: 'a', description: 'x', prompt: 'y', permissionMode: 'yolo' })).toThrow(/permissionMode/)
    expect(() => modAgentSpecOf({ name: 'a', description: 'x', prompt: 'y', maxTurns: 0 })).toThrow(/maxTurns/)
  })

  it('the definition the Agent tool reads: the full name, the system prompt, the plugin as its source', () => {
    const definition = buildModAgentDefinition('lab', modAgentSpecOf({ name: 'runner', description: 'Runs', prompt: 'P', tools: ['Read'], disallowedTools: ['Bash'], model: 'opus', effort: 'low' }))
    expect(modAgentFullName('lab', 'runner')).toBe('lab:runner')
    expect(definition).toEqual({
      name: 'lab:runner',
      description: 'Runs',
      systemPrompt: 'P',
      tools: ['Read'],
      disallowedTools: ['Bash'],
      model: 'opus',
      effort: 'low',
      source: 'plugin',
      pluginName: 'lab',
      modPlugin: 'lab',
    })
    expect(isModRegisteredAgent(definition)).toBe(true)
    const explore: { name: string; modPlugin?: unknown } = { name: 'Explore' }
    expect(isModRegisteredAgent(explore)).toBe(false)
  })

  it('the registry replaces by name, forgets a plugin, and tells its listener', () => {
    const seen: string[][] = []
    const registry = new ModRegisteredAgents(agents => seen.push(agents.map(a => a.name)))
    expect(registry.register(modAgentSpecOf({ name: 'a', description: 'd', prompt: 'p' }), 'p')).toBe('p:a')
    registry.register(modAgentSpecOf({ name: 'a', description: 'd2', prompt: 'p' }), 'p')
    registry.register(modAgentSpecOf({ name: 'a', description: 'd', prompt: 'p' }), 'q')
    expect(registry.list().map(a => [a.name, a.description])).toEqual([['p:a', 'd2'], ['q:a', 'd']])
    registry.forget('p')
    expect(registry.list().map(a => a.name)).toEqual(['q:a'])
    expect(seen).toHaveLength(4)
  })
})

describe('a spawn and the list', () => {
  it('the spawn arguments become a background Agent tool call; the id and a denial are read off the tool\'s text', () => {
    expect(modAgentSpawnArgsOf({ prompt: 'Read README.md.', subagentType: 'lab:runner', model: 'haiku' })).toEqual({
      prompt: 'Read README.md.',
      subagentType: 'lab:runner',
      model: 'haiku',
    })
    expect(() => modAgentSpawnArgsOf({ prompt: '' })).toThrow(/prompt/)
    expect(() => modAgentSpawnArgsOf({ prompt: 'x', model: 3 })).toThrow(/model/)
    expect(agentToolInputOf({ prompt: 'Read the README and summarize it for me please', subagentType: 'Explore' })).toEqual({
      tool: 'Agent',
      prompt: 'Read the README and summarize it for me please',
      description: 'Read the README and summarize',
      subagent_type: 'Explore',
      run_in_background: true,
    })
    expect(agentIdOfLaunch('Launched background sub-agent "x" (Explore) (task id subagent-abc-1). It runs…')).toBe('subagent-abc-1')
    expect(agentIdOfLaunch('(task id s-9)\n\nthe output')).toBe('s-9')
    expect(agentIdOfLaunch('Agent could not start: GUARD refused')).toBeUndefined()
    expect(denialOfLaunch('Agent could not start: GUARD refused')).toBe('GUARD refused')
    expect(denialOfLaunch('Launched background sub-agent')).toBeUndefined()
  })

  it("a controller row as AgentInfo, the engine's statuses spelled as the declaration's", () => {
    const row = { sessionId: 'subagent-1', status: 'success' as const, description: 'read it', agentType: 'Explore', startedAt: 1 }
    expect(agentInfoOf(row)).toEqual({ id: 'subagent-1', description: 'read it', type: 'Explore', status: 'completed' })
    expect(agentInfoOf({ ...row, status: 'error', agentType: undefined }, 'lab')).toMatchObject({ type: 'general-purpose', status: 'failed', spawnedBy: 'lab' })
    expect(agentInfoOf({ ...row, status: 'stopped' }).status).toBe('killed')
    expect(agentInfoOf({ ...row, status: 'running' }).status).toBe('running')
  })
})

describe('$.agent through the runtime', () => {
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

  it('a mod registers at session.start (the guard rewrites the description, never the name), spawns, lists; bad arguments are refused by name; its plugin unloading forgets its types', async () => {
    const registry = new ModRegisteredAgents(() => {})
    const spawned: unknown[] = []
    const forgotten: string[] = []
    const agents: ModAgentHost = {
      register: (spec, plugin) => registry.register(spec, plugin),
      forget: plugin => forgotten.push(plugin),
      list: () => [{ id: 'subagent-7', description: 'read it', type: 'lab:runner', status: 'running' }],
      spawn: async args => {
        spawned.push(args)
        return args.subagentType === 'nope' ? { deny: 'no such type' } : { model: 'm-1', agentId: 'subagent-7' }
      },
    }
    const { runtime, reports } = world(
      {
        guard: `
          export function register(on) {
            on('agent.register', ($, e, next) => next({ ...e, name: 'hijacked', description: e.description + ' (reviewed)' }));
          }
        `,
        lab: `
          export function register(on) {
            on('session.start', async ($, e, next) => {
              const ok = await $.agent.register({ name: 'runner', description: 'Runs a spec', prompt: 'You run specs.', tools: ['Read'] });
              const bad = await $.agent.register({ name: 'runner', description: 'x' }).catch(err => err.name + ': ' + err.message);
              const started = await $.agent.spawn({ prompt: 'Read README.md.', subagentType: 'lab:runner' });
              const denied = await $.agent.spawn({ prompt: 'x', subagentType: 'nope' });
              const badSpawn = await $.agent.spawn({}).catch(err => err.name + ': ' + err.message);
              const list = await $.agent.list();
              await $.ui.log(JSON.stringify({ ok, bad, started, denied, badSpawn, list }));
              return next(e);
            });
          }
        `,
      },
      { agents },
    )
    await runtime.ready
    const line = reports.find(r => r.startsWith('lab: {'))!
    expect(JSON.parse(line.slice('lab: '.length))).toEqual({
      ok: { agent: 'lab:runner' },
      bad: 'TypeError: $.agent.register: prompt must be a non-empty string',
      started: { model: 'm-1', agentId: 'subagent-7' },
      denied: { deny: 'no such type' },
      badSpawn: 'TypeError: $.agent.spawn(input): input.prompt must be a non-empty string',
      list: [{ id: 'subagent-7', description: 'read it', type: 'lab:runner', status: 'running' }],
    })
    const [definition] = registry.list()
    expect(definition).toMatchObject({ name: 'lab:runner', description: 'Runs a spec (reviewed)', systemPrompt: 'You run specs.', tools: ['Read'], source: 'plugin', pluginName: 'lab' })
    expect(spawned).toEqual([
      { prompt: 'Read README.md.', subagentType: 'lab:runner' },
      { prompt: 'x', subagentType: 'nope' },
    ])
    await runtime.reconcile([{ plugin: 'guard', path: '/plugins/guard/hooks/register.js' }])
    expect(forgotten).toEqual(['lab'])
  })

  it('a host without an Agent tool refuses the noun by name', async () => {
    const { runtime, reports } = world({
      probe: `
        export function register(on) {
          on('prompt.submit', async ($, e, next) => {
            await $.ui.log(await $.agent.list().catch(err => err.name + ': ' + err.message));
            return next(e);
          });
        }
      `,
    })
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(reports).toEqual(['probe: NotSupportedError: $.agent is not available: this session has no Agent tool'])
  })
})

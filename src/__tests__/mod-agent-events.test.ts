/**
 * `agent.offer` and `agent.spawn` (F-25) through a real
 * `ModRuntime`, the helpers the Agent tool calls, and the tool's call site
 * pinned by its source: an agent kept out of the listing and refused at
 * dispatch; a spawn's prompt / description / type / model / background
 * rewritten, its model picked by a hook, or the spawn denied; the pins; a
 * failing hook leaving the spawn as decided.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { declareTool, type ToolContract } from '../toolkit/toolContract'
import { engineWorld } from './engine-replay/harness/world'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import {
  ENGINE_PROVIDER,
  isAgentSpawnResult,
  spawnInputProblem,
  type AgentSpawnInput,
} from '../mods/agentEvents'
import {
  agentOfferedThroughMods,
  agentSpawnThroughMods,
  describeAgentForOffer,
  offeredAgentsThroughMods,
} from '../agents/agentEventsThroughMods'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

let uniq = 0

function world(sources: Record<string, string>) {
  const reports: string[] = []
  const modules: ModModuleRef[] = Object.keys(sources).map(path => ({ plugin: path.split('/')[0]!, path }))
  const runtime = new ModRuntime({
    modules,
    readModule: async path => `${sources[path]!}\n// load ${++uniq}`,
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
  return { runtime, reports }
}

const SPAWN: AgentSpawnInput = {
  tool_use_id: 'call-9',
  prompt: 'survey the repo',
  description: 'survey',
  subagentType: 'Explore',
  provider: ENGINE_PROVIDER,
  parentModel: 'claude-opus-5-5',
  permissionMode: 'default',
  background: false,
  fork: false,
}

describe('the shapes', () => {
  it('describeAgentForOffer reads useWhen, then description; the source; the engine as provider', () => {
    expect(describeAgentForOffer({ name: 'Explore', useWhen: 'to look around', source: 'built-in' })).toEqual({
      agent: 'Explore',
      description: 'to look around',
      source: 'built-in',
      provider: { plugin: 'engine', tier: 'core' },
    })
    expect(describeAgentForOffer({ name: 'mine', description: 'd' })).toMatchObject({ description: 'd', source: 'built-in' })
  })

  it('the spawn result: { model } or a non-empty deny', () => {
    expect(isAgentSpawnResult({ model: 'haiku' })).toBe(true)
    expect(isAgentSpawnResult({ deny: 'no' })).toBe(true)
    expect(isAgentSpawnResult({ deny: '' })).toBe(false)
    expect(isAgentSpawnResult({ agentId: 'x' })).toBe(false)
  })

  it('a rewritten spawn: the rewritable fields of the right kind, the pins kept, a fork dispatching no other', () => {
    expect(spawnInputProblem(SPAWN, { ...SPAWN, prompt: 'p2', model: 'haiku', background: true })).toBeNull()
    expect(spawnInputProblem(SPAWN, { ...SPAWN, tool_use_id: 'other' })).toBe('tool_use_id is pinned')
    expect(spawnInputProblem(SPAWN, { ...SPAWN, parentModel: 'x' })).toBe('parentModel is pinned')
    expect(spawnInputProblem(SPAWN, { ...SPAWN, provider: { plugin: 'me', tier: 'user' } })).toBe('provider is pinned')
    expect(spawnInputProblem(SPAWN, { ...SPAWN, prompt: '' })).toBe('prompt is not a non-empty string')
    expect(spawnInputProblem(SPAWN, { ...SPAWN, background: 'yes' })).toBe('background is not a boolean')
    expect(spawnInputProblem(SPAWN, { ...SPAWN, extra: 1 })).toBe('extra is not a field of agent.spawn')
    expect(spawnInputProblem({ ...SPAWN, fork: true, subagentType: 'fork' }, { ...SPAWN, fork: true, subagentType: 'Explore' })).toBe(
      'a fork dispatches no other agent',
    )
    // Left out, a pin is kept.
    expect(spawnInputProblem(SPAWN, { prompt: 'p', description: 'd', subagentType: 'Explore', background: false })).toBeNull()
  })
})

describe('agent.offer through the runtime', () => {
  it('a hook keeps one type out; the others are offered; the listing helper filters the same way', async () => {
    const { runtime } = world({
      'noplan/hooks/register.js': `
        export function register(on) {
          on('agent.offer', { agent: 'Plan' }, () => ({ isOffered: false }));
        }
      `,
    })
    await runtime.ready
    expect(runtime.hasAgentOfferHooks()).toBe(true)
    expect(await runtime.agentOffer(describeAgentForOffer({ name: 'Plan', useWhen: 'plans' }))).toBe(false)
    expect(await runtime.agentOffer(describeAgentForOffer({ name: 'Explore', useWhen: 'looks' }))).toBe(true)
    const kept = await offeredAgentsThroughMods(runtime, [{ name: 'Explore' }, { name: 'Plan' }, { name: 'general-purpose' }])
    expect(kept.map(agent => agent.name)).toEqual(['Explore', 'general-purpose'])
    expect(await agentOfferedThroughMods(runtime, { name: 'Plan' })).toBe(false)
  })

  it('a hook that throws, or answers the wrong shape, offers the agent; no hook costs nothing', async () => {
    const { runtime, reports } = world({
      'bad/hooks/register.js': `
        export function register(on) {
          on('agent.offer', { agent: 'A' }, () => { throw new Error('no') });
          on('agent.offer', { agent: 'B' }, () => ({ offered: false }));
        }
      `,
    })
    await runtime.ready
    expect(await runtime.agentOffer(describeAgentForOffer({ name: 'A' }))).toBe(true)
    expect(await runtime.agentOffer(describeAgentForOffer({ name: 'B' }))).toBe(true)
    expect(reports).toHaveLength(2)
    expect(await offeredAgentsThroughMods(undefined, [{ name: 'A' }])).toEqual([{ name: 'A' }])
    expect(await offeredAgentsThroughMods({ hasAgentOfferHooks: () => false }, [{ name: 'A' }])).toEqual([{ name: 'A' }])
  })
})

describe('agent.spawn through the runtime', () => {
  it("a hook rewrites the prompt, the type and the background on the way down; core resolves the model for what it is handed; next's answer is the decision", async () => {
    const { runtime, reports } = world({
      'shape/hooks/register.js': `
        export function register(on) {
          on('agent.spawn', { subagentType: 'Explore' }, async ($, e, next) => {
            const result = await next({ ...e, prompt: e.prompt + ' (quietly)', subagentType: 'general-purpose', background: true, model: 'fast' });
            await $.ui.log('resolved ' + result.model);
            return result;
          });
        }
      `,
    })
    await runtime.ready
    const cores: AgentSpawnInput[] = []
    const settled = await runtime.agentSpawn(SPAWN, e => {
      cores.push(e)
      return { model: `${e.model ?? 'inherit'}->claude-haiku` }
    })
    expect(cores).toHaveLength(1)
    expect(cores[0]).toMatchObject({ prompt: 'survey the repo (quietly)', subagentType: 'general-purpose', background: true, model: 'fast' })
    expect(settled).toEqual({
      prompt: 'survey the repo (quietly)',
      description: 'survey',
      subagentType: 'general-purpose',
      // Core's answer relayed unchanged is the engine's own choice, made
      // again from the input: the decision carries the alias handed down.
      model: 'fast',
      background: true,
    })
    expect(reports).toEqual(['shape: resolved fast->claude-haiku'])
  })

  it('a hook answers { model } of its own without next: no core, the alias is the decision; { deny } refuses the spawn', async () => {
    const { runtime } = world({
      'pick/hooks/register.js': `
        export function register(on) {
          on('agent.spawn', ($, e) => e.description === 'deny me' ? { deny: 'not today' } : { model: 'haiku' });
        }
      `,
    })
    await runtime.ready
    let cores = 0
    expect(await runtime.agentSpawn(SPAWN, () => (cores++, { model: 'x' }))).toEqual({
      prompt: 'survey the repo',
      description: 'survey',
      subagentType: 'Explore',
      model: 'haiku',
      background: false,
    })
    expect(cores).toBe(0)
    expect(await runtime.agentSpawn({ ...SPAWN, description: 'deny me' }, () => ({ model: 'x' }))).toEqual({ deny: 'not today' })
  })

  it("a pass-through hook leaves the model as the call asked: core's resolved id never comes back as a tier to resolve", async () => {
    const { runtime } = world({
      'log/hooks/register.js': `
        export function register(on) {
          on('*', ($, e, next) => next(e));
        }
      `,
    })
    await runtime.ready
    const core = (e: AgentSpawnInput) => ({ model: e.model === 'fast' ? 'claude-haiku-4-5' : 'claude-opus-5-5' })
    expect(await runtime.agentSpawn(SPAWN, core)).not.toHaveProperty('model')
    expect(await runtime.agentSpawn({ ...SPAWN, model: 'fast' }, core)).toMatchObject({ model: 'fast' })
  })

  it('a hook that moves a pin, or throws, leaves the spawn as decided, each named; no hook costs nothing', async () => {
    const { runtime, reports } = world({
      'bad/hooks/register.js': `
        export function register(on) {
          on('agent.spawn', ($, e, next) => e.description === 'pin' ? next({ ...e, parentModel: 'other' }) : (() => { throw new Error('boom') })());
        }
      `,
    })
    await runtime.ready
    const decided = { prompt: 'survey the repo', description: 'pin', subagentType: 'Explore', background: false }
    expect(await runtime.agentSpawn({ ...SPAWN, description: 'pin' }, () => ({ model: 'x' }))).toEqual(decided)
    // A hook that throws before next is skipped by the chain, which runs core
    // in its place: core's own model is not handed back as a choice.
    expect(await runtime.agentSpawn(SPAWN, () => ({ model: 'x' }))).toEqual({ ...decided, description: 'survey' })
    expect(reports).toEqual([
      'mods: agent.spawn (Explore) failed: the rewritten event is refused: parentModel is pinned; the subagent starts as decided',
      expect.stringMatching(/^bad: agent\.spawn .*boom/),
    ])
    expect(await agentSpawnThroughMods(undefined, SPAWN, () => ({ model: 'x' }))).toEqual({ ...decided, description: 'survey' })
  })
})

describe('the Agent tool raises them', () => {
  it('offers the listing and the dispatched type through the mods, and raises agent.spawn before the route and the tier are read', () => {
    const source = readFileSync(join(__dirname, '..', 'toolkit', 'builtin', 'subagentLaunch.ts'), 'utf8')
    expect(source).toContain('offeredAgentsThroughMods(')
    const offer = source.indexOf('agentOfferedThroughMods(mods, preRoute.agent)')
    const spawn = source.indexOf('agentSpawnThroughMods(')
    const route = source.indexOf('const route = resolveSubagentRoute(')
    expect(offer).toBeGreaterThan(0)
    expect(spawn).toBeGreaterThan(offer)
    expect(route).toBeGreaterThan(spawn)
    // Background is read from the settled input, and a rewritten type is held
    // to the Agent(<type>) deny rules the gate applied to the model's.
    expect(source.indexOf('const runInBackground =')).toBeGreaterThan(spawn)
    expect(source.indexOf('withoutBlockedAgents([{ name: rewritten }]')).toBeGreaterThan(spawn)
  })

  it("the schema render hands every tool's description the session's mods", async () => {
    // The Agent tool's description lists the agents through the mods; any
    // tool's description sees the same mods the turn runs with.
    const seen: unknown[] = []
    const probe = declareTool({
      name: 'Probe',
      argsSchema: { type: 'object' as const, properties: {} },
      description: async (_input: unknown, options: { mods?: unknown }) => {
        seen.push(options.mods)
        return 'Probe tool.'
      },
      call: async () => ({ data: 'ok' }),
    }) as unknown as ToolContract
    const w = engineWorld({
      mods: {},
      extraTools: [probe],
      replies: [{ label: 'answer', text: 'Answer.' }, { label: 'title', querySource: 'rename_generate_name', text: 'A title' }],
    })
    await w.submit('hello')
    await w.finish()
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(mods => mods === w.mods)).toBe(true)
  })
})

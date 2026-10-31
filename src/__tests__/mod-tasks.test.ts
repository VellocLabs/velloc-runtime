/**
 * `$.task` (F-25) through a real `ModRuntime` over a real `PluginTaskCoordinator`: a plugin starts, reports,
 * lists and finishes its own task; a guard above sees and denies the calls; `task.stop` reaches the owning
 * plugin; `$.agent.spawn({ task })` ties a subagent to the task; bad input and a missing host are refused by name.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ModNounHost } from '../mods/modNouns'
import type { ModAgentHost } from '../mods/modAgents'
import { modTaskFinishArgsOf, modTaskProgressArgsOf, modTaskStartArgsOf, type ModTaskHost } from '../mods/modTasks'
import { TaskRegistry } from '../browser/worker/TaskRegistry'
import { PluginTaskCoordinator, type PluginTaskStopEvent } from '../browser/worker/PluginTaskCoordinator'
import type { NexusFinishedTaskRecord, NexusTaskDeliveryResult, NexusTaskState } from '../browser/worker/taskTypes'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

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

/** The session's plugin tasks, as the session manager keeps them, for session `s`. */
function sessionTasks() {
  const registry = new TaskRegistry<NexusTaskState, NexusFinishedTaskRecord>()
  const delivered: NexusTaskDeliveryResult[] = []
  const stopsRaised: PluginTaskStopEvent[] = []
  const stoppedAgents: string[] = []
  let seq = 0
  const coordinator = new PluginTaskCoordinator(registry, {
    scheduleSummary: () => {},
    mintTaskHandle: () => `p${++seq}`,
    deliverResult: (_parent, result) => delivered.push(result),
    dropPendingResult: () => {},
    evictFinishedOverCap: (kind, cap) => registry.evictFinishedOverCap(kind, cap),
    persist: () => {},
    raiseStop: (_parent, e) => stopsRaised.push(e),
    stopAgent: agentId => stoppedAgents.push(agentId),
  })
  const tasks: ModTaskHost = {
    start: (args, plugin) => ({ taskId: coordinator.start({ spawnerSessionId: 's', plugin, ...modTaskStartArgsOf(args) }) }),
    progress: (taskId, update, plugin) => coordinator.progress('s', plugin, taskId, update),
    finish: (taskId, outcome, plugin) => coordinator.finish('s', plugin, taskId, outcome),
    list: async plugin => coordinator.list('s', plugin),
    adoptChild: (taskId, agentId, plugin) => coordinator.adoptChild('s', plugin, taskId, agentId),
  }
  return { coordinator, tasks, delivered, stopsRaised, stoppedAgents }
}

const lineOf = (reports: string[], plugin: string) => {
  const line = reports.find(r => r.startsWith(`${plugin}: {`))
  return line ? JSON.parse(line.slice(plugin.length + 2)) : undefined
}

describe('$.task through the runtime', () => {
  it('a plugin starts, reports, lists and finishes its own task; another plugin cannot touch it', async () => {
    const { tasks, delivered } = sessionTasks()
    const { runtime, reports } = world(
      {
        flow: `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => {
              const { taskId } = await $.task.start({ kind: 'review', title: '  Review the diff  ' });
              await $.task.progress(taskId, { text: 'step 1', items: [{ id: 'a', label: 'lint', status: 'done' }] });
              const running = (await $.task.list()).map(t => t.status);
              await $.task.finish(taskId, { result: 'clean' });
              const after = (await $.task.list()).map(t => t.title + ' ' + t.status);
              const again = await $.task.finish(taskId, { result: 'x' }).catch(err => err.name);
              await $.ui.log(JSON.stringify({ taskId, running, after, again }));
              return next(e);
            });
          }
        `,
        other: `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => {
              const mine = await $.task.list();
              const poke = await $.task.progress('p1', { text: 'hi' }).catch(err => err.name);
              await $.ui.log(JSON.stringify({ mine, poke }));
              return next(e);
            });
          }
        `,
      },
      { tasks },
    )
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(lineOf(reports, 'flow')).toEqual({
      taskId: 'p1',
      running: ['running'],
      after: ['Review the diff completed'],
      again: 'InvalidStateError',
    })
    expect(lineOf(reports, 'other')).toEqual({ mine: [], poke: 'NotFoundError' })
    expect(delivered).toEqual([expect.objectContaining({ type: 'local_plugin', taskId: 'p1', plugin: 'flow', summary: 'clean' })])
  })

  it('each call is an op event: a guard above sees it and can deny it; bad input is refused before any hook', async () => {
    const { tasks } = sessionTasks()
    const { runtime, reports } = world(
      {
        guard: `
          export function register(on) {
            on('task.start', ($, e, next) => e.kind === 'forbidden' ? { deny: 'no ' + e.kind } : next(e));
            on('task.finish', async ($, e, next) => { await $.ui.log('finish ' + e.taskId + ' ' + e.outcome.result); return next(e); });
          }
        `,
        flow: `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => {
              const denied = await $.task.start({ kind: 'forbidden', title: 't' }).catch(err => err.name + ': ' + err.message);
              const { taskId } = await $.task.start({ kind: 'ok', title: 't' });
              await $.task.finish(taskId, { result: 'done' });
              const bad = await Promise.all([
                $.task.start({ kind: 'has space', title: 't' }).catch(err => err.name),
                $.task.start({ kind: 'ok', title: '' }).catch(err => err.name),
                $.task.start({ kind: 'ok', title: 't', children: 'kill' }).catch(err => err.name),
                $.task.progress(taskId, { items: [{ id: 1 }] }).catch(err => err.name),
                $.task.finish(taskId, { result: 7 }).catch(err => err.name),
              ]);
              await $.ui.log(JSON.stringify({ denied, bad }));
              return next(e);
            });
          }
        `,
      },
      { tasks },
    )
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(lineOf(reports, 'flow')).toEqual({
      denied: 'DeniedError: no forbidden',
      bad: ['TypeError', 'TypeError', 'TypeError', 'TypeError', 'TypeError'],
    })
    expect(reports).toContain('guard: finish p1 done')
  })

  it('a stop asked of the task reaches the plugin as task.stop; the plugin finishes it and its tied subagent is stopped', async () => {
    const { coordinator, tasks, stopsRaised, stoppedAgents, delivered } = sessionTasks()
    const spawned: unknown[] = []
    const agents: ModAgentHost = {
      register: () => '',
      forget: () => {},
      list: () => [],
      spawn: async args => {
        spawned.push(args)
        return { agentId: `a${spawned.length}`, model: 'm' }
      },
      wait: async () => {
        throw new Error('unused')
      },
    }
    const { runtime, reports } = world(
      {
        flow: `
          export function register(on) {
            on('prompt.submit', async ($, e, next) => {
              const { taskId } = await $.task.start({ kind: 'fanout', title: 'Fan out' });
              const child = await $.agent.spawn({ prompt: 'look', description: 'look', task: taskId });
              const stray = await $.agent.spawn({ prompt: 'p', description: 'd', task: 'p99' }).catch(err => err.name);
              await $.ui.log(JSON.stringify({ taskId, child, stray }));
              return next(e);
            });
            on('task.stop', async ($, e, next) => {
              await $.task.finish(e.taskId, { result: 'stopped by request' });
              await $.ui.log('stop ' + e.taskId + ' ' + e.kind);
              return next(e);
            });
          }
        `,
      },
      { tasks, agents },
    )
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(lineOf(reports, 'flow')).toEqual({ taskId: 'p1', child: { agentId: 'a1', model: 'm' }, stray: 'NotFoundError' })
    expect(spawned).toHaveLength(1)

    coordinator.stop('p1')
    expect(stopsRaised).toEqual([{ taskId: 'p1', plugin: 'flow', kind: 'fanout' }])
    expect(stoppedAgents).toEqual(['a1'])
    for (const e of stopsRaised) runtime.taskStop(e)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(reports).toContain('flow: stop p1 fanout')
    expect(coordinator.getSnapshot('p1')).toMatchObject({ status: 'stopped', output: 'stopped by request' })
    expect(delivered).toEqual([])
  })

  it('a session that keeps no background tasks refuses the noun by name', async () => {
    const { runtime, reports } = world({
      probe: `
        export function register(on) {
          on('prompt.submit', async ($, e, next) => {
            await $.ui.log(await $.task.list().catch(err => err.name + ': ' + err.message));
            return next(e);
          });
        }
      `,
    })
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(reports).toEqual(['probe: NotSupportedError: $.task is not available: this session keeps no background tasks'])
  })

  it('the argument readers keep only the fields they name', () => {
    expect(modTaskProgressArgsOf(['p1', { text: 't', extra: 1, data: null }])).toEqual({ taskId: 'p1', update: { text: 't', data: null } })
    expect(modTaskFinishArgsOf(['p1', { result: 'r', isError: true }])).toEqual({ taskId: 'p1', outcome: { result: 'r', isError: true } })
    expect(() => modTaskProgressArgsOf(['', {}])).toThrow(TypeError)
  })
})

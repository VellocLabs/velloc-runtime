/**
 * `$.ui.view` (F-25) — `{ agentId }` of a subagent or teammate of this session
 * publishes the view on the slot's UI state, each call a new `seq`; `{}`
 * publishes the way back; an id that is no agent of the session is answered
 * `{ deny }` and publishes nothing; raised as `ui.view`, a hook above may
 * rewrite, answer or deny it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ModNounHost } from '../mods/modNouns'
import type { ModAgentHost } from '../mods/modAgents'
import type { ModUiEvent } from '../mods/modUi'
import { isUiViewResult, uiViewArgsOf } from '../mods/modAgentView'
import { isModsUiState } from '../browser/runtimeProtocol'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

let uniq = 0
function world(modules: Record<string, string>, host: Partial<ModNounHost> = {}) {
  const reports: string[] = []
  const events: ModUiEvent[] = []
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
    onUiChanged: event => events.push(event),
  })
  runtimes.push(runtime)
  const views = () => events.flatMap(event => (event.kind === 'state' && event.state.view ? [event.state.view] : []))
  return { runtime, reports, views }
}

const agents = {
  viewTarget: (agentId: string) =>
    agentId === 'a1' ? { kind: 'subagent' as const, sessionId: 'a1' } : agentId === 'teammate-bo' ? { kind: 'teammate' as const, sessionId: 'teammate-bo' } : undefined,
} as unknown as ModAgentHost

const asker = (calls: string) => `
  export function register(on) {
    on('prompt.submit', async ($, e, next) => {
      const answers = [];
      for (const target of ${calls}) answers.push(await $.ui.view(target).catch(err => err.name + ': ' + err.message));
      await $.ui.log(JSON.stringify(answers));
      return next(e);
    });
  }
`

describe('$.ui.view', () => {
  it('checks its argument and the answers a hook may give', () => {
    expect(uiViewArgsOf({ agentId: 'a1' })).toEqual({ agentId: 'a1' })
    expect(uiViewArgsOf({})).toEqual({})
    expect(() => uiViewArgsOf(undefined)).toThrow('$.ui.view(target): target must be { agentId } or {}')
    expect(() => uiViewArgsOf({ agentId: '' })).toThrow('$.ui.view: agentId must be a non-empty string, or left out to go back')
    expect(() => uiViewArgsOf({ agentId: 3 })).toThrow(TypeError)
    expect(isUiViewResult({})).toBe(true)
    expect(isUiViewResult({ deny: 'no' })).toBe(true)
    expect(isUiViewResult({ deny: 3 })).toBe(false)
  })

  it("publishes a subagent's and a teammate's view, then the way back, each a new seq; an unknown id is denied and publishes nothing", async () => {
    const { runtime, reports, views } = world(
      { viewer: asker(`[{ agentId: 'a1' }, { agentId: 'teammate-bo' }, { agentId: 'nobody' }, {}, { agentId: '' }]`) },
      { agents },
    )
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(JSON.parse(reports.find(r => r.startsWith('viewer: ['))!.slice('viewer: '.length))).toEqual([
      {},
      {},
      { deny: 'no subagent or teammate of this session has the id nobody' },
      {},
      'TypeError: $.ui.view: agentId must be a non-empty string, or left out to go back',
    ])
    expect(views()).toEqual([
      { seq: 1, agentId: 'a1', kind: 'subagent', sessionId: 'a1' },
      { seq: 2, agentId: 'teammate-bo', kind: 'teammate', sessionId: 'teammate-bo' },
      { seq: 3 },
    ])
    // The published state is one the page's guard takes.
    expect(views().every(view => isModsUiState({ status: [], notices: [], view }))).toBe(true)
  })

  it('before the engine binds, every id is denied', async () => {
    const { runtime, reports, views } = world({ viewer: asker(`[{ agentId: 'a1' }]`) })
    await runtime.ready
    await runtime.promptSubmit('go')
    expect(reports).toEqual(['viewer: [{"deny":"no subagent or teammate of this session has the id a1"}]'])
    expect(views()).toEqual([])
  })

  it('is raised as ui.view: a hook above rewrites the id, answers for core, or denies and the call rejects', async () => {
    const { runtime, reports, views } = world(
      {
        guard: `
          export function register(on) {
            on('ui.view', ($, e, next) => {
              if (e.agentId === 'alias') return next({ agentId: 'a1' });
              if (e.agentId === 'quiet') return { value: { deny: 'not now' } };
              if (e.agentId === 'secret') return { deny: 'hidden' };
              return next(e);
            });
          }
        `,
        viewer: asker(`[{ agentId: 'alias' }, { agentId: 'quiet' }, { agentId: 'secret' }]`),
      },
      { agents },
    )
    await runtime.ready
    await runtime.promptSubmit('go')
    const answers = JSON.parse(reports.find(r => r.startsWith('viewer: ['))!.slice('viewer: '.length)) as unknown[]
    expect(answers[0]).toEqual({})
    expect(answers[1]).toEqual({ deny: 'not now' })
    expect(answers[2]).toMatch(/hidden/)
    expect(views()).toEqual([{ seq: 1, agentId: 'a1', kind: 'subagent', sessionId: 'a1' }])
  })
})

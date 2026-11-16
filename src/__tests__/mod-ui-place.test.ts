/**
 * `$.ui.place({ id })` (F-25): a row at the transcript's end, raised as `ui.place`
 * with its id pinned; placed where a page draws the session, the same row for an id
 * that stands, published on the ui state, drawn as the `Placed` site, gone with its
 * plugin.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import { ModPlaceRegistry, isUiPlaceResult, uiPlaceArgsOf, uiPlaceCore } from '../mods/modPlaces'
import type { ModUiEvent, ModUiSnapshot } from '../mods/modUi'
import { isModsUiState } from '../browser/runtimeProtocol'

const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

let uniq = 0
function world(modules: Record<string, string>, drawsComposer: boolean) {
  const reports: string[] = []
  const states: ModUiSnapshot[] = []
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
    session: { id: () => 's', cwd: () => '/work/project' },
    report: line => reports.push(line),
    drawsComposer,
    onUiChanged: (event: ModUiEvent) => {
      if (event.kind === 'state') states.push(event.state)
    },
  })
  runtimes.push(runtime)
  const logs = () => reports.filter(r => r.startsWith('placer: ')).map(r => JSON.parse(r.slice('placer: '.length)) as unknown)
  return { runtime, reports, states, logs }
}

const PLACER = `
  export function register(on) {
    on('session.start', async ($, e, next) => {
      const first = await $.ui.place({ id: 'chart' });
      const again = await $.ui.place({ id: 'chart' });
      const other = await $.ui.place({ id: 'log' });
      const refused = await $.ui.place({ id: 'secret' }).catch(err => 'rejected: ' + err.message);
      const bad = await $.ui.place({ id: 'no spaces' }).catch(err => err.name + ': ' + err.message);
      await $.ui.log(JSON.stringify({ first, again, other, refused, bad }));
      return next(e);
    });
    on('ui.render', { component: 'Placed' }, ($, e) => {
      const { Text } = $.ui.resolve(e);
      return h(Text, null, e.props.plugin + '/' + e.props.id);
    });
  }
`
const GUARD = `
  export function register(on) {
    on('ui.place', ($, e, next) => (e.id === 'secret' ? { deny: 'not here' } : next(e)));
  }
`

describe('$.ui.place', () => {
  it('places a row at the end where a page draws the session; the same id hands back the row that stands; a hook may deny', async () => {
    const { runtime, logs, states } = world({ guard: GUARD, placer: PLACER }, true)
    await runtime.ready
    const [got] = logs() as Array<Record<string, unknown>>
    expect(got!.first).toEqual({ isPlaced: true, requestId: 'placed:placer:chart' })
    expect(got!.again).toEqual(got!.first)
    expect(got!.other).toEqual({ isPlaced: true, requestId: 'placed:placer:log' })
    expect(got!.refused).toMatch(/^rejected: .*not here/)
    expect(got!.bad).toBe('TypeError: $.ui.place({ id }): id must be 1-64 of letters, digits, _ and -')
    const latest = runtime.uiSnapshot()
    expect(latest.placed).toEqual([
      { plugin: 'placer', id: 'chart', requestId: 'placed:placer:chart' },
      { plugin: 'placer', id: 'log', requestId: 'placed:placer:log' },
    ])
    expect(isModsUiState(latest)).toBe(true)
    expect(states.length).toBeGreaterThan(0)
    expect(runtime.renderSites()).toContainEqual({ plugin: 'placer', component: 'Placed' })
  })

  it('a row waits, not placed, where no page draws the session', async () => {
    const { runtime, logs } = world({ placer: PLACER }, false)
    await runtime.ready
    const [got] = logs() as Array<Record<string, unknown>>
    expect(got!.first).toEqual({ isPlaced: false, requestId: 'placed:placer:chart', reason: 'no page draws this session' })
  })

  it("is drawn as the Placed site with the row's id and plugin", async () => {
    const { runtime } = world({ placer: PLACER }, true)
    await runtime.ready
    const drawn = await runtime.render({ component: 'Placed', requestId: 'placed:placer:chart', props: { id: 'chart', plugin: 'placer' } })
    expect(drawn.kind).toBe('tree')
    expect(JSON.stringify(drawn)).toContain('placer/chart')
  })

  it('the registry keeps placing order and drops a plugin with its rows', () => {
    let changes = 0
    const registry = new ModPlaceRegistry(() => void (changes += 1))
    expect(uiPlaceCore(registry, 'a', 'x', true)).toEqual({ isPlaced: true, requestId: 'placed:a:x' })
    uiPlaceCore(registry, 'b', 'x', true)
    uiPlaceCore(registry, 'a', 'y', true)
    uiPlaceCore(registry, 'a', 'x', true)
    expect(changes).toBe(3)
    expect(registry.clearPlugin('a').sort()).toEqual(['placed:a:x', 'placed:a:y'])
    expect(registry.list()).toEqual([{ plugin: 'b', id: 'x', requestId: 'placed:b:x' }])
    expect(registry.clearPlugin('a')).toEqual([])
    expect(changes).toBe(4)
    expect(() => uiPlaceArgsOf({ id: '' })).toThrow()
    expect(isUiPlaceResult({ isPlaced: false, reason: 'x' })).toBe(true)
    expect(isUiPlaceResult({ isPlaced: true })).toBe(false)
  })
})

/**
 * The drawing surface's fields (F-25): `$.ui.open`'s `backgroundColor` and
 * `placement`, `ui.render`'s `plugin` and its default matching, the
 * `Progress` element in a tree, and `matchesOwned`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { matchesOwned } from '../mods/eventPattern'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ModUiEvent } from '../mods/modUi'
import { DESKTOP_ELEMENTS, validateRenderTree } from '../mods/modRender'
import { ModPaneRegistry, isPaneBackground } from '../mods/modPanes'

let uniqueLoad = 0
const ports: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of ports.splice(0)) port.close()
})

function world(modules: Record<string, string>) {
  const reports: string[] = []
  const events: ModUiEvent[] = []
  const refs: ModModuleRef[] = Object.keys(modules).map(plugin => ({ plugin, path: `/plugins/${plugin}/hooks/register.js` }))
  const runtime = new ModRuntime({
    modules: refs,
    readModule: async path => `export function register(on) {\n${modules[path.split('/')[2]!]}\n}\n// load ${++uniqueLoad}`,
    openWorker: async (): Promise<ModWorkerHandle> => {
      const channel = new MessageChannel()
      ports.push(channel.port1, channel.port2)
      installModWorkerHost(channel.port2)
      return { port: channel.port1, closed: new Promise(() => {}), close: () => {} }
    },
    session: { id: () => 'sess-fields', cwd: () => '/work/project' },
    report: line => reports.push(line),
    respawnBackoffMs: [10],
    onUiChanged: event => events.push(event),
  })
  runtimes.push(runtime)
  const lastState = () =>
    [...events].reverse().find(e => e.kind === 'state') as { state: { panes?: Array<Record<string, unknown>> } } | undefined
  return { runtime, reports, lastState }
}

const logged = (reports: string[], plugin: string): unknown[] =>
  reports.filter(line => line.startsWith(`${plugin}: `)).map(line => JSON.parse(line.slice(plugin.length + 2)))

const PANE_PROPS = {
  title: 'P',
  isFocused: false,
  bodyColumns: 60,
  placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

describe('$.ui.open backgroundColor and placement', () => {
  it('carries a valid backgroundColor to the pane row, sets it anew on each open, and refuses anything else', async () => {
    const { runtime, reports, lastState } = world({
      opener: `
        on('session.start', async ($, e, next) => {
          for (const pane of [
            { id: 'a', backgroundColor: 'transparent' },
            { id: 'b', backgroundColor: '#112233' },
            { id: 'c', backgroundColor: 'success' },
            { id: 'd', backgroundColor: 'not a color!' },
            { id: 'e', backgroundColor: 7 },
          ]) {
            try { await $.ui.open(pane); await $.ui.log(JSON.stringify({ opened: pane.id })) }
            catch (error) { await $.ui.log(JSON.stringify({ threw: error.name })) }
          }
          await $.ui.open({ id: 'b' })
          return next(e)
        })`,
    })
    await runtime.ready
    expect(logged(reports, 'opener')).toEqual([
      { opened: 'a' },
      { opened: 'b' },
      { opened: 'c' },
      { threw: 'TypeError' },
      { threw: 'TypeError' },
    ])
    const backgrounds = Object.fromEntries((lastState()?.state.panes ?? []).map(pane => [pane.id, pane.backgroundColor]))
    expect(backgrounds).toEqual({ a: 'transparent', b: undefined, c: 'success' })
  })

  it("hands placement 'widget' to a ui.open hook, ignores any other value, and opens the pane as usual", async () => {
    const { runtime, reports, lastState } = world({
      watcher: `
        on('ui.open', ($, e, next) => { $.ui.log(JSON.stringify({ id: e.id, placement: e.placement ?? null })); return next(e) })
      `,
      opener: `
        on('session.start', async ($, e, next) => {
          await $.ui.open({ id: 'ticker', placement: 'widget' })
          await $.ui.open({ id: 'other', placement: 'dock' })
          return next(e)
        })`,
    })
    await runtime.ready
    expect(logged(reports, 'watcher')).toEqual([
      { id: 'ticker', placement: 'widget' },
      { id: 'other', placement: null },
    ])
    expect((lastState()?.state.panes ?? []).map(pane => [pane.id, pane.isPlaced])).toEqual([
      ['ticker', true],
      ['other', true],
    ])
  })

  it('isPaneBackground takes raw colors, transparent and theme keys', () => {
    for (const ok of ['transparent', '#fff', '#11223344', 'rgb(1, 2, 3)', 'diffAdded']) expect(isPaneBackground(ok)).toBe(true)
    for (const bad of ['', ' red', 'url(x)', 'var(--x)', 3, null]) expect(isPaneBackground(bad)).toBe(false)
  })

  it('the registry drops a background an open leaves out', () => {
    const panes = new ModPaneRegistry(() => {})
    panes.open('p', { id: 'x', backgroundColor: 'warning' })
    expect(panes.get('p', 'x')?.backgroundColor).toBe('warning')
    panes.open('p', { id: 'x' })
    expect(panes.get('p', 'x')?.backgroundColor).toBeUndefined()
  })
})

describe("ui.render's plugin", () => {
  const OPENER = (plugin: string) => `
    on('session.start', async ($, e, next) => { await $.ui.open({ id: 'shared' }); return next(e) })
    on('ui.render', { component: 'Pane' }, async ($, e) => {
      $.ui.log(JSON.stringify({ heard: e.plugin }))
      const { Text } = $.ui.resolve(e)
      return Text({ children: ['${plugin}'] })
    })`

  it("names the pane's plugin; a hook leaving plugin out hears its own panes alone, { plugin: '*' } hears all", async () => {
    // The frame registers first, so its hooks sit above the openers' drawings.
    const { runtime, reports } = world({
      frame: `
        on('ui.render', { component: 'Pane', plugin: '*' }, async ($, e, next) => {
          $.ui.log(JSON.stringify({ framed: e.plugin }))
          return next(e)
        })
        on('ui.render', { component: 'Pane', plugin: 'beta' }, async ($, e, next) => {
          $.ui.log(JSON.stringify({ named: e.plugin }))
          return next(e)
        })`,
      alpha: OPENER('alpha'),
      beta: OPENER('beta'),
    })
    await runtime.ready
    const drawnAlpha = await runtime.render({ component: 'Pane', requestId: 'shared', props: PANE_PROPS, plugin: 'alpha' })
    const drawnBeta = await runtime.render({ component: 'Pane', requestId: 'shared', props: PANE_PROPS, plugin: 'beta' })
    expect(drawnAlpha).toEqual(expect.objectContaining({ kind: 'tree', tree: expect.objectContaining({ children: ['alpha'] }) }))
    expect(drawnBeta).toEqual(expect.objectContaining({ kind: 'tree', tree: expect.objectContaining({ children: ['beta'] }) }))
    expect(logged(reports, 'alpha')).toEqual([{ heard: 'alpha' }])
    expect(logged(reports, 'beta')).toEqual([{ heard: 'beta' }])
    expect(logged(reports, 'frame')).toEqual([{ framed: 'alpha' }, { framed: 'beta' }, { named: 'beta' }])
  })

  it("keeps a client's plugin only when that plugin has the pane open; one owner is found without it", async () => {
    // The spy registers first, so it sits above alpha's drawing.
    const { runtime, reports } = world({
      spy: `
        on('ui.render', { plugin: '*' }, async ($, e, next) => {
          $.ui.log(JSON.stringify({ plugin: e.plugin ?? null }))
          return next(e)
        })`,
      alpha: OPENER('alpha'),
    })
    await runtime.ready
    await runtime.render({ component: 'Pane', requestId: 'shared', props: PANE_PROPS, plugin: 'spy' })
    await runtime.render({ component: 'Pane', requestId: 'shared', props: PANE_PROPS })
    await runtime.render({ component: 'Pane', requestId: 'nobody', props: PANE_PROPS })
    expect(logged(reports, 'spy')).toEqual([{ plugin: 'alpha' }, { plugin: 'alpha' }, { plugin: null }])
  })
})

describe('matchesOwned', () => {
  it('a matcher without the key holds for its own plugin only, while e carries one', () => {
    expect(matchesOwned(undefined, { plugin: 'a' }, 'plugin', 'a')).toBe(true)
    expect(matchesOwned(undefined, { plugin: 'a' }, 'plugin', 'b')).toBe(false)
    expect(matchesOwned({ component: 'Pane' }, { component: 'Pane', plugin: 'a' }, 'plugin', 'b')).toBe(false)
    expect(matchesOwned({ component: 'Pane' }, { component: 'Band' }, 'plugin', 'b')).toBe(false)
    expect(matchesOwned({ component: 'Band' }, { component: 'Band' }, 'plugin', 'b')).toBe(true)
  })

  it("'*' names every value, present or absent; another value is read as written", () => {
    expect(matchesOwned({ plugin: '*', component: 'Pane' }, { component: 'Pane', plugin: 'a' }, 'plugin', 'b')).toBe(true)
    expect(matchesOwned({ plugin: '*' }, { component: 'Band' }, 'plugin', 'b')).toBe(true)
    expect(matchesOwned({ plugin: 'a' }, { plugin: 'a' }, 'plugin', 'b')).toBe(true)
    expect(matchesOwned({ plugin: 'a' }, { plugin: 'c' }, 'plugin', 'a')).toBe(false)
  })
})

describe('Progress in a tree', () => {
  it('is a desktop element', () => {
    expect(DESKTOP_ELEMENTS).toContain('Progress')
  })

  it('takes a label with optional value, max, valueText and color', () => {
    for (const props of [
      { label: 'Indexing' },
      { label: 'Indexing', value: 0.4 },
      { label: 'Files', value: 412, max: 900, valueText: '412 of 900', color: 'success' },
      { label: 'Files', value: 2, max: 0 },
    ]) {
      expect(validateRenderTree({ type: 'Box', children: [{ type: 'Progress', props }] }).ok).toBe(true)
    }
  })

  it('refuses a blank label, a non-number figure, an unknown prop and children', () => {
    const reasonOf = (node: unknown) => {
      const checked = validateRenderTree({ type: 'Box', children: [node] })
      return checked.ok ? null : checked.reason
    }
    expect(reasonOf({ type: 'Progress', props: { label: '  ' } })).toMatch(/no label/)
    expect(reasonOf({ type: 'Progress', props: { label: 'x', value: '3' } })).toMatch(/value is not a number/)
    expect(reasonOf({ type: 'Progress', props: { label: 'x', max: true } })).toMatch(/max is not a number/)
    expect(reasonOf({ type: 'Progress', props: { label: 'x', valueText: 4 } })).toMatch(/valueText/)
    expect(reasonOf({ type: 'Progress', props: { label: 'x', size: 3 } })).not.toBeNull()
    expect(reasonOf({ type: 'Progress', props: { label: 'x' }, children: ['y'] })).toMatch(/takes no children/)
    expect(reasonOf({ type: 'Text', children: [{ type: 'Progress', props: { label: 'x' } }] })).not.toBeNull()
  })

  it("a hook's $.ui.resolve(e) offers Progress and its tree draws", async () => {
    const { runtime } = world({
      bar: `
        on('session.start', async ($, e, next) => { await $.ui.open({ id: 'job' }); return next(e) })
        on('ui.render', { component: 'Pane' }, async ($, e) => {
          const { Box, Progress } = $.ui.resolve(e)
          return Box({ children: [Progress({ label: 'Indexing', value: 3, max: 4 })] })
        })`,
    })
    await runtime.ready
    const drawn = await runtime.render({ component: 'Pane', requestId: 'job', props: PANE_PROPS })
    expect(drawn.kind).toBe('tree')
    if (drawn.kind !== 'tree') return
    expect(drawn.tree).toEqual(
      expect.objectContaining({ children: [{ type: 'Progress', props: { label: 'Indexing', value: 3, max: 4 } }] }),
    )
  })
})

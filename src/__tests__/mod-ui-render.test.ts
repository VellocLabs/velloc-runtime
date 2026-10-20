/**
 * `ui.render` for `Pane` and `AbovePrompt`, `$.ui.open` / `close` / `panes` / `invalidate`, and the input a drawing
 * raises (F-25): a hook answers with a tree from `$.ui.resolve(e)`; a leaf's handler stays in the plugin; a read
 * subscribes, so a later `$.state.set` redraws exactly the readers; an invalid tree falls back to the engine's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RAISED_EVENTS, refuseRegistrations } from '../mods/modAdmission'
import { implementedNouns } from '../mods/modNouns'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ModUiEvent } from '../mods/modUi'
import type { RenderElement } from '../mods/modRender'
import { FOCUS_PANE_WAITS_REASON, PANE_WAITS_REASON } from '../mods/modPanes'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await sleep(5)
  }
}

let uniqueLoad = 0
const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

type Worker = ModWorkerHandle & { crash(): void }

function world(modules: Record<string, string>, gates: Record<string, Promise<void>> = {}) {
  const reports: string[] = []
  const events: ModUiEvent[] = []
  const workers: Record<string, Worker[]> = {}
  const refs: ModModuleRef[] = Object.keys(modules).map(plugin => ({ plugin, path: `/plugins/${plugin}/hooks/register.js` }))
  const runtime = new ModRuntime({
    modules: refs,
    readModule: async path => {
      await gates[path.split('/')[2]!]
      return `export function register(on) {\n${modules[path.split('/')[2]!]}\n}\n// load ${++uniqueLoad}`
    },
    openWorker: async (plugin): Promise<ModWorkerHandle> => {
      const channel = new MessageChannel()
      open.push(channel.port1, channel.port2)
      installModWorkerHost(channel.port2)
      let settle!: (closed: { reason: 'closed' | 'crashed' }) => void
      const closed = new Promise<{ reason: 'closed' | 'crashed' }>(resolve => {
        settle = resolve
      })
      const worker: Worker = { port: channel.port1, closed, close: () => settle({ reason: 'closed' }), crash: () => settle({ reason: 'crashed' }) }
      ;(workers[plugin] ??= []).push(worker)
      return worker
    },
    session: { id: () => 'sess-render', cwd: () => '/work/project' },
    report: line => reports.push(line),
    respawnBackoffMs: [10],
    onUiChanged: event => events.push(event),
  })
  runtimes.push(runtime)
  // The stale events after start-up: a runtime marks its hooking plugins stale once it is up.
  let startedAt = 0
  void runtime.ready.then(() => {
    startedAt = events.length
  })
  const stale = () => events.slice(startedAt).filter(e => e.kind === 'stale').map(e => (e as { stale: unknown }).stale)
  const staleAtStart = () => events.slice(0, startedAt).filter(e => e.kind === 'stale').map(e => (e as { stale: unknown }).stale)
  const lastState = () => [...events].reverse().find(e => e.kind === 'state') as { state: { panes?: unknown[]; hooked?: unknown[]; status: unknown[] } } | undefined
  return { runtime, reports, events, workers, stale, staleAtStart, lastState }
}

const PANE_PROPS = {
  title: 'Clock',
  isFocused: false,
  bodyColumns: 60,
  placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}
const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 6 },
  view: {},
}

/** A pane that counts presses in `$.state`: the drawing reads the count,
 *  the Button's handler writes it. */
const COUNTER = `
  const count = { plugin: 'counter', key: 'count' }
  on('session.start', async ($, e, next) => {
    await $.ui.open({ id: 'clock', title: 'Clock' })
    return next(e)
  })
  on('ui.render', { component: 'Pane', requestId: 'clock' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { value = 0 } = await $.state.get(count)
    return Box({ flexDirection: 'column', children: [
      Text({ children: ['count ' + value + ' cols ' + e.props.bodyColumns] }),
      Button({ key: 'bump', label: 'Bump', onPress: async (press) => {
        const held = await $.state.get(count)
        await $.state.set(count, (held.value ?? 0) + 1)
        await $.ui.log(JSON.stringify({ pressed: press.element, at: press.requestId }))
      } }),
    ] })
  })
`

type Tree = RenderElement & { children?: Array<RenderElement | string> }
const texts = (tree: unknown): string[] => {
  const out: string[] = []
  const visit = (node: unknown): void => {
    if (typeof node === 'string') out.push(node)
    else if (node && typeof node === 'object' && Array.isArray((node as Tree).children)) {
      for (const child of (node as Tree).children!) visit(child)
    }
  }
  visit(tree)
  return out
}
const buttonOf = (tree: unknown, key: string): { press: { plugin: string; handle: number } } | undefined => {
  let found: { press: { plugin: string; handle: number } } | undefined
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const element = node as { type?: string; props?: { key?: string }; press?: { plugin: string; handle: number }; children?: unknown[] }
    if (element.props?.key === key && element.press) found = element as never
    if (Array.isArray(element.children)) for (const child of element.children) visit(child)
  }
  visit(tree)
  return found
}

describe('ui.render — admission and the nouns', () => {
  it('raises the drawing events and serves the pane nouns', () => {
    for (const event of ['ui.render', 'ui.press', 'ui.input', 'ui.select', 'ui.open', 'ui.close', 'ui.panes', 'ui.invalidate']) {
      expect(RAISED_EVENTS, event).toContain(event)
    }
    expect(implementedNouns()).toEqual(expect.arrayContaining(['ui.open', 'ui.close', 'ui.panes', 'ui.invalidate']))
    // `ui.resolve` is a read in the worker, never dispatched: a hook on it is
    // refused as an event this engine does not raise.
    expect(RAISED_EVENTS).not.toContain('ui.resolve')
  })

  it('refuses a hook on a site this surface does not draw, by name', () => {
    expect(refuseRegistrations([{ hookId: 'h1', pattern: 'ui.render', matcher: { component: 'ToolProgress' }, hasCatch: false }])).toContain(
      'ui.render for ToolProgress',
    )
    expect(refuseRegistrations([{ hookId: 'h1', pattern: 'ui.render', matcher: { component: 'Pane' }, hasCatch: false }])).toBeNull()
    expect(refuseRegistrations([{ hookId: 'h1', pattern: 'ui.render', hasCatch: false }])).toBeNull()
  })

  it('loads a module whose other hooks are reached, skipping its hook on a site this surface does not draw, and says so', async () => {
    expect(
      refuseRegistrations([
        { hookId: 'h1', pattern: 'ui.render', matcher: { component: 'Spinner' }, hasCatch: false },
        { hookId: 'h2', pattern: 'ui.render', matcher: { component: 'Pane' }, hasCatch: false },
      ]),
    ).toBeNull()
    const { runtime, reports, lastState } = world({
      mixed: `
        on('ui.render', { component: 'Spinner' }, ($, e, next) => next(e))
        on('ui.render', { component: 'Pane', requestId: 'p' }, ($, e, next) => next(e))`,
    })
    await runtime.ready
    expect(lastState()?.state.hooked).toEqual([{ plugin: 'mixed', component: 'Pane', requestId: 'p' }])
    expect(reports).toContain('mixed: its hook on ui.render for Spinner never runs: this surface does not draw Spinner')
  })
})

describe('$.ui.open / close / panes', () => {
  it('opens a pane at session.start: on the ui state, listed by $.ui.panes, its site hooked', async () => {
    const { runtime, reports, lastState } = world({
      counter: COUNTER + `
        on('prompt.submit', async ($, e, next) => {
          await $.ui.log(JSON.stringify(await $.ui.panes()))
          return next(e)
        })`,
    })
    await runtime.ready
    expect(lastState()?.state.panes).toEqual([
      {
        plugin: 'counter',
        id: 'clock',
        title: 'Clock',
        isShown: true,
        isFocused: false,
        isPlaced: true,
        asked: false,
        focus: false,
        openSeq: 1,
        closeOnEscape: false,
      },
    ])
    expect(lastState()?.state.hooked).toEqual([{ plugin: 'counter', component: 'Pane', requestId: 'clock' }])
    await runtime.promptSubmit('go')
    expect(reports).toContain(
      'counter: ' + JSON.stringify([{ id: 'clock', title: 'Clock', isShown: true, isFocused: false, isPlaced: true }]),
    )
  })

  it('an open id retitles; a second pane becomes the shown one; close takes it off', async () => {
    const { runtime, reports, lastState } = world({
      two: `
        on('session.start', async ($, e, next) => {
          await $.ui.open({ id: 'a', title: 'A' })
          await $.ui.open({ id: 'b', title: 'B' })
          await $.ui.open({ id: 'a', title: 'A2' })
          await $.ui.close({ id: 'b' })
          await $.ui.close({ id: 'nope' })
          await $.ui.log(JSON.stringify((await $.ui.panes()).map(p => p.id + ':' + p.title + ':' + p.isShown)))
          return next(e)
        })`,
    })
    await runtime.ready
    expect(reports).toContain('two: ' + JSON.stringify(['a:A2:true']))
    expect(lastState()?.state.panes).toHaveLength(1)
  })

  it('refuses a bad id and a control character in the title; a hook may retitle or deny', async () => {
    const { runtime, reports } = world({
      guard: `
        on('ui.open', { id: 'loud' }, () => ({ deny: 'not that one' }))
        on('ui.open', { id: 'quiet' }, ($, e, next) => next({ ...e, title: 'Renamed by guard' }))
      `,
      opener: `
        on('session.start', async ($, e, next) => {
          for (const pane of [{ id: 'has space' }, { id: 'x', title: 'bad\\u0007' }, { id: 'loud' }, { id: 'quiet', title: 'Quiet' }]) {
            try { await $.ui.log(JSON.stringify(await $.ui.open(pane))) }
            catch (error) { await $.ui.log(JSON.stringify({ threw: error.name, message: error.message })) }
          }
          await $.ui.log(JSON.stringify((await $.ui.panes()).map(p => p.id + ':' + p.title)))
          return next(e)
        })`,
    })
    await runtime.ready
    const lines = reports.filter(line => line.startsWith('opener: ')).map(line => JSON.parse(line.slice(8)))
    expect(lines[0]).toMatchObject({ threw: 'TypeError' })
    expect(lines[1]).toMatchObject({ threw: 'TypeError' })
    expect(lines[2]).toEqual({ threw: 'DeniedError', message: 'not that one' })
    expect(lines[3]).toEqual({ isPlaced: true })
    expect(lines[4]).toEqual(['quiet:Renamed by guard'])
  })
})

describe('$.ui.open / panes — where the clients seat the panes', () => {
  /** Opens `report` unasked at a turn's start and asked under `/show` or a
   *  press; logs what each open answered and, under a prompt, the panes. */
  const OPENER = `
    on('turn.start', async ($, e, next) => {
      await $.ui.log('unasked ' + JSON.stringify(await $.ui.open({ id: 'report', title: 'Report' })))
      return next(e)
    })
    on('command.run', { command: 'show' }, async ($) => {
      await $.ui.log('asked ' + JSON.stringify(await $.ui.open({ id: 'report', title: 'Report' })))
      return { text: 'shown' }
    })
    on('prompt.submit', async ($, e, next) => {
      await $.ui.log('panes ' + JSON.stringify((await $.ui.panes()).map(p => ({ id: p.id, isShown: p.isShown, isPlaced: p.isPlaced }))))
      return next(e)
    })
    on('ui.render', { component: 'Pane', requestId: 'report' }, async ($, e) => {
      const { Button } = $.ui.resolve(e)
      return Button({ key: 'more', label: 'More', onPress: async () => {
        await $.ui.log('pressed ' + JSON.stringify(await $.ui.open({ id: 'more' })))
      } })
    })
  `
  const logged = (reports: string[], prefix: string): unknown[] =>
    reports.filter(line => line.startsWith(`opener: ${prefix} `)).map(line => JSON.parse(line.slice(`opener: ${prefix} `.length)))
  const panesNow = async (runtime: ModRuntime, reports: string[]): Promise<unknown> => {
    await runtime.promptSubmit('look')
    return logged(reports, 'panes').at(-1)
  }

  it('no seat ever reported (headless) places every open, the front one shown', async () => {
    const { runtime, reports } = world({ opener: OPENER })
    await runtime.ready
    await runtime.turnStart({ text: 'go', turnId: 't1' })
    expect(logged(reports, 'unasked')).toEqual([{ isPlaced: true }])
    expect(await panesNow(runtime, reports)).toEqual([{ id: 'report', isShown: true, isPlaced: true }])
  })

  it("a mod's own open waits while the only window hides its panel; showing the panel places it", async () => {
    const { runtime, reports, lastState } = world({ opener: OPENER })
    await runtime.ready
    runtime.seat('c1', { kind: 'dock-hidden' })
    await runtime.turnStart({ text: 'go', turnId: 't1' })
    expect(logged(reports, 'unasked')).toEqual([{ isPlaced: false, reason: PANE_WAITS_REASON }])
    expect(lastState()?.state.panes).toEqual([expect.objectContaining({ id: 'report', isPlaced: false, asked: false })])
    expect(await panesNow(runtime, reports)).toEqual([{ id: 'report', isShown: false, isPlaced: false }])
    // The panel shows another tab: placed (and published), not shown.
    runtime.seat('c1', { kind: 'dock-visible' })
    expect(lastState()?.state.panes).toEqual([expect.objectContaining({ id: 'report', isPlaced: true })])
    expect(await panesNow(runtime, reports)).toEqual([{ id: 'report', isShown: false, isPlaced: true }])
    runtime.seat('c1', { kind: 'dock-visible', showing: { plugin: 'opener', id: 'report' } })
    expect(await panesNow(runtime, reports)).toEqual([{ id: 'report', isShown: true, isPlaced: true }])
  })

  it("a hidden pane naming the mod's own opens it would bring into view places them at once", async () => {
    const { runtime, reports } = world({ opener: OPENER })
    await runtime.ready
    runtime.seat('c1', { kind: 'dock-hidden', places: [{ plugin: 'other', id: 'report' }] })
    await runtime.turnStart({ text: 'go', turnId: 't1' })
    expect(logged(reports, 'unasked')).toEqual([{ isPlaced: false, reason: PANE_WAITS_REASON }])
    // Widened to the floor that admits it: the waiting pane is placed.
    runtime.seat('c1', { kind: 'dock-hidden', places: [{ plugin: 'opener', id: 'report' }] })
    expect(await panesNow(runtime, reports)).toEqual([{ id: 'report', isShown: false, isPlaced: true }])
    const second = world({ opener: OPENER })
    await second.runtime.ready
    second.runtime.seat('c1', { kind: 'dock-hidden', places: 'all' })
    await second.runtime.turnStart({ text: 'go', turnId: 't1' })
    expect(logged(second.reports, 'unasked')).toEqual([{ isPlaced: true }])
  })

  it("the person's command places at once and stamps an asked open; hiding the panel unshows it; asking again stamps anew", async () => {
    const { runtime, reports, lastState } = world({ opener: OPENER })
    await runtime.ready
    runtime.seat('c1', { kind: 'dock-hidden' })
    await runtime.commandRun({ command: 'show', args: '' }, undefined)
    expect(logged(reports, 'asked')).toEqual([{ isPlaced: true }])
    expect(lastState()?.state.panes).toEqual([expect.objectContaining({ id: 'report', isPlaced: true, asked: true, openSeq: 1 })])
    runtime.seat('c1', { kind: 'dock-visible', showing: { plugin: 'opener', id: 'report' } })
    expect(await panesNow(runtime, reports)).toEqual([{ id: 'report', isShown: true, isPlaced: true }])
    // The person hides the panel: the pane stays open, out of sight.
    runtime.seat('c1', { kind: 'dock-hidden' })
    expect(await panesNow(runtime, reports)).toEqual([{ id: 'report', isShown: false, isPlaced: true }])
    await runtime.commandRun({ command: 'show', args: '' }, undefined)
    expect(lastState()?.state.panes).toEqual([expect.objectContaining({ id: 'report', asked: true, openSeq: 2 })])
    // A mod's own re-open before the pane is shown keeps the person's open to be shown.
    await runtime.turnStart({ text: 'go', turnId: 't1' })
    expect(lastState()?.state.panes).toEqual([expect.objectContaining({ id: 'report', asked: true, openSeq: 3 })])
    // A window showing it answers the open; a mod's re-open after that is not asked.
    runtime.seat('c1', { kind: 'dock-visible', showing: { plugin: 'opener', id: 'report' } })
    expect(lastState()?.state.panes).toEqual([expect.objectContaining({ id: 'report', asked: false, openSeq: 3 })])
    runtime.seat('c1', { kind: 'dock-hidden' })
    await runtime.turnStart({ text: 'go', turnId: 't2' })
    expect(lastState()?.state.panes).toEqual([expect.objectContaining({ id: 'report', asked: false, openSeq: 4 })])
  })

  it('an open under a press on a drawn button is asked', async () => {
    const { runtime, reports, lastState } = world({ opener: OPENER })
    await runtime.ready
    await runtime.commandRun({ command: 'show', args: '' }, undefined)
    runtime.seat('c1', { kind: 'dock-hidden' })
    const drawn = await runtime.render({ component: 'Pane', requestId: 'report', props: PANE_PROPS })
    if (drawn.kind !== 'tree') throw new Error('expected a tree')
    const handle = (drawn.tree as unknown as { press: { handle: number } }).press.handle
    await runtime.uiInput({ kind: 'press', plugin: 'opener', element: 'more', component: 'Pane', requestId: 'report', handle })
    expect(logged(reports, 'pressed')).toEqual([{ isPlaced: true }])
    expect(lastState()?.state.panes).toEqual([
      expect.objectContaining({ id: 'report' }),
      expect.objectContaining({ id: 'more', asked: true, isPlaced: true }),
    ])
  })

  it("a client gone takes its seat: with none left a mod's own open waits; an inline seat places it and shows the front pane", async () => {
    const { runtime, reports } = world({ opener: OPENER })
    await runtime.ready
    runtime.seat('c1', { kind: 'dock-visible' })
    runtime.clientGone('c1')
    await runtime.turnStart({ text: 'go', turnId: 't1' })
    expect(logged(reports, 'unasked')).toEqual([{ isPlaced: false, reason: PANE_WAITS_REASON }])
    runtime.seat('phone', { kind: 'inline' })
    expect(await panesNow(runtime, reports)).toEqual([{ id: 'report', isShown: true, isPlaced: true }])
    runtime.seat('phone', null)
    expect(await panesNow(runtime, reports)).toEqual([{ id: 'report', isShown: false, isPlaced: true }])
  })

  const FOCUSER = `
    on('turn.start', async ($, e, next) => {
      await $.ui.log('focused ' + JSON.stringify(await $.ui.open({ id: 'hold', title: 'Hold', focus: true })))
      return next(e)
    })
    on('ui.render', { component: 'Pane', requestId: 'hold' }, async ($, e) => {
      const { Text } = $.ui.resolve(e)
      return Text({ children: ['held'] })
    })
  `
  const focusedOpens = (reports: string[]): unknown[] =>
    reports.filter(line => line.startsWith('focuser: focused ')).map(line => JSON.parse(line.slice('focuser: focused '.length)))

  it("a mod's focus open is placed while the only window hides its panel, and is published with focus for the page to show", async () => {
    const { runtime, reports, lastState } = world({ focuser: FOCUSER })
    await runtime.ready
    runtime.seat('c1', { kind: 'dock-hidden' })
    await runtime.turnStart({ text: 'go', turnId: 't1' })
    expect(focusedOpens(reports)).toEqual([{ isPlaced: true }])
    expect(lastState()?.state.panes).toEqual([
      expect.objectContaining({ id: 'hold', isPlaced: true, asked: false, focus: true, isShown: true }),
    ])
  })

  it('a focus open with no window showing the session waits, and is placed once a window shows it with its panel hidden', async () => {
    const { runtime, reports, lastState } = world({ focuser: FOCUSER })
    await runtime.ready
    runtime.seat('c1', { kind: 'dock-visible' })
    runtime.seat('c1', null)
    await runtime.turnStart({ text: 'go', turnId: 't1' })
    expect(focusedOpens(reports)).toEqual([{ isPlaced: false, reason: FOCUS_PANE_WAITS_REASON }])
    runtime.seat('c2', { kind: 'dock-hidden' })
    expect(lastState()?.state.panes).toEqual([expect.objectContaining({ id: 'hold', isPlaced: true, focus: true })])
  })
})

describe('ui.render — a pane drawn, pressed, redrawn', () => {
  it('draws the tree the hook built from the table, with the handler behind a handle', async () => {
    const { runtime } = world({ counter: COUNTER })
    await runtime.ready
    const drawn = await runtime.render({ component: 'Pane', requestId: 'clock', props: PANE_PROPS })
    expect(drawn.kind).toBe('tree')
    if (drawn.kind !== 'tree') return
    expect(drawn.plugin).toBe('counter')
    expect(drawn.tree.type).toBe('Box')
    expect(texts(drawn.tree)).toEqual(['count 0 cols 60'])
    const button = buttonOf(drawn.tree, 'bump')
    expect(button?.press.plugin).toBe('counter')
    expect(typeof button?.press.handle).toBe('number')
  })

  it('a press runs the closure in the worker; its $.state write makes the drawing stale; the redraw reads it', async () => {
    const { runtime, reports, stale } = world({ counter: COUNTER })
    await runtime.ready
    const first = await runtime.render({ component: 'Pane', requestId: 'clock', props: PANE_PROPS })
    if (first.kind !== 'tree') throw new Error('expected a tree')
    const handle = buttonOf(first.tree, 'bump')!.press.handle
    const pressed = await runtime.uiInput({ kind: 'press', plugin: 'counter', element: 'bump', component: 'Pane', requestId: 'clock', handle })
    expect(pressed).toEqual({ ok: true })
    expect(reports).toContain('counter: ' + JSON.stringify({ pressed: 'bump', at: 'clock' }))
    expect(stale()).toEqual([{ component: 'Pane', requestId: 'clock' }])
    const second = await runtime.render({ component: 'Pane', requestId: 'clock', props: PANE_PROPS })
    if (second.kind !== 'tree') throw new Error('expected a tree')
    expect(texts(second.tree)).toEqual(['count 1 cols 60'])
  })

  it('a redraw drops the previous drawing\'s handles: the old handle no longer presses', async () => {
    const { runtime } = world({ counter: COUNTER })
    await runtime.ready
    const first = await runtime.render({ component: 'Pane', requestId: 'clock', props: PANE_PROPS })
    const second = await runtime.render({ component: 'Pane', requestId: 'clock', props: PANE_PROPS })
    if (first.kind !== 'tree' || second.kind !== 'tree') throw new Error('expected trees')
    const old = buttonOf(first.tree, 'bump')!.press.handle
    const fresh = buttonOf(second.tree, 'bump')!.press.handle
    expect(fresh).not.toBe(old)
    expect(await runtime.uiInput({ kind: 'press', plugin: 'counter', element: 'bump', component: 'Pane', requestId: 'clock', handle: old })).toEqual({
      ok: false,
      reason: 'the drawing is gone',
    })
    expect(await runtime.uiInput({ kind: 'press', plugin: 'counter', element: 'bump', component: 'Pane', requestId: 'clock', handle: fresh })).toEqual({ ok: true })
  })

  it('two asks for one drawing in flight: the later ask\'s handles are held, though the earlier finishes last', async () => {
    const { runtime, reports } = world({
      counter: `
        on('ui.render', { component: 'Pane', requestId: 'clock' }, async ($, e) => {
          if (e.props.bodyColumns === 1) await new Promise(resolve => setTimeout(resolve, 60))
          const { Box, Button } = $.ui.resolve(e)
          return Box({ children: [Button({ key: 'bump', label: 'Bump', onPress: async () => { await $.ui.log('pressed') } })] })
        })
      `,
    })
    await runtime.ready
    const earlier = runtime.render({ component: 'Pane', requestId: 'clock', props: { ...PANE_PROPS, bodyColumns: 1 } })
    const later = await runtime.render({ component: 'Pane', requestId: 'clock', props: PANE_PROPS })
    await earlier
    if (later.kind !== 'tree') throw new Error('expected a tree')
    const handle = buttonOf(later.tree, 'bump')!.press.handle
    expect(await runtime.uiInput({ kind: 'press', plugin: 'counter', element: 'bump', component: 'Pane', requestId: 'clock', handle })).toEqual({ ok: true })
    expect(reports).toContain('counter: pressed')
  })

  it('ui.press is an event: another mod may take the press, and the closure does not run', async () => {
    const { runtime, reports } = world({
      taker: `on('ui.press', { plugin: 'counter', element: 'bump' }, async ($, e) => {
        await $.ui.log(JSON.stringify({ took: e.element, from: e.plugin, in: e.component, surface: e.surface }))
        return { element: e.element }
      })`,
      counter: COUNTER,
    })
    await runtime.ready
    const drawn = await runtime.render({ component: 'Pane', requestId: 'clock', props: PANE_PROPS })
    if (drawn.kind !== 'tree') throw new Error('expected a tree')
    const handle = buttonOf(drawn.tree, 'bump')!.press.handle
    expect(await runtime.uiInput({ kind: 'press', plugin: 'counter', element: 'bump', component: 'Pane', requestId: 'clock', handle })).toEqual({ ok: true })
    expect(reports).toContain('taker: ' + JSON.stringify({ took: 'bump', from: 'counter', in: 'Pane', surface: 'desktop' }))
    expect(reports.some(line => line.includes('"pressed"'))).toBe(false)
  })

  it('$.state.set while drawing is denied, and the engine draws its own', async () => {
    const { runtime, reports } = world({
      writer: `
        on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
          await $.state.set({ plugin: 'writer', key: 'n' }, 1)
          const { Text } = $.ui.resolve(e)
          return Text({ children: ['never'] })
        })`,
    })
    await runtime.ready
    const drawn = await runtime.render({ component: 'AbovePrompt', requestId: 'band', props: BAND_PROPS })
    expect(drawn).toEqual({ kind: 'engine' })
    expect(reports.some(line => /writer.*\$\.state\.set while drawing is denied/.test(line))).toBe(true)
  })

  it('a tree that does not validate draws the engine\'s own, and says why under the plugin', async () => {
    const { runtime, reports } = world({
      odd: `
        on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
          const { Box, Button } = $.ui.resolve(e)
          return Box({ children: [Button({ key: 'k', label: 'L', hotkey: 'XY', onPress: () => {} })] })
        })`,
    })
    await runtime.ready
    const drawn = await runtime.render({ component: 'AbovePrompt', requestId: 'band', props: BAND_PROPS })
    expect(drawn).toEqual({ kind: 'engine' })
    expect(reports).toContainEqual(
      expect.stringMatching(/^odd: ui\.render \(AbovePrompt\) refused: Button's hotkey is not one digit or one lowercase letter; the engine drew its own$/),
    )
  })

  it('a refused tree leaves out its plugin\'s part alone: the band draws the others\' beneath it', async () => {
    const { runtime, reports } = world({
      odd: `on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
        const rest = await next(e)
        const { Box, Button } = $.ui.resolve(e)
        return Box({ children: [Button({ key: 'k', label: 'L', hotkey: 'XY', onPress: () => {} }), rest] })
      })`,
      bar: `on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
        const { Text } = $.ui.resolve(e)
        return Text({ children: ['context 19%'] })
      })`,
    })
    await runtime.ready
    const drawn = await runtime.render({ component: 'AbovePrompt', requestId: 'band', props: BAND_PROPS })
    expect(drawn.kind).toBe('tree')
    if (drawn.kind !== 'tree') return
    expect(texts(drawn.tree)).toEqual(['context 19%'])
    expect(drawn.plugins).toEqual(['bar'])
    expect(reports).toContain(
      "odd: ui.render (AbovePrompt) refused: Button's hotkey is not one digit or one lowercase letter; the rest was drawn without it",
    )
  })

  it('a refused tree beneath another plugin\'s is skipped: the plugin above draws over the engine\'s own', async () => {
    const { runtime, reports } = world({
      bar: `on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
        const rest = await next(e)
        const { Box, Text } = $.ui.resolve(e)
        return Box({ flexDirection: 'column', children: [Text({ children: ['context 19%'] }), rest] })
      })`,
      odd: `on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
        const { Text } = $.ui.resolve(e)
        return Text({ color: { not: 'a colour' }, children: ['never'] })
      })`,
    })
    await runtime.ready
    const drawn = await runtime.render({ component: 'AbovePrompt', requestId: 'band', props: BAND_PROPS })
    expect(drawn.kind).toBe('tree')
    if (drawn.kind !== 'tree') return
    expect(texts(drawn.tree)).toEqual(['context 19%'])
    expect(reports).toContain(
      "odd: ui.render (AbovePrompt) refused: Text's color is not a string, a number or a boolean; the rest was drawn without it",
    )
  })

  it('a prop set to undefined is an absent prop: the band still draws, every plugin\'s part with it', async () => {
    const { runtime, reports } = world({
      weather: `on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
        const rest = await next(e)
        const { Box, Text } = $.ui.resolve(e)
        return Box({ flexDirection: 'column', hover: { color: undefined }, children: [
          Text({ color: undefined, dimColor: false, children: ['cache 4:30'] }),
          rest,
        ] })
      })`,
      bar: `on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
        const { Text } = $.ui.resolve(e)
        return Text({ children: ['context 19%'] })
      })`,
    })
    await runtime.ready
    const drawn = await runtime.render({ component: 'AbovePrompt', requestId: 'band', props: BAND_PROPS })
    expect(drawn.kind).toBe('tree')
    if (drawn.kind !== 'tree') return
    expect(texts(drawn.tree)).toEqual(['cache 4:30', 'context 19%'])
    expect(reports.some(line => line.includes('refused'))).toBe(false)
  })

  it('a hook that passes the band on (next) and a hook that wraps the engine node both draw as the engine', async () => {
    const { runtime } = world({
      quiet: `on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => next(e))`,
    })
    await runtime.ready
    expect(await runtime.render({ component: 'AbovePrompt', requestId: 'band', props: BAND_PROPS })).toEqual({ kind: 'engine' })
  })

  it('names every plugin that drew the band, text alone or not; one that passed the band on is not among them', async () => {
    const { runtime } = world({
      usage: `on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
        const { Box, Text } = $.ui.resolve(e)
        const beneath = await next(e)
        return Box({ flexDirection: 'column', children: [Text({ children: ['19% of context'] }), beneath] })
      })`,
      quiet: `on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => next(e))`,
      clock: `on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
        const { Text } = $.ui.resolve(e)
        return Text({ children: ['12:00'] })
      })`,
    })
    await runtime.ready
    const drawn = await runtime.render({ component: 'AbovePrompt', requestId: 'band', props: BAND_PROPS })
    expect(drawn.kind).toBe('tree')
    if (drawn.kind !== 'tree') return
    // Text alone: no handle names the plugin, so `plugin` is unset.
    expect(drawn.plugin).toBeUndefined()
    expect([...(drawn.plugins ?? [])].sort()).toEqual(['clock', 'usage'])
  })

  it("cuts a band two plugins drew into each one's own section, outermost first", async () => {
    const { runtime } = world({
      usage: `on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
        const { Box, Text } = $.ui.resolve(e)
        const beneath = await next(e)
        return Box({ flexDirection: 'column', children: [Text({ children: ['19% of context'] }), beneath] })
      })`,
      clock: `on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
        const { Text } = $.ui.resolve(e)
        return Text({ children: ['12:00'] })
      })`,
    })
    await runtime.ready
    const drawn = await runtime.render({ component: 'AbovePrompt', requestId: 'band', props: BAND_PROPS })
    if (drawn.kind !== 'tree') throw new Error('the band was not drawn')
    expect(drawn.sections?.map(section => section.plugin)).toEqual(['usage', 'clock'])
    const [usage, clock] = drawn.sections!.map(section => JSON.stringify(section.tree))
    expect(usage).toContain('19% of context')
    expect(usage).not.toContain('12:00')
    expect(clock).toContain('12:00')
  })

  it('cuts a band whose plugins each unpack the column beneath and stack their own band into it, top to bottom', async () => {
    const stacking = (name: string) => `on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
        const { Box, Text } = $.ui.resolve(e)
        const rest = await next(e)
        const others = rest && rest.props && rest.props.key === 'bands' ? rest.children : [rest]
        const own = Box({ key: 'band:${name}', flexDirection: 'column', children: [Text({ children: ['${name} line'] })] })
        return Box({ key: 'bands', flexDirection: 'column', children: [...others, own] })
      })`
    const { runtime } = world({ context: stacking('context'), weather: stacking('weather'), steps: stacking('steps') })
    await runtime.ready
    const drawn = await runtime.render({ component: 'AbovePrompt', requestId: 'band', props: BAND_PROPS })
    if (drawn.kind !== 'tree') throw new Error('the band was not drawn')
    expect(drawn.sections?.map(section => section.plugin)).toEqual(['steps', 'weather', 'context'])
    for (const section of drawn.sections!) {
      const json = JSON.stringify(section.tree)
      expect(json).toContain(`${section.plugin} line`)
      expect(['context', 'weather', 'steps'].filter(name => json.includes(`${name} line`))).toEqual([section.plugin])
    }
  })

  it('a band one plugin drew carries no sections', async () => {
    const { runtime } = world({
      clock: `on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
        const { Text } = $.ui.resolve(e)
        return Text({ children: ['12:00'] })
      })`,
    })
    await runtime.ready
    const drawn = await runtime.render({ component: 'AbovePrompt', requestId: 'band', props: BAND_PROPS })
    expect(drawn).toMatchObject({ kind: 'tree' })
    expect(drawn).not.toHaveProperty('sections')
  })

  it("stamps each hook's returned root with its plugin, and hands the stamp beneath to the hook above through next", async () => {
    const { runtime } = world({
      usage: `on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
        const { Box, Text } = $.ui.resolve(e)
        const beneath = await next(e)
        return Box({ flexDirection: 'column', children: [Text({ children: ['beneath is ' + beneath.part.plugin] }), beneath] })
      })`,
      clock: `on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
        const { Text } = $.ui.resolve(e)
        return Text({ children: ['12:00'] })
      })`,
    })
    await runtime.ready
    const drawn = await runtime.render({ component: 'AbovePrompt', requestId: 'band', props: BAND_PROPS })
    if (drawn.kind !== 'tree') throw new Error('the band was not drawn')
    expect(drawn.tree).toEqual({
      type: 'Box',
      props: { flexDirection: 'column' },
      part: { plugin: 'usage' },
      children: [
        { type: 'Text', props: {}, children: ['beneath is clock'] },
        { type: 'Text', props: {}, part: { plugin: 'clock' }, children: ['12:00'] },
      ],
    })
  })

  it("keeps a hook's own stamps and the ones next handed it, wherever it moves them, and drops any other", async () => {
    const { runtime } = world({
      forger: `on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
        const { Box, Text } = $.ui.resolve(e)
        const beneath = await next(e)
        const mine = { ...Text({ children: ['mine'] }), part: { plugin: 'forger' } }
        const moved = { ...Text({ children: ['moved'] }), part: beneath.part }
        const again = { ...Text({ children: ['again'] }), part: beneath.part }
        const forged = { ...Text({ children: ['forged'] }), part: { plugin: 'someone' } }
        return Box({ flexDirection: 'column', children: [mine, moved, again, forged] })
      })`,
      clock: `on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
        const { Text } = $.ui.resolve(e)
        return Text({ children: ['12:00'] })
      })`,
    })
    await runtime.ready
    const drawn = await runtime.render({ component: 'AbovePrompt', requestId: 'band', props: BAND_PROPS })
    if (drawn.kind !== 'tree') throw new Error('the band was not drawn')
    const parts = (drawn.tree as { children: Array<{ children: string[]; part?: unknown }> }).children.map(child => [child.children[0], child.part])
    expect(parts).toEqual([
      ['mine', { plugin: 'forger' }],
      ['moved', { plugin: 'clock' }],
      ['again', undefined],
      ['forged', undefined],
    ])
  })

  it('credits each band to its own plugin when the band mods move the column stamp onto its owner, though their bands draw alike', async () => {
    // The shared band-stacking helper band mods ship: unpack the column beneath, the
    // column's stamp onto its owner's band, then stack this plugin's band last.
    const stacking = (name: string) => `on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
        const { Box, Text } = $.ui.resolve(e)
        const rest = await next(e)
        const isColumn = rest && rest.type === 'Box' && rest.props && rest.props.key === 'bands'
        const owner = isColumn && rest.part ? rest.part.plugin : undefined
        const others = !rest ? [] : !isColumn ? [rest] : rest.children.map(k =>
          owner && typeof k !== 'string' && k.props && k.props.key === 'band:' + owner && !k.part ? { ...k, part: rest.part } : k)
        const own = Box({ key: 'band:${name}', flexDirection: 'column', children: [Text({ children: ['●'] })] })
        return Box({ key: 'bands', flexDirection: 'column', children: [...others, own] })
      })`
    const { runtime } = world({ context: stacking('context'), weather: stacking('weather'), steps: stacking('steps') })
    await runtime.ready
    const drawn = await runtime.render({ component: 'AbovePrompt', requestId: 'band', props: BAND_PROPS })
    if (drawn.kind !== 'tree') throw new Error('the band was not drawn')
    const bandsIn = (tree: unknown) => [...JSON.stringify(tree).matchAll(/"key":"(band:\w+)"/g)].map(match => match[1])
    expect(drawn.sections?.map(section => [section.plugin, bandsIn(section.tree)])).toEqual([
      ['steps', ['band:steps']],
      ['weather', ['band:weather']],
      ['context', ['band:context']],
    ])
  })

  it('a Button holding Texts reaches the drawing with its children, its label naming it', async () => {
    const { runtime } = world({
      chip: `on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
        const { Button, Text } = $.ui.resolve(e)
        return Button({ key: 'open', label: 'Open notes', onPress: () => {}, children: ['notes ', Text({ dimColor: true, children: ['2m'] })] })
      })`,
    })
    await runtime.ready
    const drawn = await runtime.render({ component: 'AbovePrompt', requestId: 'band', props: BAND_PROPS })
    if (drawn.kind !== 'tree') throw new Error('the band was not drawn')
    expect(drawn.tree).toMatchObject({
      type: 'Button',
      props: { key: 'open', label: 'Open notes' },
      children: ['notes ', { type: 'Text', props: { dimColor: true }, children: ['2m'] }],
    })
  })

  it('a mod switched off and on again while another still hooks the band marks the band stale both times, and draws in it again', async () => {
    const { runtime, stale } = world({
      clock: `on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
        const { Box, Text } = $.ui.resolve(e)
        return Box({ flexDirection: 'column', children: [Text({ children: ['12:00'] }), await next(e)] })
      })`,
      usage: `on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
        const { Text } = $.ui.resolve(e)
        return Text({ children: ['19% of context'] })
      })`,
    })
    const ref = (plugin: string): ModModuleRef => ({ plugin, path: `/plugins/${plugin}/hooks/register.js` })
    await runtime.ready
    const drawnBy = async () => {
      const drawn = await runtime.render({ component: 'AbovePrompt', requestId: 'band', props: BAND_PROPS })
      return drawn.kind === 'tree' ? [...(drawn.plugins ?? [])].sort() : []
    }
    expect(await drawnBy()).toEqual(['clock', 'usage'])

    await runtime.reconcile([ref('clock')])
    // The band is still hooked (by clock): only the stale event redraws it.
    expect(runtime.renderSites().some(site => site.component === 'AbovePrompt')).toBe(true)
    expect(stale()).toEqual([{ plugin: 'usage' }])
    expect(await drawnBy()).toEqual(['clock'])

    await runtime.reconcile([ref('clock'), ref('usage')])
    expect(stale()).toEqual([{ plugin: 'usage' }, { plugin: 'usage' }])
    expect(await drawnBy()).toEqual(['clock', 'usage'])
  })

  it('a mod switched off and on again takes back its place in the chain: a band hook after it that draws without next does not hide it', async () => {
    const { runtime } = world({
      bar: `on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
        const { Box, Text } = $.ui.resolve(e)
        return Box({ flexDirection: 'column', children: [await next(e), Text({ children: ['BAR'] })] })
      })`,
      weather: `on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
        const { Text } = $.ui.resolve(e)
        return Text({ children: ['SUNNY'] })
      })`,
    })
    const ref = (plugin: string): ModModuleRef => ({ plugin, path: `/plugins/${plugin}/hooks/register.js` })
    await runtime.ready
    const drawnBy = async () => {
      const drawn = await runtime.render({ component: 'AbovePrompt', requestId: 'band', props: BAND_PROPS })
      return drawn.kind === 'tree' ? [...(drawn.plugins ?? [])].sort() : []
    }
    expect(await drawnBy()).toEqual(['bar', 'weather'])

    await runtime.reconcile([ref('weather')])
    expect(await drawnBy()).toEqual(['weather'])

    await runtime.reconcile([ref('bar'), ref('weather')])
    expect(await drawnBy()).toEqual(['bar', 'weather'])
  })

  it('a switched-off plugin is marked stale before the rest of the reconcile finishes', async () => {
    let openGate!: () => void
    const slow = new Promise<void>(resolve => { openGate = resolve })
    const gates: Record<string, Promise<void>> = {}
    const { runtime, stale } = world({
      bar: `on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
        const { Box, Text } = $.ui.resolve(e)
        return Box({ flexDirection: 'column', children: [await next(e), Text({ children: ['BAR'] })] })
      })`,
      weather: `on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
        const { Text } = $.ui.resolve(e)
        return Text({ children: ['SUNNY'] })
      })`,
      clock: `on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => next(e))`,
    }, gates)
    const ref = (plugin: string): ModModuleRef => ({ plugin, path: `/plugins/${plugin}/hooks/register.js` })
    await runtime.reconcile([ref('bar'), ref('weather')])
    await runtime.ready
    gates.clock = slow
    let done = false
    const run = runtime.reconcile([ref('weather'), ref('clock')]).then(() => { done = true })
    await vi.waitFor(() => expect(stale()).toContainEqual({ plugin: 'bar' }))
    expect(done).toBe(false)
    openGate()
    await run
  })

  it('a runtime marks each plugin hooking a site stale once it is up, so a client that asked before it came up draws again', async () => {
    const { runtime, staleAtStart } = world({
      usage: `on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
        const { Text } = $.ui.resolve(e)
        return Text({ children: ['19% of context'] })
      })`,
      quiet: `on('session.start', ($, e, next) => next(e))`,
    })
    await runtime.ready
    expect(staleAtStart()).toEqual([{ plugin: 'usage' }])
  })

  it('an unhooked site is not asked: the band with a pane-only mod draws as the engine without a dispatch', async () => {
    const { runtime, reports } = world({ counter: COUNTER })
    await runtime.ready
    expect(await runtime.render({ component: 'AbovePrompt', requestId: 'band', props: BAND_PROPS })).toEqual({ kind: 'engine' })
    expect(reports.some(line => line.includes('ui.render'))).toBe(false)
  })

  it('a string tag and a JSX Fragment: h() builds data the surface refuses or a column Box', async () => {
    const { runtime, reports } = world({
      jsx: `
        on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
          const { Text } = $.ui.resolve(e)
          return h(Fragment, null, h(Text, null, 'one'), h(Text, { dimColor: true }, 'two'))
        })`,
      stringy: `
        on('ui.render', { component: 'Pane', requestId: 's' }, () => h('div', null, 'nope'))
        on('session.start', async ($, e, next) => { await $.ui.open({ id: 's' }); return next(e) })`,
    })
    await runtime.ready
    const band = await runtime.render({ component: 'AbovePrompt', requestId: 'band', props: BAND_PROPS })
    expect(band.kind).toBe('tree')
    if (band.kind === 'tree') {
      expect(band.tree).toMatchObject({ type: 'Box', props: { flexDirection: 'column' } })
      expect(texts(band.tree)).toEqual(['one', 'two'])
    }
    expect(await runtime.render({ component: 'Pane', requestId: 's', props: PANE_PROPS })).toEqual({ kind: 'engine' })
    expect(reports).toContainEqual(expect.stringMatching(/ui\.render \(Pane\) refused: this surface draws no element named "div"/))
  })
})

describe('ui.input and ui.select', () => {
  const FORM = `
    on('session.start', async ($, e, next) => { await $.ui.open({ id: 'form' }); return next(e) })
    on('ui.render', { component: 'Pane', requestId: 'form' }, ($, e) => {
      const { Box, Input, Select } = $.ui.resolve(e)
      return Box({ children: [
        Input({ key: 'q', placeholder: 'ask', onInput: v => $.ui.status('typing ' + v), onSubmit: (v, ev) => $.ui.status('sent ' + v + ' ' + ev.kind) }),
        Select({ key: 'pick', options: [{ value: 'a', label: 'A' }, { value: 'b' }], onSelect: (v, ev) => $.ui.status('picked ' + v + ' in ' + ev.requestId) }),
      ] })
    })
  `
  const handlesOf = (tree: unknown) => ({ q: buttonOf(tree, 'q')!.press.handle, pick: buttonOf(tree, 'pick')!.press.handle })

  it('a change and a submit reach onInput and onSubmit with the value; a pick reaches onSelect', async () => {
    const { runtime, lastState } = world({ form: FORM })
    await runtime.ready
    const drawn = await runtime.render({ component: 'Pane', requestId: 'form', props: PANE_PROPS })
    if (drawn.kind !== 'tree') throw new Error('expected a tree')
    const { q, pick } = handlesOf(drawn.tree)
    await runtime.uiInput({ kind: 'input', plugin: 'form', element: 'q', component: 'Pane', requestId: 'form', handle: q, inputKind: 'change', value: 'he' })
    await until(() => JSON.stringify(lastState()?.state.status).includes('typing he'))
    await runtime.uiInput({ kind: 'input', plugin: 'form', element: 'q', component: 'Pane', requestId: 'form', handle: q, inputKind: 'submit', value: 'hello' })
    await until(() => JSON.stringify(lastState()?.state.status).includes('sent hello submit'))
    await runtime.uiInput({ kind: 'select', plugin: 'form', element: 'pick', component: 'Pane', requestId: 'form', handle: pick, value: 'b' })
    await until(() => JSON.stringify(lastState()?.state.status).includes('picked b in form'))
  })

  it('a hook above rewrites the typing for the handler beneath', async () => {
    const { runtime, lastState } = world({
      shout: `on('ui.input', { plugin: 'form' }, ($, e, next) => next({ ...e, value: e.value.toUpperCase() }))`,
      form: FORM,
    })
    await runtime.ready
    const drawn = await runtime.render({ component: 'Pane', requestId: 'form', props: PANE_PROPS })
    if (drawn.kind !== 'tree') throw new Error('expected a tree')
    await runtime.uiInput({ kind: 'input', plugin: 'form', element: 'q', component: 'Pane', requestId: 'form', handle: handlesOf(drawn.tree).q, inputKind: 'submit', value: 'quiet' })
    await until(() => JSON.stringify(lastState()?.state.status).includes('sent QUIET submit'))
  })

  it('a handler that throws answers ok: false with the reason, and is reported', async () => {
    const { runtime, reports } = world({
      boom: `
        on('session.start', async ($, e, next) => { await $.ui.open({ id: 'b' }); return next(e) })
        on('ui.render', { component: 'Pane', requestId: 'b' }, ($, e) => {
          const { Button } = $.ui.resolve(e)
          return Button({ key: 'x', label: 'X', onPress: () => { throw new Error('kaboom') } })
        })`,
    })
    await runtime.ready
    const drawn = await runtime.render({ component: 'Pane', requestId: 'b', props: PANE_PROPS })
    if (drawn.kind !== 'tree') throw new Error('expected a tree')
    const answer = await runtime.uiInput({ kind: 'press', plugin: 'boom', element: 'x', component: 'Pane', requestId: 'b', handle: drawn.tree.type === 'Button' ? (drawn.tree as { press: { handle: number } }).press.handle : -1 })
    expect(answer).toMatchObject({ ok: false })
    expect((answer as { reason: string }).reason).toContain('kaboom')
    expect(reports.some(line => line.startsWith('boom: ui.press on x failed'))).toBe(true)
  })
})

describe('the person closes a pane; invalidation; a plugin gone', () => {
  it('closePane raises ui.close with origin person; a hook answering without next keeps it open', async () => {
    const { runtime, reports, lastState } = world({
      sticky: `
        on('session.start', async ($, e, next) => { await $.ui.open({ id: 'keep' }); await $.ui.open({ id: 'go' }); return next(e) })
        on('ui.close', { id: 'keep' }, async ($, e) => { await $.ui.log('close ' + e.id + ' by ' + e.origin.kind + ' refused'); return {} })
        on('ui.close', { id: 'go' }, ($, e, next) => next(e))
      `,
    })
    await runtime.ready
    expect(await runtime.closePane('sticky', 'keep')).toBe(false)
    expect(reports).toContain('sticky: close keep by person refused')
    expect(await runtime.closePane('sticky', 'go')).toBe(true)
    expect(await runtime.closePane('sticky', 'nope')).toBe(false)
    expect((lastState()?.state.panes as Array<{ id: string }>).map(p => p.id)).toEqual(['keep'])
  })

  it('showPane shows a tab; $.ui.invalidate marks the plugin\'s drawings stale, folded', async () => {
    const { runtime, stale, lastState } = world({
      tabs: `
        on('session.start', async ($, e, next) => { await $.ui.open({ id: 'one' }); await $.ui.open({ id: 'two' }); return next(e) })
        on('prompt.submit', ($, e, next) => { $.ui.invalidate('ui.render'); $.ui.invalidate('ui.render'); return next(e) })
      `,
    })
    await runtime.ready
    expect((lastState()?.state.panes as Array<{ id: string; isShown: boolean }>).find(p => p.isShown)?.id).toBe('two')
    expect(runtime.showPane('tabs', 'one')).toBe(true)
    expect((lastState()?.state.panes as Array<{ id: string; isShown: boolean }>).find(p => p.isShown)?.id).toBe('one')
    await runtime.promptSubmit('go')
    await until(() => stale().length > 0, 1_000)
    await sleep(150)
    expect(stale()).toEqual([{ plugin: 'tabs' }])
  })

  it('two clients drawing one site keep their own handles; a client that leaves takes its drawing with it', async () => {
    const { runtime } = world({ counter: COUNTER })
    await runtime.ready
    const press = (client: string, handle: number) =>
      runtime.uiInput({ kind: 'press', plugin: 'counter', element: 'bump', component: 'Pane', requestId: 'clock', handle, client })
    const desk = await runtime.render({ component: 'Pane', requestId: 'clock', props: PANE_PROPS, client: 'desk' })
    const phone = await runtime.render({ component: 'Pane', requestId: 'clock', props: PANE_PROPS, client: 'phone' })
    if (desk.kind !== 'tree' || phone.kind !== 'tree') throw new Error('expected trees')
    const deskHandle = buttonOf(desk.tree, 'bump')!.press.handle
    const phoneHandle = buttonOf(phone.tree, 'bump')!.press.handle
    // The phone's drawing did not drop the desktop's handles.
    expect(await press('desk', deskHandle)).toEqual({ ok: true })
    // A handle presses only for the client that drew it.
    expect(await press('desk', phoneHandle)).toEqual({ ok: false, reason: 'the drawing is gone' })
    runtime.clientGone('phone')
    expect(await press('phone', phoneHandle)).toEqual({ ok: false, reason: 'the drawing is gone' })
    expect(await press('desk', deskHandle)).toEqual({ ok: true })
  })

  it('a reload forgets the old worker\'s drawings: an old handle does not press a new closure, and the plugin is stale', async () => {
    const { runtime, reports, stale } = world({ counter: COUNTER })
    await runtime.ready
    const before = await runtime.render({ component: 'Pane', requestId: 'clock', props: PANE_PROPS })
    if (before.kind !== 'tree') throw new Error('expected a tree')
    const old = buttonOf(before.tree, 'bump')!.press.handle
    const outcome = await runtime.reload()
    expect(outcome.reloaded).toHaveLength(1)
    expect(stale()).toContainEqual({ plugin: 'counter' })
    expect(await runtime.uiInput({ kind: 'press', plugin: 'counter', element: 'bump', component: 'Pane', requestId: 'clock', handle: old })).toEqual({
      ok: false,
      reason: 'the drawing is gone',
    })
    expect(reports.filter(line => line.includes('"pressed"'))).toHaveLength(0)
  })

  it('a lost worker takes the plugin\'s panes with it, and a reload brings them back through session.start', async () => {
    const { runtime, workers, lastState } = world({ counter: COUNTER })
    await runtime.ready
    expect(lastState()?.state.panes).toHaveLength(1)
    workers.counter![0]!.crash()
    await until(() => (lastState()?.state.panes?.length ?? 1) === 0)
    await until(() => (lastState()?.state.panes?.length ?? 0) === 1, 3_000)
  })
})

// ── The UserMessage site — the first with an engine drawing ──

const USER_PROPS = { text: 'fix the build', origin: { kind: 'unclassified' as const }, isExpanded: true }

describe('ui.render — UserMessage', () => {
  it('is a site this surface draws: a hook on it is admitted and listed as hooked; Spinner is still refused', async () => {
    expect(refuseRegistrations([{ hookId: 'h1', pattern: 'ui.render', matcher: { component: 'UserMessage' }, hasCatch: false }])).toBeNull()
    expect(refuseRegistrations([{ hookId: 'h1', pattern: 'ui.render', matcher: { component: 'Spinner' }, hasCatch: false }])).toContain(
      'ui.render for Spinner',
    )
    const { runtime, lastState } = world({ badge: `on('ui.render', { component: 'UserMessage' }, ($, e, next) => next(e))` })
    await runtime.ready
    expect(lastState()?.state.hooked).toEqual([{ plugin: 'badge', component: 'UserMessage' }])
  })

  it('a hook that passes draws the engine\'s row, its props as the engine raised them', async () => {
    const { runtime, reports } = world({
      pass: `on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
        await $.ui.log(JSON.stringify({ requestId: e.requestId, props: e.props }))
        return next(e)
      })`,
    })
    await runtime.ready
    expect(await runtime.render({ component: 'UserMessage', requestId: 'u-1', props: USER_PROPS })).toEqual({ kind: 'engine' })
    expect(reports).toContain('pass: ' + JSON.stringify({ requestId: 'u-1', props: USER_PROPS }))
  })

  it('a text rewrite draws in the row alone: the engine\'s drawing, with the rewritten text', async () => {
    const { runtime } = world({
      shout: `on('ui.render', { component: 'UserMessage' }, ($, e, next) =>
        next({ ...e, props: { ...e.props, text: e.props.text.toUpperCase() } }))`,
    })
    await runtime.ready
    expect(await runtime.render({ component: 'UserMessage', requestId: 'u-1', props: USER_PROPS })).toEqual({
      kind: 'engine',
      rewrite: { text: 'FIX THE BUILD' },
    })
  })

  it('a tree may wrap the engine\'s row; each engine node carries the props its own next carried', async () => {
    const { runtime } = world({
      badge: `on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
        const { Box, Text } = $.ui.resolve(e)
        const plain = await next(e)
        const loud = await next({ ...e, props: { ...e.props, text: 'LOUD' } })
        return Box({ flexDirection: 'column', children: [Text({ children: ['BADGE ' + e.props.origin.kind] }), plain, loud] })
      })`,
    })
    await runtime.ready
    const drawn = await runtime.render({ component: 'UserMessage', requestId: 'u-1', props: USER_PROPS })
    expect(drawn.kind).toBe('tree')
    if (drawn.kind !== 'tree') return
    expect(texts(drawn.tree)).toEqual(['BADGE unclassified'])
    const engines = (drawn.tree as Tree).children!.filter(child => typeof child === 'object' && child.type === 'engine') as Array<{ ref: number }>
    expect(engines).toHaveLength(2)
    expect(drawn.rewrites).toEqual({ [String(engines[1]!.ref)]: { text: 'LOUD' } })
  })

  it('a rewrite of a read-only prop, an unknown prop or a control character draws the original, said in the report', async () => {
    const { runtime, reports } = world({
      bad: `on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
        const which = e.requestId
        if (which === 'origin') return next({ ...e, props: { ...e.props, origin: { kind: 'composer' } } })
        if (which === 'expanded') return next({ ...e, props: { ...e.props, isExpanded: false } })
        if (which === 'extra') return next({ ...e, props: { ...e.props, from: { name: 'x' } } })
        return next({ ...e, props: { ...e.props, text: 'bell \\u0007' } })
      })`,
    })
    await runtime.ready
    for (const requestId of ['origin', 'expanded', 'extra', 'control']) {
      expect(await runtime.render({ component: 'UserMessage', requestId, props: USER_PROPS }), requestId).toEqual({ kind: 'engine' })
    }
    const refused = reports.filter(line => line.startsWith('hooks: ui.render (UserMessage) props refused: '))
    expect(refused).toEqual([
      'hooks: ui.render (UserMessage) props refused: origin is read-only; the engine drew the original',
      'hooks: ui.render (UserMessage) props refused: isExpanded is read-only; the engine drew the original',
      'hooks: ui.render (UserMessage) props refused: UserMessage takes no prop named "from"; the engine drew the original',
      'hooks: ui.render (UserMessage) props refused: text holds a control character; the engine drew the original',
    ])
  })

  it('a plugin\'s prompt carries its origin; a tree that does not validate draws the engine\'s row', async () => {
    const { runtime, reports } = world({
      seen: `on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
        await $.ui.log(JSON.stringify(e.props.origin))
        return { type: 'Marquee' }
      })`,
    })
    await runtime.ready
    const props = { ...USER_PROPS, origin: { kind: 'plugin' as const, name: 'lab' } }
    expect(await runtime.render({ component: 'UserMessage', requestId: 'u-2', props })).toEqual({ kind: 'engine' })
    expect(reports).toContain('seen: ' + JSON.stringify({ kind: 'plugin', name: 'lab' }))
    expect(reports.some(line => line.includes('ui.render (UserMessage) refused: this surface draws no element named "Marquee"'))).toBe(true)
  })

  it('a session with no ui.render hook asks nothing of the chain', async () => {
    const { runtime } = world({ other: `on('prompt.submit', ($, e, next) => next(e))` })
    await runtime.ready
    expect(await runtime.render({ component: 'UserMessage', requestId: 'u-1', props: USER_PROPS })).toEqual({ kind: 'engine' })
  })
})

// ── The CommandOutput site — a slash command's output row ──

const COMMAND_PROPS = { command: 'cost', args: '--all', text: 'Total: $0.12', isErrored: false }

describe('ui.render — CommandOutput', () => {
  it('is a site this surface draws: a hook on it is admitted, one naming its command too', async () => {
    expect(refuseRegistrations([{ hookId: 'h1', pattern: 'ui.render', matcher: { component: 'CommandOutput' }, hasCatch: false }])).toBeNull()
    expect(
      refuseRegistrations([
        { hookId: 'h1', pattern: 'ui.render', matcher: { component: 'CommandOutput', props: { command: 'mine' } }, hasCatch: false },
      ]),
    ).toBeNull()
    const { runtime, lastState } = world({ out: `on('ui.render', { component: 'CommandOutput' }, ($, e, next) => next(e))` })
    await runtime.ready
    expect(lastState()?.state.hooked).toEqual([{ plugin: 'out', component: 'CommandOutput' }])
  })

  it('a hook that passes draws the engine\'s row, its props as the engine raised them', async () => {
    const { runtime, reports } = world({
      pass: `on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
        await $.ui.log(JSON.stringify({ requestId: e.requestId, props: e.props }))
        return next(e)
      })`,
    })
    await runtime.ready
    expect(await runtime.render({ component: 'CommandOutput', requestId: 'c-1', props: COMMAND_PROPS })).toEqual({ kind: 'engine' })
    expect(reports).toContain('pass: ' + JSON.stringify({ requestId: 'c-1', props: COMMAND_PROPS }))
  })

  it('a text rewrite draws there: the engine\'s row with the rewritten markdown', async () => {
    const { runtime } = world({
      bold: `on('ui.render', { component: 'CommandOutput' }, ($, e, next) =>
        next({ ...e, props: { ...e.props, text: '**' + e.props.text + '**' } }))`,
    })
    await runtime.ready
    expect(await runtime.render({ component: 'CommandOutput', requestId: 'c-1', props: COMMAND_PROPS })).toEqual({
      kind: 'engine',
      rewrite: { text: '**Total: $0.12**' },
    })
  })

  it('a matcher on its command draws that command\'s row alone', async () => {
    const { runtime } = world({
      mine: `on('ui.render', { component: 'CommandOutput', props: { command: 'mine' } }, ($, e) => {
        const { Text } = $.ui.resolve(e)
        return Text({ children: ['MINE ' + e.props.text] })
      })`,
    })
    await runtime.ready
    const drawn = await runtime.render({ component: 'CommandOutput', requestId: 'c-2', props: { ...COMMAND_PROPS, command: 'mine' } })
    expect(drawn.kind).toBe('tree')
    if (drawn.kind === 'tree') expect(texts(drawn.tree)).toEqual(['MINE Total: $0.12'])
    expect(await runtime.render({ component: 'CommandOutput', requestId: 'c-3', props: COMMAND_PROPS })).toEqual({ kind: 'engine' })
  })

  it('a rewrite of command, args or isErrored, or an unknown prop, draws the original, said in the report', async () => {
    const { runtime, reports } = world({
      bad: `on('ui.render', { component: 'CommandOutput' }, ($, e, next) => {
        const which = e.requestId
        if (which === 'command') return next({ ...e, props: { ...e.props, command: 'other' } })
        if (which === 'dropped') { const { command, ...rest } = e.props; return next({ ...e, props: rest }) }
        if (which === 'args') return next({ ...e, props: { ...e.props, args: '' } })
        if (which === 'errored') return next({ ...e, props: { ...e.props, isErrored: true } })
        return next({ ...e, props: { ...e.props, onScreen: null } })
      })`,
    })
    await runtime.ready
    for (const requestId of ['command', 'dropped', 'args', 'errored', 'extra']) {
      expect(await runtime.render({ component: 'CommandOutput', requestId, props: COMMAND_PROPS }), requestId).toEqual({ kind: 'engine' })
    }
    expect(reports.filter(line => line.startsWith('hooks: ui.render (CommandOutput) props refused: '))).toEqual([
      'hooks: ui.render (CommandOutput) props refused: command is read-only; the engine drew the original',
      'hooks: ui.render (CommandOutput) props refused: command is read-only; the engine drew the original',
      'hooks: ui.render (CommandOutput) props refused: args is read-only; the engine drew the original',
      'hooks: ui.render (CommandOutput) props refused: isErrored is read-only; the engine drew the original',
      'hooks: ui.render (CommandOutput) props refused: CommandOutput takes no prop named "onScreen"; the engine drew the original',
    ])
  })

  it('a tree that does not validate draws the engine\'s row', async () => {
    const { runtime, reports } = world({
      odd: `on('ui.render', { component: 'CommandOutput' }, () => ({ type: 'Marquee' }))`,
    })
    await runtime.ready
    expect(await runtime.render({ component: 'CommandOutput', requestId: 'c-1', props: COMMAND_PROPS })).toEqual({ kind: 'engine' })
    expect(reports.some(line => line.includes('ui.render (CommandOutput) refused: this surface draws no element named "Marquee"'))).toBe(true)
  })
})

// ── the PromptHint site — the composer's hint line ──

const HINT_PROPS = { isDraft: true, isWorking: false, hint: 'Enter to send · Shift+Enter for a new line' }

describe('ui.render — PromptHint', () => {
  it('is a site this surface draws: a hook on it is admitted and its site hooked, no report', async () => {
    expect(refuseRegistrations([{ hookId: 'h1', pattern: 'ui.render', matcher: { component: 'PromptHint' }, hasCatch: false }])).toBeNull()
    const { runtime, reports, lastState } = world({ hint: `on('ui.render', { component: 'PromptHint' }, ($, e, next) => next(e))` })
    await runtime.ready
    expect(lastState()?.state.hooked).toEqual([{ plugin: 'hint', component: 'PromptHint' }])
    expect(reports.filter(line => line.includes('PromptHint'))).toEqual([])
  })

  it("a hook that passes draws the engine's line, its props and viewport as the engine raised them", async () => {
    const { runtime, reports } = world({
      pass: `on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
        await $.ui.log(JSON.stringify({ surface: e.surface, requestId: e.requestId, viewport: e.viewport, props: e.props }))
        return next(e)
      })`,
    })
    await runtime.ready
    const viewport = { columns: 48, rows: 40, isFullscreen: false }
    expect(await runtime.render({ component: 'PromptHint', requestId: 'hint', props: HINT_PROPS, viewport })).toEqual({ kind: 'engine' })
    expect(reports).toContain('pass: ' + JSON.stringify({ surface: 'desktop', requestId: 'hint', viewport, props: HINT_PROPS }))
  })

  it("a hint rewrite draws in the line's place; a tail rides after the engine's line; both together carry both", async () => {
    const { runtime } = world({
      line: `on('ui.render', { component: 'PromptHint' }, ($, e, next) => {
        if (e.requestId === 'hint-only') return next({ ...e, props: { ...e.props, hint: 'mine' } })
        if (e.requestId === 'tail-only') return next({ ...e, props: { ...e.props, tail: 'main · 3 files' } })
        if (e.requestId === 'both') return next({ ...e, props: { ...e.props, hint: '', tail: 'idle' } })
        return next({ ...e, props: { ...e.props, tail: '' } })
      })`,
    })
    await runtime.ready
    expect(await runtime.render({ component: 'PromptHint', requestId: 'hint-only', props: HINT_PROPS })).toEqual({
      kind: 'engine',
      rewrite: { hint: 'mine' },
    })
    expect(await runtime.render({ component: 'PromptHint', requestId: 'tail-only', props: HINT_PROPS })).toEqual({
      kind: 'engine',
      rewrite: { hint: HINT_PROPS.hint, tail: 'main · 3 files' },
    })
    // The empty prompt is raised too (`hint: ""`): a hook may fill the line.
    expect(
      await runtime.render({ component: 'PromptHint', requestId: 'both', props: { isDraft: false, isWorking: false, hint: '' } }),
    ).toEqual({ kind: 'engine', rewrite: { hint: '', tail: 'idle' } })
    // An empty tail and an unchanged hint are no rewrite.
    expect(await runtime.render({ component: 'PromptHint', requestId: 'empty-tail', props: HINT_PROPS })).toEqual({ kind: 'engine' })
  })

  it('a rewrite of isDraft or isWorking, a hint or tail that is not one bounded line, or an unknown prop draws the original, said in the report', async () => {
    const { runtime, reports } = world({
      bad: `on('ui.render', { component: 'PromptHint' }, ($, e, next) => {
        const which = e.requestId
        if (which === 'draft') return next({ ...e, props: { ...e.props, isDraft: false } })
        if (which === 'working') return next({ ...e, props: { ...e.props, isWorking: true } })
        if (which === 'dropped') { const { hint, ...rest } = e.props; return next({ ...e, props: rest }) }
        if (which === 'break') return next({ ...e, props: { ...e.props, hint: 'two' + String.fromCharCode(10) + 'rows' } })
        if (which === 'long') return next({ ...e, props: { ...e.props, tail: 'x'.repeat(1001) } })
        if (which === 'number') return next({ ...e, props: { ...e.props, tail: 3 } })
        return next({ ...e, props: { ...e.props, onScreen: null } })
      })`,
    })
    await runtime.ready
    for (const requestId of ['draft', 'working', 'dropped', 'break', 'long', 'number', 'extra']) {
      expect(await runtime.render({ component: 'PromptHint', requestId, props: HINT_PROPS }), requestId).toEqual({ kind: 'engine' })
    }
    expect(reports.filter(line => line.startsWith('hooks: ui.render (PromptHint) props refused: '))).toEqual([
      'hooks: ui.render (PromptHint) props refused: isDraft is read-only; the engine drew the original',
      'hooks: ui.render (PromptHint) props refused: isWorking is read-only; the engine drew the original',
      'hooks: ui.render (PromptHint) props refused: hint is not a string; the engine drew the original',
      'hooks: ui.render (PromptHint) props refused: hint holds a control character; the engine drew the original',
      'hooks: ui.render (PromptHint) props refused: tail is longer than 1000 characters; the engine drew the original',
      'hooks: ui.render (PromptHint) props refused: tail is not a string; the engine drew the original',
      'hooks: ui.render (PromptHint) props refused: PromptHint takes no prop named "onScreen"; the engine drew the original',
    ])
  })

  it("a hook's own tree draws in the line's place, and its Button presses back to the hook", async () => {
    const { runtime, reports } = world({
      own: `on('ui.render', { component: 'PromptHint' }, ($, e) => {
        const { Box, Text, Button } = $.ui.resolve(e)
        return Box({ children: [
          Text({ children: ['MINE ' + (e.props.isDraft ? 'draft' : 'idle')] }),
          Button({ key: 'go', label: 'Go', onPress: () => { void $.ui.log('pressed') } }),
        ] })
      })`,
    })
    await runtime.ready
    const drawn = await runtime.render({ component: 'PromptHint', requestId: 'hint', props: HINT_PROPS })
    expect(drawn.kind).toBe('tree')
    if (drawn.kind !== 'tree') return
    expect(texts(drawn.tree)).toEqual(['MINE draft'])
    const button = (drawn.tree as unknown as { children: Array<{ type: string; press?: { plugin: string; handle: number } }> }).children[1]!
    expect(button.type).toBe('Button')
    expect(
      await runtime.uiInput({ kind: 'press', plugin: 'own', element: 'go', component: 'PromptHint', requestId: 'hint', handle: button.press!.handle }),
    ).toEqual({ ok: true })
    await until(() => reports.includes('own: pressed'))
  })
})

// ── The AssistantMessage site — one text block of a reply ──

const REPLY_PROPS = { text: 'The build is green.', isFirstOfReply: true }

describe('ui.render — AssistantMessage', () => {
  it('is a site this surface draws: a mod hooking it alone is admitted and listed as hooked', async () => {
    // The refusal a mod that draws reply text alone (memo-aid) met:
    // "it hooks an event this engine does not raise yet: ui.render for AssistantMessage".
    expect(refuseRegistrations([{ hookId: 'h1', pattern: 'ui.render', matcher: { component: 'AssistantMessage' }, hasCatch: false }])).toBeNull()
    expect(
      refuseRegistrations([
        { hookId: 'h1', pattern: 'ui.render', matcher: { component: 'AssistantMessage', props: { isFirstOfReply: true } }, hasCatch: false },
      ]),
    ).toBeNull()
    const { runtime, lastState } = world({ reply: `on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => next(e))` })
    await runtime.ready
    expect(lastState()?.state.hooked).toEqual([{ plugin: 'reply', component: 'AssistantMessage' }])
  })

  it('a hook that passes draws the engine\'s block, its props as the engine raised them', async () => {
    const { runtime, reports } = world({
      pass: `on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
        await $.ui.log(JSON.stringify({ requestId: e.requestId, props: e.props }))
        return next(e)
      })`,
    })
    await runtime.ready
    expect(await runtime.render({ component: 'AssistantMessage', requestId: 'a-1:0', props: REPLY_PROPS })).toEqual({ kind: 'engine' })
    expect(reports).toContain('pass: ' + JSON.stringify({ requestId: 'a-1:0', props: REPLY_PROPS }))
  })

  it('a text rewrite draws in the block alone: the engine\'s block with the rewritten markdown', async () => {
    const { runtime } = world({
      fence: `on('ui.render', { component: 'AssistantMessage' }, ($, e, next) =>
        next({ ...e, props: { ...e.props, text: e.props.text.replace('green', '**green**') } }))`,
    })
    await runtime.ready
    expect(await runtime.render({ component: 'AssistantMessage', requestId: 'a-1:0', props: REPLY_PROPS })).toEqual({
      kind: 'engine',
      rewrite: { text: 'The build is **green**.' },
    })
  })

  it('a hook\'s own tree draws in the block\'s place; a matcher on isFirstOfReply selects the opening block alone', async () => {
    const { runtime } = world({
      first: `on('ui.render', { component: 'AssistantMessage', props: { isFirstOfReply: true } }, ($, e) => {
        const { Markdown } = $.ui.resolve(e)
        return Markdown({ text: '> ' + e.props.text })
      })`,
    })
    await runtime.ready
    const drawn = await runtime.render({ component: 'AssistantMessage', requestId: 'a-1:0', props: REPLY_PROPS })
    expect(drawn.kind).toBe('tree')
    if (drawn.kind === 'tree') expect(drawn.tree).toMatchObject({ type: 'Markdown', props: { text: '> The build is green.' } })
    expect(
      await runtime.render({ component: 'AssistantMessage', requestId: 'a-1:2', props: { ...REPLY_PROPS, isFirstOfReply: false } }),
    ).toEqual({ kind: 'engine' })
  })

  it('a rewrite of isFirstOfReply, an unknown prop or a control character draws the original, said in the report', async () => {
    const { runtime, reports } = world({
      bad: `on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
        const which = e.requestId
        if (which === 'first') return next({ ...e, props: { ...e.props, isFirstOfReply: false } })
        if (which === 'extra') return next({ ...e, props: { ...e.props, onScreen: null } })
        return next({ ...e, props: { ...e.props, text: 'bell \\u0007' } })
      })`,
    })
    await runtime.ready
    for (const requestId of ['first', 'extra', 'control']) {
      expect(await runtime.render({ component: 'AssistantMessage', requestId, props: REPLY_PROPS }), requestId).toEqual({ kind: 'engine' })
    }
    expect(reports.filter(line => line.startsWith('hooks: ui.render (AssistantMessage) props refused: '))).toEqual([
      'hooks: ui.render (AssistantMessage) props refused: isFirstOfReply is read-only; the engine drew the original',
      'hooks: ui.render (AssistantMessage) props refused: AssistantMessage takes no prop named "onScreen"; the engine drew the original',
      'hooks: ui.render (AssistantMessage) props refused: text holds a control character; the engine drew the original',
    ])
  })
})

// ── The ToolUse site — a tool call's row ──

const TOOL_PROPS = {
  tool_use_id: 't-1',
  tool: 'Bash',
  input: { command: 'ls' },
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
  output: 'a\nb',
}
const RUNNING_PROPS = { tool_use_id: 't-2', tool: 'Bash', input: { command: 'sleep 9' }, isRunning: true, isErrored: false, isInterrupted: false }

describe('ui.render — ToolUse', () => {
  it('is a site this surface draws: a hook on it is admitted, one naming its tool too', async () => {
    expect(refuseRegistrations([{ hookId: 'h1', pattern: 'ui.render', matcher: { component: 'ToolUse' }, hasCatch: false }])).toBeNull()
    expect(
      refuseRegistrations([
        { hookId: 'h1', pattern: 'ui.render', matcher: { component: 'ToolUse', props: { tool: 'Bash' } }, hasCatch: false },
      ]),
    ).toBeNull()
    const { runtime, lastState } = world({ rows: `on('ui.render', { component: 'ToolUse' }, ($, e, next) => next(e))` })
    await runtime.ready
    expect(lastState()?.state.hooked).toEqual([{ plugin: 'rows', component: 'ToolUse' }])
  })

  it("a hook that passes draws the engine's row, its props as the engine raised them", async () => {
    const { runtime, reports } = world({
      pass: `on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
        await $.ui.log(JSON.stringify({ requestId: e.requestId, props: e.props }))
        return next(e)
      })`,
    })
    await runtime.ready
    expect(await runtime.render({ component: 'ToolUse', requestId: 't-1', props: TOOL_PROPS })).toEqual({ kind: 'engine' })
    expect(await runtime.render({ component: 'ToolUse', requestId: 't-2', props: RUNNING_PROPS })).toEqual({ kind: 'engine' })
    expect(reports).toContain('pass: ' + JSON.stringify({ requestId: 't-1', props: TOOL_PROPS }))
    expect(reports).toContain('pass: ' + JSON.stringify({ requestId: 't-2', props: RUNNING_PROPS }))
  })

  it("an input or output rewrite draws in the engine's row, each only when it changed", async () => {
    const { runtime } = world({
      mask: `on('ui.render', { component: 'ToolUse' }, ($, e, next) => {
        if (e.requestId === 'both') return next({ ...e, props: { ...e.props, input: { command: '***' }, output: 'hidden' } })
        if (e.requestId === 'output') return next({ ...e, props: { ...e.props, input: { ...e.props.input }, output: 'hidden' } })
        return next({ ...e, props: { ...e.props, input: { command: 'masked' } } })
      })`,
    })
    await runtime.ready
    expect(await runtime.render({ component: 'ToolUse', requestId: 'both', props: TOOL_PROPS })).toEqual({
      kind: 'engine',
      rewrite: { input: { command: '***' }, output: 'hidden' },
    })
    expect(await runtime.render({ component: 'ToolUse', requestId: 'output', props: TOOL_PROPS })).toEqual({
      kind: 'engine',
      rewrite: { output: 'hidden' },
    })
    expect(await runtime.render({ component: 'ToolUse', requestId: 'running', props: RUNNING_PROPS })).toEqual({
      kind: 'engine',
      rewrite: { input: { command: 'masked' } },
    })
  })

  it("a tree wrapping the engine's row carries each engine node's own rewrite", async () => {
    const { runtime } = world({
      badge: `on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
        const { Box, Text } = $.ui.resolve(e)
        const masked = await next({ ...e, props: { ...e.props, output: '[' + e.props.tool + ' output hidden]' } })
        return Box({ flexDirection: 'column', children: [Text({ children: ['AUDITED'] }), masked] })
      })`,
    })
    await runtime.ready
    const drawn = await runtime.render({ component: 'ToolUse', requestId: 't-1', props: TOOL_PROPS })
    if (drawn.kind !== 'tree') throw new Error('expected a tree')
    expect(texts(drawn.tree)).toEqual(['AUDITED'])
    const engines = (drawn.tree as Tree).children!.filter(child => typeof child === 'object' && child.type === 'engine') as Array<{ ref: number }>
    expect(engines).toHaveLength(1)
    expect(drawn.rewrites).toEqual({ [String(engines[0]!.ref)]: { output: '[Bash output hidden]' } })
  })

  it("a matcher on its tool draws that tool's rows alone", async () => {
    const { runtime } = world({
      grep: `on('ui.render', { component: 'ToolUse', props: { tool: 'Grep' } }, ($, e) => {
        const { Text } = $.ui.resolve(e)
        return Text({ children: ['GREP ' + e.props.input.pattern] })
      })`,
    })
    await runtime.ready
    const drawn = await runtime.render({ component: 'ToolUse', requestId: 't-3', props: { ...TOOL_PROPS, tool: 'Grep', input: { pattern: 'x' } } })
    expect(drawn.kind).toBe('tree')
    if (drawn.kind === 'tree') expect(texts(drawn.tree)).toEqual(['GREP x'])
    expect(await runtime.render({ component: 'ToolUse', requestId: 't-1', props: TOOL_PROPS })).toEqual({ kind: 'engine' })
  })

  it('a rewrite of the id, the tool or a state flag, an output while it runs, or an unknown prop draws the original, said in the report', async () => {
    const { runtime, reports } = world({
      bad: `on('ui.render', { component: 'ToolUse' }, ($, e, next) => {
        const which = e.requestId
        if (which === 'id') return next({ ...e, props: { ...e.props, tool_use_id: 'other' } })
        if (which === 'tool') return next({ ...e, props: { ...e.props, tool: 'Read' } })
        if (which === 'running') return next({ ...e, props: { ...e.props, isRunning: true } })
        if (which === 'errored') return next({ ...e, props: { ...e.props, isErrored: true } })
        if (which === 'interrupted') return next({ ...e, props: { ...e.props, isInterrupted: true } })
        if (which === 'early') return next({ ...e, props: { ...e.props, output: 'done' } })
        if (which === 'fn') return next({ ...e, props: { ...e.props, input: 1n } })
        if (which === 'long') return next({ ...e, props: { ...e.props, output: 'x'.repeat(100001) } })
        return next({ ...e, props: { ...e.props, onScreen: null } })
      })`,
    })
    await runtime.ready
    for (const requestId of ['id', 'tool', 'running', 'errored', 'interrupted', 'fn', 'long', 'extra']) {
      expect(await runtime.render({ component: 'ToolUse', requestId, props: TOOL_PROPS }), requestId).toEqual({ kind: 'engine' })
    }
    expect(await runtime.render({ component: 'ToolUse', requestId: 'early', props: RUNNING_PROPS })).toEqual({ kind: 'engine' })
    expect(reports.filter(line => line.startsWith('hooks: ui.render (ToolUse) props refused: '))).toEqual([
      'hooks: ui.render (ToolUse) props refused: tool_use_id is read-only; the engine drew the original',
      'hooks: ui.render (ToolUse) props refused: tool is read-only; the engine drew the original',
      'hooks: ui.render (ToolUse) props refused: isRunning is read-only; the engine drew the original',
      'hooks: ui.render (ToolUse) props refused: isErrored is read-only; the engine drew the original',
      'hooks: ui.render (ToolUse) props refused: isInterrupted is read-only; the engine drew the original',
      'hooks: ui.render (ToolUse) props refused: input is not plain data; the engine drew the original',
      'hooks: ui.render (ToolUse) props refused: output is longer than 100000 characters as JSON; the engine drew the original',
      'hooks: ui.render (ToolUse) props refused: ToolUse takes no prop named "onScreen"; the engine drew the original',
      'hooks: ui.render (ToolUse) props refused: output is absent while the call runs; the engine drew the original',
    ])
  })

  it("a tree that does not validate draws the engine's row", async () => {
    const { runtime, reports } = world({
      odd: `on('ui.render', { component: 'ToolUse' }, () => ({ type: 'Marquee' }))`,
    })
    await runtime.ready
    expect(await runtime.render({ component: 'ToolUse', requestId: 't-1', props: TOOL_PROPS })).toEqual({ kind: 'engine' })
    expect(reports.some(line => line.includes('ui.render (ToolUse) refused: this surface draws no element named "Marquee"'))).toBe(true)
  })
})

// ── The ToolResult site — a lone card's result block ──

const RESULT_PROPS = { tool_use_id: 'r-1', tool: 'Bash', output: 'a\nb', isErrored: false }

describe('ui.render — ToolResult', () => {
  it('is a site this surface draws: a hook on it is admitted, one naming its tool too', async () => {
    expect(refuseRegistrations([{ hookId: 'h1', pattern: 'ui.render', matcher: { component: 'ToolResult' }, hasCatch: false }])).toBeNull()
    expect(
      refuseRegistrations([
        { hookId: 'h1', pattern: 'ui.render', matcher: { component: 'ToolResult', props: { tool: 'Bash' } }, hasCatch: false },
      ]),
    ).toBeNull()
    const { runtime, lastState } = world({ results: `on('ui.render', { component: 'ToolResult' }, ($, e, next) => next(e))` })
    await runtime.ready
    expect(lastState()?.state.hooked).toEqual([{ plugin: 'results', component: 'ToolResult' }])
  })

  it("a hook that passes draws the engine's block, its props as the engine raised them", async () => {
    const { runtime, reports } = world({
      pass: `on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
        await $.ui.log(JSON.stringify({ requestId: e.requestId, props: e.props }))
        return next(e)
      })`,
    })
    await runtime.ready
    expect(await runtime.render({ component: 'ToolResult', requestId: 'r-1', props: RESULT_PROPS })).toEqual({ kind: 'engine' })
    expect(reports).toContain('pass: ' + JSON.stringify({ requestId: 'r-1', props: RESULT_PROPS }))
  })

  it("an output rewrite draws in the engine's block; an unchanged one is no rewrite", async () => {
    const { runtime } = world({
      upper: `on('ui.render', { component: 'ToolResult' }, ($, e, next) =>
        e.requestId === 'same'
          ? next({ ...e, props: { ...e.props, output: String(e.props.output) } })
          : next({ ...e, props: { ...e.props, output: String(e.props.output).toUpperCase() } }))`,
    })
    await runtime.ready
    expect(await runtime.render({ component: 'ToolResult', requestId: 'r-1', props: RESULT_PROPS })).toEqual({
      kind: 'engine',
      rewrite: { output: 'A\nB' },
    })
    expect(await runtime.render({ component: 'ToolResult', requestId: 'same', props: RESULT_PROPS })).toEqual({ kind: 'engine' })
  })

  it("a matcher on its tool draws that tool's blocks alone, a tree in the block's place", async () => {
    const { runtime } = world({
      grep: `on('ui.render', { component: 'ToolResult', props: { tool: 'Grep' } }, ($, e) => {
        const { Text } = $.ui.resolve(e)
        return Text({ children: ['HITS ' + e.props.output] })
      })`,
    })
    await runtime.ready
    const drawn = await runtime.render({ component: 'ToolResult', requestId: 'r-2', props: { ...RESULT_PROPS, tool: 'Grep', output: '3' } })
    expect(drawn.kind).toBe('tree')
    if (drawn.kind === 'tree') expect(texts(drawn.tree)).toEqual(['HITS 3'])
    expect(await runtime.render({ component: 'ToolResult', requestId: 'r-1', props: RESULT_PROPS })).toEqual({ kind: 'engine' })
  })

  it('a rewrite of the id, the tool or isErrored, a dropped or over-long output, or an unknown prop draws the original, said in the report', async () => {
    const { runtime, reports } = world({
      bad: `on('ui.render', { component: 'ToolResult' }, ($, e, next) => {
        const which = e.requestId
        if (which === 'id') return next({ ...e, props: { ...e.props, tool_use_id: 'other' } })
        if (which === 'tool') return next({ ...e, props: { ...e.props, tool: 'Read' } })
        if (which === 'errored') return next({ ...e, props: { ...e.props, isErrored: true } })
        if (which === 'dropped') { const { output, ...rest } = e.props; return next({ ...e, props: rest }) }
        if (which === 'long') return next({ ...e, props: { ...e.props, output: 'x'.repeat(100001) } })
        return next({ ...e, props: { ...e.props, isRunning: false } })
      })`,
    })
    await runtime.ready
    for (const requestId of ['id', 'tool', 'errored', 'dropped', 'long', 'extra']) {
      expect(await runtime.render({ component: 'ToolResult', requestId, props: RESULT_PROPS }), requestId).toEqual({ kind: 'engine' })
    }
    expect(reports.filter(line => line.startsWith('hooks: ui.render (ToolResult) props refused: '))).toEqual([
      'hooks: ui.render (ToolResult) props refused: tool_use_id is read-only; the engine drew the original',
      'hooks: ui.render (ToolResult) props refused: tool is read-only; the engine drew the original',
      'hooks: ui.render (ToolResult) props refused: isErrored is read-only; the engine drew the original',
      'hooks: ui.render (ToolResult) props refused: output is not plain data; the engine drew the original',
      'hooks: ui.render (ToolResult) props refused: output is longer than 100000 characters as JSON; the engine drew the original',
      'hooks: ui.render (ToolResult) props refused: ToolResult takes no prop named "isRunning"; the engine drew the original',
    ])
  })

  it("a tree that does not validate draws the engine's block", async () => {
    const { runtime, reports } = world({
      odd: `on('ui.render', { component: 'ToolResult' }, () => ({ type: 'Marquee' }))`,
    })
    await runtime.ready
    expect(await runtime.render({ component: 'ToolResult', requestId: 'r-1', props: RESULT_PROPS })).toEqual({ kind: 'engine' })
    expect(reports.some(line => line.includes('ui.render (ToolResult) refused: this surface draws no element named "Marquee"'))).toBe(true)
  })
})

// ── The ToolGroup site — a run's plan card ──

const GROUP_CALLS = [
  { tool_use_id: 'g-1', tool: 'Read', input: { file_path: '/a' }, isRunning: false, isErrored: false, isInterrupted: false, output: 'A' },
  { tool_use_id: 'g-2', tool: 'Grep', input: { pattern: 'x' }, isRunning: true, isErrored: false, isInterrupted: false },
]
const GROUP_PROPS = { calls: GROUP_CALLS, isActive: true, isExpanded: false }

describe('ui.render — ToolGroup', () => {
  it('is a site this surface draws: a hook on it is admitted and listed as hooked', async () => {
    expect(refuseRegistrations([{ hookId: 'h1', pattern: 'ui.render', matcher: { component: 'ToolGroup' }, hasCatch: false }])).toBeNull()
    const { runtime, lastState } = world({ groups: `on('ui.render', { component: 'ToolGroup' }, ($, e, next) => next(e))` })
    await runtime.ready
    expect(lastState()?.state.hooked).toEqual([{ plugin: 'groups', component: 'ToolGroup' }])
  })

  it("a hook that passes draws the engine's card, its props as the engine raised them", async () => {
    const { runtime, reports } = world({
      pass: `on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
        await $.ui.log(JSON.stringify({ requestId: e.requestId, props: e.props }))
        return next(e)
      })`,
    })
    await runtime.ready
    expect(await runtime.render({ component: 'ToolGroup', requestId: 'g-1', props: GROUP_PROPS })).toEqual({ kind: 'engine' })
    expect(reports).toContain('pass: ' + JSON.stringify({ requestId: 'g-1', props: GROUP_PROPS }))
  })

  it('an isExpanded rewrite draws the card unfolded; an unchanged one is no rewrite', async () => {
    const { runtime } = world({
      unfold: `on('ui.render', { component: 'ToolGroup' }, ($, e, next) =>
        next({ ...e, props: { ...e.props, isExpanded: e.requestId === 'same' ? e.props.isExpanded : !e.props.isExpanded } }))`,
    })
    await runtime.ready
    expect(await runtime.render({ component: 'ToolGroup', requestId: 'g-1', props: GROUP_PROPS })).toEqual({
      kind: 'engine',
      rewrite: { isExpanded: true },
    })
    expect(await runtime.render({ component: 'ToolGroup', requestId: 'g-1', props: { ...GROUP_PROPS, isExpanded: true } })).toEqual({
      kind: 'engine',
      rewrite: { isExpanded: false },
    })
    expect(await runtime.render({ component: 'ToolGroup', requestId: 'same', props: GROUP_PROPS })).toEqual({ kind: 'engine' })
  })

  it("a hook's tree draws in the card's place, its engine node with the rewrite that node's next carried", async () => {
    const { runtime } = world({
      wrap: `on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
        const { Box, Text } = $.ui.resolve(e)
        const card = await next({ ...e, props: { ...e.props, isExpanded: true } })
        return Box({ children: [Text({ children: ['CALLS ' + e.props.calls.length] }), card] })
      })`,
    })
    await runtime.ready
    const drawn = await runtime.render({ component: 'ToolGroup', requestId: 'g-1', props: GROUP_PROPS })
    expect(drawn.kind).toBe('tree')
    if (drawn.kind === 'tree') {
      expect(texts(drawn.tree)).toEqual(['CALLS 2'])
      expect(Object.values(drawn.rewrites ?? {})).toEqual([{ isExpanded: true }])
    }
  })

  it('a rewrite of the calls or isActive, an isExpanded that is not a boolean, or an unknown prop draws the original, said in the report', async () => {
    const { runtime, reports } = world({
      bad: `on('ui.render', { component: 'ToolGroup' }, ($, e, next) => {
        const which = e.requestId
        if (which === 'calls') return next({ ...e, props: { ...e.props, calls: e.props.calls.slice(1) } })
        if (which === 'call') return next({ ...e, props: { ...e.props, calls: e.props.calls.map(c => ({ ...c, output: 'X' })) } })
        if (which === 'active') return next({ ...e, props: { ...e.props, isActive: false } })
        if (which === 'expanded') return next({ ...e, props: { ...e.props, isExpanded: 'yes' } })
        return next({ ...e, props: { ...e.props, title: 'T' } })
      })`,
    })
    await runtime.ready
    for (const requestId of ['calls', 'call', 'active', 'expanded', 'extra']) {
      expect(await runtime.render({ component: 'ToolGroup', requestId, props: GROUP_PROPS }), requestId).toEqual({ kind: 'engine' })
    }
    expect(reports.filter(line => line.startsWith('hooks: ui.render (ToolGroup) props refused: '))).toEqual([
      'hooks: ui.render (ToolGroup) props refused: calls is read-only; the engine drew the original',
      'hooks: ui.render (ToolGroup) props refused: calls is read-only; the engine drew the original',
      'hooks: ui.render (ToolGroup) props refused: isActive is read-only; the engine drew the original',
      'hooks: ui.render (ToolGroup) props refused: isExpanded is not a boolean; the engine drew the original',
      'hooks: ui.render (ToolGroup) props refused: ToolGroup takes no prop named "title"; the engine drew the original',
    ])
  })
})

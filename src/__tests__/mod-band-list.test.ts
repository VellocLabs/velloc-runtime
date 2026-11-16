/**
 * `ui.render` for `AbovePromptList` (F-25): the band above the prompt once its
 * rows settled. A hook naming it reorders or hides the rows it hands `next`, or
 * wraps what `next` stacked; a changed or repeated row is refused and the band
 * draws as it settled; a `ui.render` hook naming no component does not hear it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ModRuntime, type ModModuleRef, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import { bandListPropsProblem, hearsBandList, stackRows } from '../mods/bandArrangement'
import { renderMatcherSite, type RenderElement, type RenderNode } from '../mods/modRender'

let uniqueLoad = 0
const open: MessagePort[] = []
const runtimes: ModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of open.splice(0)) port.close()
})

function world(modules: Record<string, string>) {
  const reports: string[] = []
  const refs: ModModuleRef[] = Object.keys(modules).map(plugin => ({ plugin, path: `/plugins/${plugin}/hooks/register.js` }))
  const runtime = new ModRuntime({
    modules: refs,
    readModule: async path => `export function register(on) {\n${modules[path.split('/')[2]!]}\n}\n// load ${++uniqueLoad}`,
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
    session: { id: () => 'sess-band', cwd: () => '/work/project' },
    report: line => reports.push(line),
  })
  runtimes.push(runtime)
  return { runtime, reports }
}

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 6 },
  view: {},
}

function texts(node: RenderNode | undefined): string[] {
  if (node === undefined) return []
  if (typeof node === 'string') return [node]
  return 'children' in node && Array.isArray(node.children) ? node.children.flatMap(child => texts(child)) : []
}

/** Two plugins drawing the band, each its own row. */
const TWO_ROWS = {
  weather: `on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    return Box({ flexDirection: 'column', children: [Text({ children: ['cache 4:30'] }), rest] })
  })`,
  bar: `on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: ['context 19%'] })
  })`,
}

const band = (runtime: ModRuntime) => runtime.render({ component: 'AbovePrompt', requestId: 'band', props: BAND_PROPS })

describe('the shapes', () => {
  it('who hears it, what a rewrite may hand on, and that it is an admitted site', () => {
    expect(hearsBandList({ pattern: 'ui.render', matcher: { component: 'AbovePromptList' } })).toBe(true)
    expect(hearsBandList({ pattern: '*' })).toBe(true)
    expect(hearsBandList({ pattern: 'ui.render' })).toBe(false)
    expect(hearsBandList({ pattern: 'ui.render', matcher: { component: 'AbovePrompt' } })).toBe(false)
    expect(renderMatcherSite({ component: 'AbovePromptList' })).toEqual({ component: 'AbovePromptList' })

    const a = { plugin: 'a', tree: { type: 'Text', children: ['A'] } as RenderElement }
    const b = { plugin: 'b', tree: { type: 'Text', children: ['B'] } as RenderElement }
    const handed = { ...BAND_PROPS, rows: [a, b] }
    expect(bandListPropsProblem(handed, { ...handed, rows: [b, a] })).toBeNull()
    expect(bandListPropsProblem(handed, { ...handed, rows: [] })).toBeNull()
    expect(bandListPropsProblem(handed, { ...handed, rows: [a, a] })).toBe('a row is not one it was handed, or is repeated')
    expect(bandListPropsProblem(handed, { ...handed, rows: [{ ...a, tree: { type: 'Text', children: ['X'] } }] })).toBe(
      'a row is not one it was handed, or is repeated',
    )
    expect(bandListPropsProblem(handed, { ...handed, maxRows: 1 })).toBe('only rows may change')
    expect(stackRows([a, b])).toEqual({ type: 'Box', props: { flexDirection: 'column' }, children: [a.tree, b.tree] })
  })
})

describe('AbovePromptList through the runtime', () => {
  it('a hook reorders the rows: the band draws them in its order, one section each', async () => {
    const { runtime, reports } = world({
      ...TWO_ROWS,
      order: `on('ui.render', { component: 'AbovePromptList' }, ($, e, next) =>
        next({ ...e, props: { ...e.props, rows: [...e.props.rows].reverse() } }))`,
    })
    await runtime.ready
    const drawn = await band(runtime)
    expect(drawn.kind).toBe('tree')
    if (drawn.kind !== 'tree') return
    expect(drawn.sections?.map(section => section.plugin)).toEqual(['bar', 'weather'])
    expect(texts(drawn.tree)).toEqual(['context 19%', 'cache 4:30'])
    expect(drawn.plugins).toEqual(['bar', 'weather'])
    expect(reports).toEqual([])
  })

  it('a hook hides a row; hiding every row leaves the band empty', async () => {
    const { runtime } = world({
      ...TWO_ROWS,
      hide: `on('ui.render', { component: 'AbovePromptList' }, ($, e, next) =>
        next({ ...e, props: { ...e.props, rows: e.props.rows.filter(row => row.plugin !== 'bar') } }))`,
    })
    await runtime.ready
    const drawn = await band(runtime)
    expect(drawn.kind).toBe('tree')
    if (drawn.kind !== 'tree') return
    expect(drawn.sections).toBeUndefined()
    expect(drawn.plugins).toEqual(['weather'])
    expect(texts(drawn.tree)).toEqual(['cache 4:30'])

    const { runtime: blank } = world({
      ...TWO_ROWS,
      none: `on('ui.render', { component: 'AbovePromptList' }, ($, e, next) => next({ ...e, props: { ...e.props, rows: [] } }))`,
    })
    await blank.ready
    expect(await band(blank)).toEqual({ kind: 'engine' })
  })

  it('a hook wraps what next stacked: one tree, no sections, the wrapper named among the plugins', async () => {
    const { runtime } = world({
      ...TWO_ROWS,
      frame: `on('ui.render', { component: 'AbovePromptList' }, async ($, e, next) => {
        const rows = await next(e)
        const { Box, Text } = $.ui.resolve(e)
        return Box({ flexDirection: 'column', children: [Text({ children: ['band'] }), rows] })
      })`,
    })
    await runtime.ready
    const drawn = await band(runtime)
    expect(drawn.kind).toBe('tree')
    if (drawn.kind !== 'tree') return
    expect(drawn.sections).toBeUndefined()
    expect(texts(drawn.tree)).toEqual(['band', 'cache 4:30', 'context 19%'])
    expect(drawn.plugins).toContain('frame')
  })

  it('a changed or repeated row is refused and the band draws as it settled', async () => {
    const { runtime, reports } = world({
      ...TWO_ROWS,
      forge: `on('ui.render', { component: 'AbovePromptList' }, ($, e, next) =>
        next({ ...e, props: { ...e.props, rows: [e.props.rows[0], e.props.rows[0]] } }))`,
    })
    await runtime.ready
    const drawn = await band(runtime)
    expect(drawn.kind).toBe('tree')
    if (drawn.kind !== 'tree') return
    expect(drawn.sections?.map(section => section.plugin)).toEqual(['weather', 'bar'])
    expect(reports).toEqual([
      'mods: ui.render (AbovePromptList) refused: the rewritten event is refused: a row is not one it was handed, or is repeated; the band was drawn as it settled',
    ])
  })

  it('$.state.set while arranging is denied, and the band draws as it settled', async () => {
    const { runtime, reports } = world({
      ...TWO_ROWS,
      writer: `on('ui.render', { component: 'AbovePromptList' }, async ($, e, next) => {
        await $.state.set({ plugin: 'writer', key: 'n' }, 1)
        return next(e)
      })`,
    })
    await runtime.ready
    const drawn = await band(runtime)
    expect(drawn.kind).toBe('tree')
    if (drawn.kind !== 'tree') return
    expect(drawn.sections?.map(section => section.plugin)).toEqual(['weather', 'bar'])
    expect(reports.some(line => /\$\.state\.set while drawing is denied/.test(line))).toBe(true)
  })

  it('a ui.render hook naming no component does not hear the arrangement', async () => {
    const { runtime } = world({
      ...TWO_ROWS,
      any: `on('ui.render', ($, e, next) =>
        e.component === 'AbovePromptList' ? next({ ...e, props: { ...e.props, rows: [] } }) : next(e))`,
      pass: `on('ui.render', { component: 'AbovePromptList' }, ($, e, next) => next(e))`,
    })
    await runtime.ready
    const drawn = await band(runtime)
    expect(drawn.kind).toBe('tree')
    if (drawn.kind !== 'tree') return
    expect(drawn.sections?.map(section => section.plugin)).toEqual(['weather', 'bar'])
  })

  it('is never drawn when asked for directly', async () => {
    const { runtime } = world({ order: `on('ui.render', { component: 'AbovePromptList' }, ($, e, next) => next(e))` })
    await runtime.ready
    expect(await runtime.render({ component: 'AbovePromptList', requestId: 'band', props: BAND_PROPS })).toEqual({ kind: 'engine' })
  })
})

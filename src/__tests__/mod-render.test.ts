/**
 * `mods/modRender.ts` — what a render tree is on the desktop surface and
 * what makes one refused — and `mods/modPanes.ts`, the panes roster
 * (F-25). Pure, no worker.
 */
import { describe, expect, it } from 'vitest'
import {
  RENDER_TEXT_MAX_CHARS,
  drawnBy,
  drewOf,
  sectionsOf,
  handlesIn,
  isAllowedHref,
  isPaneId,
  isRenderAnswer,
  partStampsIn,
  stampRenderRoot,
  renderMatcherSite,
  validateRenderTree,
} from '../mods/modRender'
import { ModPaneRegistry } from '../mods/modPanes'
import type { TraceEntry } from '../mods/modTypes'

const press = { plugin: 'p', handle: 1 }

describe('validateRenderTree', () => {
  it('takes a Box of Texts and strings, a Button with its handle, and an engine node', () => {
    const tree = {
      type: 'Box',
      props: { flexDirection: 'column', paddingX: 1, borderStyle: 'round', key: 'k', hover: { backgroundColor: 'gray' } },
      children: [
        { type: 'Text', props: { dimColor: true, wrap: 'truncate-end' }, children: ['hello', { type: 'Text', children: ['nested'] }] },
        'bare string',
        { type: 'Button', props: { key: 'go', label: 'Go', hotkey: 'g', variant: 'primary' }, press },
        { type: 'engine', ref: 0 },
      ],
    }
    expect(validateRenderTree(tree)).toEqual({ ok: true, tree })
  })

  it('refuses an element this surface lacks, a prop an element does not take, a child where none goes', () => {
    expect(validateRenderTree({ type: 'Raster', props: {} })).toMatchObject({ ok: false, reason: 'this surface draws no element named "Raster"' })
    expect(validateRenderTree({ type: 'Client', props: {} })).toMatchObject({ ok: false })
    expect(validateRenderTree({ type: 'Box', props: { color: 'red' } })).toMatchObject({ ok: false, reason: 'Box does not take a prop named "color"' })
    expect(validateRenderTree({ type: 'Text', props: { flexGrow: 1 } })).toMatchObject({ ok: false })
    expect(validateRenderTree({ type: 'Code', props: { source: 'x' }, children: ['y'] })).toMatchObject({ ok: false, reason: 'Code takes no children' })
    expect(validateRenderTree({ type: 'Text', children: [{ type: 'Box' }] })).toMatchObject({ ok: false })
    expect(validateRenderTree({ type: 'Text', children: [{ type: 'engine', ref: 0 }] })).toMatchObject({ ok: false, reason: 'a Text holds an engine node' })
    expect(validateRenderTree('just text')).toMatchObject({ ok: false })
    expect(validateRenderTree({ type: 'Box', props: { width: { px: 3 } } })).toMatchObject({ ok: false })
  })

  it('takes a key on every element, as JSX writes it, and refuses one that is not a string or a number', () => {
    const tree = {
      type: 'Box',
      props: { key: 'row' },
      children: [
        { type: 'Text', props: { key: 'countdown', dimColor: true }, children: ['auto-cancels in 9 s'] },
        { type: 'Text', props: { key: 3 }, children: ['third'] },
        { type: 'Link', props: { key: 'docs', href: 'https://example.com/', label: 'docs' } },
        { type: 'Code', props: { key: 'src', source: 'x' } },
      ],
    }
    expect(validateRenderTree(tree)).toMatchObject({ ok: true })
    expect(validateRenderTree({ type: 'Text', props: { key: { id: 1 } }, children: ['x'] })).toMatchObject({
      ok: false,
      reason: "Text's key is not a string or a number",
    })
  })

  it('a leaf without its handler, a Button without a key or label, a bad hotkey, variant or role', () => {
    expect(validateRenderTree({ type: 'Button', props: { key: 'k', label: 'L' } })).toMatchObject({ ok: false, reason: expect.stringContaining('carries no handler') })
    expect(validateRenderTree({ type: 'Button', props: { label: 'L' }, press })).toMatchObject({ ok: false, reason: 'Button has no key' })
    expect(validateRenderTree({ type: 'Button', props: { key: 'k' }, press })).toMatchObject({ ok: false, reason: 'Button has no label' })
    expect(validateRenderTree({ type: 'Button', props: { key: 'k', label: 'L', hotkey: 'Q' }, press })).toMatchObject({ ok: false })
    expect(validateRenderTree({ type: 'Button', props: { key: 'k', label: 'L', variant: 'danger' }, press })).toMatchObject({ ok: false })
    expect(validateRenderTree({ type: 'Button', props: { key: 'k', label: 'L', role: 'close' }, press })).toMatchObject({ ok: false })
  })

  it("a Button's action is one of the engine's keybinding actions, and not one of the engine's alone", () => {
    expect(validateRenderTree({ type: 'Button', props: { key: 'k', label: '', action: 'app:cycleDiffBase' }, press })).toMatchObject({ ok: true })
    expect(validateRenderTree({ type: 'Button', props: { key: 'k', label: 'L', action: 'pane:close' }, press })).toMatchObject({ ok: true })
    expect(validateRenderTree({ type: 'Button', props: { key: 'k', label: '', action: 'app:noSuchAction' }, press })).toMatchObject({
      ok: false,
      reason: 'Button\'s action "app:noSuchAction" is not one of the engine\'s keybinding actions',
    })
    expect(validateRenderTree({ type: 'Button', props: { key: 'k', label: '', action: 3 }, press })).toMatchObject({ ok: false })
    expect(validateRenderTree({ type: 'Button', props: { key: 'k', label: '', action: 'app:interrupt' }, press })).toMatchObject({
      ok: false,
      reason: 'Button\'s action "app:interrupt" is the engine\'s alone',
    })
    expect(validateRenderTree({ type: 'Button', props: { key: 'k', label: '', action: 'app:exit' }, press })).toMatchObject({ ok: false })
  })

  it("takes a Box's or a Text's part stamp, and refuses one that names no plugin or sits on another element", () => {
    const tree = { type: 'Box', part: { plugin: 'a' }, children: [{ type: 'Text', part: { plugin: 'b' }, children: ['x'] }] }
    expect(validateRenderTree(tree)).toEqual({ ok: true, tree })
    expect(validateRenderTree({ type: 'Box', part: { plugin: '' } })).toMatchObject({ ok: false, reason: "Box's part names no plugin" })
    expect(validateRenderTree({ type: 'Text', part: 'a', children: ['x'] })).toMatchObject({ ok: false })
    expect(validateRenderTree({ type: 'Button', props: { key: 'k', label: 'L' }, press, part: { plugin: 'a' } })).toMatchObject({ ok: false, reason: 'Button takes no part' })
  })

  it("a Text takes a size step, a weight, mono and tabular; bold still stands; other sizes and weights are refused", () => {
    const text = (props: Record<string, unknown>) => ({ type: 'Text', props, children: ['42%'] })
    expect(validateRenderTree(text({ size: 'caption', weight: 'medium', mono: true, tabular: true }))).toMatchObject({ ok: true })
    expect(validateRenderTree(text({ size: 'title', weight: 'bold' }))).toMatchObject({ ok: true })
    expect(validateRenderTree(text({ bold: true }))).toMatchObject({ ok: true })
    expect(validateRenderTree(text({ size: 'huge' }))).toMatchObject({ ok: false, reason: expect.stringContaining("Text's size") })
    expect(validateRenderTree(text({ weight: 900 }))).toMatchObject({ ok: false, reason: expect.stringContaining("Text's weight") })
  })

  it('a Box takes the spacing steps', () => {
    expect(validateRenderTree({ type: 'Box', props: { gap: 'xs', padding: 'md', marginX: 'xl', rowGap: 'sm', paddingTop: 'lg' } })).toMatchObject({ ok: true })
  })

  it('a Button holds strings and Texts, a label naming it or none; any other child is refused', () => {
    const chip = { type: 'Text', props: { dimColor: true }, children: ['2m'] }
    expect(validateRenderTree({ type: 'Button', props: { key: 'open', label: 'Open' }, press, children: ['notes ', chip] })).toMatchObject({ ok: true })
    expect(validateRenderTree({ type: 'Button', props: { key: 'open' }, press, children: ['notes ', chip] })).toMatchObject({ ok: true })
    expect(validateRenderTree({ type: 'Button', props: { key: 'open' }, press, children: [{ type: 'Box' }] })).toMatchObject({
      ok: false,
      reason: 'a Button holds a Box; a Button holds strings and Texts',
    })
    expect(validateRenderTree({ type: 'Button', props: { key: 'k' }, press, children: [{ type: 'engine', ref: 0 }] })).toMatchObject({ ok: false })
    const link = { type: 'Link', props: { href: 'https://example.com/' } }
    expect(validateRenderTree({ type: 'Button', props: { key: 'k' }, press, children: [{ type: 'Text', children: [link] }] })).toMatchObject({ ok: false })
    expect(validateRenderTree({ type: 'Button', props: { key: 'k' }, press, children: [] })).toMatchObject({ ok: false, reason: 'Button has no label' })
  })

  it('an Input takes string fields', () => {
    expect(validateRenderTree({ type: 'Input', props: { key: 'q', placeholder: 'ask' }, press })).toMatchObject({ ok: true })
    expect(validateRenderTree({ type: 'Input', props: { key: 'q', value: 3 }, press })).toMatchObject({ ok: false })
  })

  it('an Input takes rows, a whole number of lines; a Text takes dir, ltr or rtl', () => {
    expect(validateRenderTree({ type: 'Input', props: { key: 'q', rows: 4, value: 'a\nb' }, press })).toMatchObject({ ok: true })
    expect(validateRenderTree({ type: 'Input', props: { key: 'q', rows: 0 }, press })).toMatchObject({ ok: false, reason: "Input's rows is not a whole number of at least 1" })
    expect(validateRenderTree({ type: 'Input', props: { key: 'q', rows: 1.5 }, press })).toMatchObject({ ok: false })
    expect(validateRenderTree({ type: 'Text', props: { dir: 'rtl' }, children: ['x'] })).toMatchObject({ ok: true })
    expect(validateRenderTree({ type: 'Text', props: { dir: 'ltr' }, children: ['x'] })).toMatchObject({ ok: true })
    expect(validateRenderTree({ type: 'Text', props: { dir: 'auto' }, children: ['x'] })).toMatchObject({ ok: false, reason: 'Text\'s dir is not "ltr" or "rtl"' })
  })

  it('a Select needs options with unique values', () => {
    expect(validateRenderTree({ type: 'Select', props: { key: 's', options: [] }, press })).toMatchObject({ ok: false, reason: 'Select has no options' })
    expect(validateRenderTree({ type: 'Select', props: { key: 's', options: [{ value: 'a' }, { value: 'a' }] }, press })).toMatchObject({ ok: false })
    expect(validateRenderTree({ type: 'Select', props: { key: 's', options: [{ value: 'a', label: 'A' }, { value: 'b' }] }, press })).toMatchObject({ ok: true })
  })

  it('a Link is https (or http://localhost) spelled as new URL(href).href; a Code, Markdown and Svg are bounded', () => {
    expect(validateRenderTree({ type: 'Link', props: { href: 'https://example.com/a?b=1', label: 'x' } })).toMatchObject({ ok: true })
    expect(validateRenderTree({ type: 'Link', props: { href: 'http://localhost:3000/x' }, children: ['here'] })).toMatchObject({ ok: true })
    expect(validateRenderTree({ type: 'Link', props: { href: 'http://example.com/' } })).toMatchObject({ ok: false })
    expect(validateRenderTree({ type: 'Link', props: { href: 'https://user@example.com/' } })).toMatchObject({ ok: false })
    expect(validateRenderTree({ type: 'Link', props: { href: 'https://example.com' } })).toMatchObject({ ok: false })
    expect(validateRenderTree({ type: 'Link', props: { href: 'javascript:alert(1)' } })).toMatchObject({ ok: false })
    expect(validateRenderTree({ type: 'Code', props: { source: 'x'.repeat(RENDER_TEXT_MAX_CHARS + 1) } })).toMatchObject({ ok: false })
    expect(validateRenderTree({ type: 'Code', props: { source: 'a\u0001b' } })).toMatchObject({ ok: false, reason: expect.stringContaining('control character') })
    expect(validateRenderTree({ type: 'Code', props: { source: 'a\tb\n', language: 'ts', startLine: 3, format: 'diff', wrap: 'truncate-end' } })).toMatchObject({ ok: true })
    expect(validateRenderTree({ type: 'Code', props: { source: 'a', wrap: 'middle' } })).toMatchObject({ ok: false })
    expect(validateRenderTree({ type: 'Markdown', props: { text: '# hi' } })).toMatchObject({ ok: true })
    expect(validateRenderTree({ type: 'Markdown', props: { text: '# hi' }, press })).toMatchObject({ ok: false, reason: 'Markdown has no key' })
    expect(validateRenderTree({ type: 'Markdown', props: { key: 'm', text: '# hi', pressableLinks: ['https://a'] }, press })).toMatchObject({ ok: true })
    expect(validateRenderTree({ type: 'Svg', props: { source: '<svg xmlns="http://www.w3.org/2000/svg"></svg>', alt: 'a circle' } })).toMatchObject({ ok: true })
    expect(validateRenderTree({ type: 'Svg', props: { source: '<div/>', alt: 'x' } })).toMatchObject({ ok: false })
    expect(validateRenderTree({ type: 'Svg', props: { source: '<svg/>' } })).toMatchObject({ ok: false, reason: 'Svg has no alt' })
  })

  it('bounds the tree: too many nodes, too deep', () => {
    const wide = { type: 'Box', children: Array.from({ length: 5_001 }, () => ({ type: 'Text', children: ['x'] })) }
    expect(validateRenderTree(wide)).toMatchObject({ ok: false, reason: expect.stringContaining('more than 5000 nodes') })
    let deep: unknown = { type: 'Text', children: ['leaf'] }
    for (let i = 0; i < 70; i += 1) deep = { type: 'Box', children: [deep] }
    expect(validateRenderTree(deep)).toMatchObject({ ok: false, reason: expect.stringContaining('deeper than 64') })
  })

  it('isRenderAnswer is the shape the dispatcher counts; isAllowedHref and isPaneId the small rules', () => {
    expect(isRenderAnswer({ type: 'Box' })).toBe(true)
    expect(isRenderAnswer({ type: '' })).toBe(false)
    expect(isRenderAnswer('text')).toBe(false)
    expect(isRenderAnswer(undefined)).toBe(false)
    expect(isAllowedHref('https://example.com/path')).toBe(true)
    expect(isAllowedHref('https://example.com/pa th')).toBe(false)
    expect(isAllowedHref('https://exämple.com/')).toBe(false)
    expect(isPaneId('tool-calls_1')).toBe(true)
    expect(isPaneId('')).toBe(false)
    expect(isPaneId('a'.repeat(65))).toBe(false)
    expect(isPaneId('a b')).toBe(false)
  })
})

describe('handlesIn, drawnBy, renderMatcherSite', () => {
  it('collects every handler by plugin, and names the one plugin that drew', () => {
    const tree = {
      type: 'Box',
      children: [
        { type: 'Button', props: { key: 'a', label: 'A' }, press: { plugin: 'p', handle: 1 } },
        { type: 'Box', children: [{ type: 'Input', props: { key: 'q' }, press: { plugin: 'p', handle: 2 } }] },
        { type: 'Select', props: { key: 's', options: [{ value: 'x' }] }, press: { plugin: 'q', handle: 7 } },
      ],
    }
    const held = handlesIn(tree)
    expect([...held.get('p')!]).toEqual([1, 2])
    expect([...held.get('q')!]).toEqual([7])
    expect(drawnBy(tree)).toBeUndefined()
    expect(drawnBy({ type: 'Button', props: { key: 'a', label: 'A' }, press: { plugin: 'p', handle: 1 } })).toBe('p')
    expect(drawnBy({ type: 'Text' })).toBeUndefined()
  })

  it('reads a matcher as a site: a component Velloc draws, one it does not, or none', () => {
    expect(renderMatcherSite({ component: 'Pane', requestId: 'clock' })).toEqual({ component: 'Pane', requestId: 'clock' })
    expect(renderMatcherSite({ component: 'AbovePrompt' })).toEqual({ component: 'AbovePrompt' })
    expect(renderMatcherSite({ component: 'ToolProgress' })).toEqual({ unraised: 'ToolProgress' })
    expect(renderMatcherSite({ requestId: 'x' })).toEqual({ requestId: 'x' })
    expect(renderMatcherSite(undefined)).toEqual({})
  })
})

describe('drewOf', () => {
  const entry = (plugin: string, outcome: TraceEntry['outcome'], returned: unknown): TraceEntry => ({
    index: 0,
    plugin,
    tier: 'user' as TraceEntry['tier'],
    event: 'ui.render',
    outcome,
    ms: 0,
    received: {},
    returned,
  })
  const text = (value: string) => ({ type: 'Text', children: [value] })

  it('names a plugin whose tree is text alone, with no handle in it', () => {
    expect(drewOf([entry('usage', 'returned', text('19% of context')), entry('engine', 'returned', undefined)])).toEqual(['usage'])
  })

  it('names every plugin that added to the tree, outermost first; a link that handed on what was beneath it unchanged drew nothing', () => {
    const inner = text('clock')
    const outer = { type: 'Box', children: [text('usage'), inner] }
    expect(
      drewOf([
        entry('usage', 'returned', outer),
        entry('relay', 'returned', inner),
        entry('clock', 'returned', inner),
        entry('engine', 'returned', undefined),
      ]),
    ).toEqual(['usage', 'clock'])
  })

  it('looks past a skipped link, and leaves out the engine and a link that only passed on', () => {
    const tree = text('clock')
    expect(
      drewOf([
        entry('quiet', 'passed', undefined),
        entry('copy', 'returned', tree),
        entry('gone', 'skipped', undefined),
        entry('clock', 'returned', tree),
        entry('engine', 'returned', undefined),
      ]),
    ).toEqual(['clock'])
    expect(drewOf([entry('engine', 'returned', undefined)])).toEqual([])
  })

  it('a link that handed on what was beneath it with only its own stamp on the root drew nothing', () => {
    const clock = { ...text('12:00'), part: { plugin: 'clock' } }
    const relayed = { ...text('12:00'), part: { plugin: 'relay' } }
    expect(drewOf([entry('relay', 'returned', relayed), entry('clock', 'returned', clock)])).toEqual(['clock'])
  })
})

describe('partStampsIn, stampRenderRoot', () => {
  const text = (value: string, plugin?: string) => ({ type: 'Text', children: [value], ...(plugin ? { part: { plugin } } : {}) })

  it('counts the stamps of each plugin in a tree', () => {
    const tree = { type: 'Box', part: { plugin: 'a' }, children: [text('x', 'b'), text('y', 'b'), { type: 'Button', part: { plugin: 'c' } }] }
    expect([...partStampsIn(tree)]).toEqual([
      ['a', 1],
      ['b', 2],
    ])
  })

  it("stamps a Box or Text root with the hook's plugin, over any stamp it carried, and leaves another root unstamped", () => {
    expect(stampRenderRoot({ type: 'Box', children: [] }, 'mine', new Map())).toEqual({ type: 'Box', children: [], part: { plugin: 'mine' } })
    expect(stampRenderRoot(text('x', 'beneath'), 'mine', new Map([['beneath', 1]]))).toEqual(text('x', 'mine'))
    const button = { type: 'Button', props: { key: 'k', label: 'L' }, press: { plugin: 'mine', handle: 1 } }
    expect(stampRenderRoot(button, 'mine', new Map())).toEqual(button)
    expect(stampRenderRoot(undefined, 'mine', new Map())).toBeUndefined()
  })

  it("keeps the hook's own stamps and another plugin's as often as next handed them; drops the rest, and changes no input", () => {
    const tree = {
      type: 'Box',
      children: [text('own', 'mine'), text('moved', 'beneath'), text('twice', 'beneath'), text('forged', 'other'), { type: 'Text', part: 'junk', children: ['junk'] }],
    }
    const before = JSON.stringify(tree)
    const out = stampRenderRoot(tree, 'mine', new Map([['beneath', 1]])) as { children: Array<{ part?: unknown }> }
    expect(out.children.map(child => child.part)).toEqual([{ plugin: 'mine' }, { plugin: 'beneath' }, undefined, undefined, undefined])
    expect(JSON.stringify(tree)).toBe(before)
  })
})

describe('sectionsOf', () => {
  const entry = (plugin: string, outcome: TraceEntry['outcome'], returned: unknown): TraceEntry => ({
    index: 0,
    plugin,
    tier: 'user' as TraceEntry['tier'],
    event: 'ui.render',
    outcome,
    ms: 0,
    received: {},
    returned,
  })
  const text = (value: string) => ({ type: 'Text', children: [value] })
  const engine = { type: 'engine', ref: 0 }

  it("gives each drawing plugin its own part, the part beneath taken out of the outer one's", () => {
    const clock = { type: 'Box', children: [text('12:00'), engine] }
    const outer = { type: 'Box', props: { flexDirection: 'column' }, children: [text('usage'), { type: 'Box', children: [clock] }] }
    expect(
      sectionsOf(
        [entry('usage', 'returned', outer), entry('relay', 'returned', clock), entry('clock', 'returned', clock), entry('engine', 'returned', engine)],
        outer as never,
      ),
    ).toEqual([
      { plugin: 'usage', tree: text('usage') },
      { plugin: 'clock', tree: { type: 'Box', children: [clock] } },
    ])
  })

  it('keeps the order the parts are drawn in, an outer plugin drawing below the tree beneath', () => {
    const clock = text('12:00')
    const usage = { type: 'Box', props: { flexDirection: 'column' }, children: [clock, text('usage')] }
    expect(sectionsOf([entry('usage', 'returned', usage), entry('clock', 'returned', clock)], usage as never)?.map(s => s.plugin)).toEqual(['clock', 'usage'])
  })

  it("credits each band to its plugin when an outer plugin unpacked the column beneath and stacked it again", () => {
    const band = (name: string) => ({ type: 'Box', props: { key: `band:${name}`, flexDirection: 'column' }, children: [text(name)] })
    const column = (...children: unknown[]) => ({ type: 'Box', props: { key: 'bands', flexDirection: 'column' }, children })
    const steps = column(band('steps'), engine)
    const weather = column(band('weather'), band('steps'), engine)
    const context = column(band('weather'), band('steps'), engine, band('context'))
    expect(
      sectionsOf(
        [entry('context', 'returned', context), entry('weather', 'returned', weather), entry('steps', 'returned', steps), entry('engine', 'returned', engine)],
        context as never,
      ),
    ).toEqual([
      { plugin: 'weather', tree: band('weather') },
      { plugin: 'steps', tree: { type: 'Box', props: { flexDirection: 'column' }, children: [band('steps'), engine] } },
      { plugin: 'context', tree: band('context') },
    ])
  })

  it("credits each stamped band to its stamp's plugin, and the outer plugin's own band to it, though every band draws alike", () => {
    const band = (name: string, plugin?: string) => ({
      type: 'Box',
      props: { key: `band:${name}`, flexDirection: 'column' },
      ...(plugin ? { part: { plugin } } : {}),
      children: [text('●')],
    })
    const column = (plugin: string, ...children: unknown[]) => ({ type: 'Box', props: { key: 'bands', flexDirection: 'column' }, part: { plugin }, children })
    const steps = column('steps', band('steps'))
    const weather = column('weather', band('steps', 'steps'), band('weather'))
    const context = column('context', band('steps', 'steps'), band('weather', 'weather'), band('context'))
    expect(
      sectionsOf([entry('context', 'returned', context), entry('weather', 'returned', weather), entry('steps', 'returned', steps)], context as never),
    ).toEqual([
      { plugin: 'steps', tree: band('steps', 'steps') },
      { plugin: 'weather', tree: band('weather', 'weather') },
      { plugin: 'context', tree: band('context') },
    ])
  })

  it('compares trees without their stamps: a band whose stamp moved onto it is still the one its plugin returned', () => {
    const clock = { ...text('12:00'), part: { plugin: 'clock' } }
    const usage = { type: 'Box', props: { flexDirection: 'column' }, part: { plugin: 'usage' }, children: [clock, text('usage')] }
    expect(sectionsOf([entry('usage', 'returned', usage), entry('clock', 'returned', { ...clock, part: { plugin: 'clock' } })], usage as never)?.map(s => s.plugin)).toEqual([
      'clock',
      'usage',
    ])
    const restamped = { ...usage, part: { plugin: 'somewhere' } }
    expect(sectionsOf([entry('usage', 'returned', usage), entry('clock', 'returned', clock)], restamped as never)?.map(s => s.plugin)).toEqual(['clock', 'usage'])
  })

  it('gives none when a row holds two plugins side by side', () => {
    const clock = text('12:00')
    const usage = { type: 'Box', children: [text('usage'), clock] }
    expect(sectionsOf([entry('usage', 'returned', usage), entry('clock', 'returned', clock)], usage as never)).toBeUndefined()
  })

  it('leaves out a plugin that only wrapped the part beneath, and gives none for a single part', () => {
    const inner = text('12:00')
    const wrap = { type: 'Box', props: { paddingX: 1 }, children: [inner] }
    expect(sectionsOf([entry('frame', 'returned', wrap), entry('clock', 'returned', inner)], wrap as never)).toBeUndefined()
  })

  it('stops at an outer plugin that drew over the part beneath instead of into it', () => {
    const mine = text('mine')
    expect(sectionsOf([entry('over', 'returned', mine), entry('clock', 'returned', text('12:00'))], mine as never)).toBeUndefined()
  })

  it('gives three sections for three plugins nested in turn', () => {
    const c = text('c')
    const b = { type: 'Box', props: { flexDirection: 'column' }, children: [text('b'), c] }
    const a = { type: 'Box', props: { flexDirection: 'column' }, children: [text('a'), b] }
    expect(sectionsOf([entry('a', 'returned', a), entry('b', 'returned', b), entry('c', 'returned', c)], a as never)?.map(s => s.plugin)).toEqual(['a', 'b', 'c'])
  })
})

describe('ModPaneRegistry', () => {
  it('opens, shows the newest, retitles in place, lists per plugin, closes and falls back to the last', () => {
    let changes = 0
    const panes = new ModPaneRegistry(() => (changes += 1))
    expect(panes.open('p', { id: 'a', title: 'A' })).toEqual({ isPlaced: true })
    panes.open('p', { id: 'b' })
    panes.open('q', { id: 'a', title: 'Other A' })
    expect(panes.list().map(pane => `${pane.plugin}:${pane.id}:${pane.title}:${pane.isShown}`)).toEqual(['p:a:A:false', 'p:b:b:false', 'q:a:Other A:true'])
    panes.open('p', { id: 'a', title: 'A2', closeOnEscape: true })
    expect(panes.get('p', 'a')).toMatchObject({ title: 'A2', isShown: false, closeOnEscape: true })
    panes.open('p', { id: 'a', focus: true })
    expect(panes.get('p', 'a')?.isShown).toBe(true)
    expect(panes.listFor('p').map(pane => pane.id)).toEqual(['a', 'b'])
    expect(panes.close('p', 'a')).toBe(true)
    expect(panes.close('p', 'a')).toBe(false)
    expect(panes.list().find(pane => pane.isShown)?.id).toBe('a')
    expect(panes.showPane('p', 'b')).toBe(true)
    expect(panes.showPane('p', 'b')).toBe(false)
    expect(panes.clearPlugin('p')).toEqual(['b'])
    expect(panes.list()).toHaveLength(1)
    expect(panes.list()[0]!.isShown).toBe(true)
    expect(changes).toBeGreaterThan(5)
    panes.clear()
    expect(panes.list()).toEqual([])
  })
})

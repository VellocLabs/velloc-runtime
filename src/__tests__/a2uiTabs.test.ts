// @vitest-environment happy-dom
// The Velloc catalog's Tabs (F-1): a count badge per tab and the tab shown
// first, written in Express and drawn by the surface renderer.
import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { A2uiSurface, type ReactCatalogComponent } from '@a2ui/react'
import { MessageProcessor } from '@a2ui/web_core/v1_0'
import { vellocCatalog, vellocCatalogPropNames } from '../browser/webview/a2ui/catalog/vellocCatalog'
import { openTabIndex, tabBadgeText, tabsSchema } from '../browser/webview/a2ui/catalog/TabsView'
import { createA2uiExpressCompiler } from '../toolkit/builtin/a2ui/express/a2uiExpressCompiler'
import { getRuntimeA2uiCompiler } from '../toolkit/builtin/a2ui/express/a2uiRuntimeCompiler'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PAGES = ['a = Text("Todo list")', 'b = Text("Done list")', 'c = Text("Archive list")']
const tabsBody = (tabsLine: string, extra: string[] = []) => ['surface("app")', tabsLine, ...PAGES, ...extra].join('\n')
const THREE = '[{title: "To do", child: a, badge: $/data/todo}, {title: "Done", child: b, badge: $/data/done}, {title: "Archive", child: c}]'

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

const settle = () => act(async () => new Promise(resolve => setTimeout(resolve, 20)))

async function draw(body: string) {
  const processor = new MessageProcessor<ReactCatalogComponent>([vellocCatalog], () => {})
  const compiler = createA2uiExpressCompiler(vellocCatalog)
  const state = compiler.stateFor(processor)
  const compile = async (source: string) => {
    const result = compiler.compile(source, state)
    expect(result, source).toMatchObject({ ok: true })
    await settle()
  }
  await compile(body)
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(createElement(A2uiSurface, { surface: processor.getSurface('app')! })))
  await settle()
  const tabs = () => [...container.querySelectorAll<HTMLElement>('[role="tab"]')]
  const selected = () => tabs().find(tab => tab.getAttribute('aria-selected') === 'true')?.textContent
  const panel = () => container.querySelector('[role="tabpanel"]')?.textContent ?? ''
  const badges = () => tabs().map(tab => tab.querySelector('[data-slot="a2ui-tab-badge"]')?.textContent ?? null)
  const click = async (index: number) => {
    await act(async () => tabs()[index].click())
    await settle()
  }
  return { container, compile, tabs, selected, panel, badges, click }
}

/** The accessible name a tab gets: its labelledby elements' text, or its own. */
function nameOf(tab: HTMLElement): string {
  const ids = tab.getAttribute('aria-labelledby')
  if (!ids) return tab.textContent ?? ''
  return ids.split(' ').map(id => document.getElementById(id)?.textContent ?? '').join(' ')
}

describe('Tabs in the Velloc catalog', () => {
  it('replaces the basic Tabs and accepts badge and open', () => {
    expect(vellocCatalog.components.get('Tabs')).toBeDefined()
    expect([...(vellocCatalogPropNames.get('Tabs') ?? [])]).toEqual(['tabs', 'open', 'weight'])
    expect(tabsSchema.safeParse({ tabs: [{ title: 'A', child: 'a', badge: 3 }], open: 0 }).success).toBe(true)
    expect(tabsSchema.safeParse({ tabs: [{ title: 'A', child: 'a', badge: { path: '/n' } }], open: { path: '/o' } }).success, 'both bind').toBe(true)
    expect(tabsSchema.safeParse({ tabs: [{ title: 'A', child: 'a', badge: '12+' }] }).success, 'a string badge').toBe(true)
    expect(tabsSchema.safeParse({ tabs: [{ title: 'A', child: 'a', badge: true }] }).success).toBe(false)
    expect(tabsSchema.safeParse({ tabs: [{ title: 'A', child: 'a' }], open: 'first' }).success).toBe(false)
  })

  it('a badge is hidden when missing, 0, empty or "0"; open falls back to the first tab', () => {
    for (const hidden of [undefined, null, 0, '', '0', ' ', true, {}]) expect(tabBadgeText(hidden), String(hidden)).toBe('')
    expect(tabBadgeText(3)).toBe('3')
    expect(tabBadgeText('12+')).toBe('12+')
    expect(openTabIndex(undefined, 3)).toBeUndefined()
    expect(openTabIndex(null, 3)).toBeUndefined()
    expect(openTabIndex(2, 3)).toBe(2)
    expect(openTabIndex('1', 3)).toBe(1)
    for (const outside of [3, -1, 1.5, 'Done']) expect(openTabIndex(outside, 3), String(outside)).toBe(0)
  })

  it('draws a bound badge after the title, hides it at 0, and names the tab with its count', async () => {
    const view = await draw(tabsBody(`root = Tabs(${THREE})`, ['$/data = {todo: 3, done: 0}']))
    expect(view.tabs().map(tab => tab.querySelector('span')?.textContent)).toEqual(['To do', 'Done', 'Archive'])
    expect(view.badges()).toEqual(['3', null, null])
    expect(nameOf(view.tabs()[0])).toBe('To do 3')
    expect(nameOf(view.tabs()[1])).toBe('Done')
    const badge = view.tabs()[0].querySelector<HTMLElement>('[data-slot="a2ui-tab-badge"]')!
    expect(badge.className).toContain('text-destructive')
    expect(view.selected()).toContain('To do')
    expect(view.panel()).toBe('Todo list')

    await view.compile('surface("app")\n$/data = {todo: 0, done: "5"}')
    expect(view.badges()).toEqual([null, '5', null])
    expect(nameOf(view.tabs()[1])).toBe('Done 5')
  })

  it('open picks the tab shown first; out of range shows the first', async () => {
    const view = await draw(tabsBody(`root = Tabs(${THREE}, open=2)`))
    expect(view.selected()).toBe('Archive')
    expect(view.panel()).toBe('Archive list')
  })

  it('an open out of range shows the first tab', async () => {
    const view = await draw(tabsBody(`root = Tabs(${THREE}, open=7)`))
    expect(view.selected()).toContain('To do')
  })

  it('a bound open that resolves after the first draw is applied once; a later change does not move the view', async () => {
    const view = await draw(tabsBody(`root = Tabs(${THREE}, open=$/data/open)`))
    expect(view.selected()).toContain('To do')
    await view.compile('surface("app")\n$/data/open = 1')
    expect(view.selected()).toBe('Done')
    expect(view.panel()).toBe('Done list')
    await view.compile('surface("app")\n$/data/open = 2')
    expect(view.selected(), 'only the first value opens a tab').toBe('Done')
  })

  it('the user pick wins over open, across data changes and an in-place rebuild', async () => {
    const view = await draw(tabsBody(`root = Tabs(${THREE}, open=$/data/open)`))
    await view.click(2)
    expect(view.selected()).toBe('Archive')
    await view.compile('surface("app")\n$/data/open = 1')
    expect(view.selected(), 'a late open does not move a pick').toBe('Archive')

    const shown = view.container.querySelector('[data-slot="a2ui-tabs"]')
    await view.compile(tabsBody(`root = Tabs(${THREE.replace('"Done"', '"Finished"')}, open=0)`))
    expect(view.container.querySelector('[data-slot="a2ui-tabs"]'), 'rebuilt in place').toBe(shown)
    expect(view.tabs()[1].textContent).toBe('Finished')
    expect(view.selected()).toBe('Archive')
    expect(view.panel()).toBe('Archive list')
  })

  it('a list shrinking under the selected tab shows the first tab', async () => {
    const view = await draw(tabsBody(`root = Tabs(${THREE})`))
    await view.click(2)
    expect(view.selected()).toBe('Archive')
    await view.compile(['surface("app")', 'root = Tabs([{title: "To do", child: a}, {title: "Done", child: b}])', ...PAGES.slice(0, 2)].join('\n'))
    expect(view.tabs()).toHaveLength(2)
    expect(view.selected()).toBe('To do')
    expect(view.panel()).toBe('Todo list')
  })

  it('arrow keys, Home and End move the selection and focus; only the selected tab is in the tab order', async () => {
    const view = await draw(tabsBody(`root = Tabs(${THREE})`))
    expect(view.tabs().map(tab => tab.tabIndex)).toEqual([0, -1, -1])
    const key = async (name: string) => {
      await act(async () => {
        view.container.querySelector('[role="tablist"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }))
      })
      await settle()
    }
    await key('ArrowRight')
    expect(view.selected()).toBe('Done')
    expect(document.activeElement).toBe(view.tabs()[1])
    await key('End')
    expect(view.selected()).toBe('Archive')
    expect(document.activeElement).toBe(view.tabs()[2])
    await key('ArrowRight')
    expect(view.selected(), 'wraps').toContain('To do')
    await key('ArrowLeft')
    expect(view.selected()).toBe('Archive')
    expect(document.activeElement).toBe(view.tabs()[2])
    await key('Home')
    expect(view.selected()).toContain('To do')
    expect(document.activeElement).toBe(view.tabs()[0])
    const panel = view.container.querySelector('[role="tabpanel"]')!
    expect(document.getElementById(panel.getAttribute('aria-labelledby')!)).toBe(view.tabs()[0])
  })

  it('Express rejects a badge or open of the wrong type; the runtime compiler accepts both props', async () => {
    const compiler = createA2uiExpressCompiler(vellocCatalog)
    const bad = compiler.compile(tabsBody(`root = Tabs([{title: "To do", child: a, badge: true}, {title: "Done", child: b}, {title: "Archive", child: c}])`), compiler.createState())
    expect(bad.ok).toBe(false)
    const badOpen = compiler.compile(tabsBody(`root = Tabs(${THREE}, open="Done")`), compiler.createState())
    expect(badOpen.ok).toBe(false)
    const runtime = await getRuntimeA2uiCompiler()
    const good = runtime.compile(tabsBody(`root = Tabs(${THREE}, open=$/data/open)`), runtime.createState())
    expect(good).toMatchObject({ ok: true })
    const messages = JSON.stringify(good.ok ? good.messages : [])
    expect(messages).toContain('"badge":{"@path":"/data/todo"}')
    expect(messages).toContain('"open":{"@path":"/data/open"}')
  })
})

// @vitest-environment happy-dom
// Studio input and row events (F-1): a ButtonGroup or ChipSelect sends
// onChange with the new value, a DataTable sends onRowClick with the row.
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { exportA2UICatalog } from '@copilotkit/react-core/v2/generative-ui'
import { studioUI } from '../browser/webview/a2ui/studio/studioCatalog'
import { createStudioExpressCompiler } from '../toolkit/builtin/a2ui/express/studioExpress'
import { StudioSurfaceHost, type StudioEvent } from '../browser/webview/a2ui/studio/StudioSurfaceHost'

const compiler = createStudioExpressCompiler(exportA2UICatalog(studioUI as never) as Record<string, unknown>)

const PAGE = [
  'surface("ev")',
  'root = Column([routes, kinds, members, plain])',
  'routes = ButtonGroup(label="Route", value=$/data/route, options=$/data/routeOptions, onChange=Event("select_route", {fixed: "yes", route: $/data/route}))',
  'kinds = ChipSelect(label="Kinds", value=$/data/kinds, options=$/data/kindOptions, onChange=Event("pick_kinds", {}))',
  'members = DataTable(title="Members", columns=$/data/columns, rows=$/data/rows, onRowClick=Event("open_member", {}))',
  'plain = DataTable(title="Plain", columns=$/data/columns, rows=$/data/rows)',
].join('\n')

const DATA = {
  route: 'a',
  routeOptions: [{ value: 'a', label: 'Route A' }, { value: 'b', label: 'Route B' }],
  kinds: [],
  kindOptions: [{ value: 'free', label: 'Free' }, { value: 'large', label: 'Large' }],
  columns: [{ key: 'name', label: 'Model' }],
  rows: [{ name: 'Alpha Model', key: 'k-alpha' }, { name: 'Beta Model', key: 'k-beta' }],
}

function page(onEvent: (event: StudioEvent) => void) {
  const compiled = compiler.compile(PAGE)
  if (!compiled.ok) throw new Error(compiled.message)
  const operations = [...compiled.messages, { version: '1.0', updateDataModel: { surfaceId: 'ev', path: '/data', value: DATA } }]
  return render(createElement(StudioSurfaceHost, { surfaceId: 'ev', operations, onEvent }))
}

const byText = async (root: HTMLElement, selector: string, text: string): Promise<HTMLElement> =>
  waitFor(() => {
    const found = [...root.querySelectorAll<HTMLElement>(selector)].find(node => node.textContent?.trim() === text)
    if (!found) throw new Error(`no ${selector} "${text}" yet`)
    return found
  })

afterEach(() => cleanup())

describe('studio input and row events', () => {
  it('compiles the three events and refuses one a component does not declare', () => {
    expect(compiler.compile(PAGE).ok).toBe(true)
    const bad = compiler.compile('surface("x")\nroot = Text("t", onChange=Event("nope", {}))')
    expect(bad.ok).toBe(false)
  })

  it('a ButtonGroup sends onChange with the new value; the bound path already holds it', async () => {
    const events: StudioEvent[] = []
    const view = page(event => events.push(event))
    fireEvent.click(await byText(view.container, 'button', 'Route B'))
    await waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toMatchObject({ name: 'select_route', componentId: 'routes', context: { value: 'b', fixed: 'yes', route: 'b' } })
    // Choosing the option already on sends nothing.
    fireEvent.click(await byText(view.container, 'button', 'Route B'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(events).toHaveLength(1)
  })

  it('a ChipSelect sends onChange with the whole new list', async () => {
    const events: StudioEvent[] = []
    const view = page(event => events.push(event))
    fireEvent.click(await byText(view.container, 'button', 'Free'))
    await waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toMatchObject({ name: 'pick_kinds', context: { value: ['free'] } })
    fireEvent.click(await byText(view.container, 'button', 'Large'))
    await waitFor(() => expect(events).toHaveLength(2))
    expect(events[1]?.context).toMatchObject({ value: ['free', 'large'] })
  })

  it('a DataTable with onRowClick sends the whole row on a click or Enter; one without has plain rows', async () => {
    const events: StudioEvent[] = []
    const view = page(event => events.push(event))
    const tables = await waitFor(() => {
      const found = view.container.querySelectorAll('[data-a2-type="DataTable"]')
      if (found.length < 2) throw new Error('tables not drawn yet')
      return [...found] as HTMLElement[]
    })
    const clickable = await byText(tables[0]!, 'td', 'Beta Model')
    fireEvent.click(clickable.closest('tr')!)
    await waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toMatchObject({ name: 'open_member', componentId: 'members', context: { row: { name: 'Beta Model', key: 'k-beta' } } })
    fireEvent.keyDown((await byText(tables[0]!, 'td', 'Alpha Model')).closest('tr')!, { key: 'Enter' })
    await waitFor(() => expect(events).toHaveLength(2))
    expect(events[1]?.context).toMatchObject({ row: { key: 'k-alpha' } })
    // A held key's repeats send nothing more.
    fireEvent.keyDown((await byText(tables[0]!, 'td', 'Alpha Model')).closest('tr')!, { key: 'Enter', repeat: true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(events).toHaveLength(2)
    const plainRow = (await byText(tables[1]!, 'td', 'Beta Model')).closest('tr')!
    expect(plainRow.getAttribute('tabindex')).toBeNull()
    fireEvent.click(plainRow)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(events).toHaveLength(2)
  })
})

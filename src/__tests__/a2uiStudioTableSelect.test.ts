// @vitest-environment happy-dom
// DataTable row selection (F-1): with selectKey a checkbox column comes first;
// checking writes the selected keys to the bound path and sends onChange.
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { exportA2UICatalog } from '@copilotkit/react-core/v2/generative-ui'
import { studioUI } from '../browser/webview/a2ui/studio/studioCatalog'
import { createStudioExpressCompiler } from '../toolkit/builtin/a2ui/express/studioExpress'
import { StudioSurfaceHost, type StudioEvent } from '../browser/webview/a2ui/studio/StudioSurfaceHost'

const compiler = createStudioExpressCompiler(exportA2UICatalog(studioUI as never) as Record<string, unknown>)

const DATA = {
  picked: ['b'],
  columns: [{ key: 'name', label: 'Item' }, { key: 'source', label: 'Source', filter: true }],
  rows: [
    { id: 'a', name: 'Alpha', source: 'North' },
    { id: 'b', name: 'Beta', source: 'South' },
    { id: 'c', name: 'Gamma', source: 'North' },
  ],
}

function page(body: string, onEvent: (event: StudioEvent) => void, data: unknown = DATA) {
  const compiled = compiler.compile(`surface("ts")\n${body}`)
  if (!compiled.ok) throw new Error(compiled.message)
  const operations = [...compiled.messages, { version: '1.0', updateDataModel: { surfaceId: 'ts', path: '/data', value: data } }]
  return render(createElement(StudioSurfaceHost, { surfaceId: 'ts', operations, onEvent }))
}

const SELECT = 'root = DataTable(columns=$/data/columns, rows=$/data/rows, selectKey="id", value=$/data/picked, onChange=Event("picked", {}))'
const boxes = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('button[role="checkbox"]')]
const rowBox = (root: HTMLElement, name: string) =>
  [...root.querySelectorAll('tbody tr')].find(tr => tr.textContent?.includes(name))!.querySelector<HTMLElement>('button[role="checkbox"]')!

afterEach(() => cleanup())

describe('DataTable row selection', () => {
  it('draws a checkbox per row and in the header, checked from the bound value', async () => {
    const view = page(SELECT, () => undefined)
    await waitFor(() => expect(boxes(view.container)).toHaveLength(4))
    expect(rowBox(view.container, 'Beta').getAttribute('aria-checked')).toBe('true')
    expect(rowBox(view.container, 'Alpha').getAttribute('aria-checked')).toBe('false')
    expect(boxes(view.container)[0]!.getAttribute('aria-checked')).toBe('mixed')
  })

  it('a checkbox or a row click toggles the row and sends the whole new list', async () => {
    const events: StudioEvent[] = []
    const view = page(SELECT, event => events.push(event))
    await waitFor(() => expect(boxes(view.container)).toHaveLength(4))
    fireEvent.click(rowBox(view.container, 'Alpha'))
    await waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toMatchObject({ name: 'picked', context: { value: ['b', 'a'] } })
    await waitFor(() => expect(rowBox(view.container, 'Alpha').getAttribute('aria-checked')).toBe('true'))
    fireEvent.click([...view.container.querySelectorAll('tbody tr')].find(tr => tr.textContent?.includes('Beta'))!)
    await waitFor(() => expect(events).toHaveLength(2))
    expect(events[1]?.context).toMatchObject({ value: ['a'] })
  })

  it('the header box selects and clears only the rows the filters show', async () => {
    const events: StudioEvent[] = []
    const view = page(SELECT, event => events.push(event))
    await waitFor(() => expect(boxes(view.container)).toHaveLength(4))
    const north = [...view.container.querySelectorAll<HTMLElement>('[aria-label="Source"] button')].find(b => b.textContent === 'North')!
    fireEvent.click(north)
    await waitFor(() => expect(boxes(view.container)).toHaveLength(3))
    fireEvent.click(boxes(view.container)[0]!)
    await waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]?.context).toMatchObject({ value: ['b', 'a', 'c'] })
    fireEvent.click(boxes(view.container)[0]!)
    await waitFor(() => expect(events).toHaveLength(2))
    expect(events[1]?.context).toMatchObject({ value: ['b'] })
  })

  it('without selectKey there is no checkbox column', async () => {
    const view = page('root = DataTable(columns=$/data/columns, rows=$/data/rows)', () => undefined)
    await waitFor(() => expect(view.container.textContent).toContain('Gamma'))
    expect(boxes(view.container)).toHaveLength(0)
  })

  it('a shared key is written once, a row without the key cannot be checked, an empty view sends nothing', async () => {
    const events: StudioEvent[] = []
    const rows = [
      { id: 'a', name: 'Alpha', source: 'North' },
      { id: 'a', name: 'Again', source: 'North' },
      { name: 'Keyless', source: 'South' },
    ]
    const view = page(SELECT.replace('selectKey=', 'searchable=true, selectKey='), event => events.push(event), { ...DATA, picked: [], rows })
    await waitFor(() => expect(boxes(view.container)).toHaveLength(4))
    expect(rowBox(view.container, 'Keyless').hasAttribute('disabled')).toBe(true)
    expect([...view.container.querySelectorAll('tbody tr')].find(tr => tr.textContent?.includes('Keyless'))!.hasAttribute('tabindex')).toBe(false)
    fireEvent.click(boxes(view.container)[0]!)
    await waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]?.context).toMatchObject({ value: ['a'] })
    fireEvent.change(view.container.querySelector('input')!, { target: { value: 'zzz' } })
    await waitFor(() => expect(boxes(view.container)).toHaveLength(1))
    fireEvent.click(boxes(view.container)[0]!)
    await new Promise(r => setTimeout(r, 50))
    expect(events).toHaveLength(1)
  })
})

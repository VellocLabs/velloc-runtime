// @vitest-environment happy-dom
// DataTable reorderable: a grip column first, every row on one page with no search,
// filters or sorting, and onReorder sends { order, from, to, row } with the new order shown at once.
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { exportA2UICatalog } from '@copilotkit/react-core/v2/generative-ui'
import { studioUI } from '../browser/webview/a2ui/studio/studioCatalog'
import { createStudioExpressCompiler } from '../toolkit/builtin/a2ui/express/studioExpress'
import { StudioSurfaceHost, type StudioEvent } from '../browser/webview/a2ui/studio/StudioSurfaceHost'

const compiler = createStudioExpressCompiler(exportA2UICatalog(studioUI as never) as Record<string, unknown>)

const NAMES = ['Alpha', 'Beta', 'Gamma', 'Delta']
const DATA = {
  columns: [{ key: 'name', label: 'Item' }, { key: 'source', label: 'Source', filter: true }],
  rows: NAMES.map((name, i) => ({ id: name.toLowerCase(), name, source: i % 2 ? 'South' : 'North' })),
}

function page(body: string, onEvent: (event: StudioEvent) => void) {
  const compiled = compiler.compile(`surface("ts")\n${body}`)
  if (!compiled.ok) throw new Error(compiled.message)
  const operations = [...compiled.messages, { version: '1.0', updateDataModel: { surfaceId: 'ts', path: '/data', value: DATA } }]
  return render(createElement(StudioSurfaceHost, { surfaceId: 'ts', operations, onEvent }))
}

const TABLE = 'root = DataTable(columns=$/data/columns, rows=$/data/rows, reorderable=true, searchable=true, pageSize=2'
const order = (root: HTMLElement) => [...root.querySelectorAll('tbody tr')].map(tr => NAMES.find(n => tr.textContent?.includes(n)))
const handles = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-reorder-handle]')]
const rowsOf = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('tbody tr')]

function drag(root: HTMLElement, from: number, to: number) {
  const dataTransfer = { setData: () => undefined, effectAllowed: '', dropEffect: '' }
  fireEvent.dragStart(rowsOf(root)[from]!, { dataTransfer })
  fireEvent.dragOver(rowsOf(root)[to]!, { dataTransfer })
  fireEvent.drop(rowsOf(root)[to]!, { dataTransfer })
}

afterEach(() => cleanup())

describe('DataTable reorderable', () => {
  it('puts a grip handle first in every row and shows every row with no search, pager or filter chips', async () => {
    const view = page(`${TABLE}, selectKey="id")`, () => undefined)
    await waitFor(() => expect(order(view.container)).toHaveLength(4))
    expect(handles(view.container)).toHaveLength(4)
    for (const tr of rowsOf(view.container)) expect(tr.firstElementChild!.querySelector('[data-reorder-handle]')).not.toBeNull()
    expect(view.container.querySelector('input')).toBeNull()
    expect(view.container.querySelector('[aria-label="Source"]')).toBeNull()
    expect(view.container.textContent).not.toContain('1 / 2')
  })

  it('a drop shows the new order at once and sends order by selectKey with from and to', async () => {
    const events: StudioEvent[] = []
    const view = page(`${TABLE}, selectKey="id", onReorder=Event("moved", {}))`, e => events.push(e))
    await waitFor(() => expect(order(view.container)).toHaveLength(4))
    drag(view.container, 0, 2)
    await waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toMatchObject({
      name: 'moved',
      context: { order: ['beta', 'gamma', 'alpha', 'delta'], from: 0, to: 2, row: { id: 'alpha', name: 'Alpha' } },
    })
    expect(order(view.container)).toEqual(['Beta', 'Gamma', 'Alpha', 'Delta'])
  })

  it('arrow keys on the grip move the row by one; without selectKey order lists row indexes', async () => {
    const events: StudioEvent[] = []
    const view = page(`${TABLE}, onReorder=Event("moved", {}))`, e => events.push(e))
    await waitFor(() => expect(handles(view.container)).toHaveLength(4))
    fireEvent.keyDown(handles(view.container)[3]!, { key: 'ArrowUp' })
    await waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]?.context).toMatchObject({ order: [0, 1, 3, 2], from: 3, to: 2 })
    expect(order(view.container)).toEqual(['Alpha', 'Beta', 'Delta', 'Gamma'])
    fireEvent.keyDown(handles(view.container)[0]!, { key: 'ArrowUp' })
    expect(events).toHaveLength(1)
  })

  it('without reorderable there is no grip column', async () => {
    const view = page('root = DataTable(columns=$/data/columns, rows=$/data/rows)', () => undefined)
    await waitFor(() => expect(view.container.textContent).toContain('Alpha'))
    expect(handles(view.container)).toHaveLength(0)
  })
})

// @vitest-environment happy-dom
// DataTable column filters (F-1): a column marked `filter` offers its distinct
// values as chips on a row of their own; picking chips narrows the rows.
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { exportA2UICatalog } from '@copilotkit/react-core/v2/generative-ui'
import { studioUI } from '../browser/webview/a2ui/studio/studioCatalog'
import { createStudioExpressCompiler } from '../toolkit/builtin/a2ui/express/studioExpress'
import { StudioSurfaceHost } from '../browser/webview/a2ui/studio/StudioSurfaceHost'

const compiler = createStudioExpressCompiler(exportA2UICatalog(studioUI as never) as Record<string, unknown>)

const DATA = {
  columns: [
    { key: 'name', label: 'Item' },
    { key: 'source', label: 'Source', filter: true },
    { key: 'price', label: 'Price', filter: true },
  ],
  rows: [
    { name: 'Alpha', source: 'North', price: 'Free' },
    { name: 'Beta', source: 'South', price: 'Paid' },
    { name: 'Gamma', source: 'North', price: 'Paid' },
    { name: 'Delta', source: '', price: 'Free' },
  ],
}

function ops(data: typeof DATA) {
  const compiled = compiler.compile('surface("cf")\nroot = DataTable(columns=$/data/columns, rows=$/data/rows)')
  if (!compiled.ok) throw new Error(compiled.message)
  return [...compiled.messages, { version: '1.0', updateDataModel: { surfaceId: 'cf', path: '/data', value: data } }]
}

const host = (data: typeof DATA) => createElement(StudioSurfaceHost, { surfaceId: 'cf', operations: ops(data), onEvent: () => undefined })
const page = () => render(host(DATA))

const names = (root: HTMLElement) => [...root.querySelectorAll('tbody tr td:first-child')].map(td => td.textContent?.trim())
const chip = (root: HTMLElement, group: string, text: string) => {
  const box = root.querySelector<HTMLElement>(`[aria-label="${group}"]`)
  const found = [...(box?.querySelectorAll<HTMLElement>('button') ?? [])].find(b => b.textContent?.trim() === text)
  if (!found) throw new Error(`no chip ${group}/${text}`)
  return found
}

afterEach(() => cleanup())

describe('DataTable column filters', () => {
  it('one chip row per filtered column, with its distinct non-blank values', async () => {
    const view = page()
    await waitFor(() => expect(names(view.container)).toHaveLength(4))
    const groups = [...view.container.querySelectorAll('[aria-label="Source"], [aria-label="Price"]')]
    expect(groups.map(g => [...g.querySelectorAll('button')].map(b => b.textContent))).toEqual([['North', 'South'], ['Free', 'Paid']])
    expect(view.container.querySelector('[aria-label="Item"]')).toBeNull()
  })

  it('chips in one column widen, chips in two columns narrow, clearing restores', async () => {
    const view = page()
    await waitFor(() => expect(names(view.container)).toHaveLength(4))
    fireEvent.click(chip(view.container, 'Source', 'North'))
    await waitFor(() => expect(names(view.container)).toEqual(['Alpha', 'Gamma']))
    fireEvent.click(chip(view.container, 'Source', 'South'))
    await waitFor(() => expect(names(view.container)).toEqual(['Alpha', 'Beta', 'Gamma']))
    fireEvent.click(chip(view.container, 'Price', 'Paid'))
    await waitFor(() => expect(names(view.container)).toEqual(['Beta', 'Gamma']))
    fireEvent.click(chip(view.container, 'Price', 'Paid'))
    fireEvent.click(chip(view.container, 'Source', 'North'))
    fireEvent.click(chip(view.container, 'Source', 'South'))
    await waitFor(() => expect(names(view.container)).toHaveLength(4))
  })

  it('a picked value gone from new rows stops filtering', async () => {
    const view = page()
    await waitFor(() => expect(names(view.container)).toHaveLength(4))
    fireEvent.click(chip(view.container, 'Source', 'South'))
    await waitFor(() => expect(names(view.container)).toEqual(['Beta']))
    view.rerender(host({ ...DATA, rows: DATA.rows.filter(r => r.source !== 'South') }))
    await waitFor(() => expect(names(view.container)).toEqual(['Alpha', 'Gamma', 'Delta']))
  })

  it('chips read like the formatted cells', async () => {
    const data = {
      columns: [{ key: 'name', label: 'Item' }, { key: 'share', label: 'Share', format: 'percent', filter: true }],
      rows: [{ name: 'Alpha', share: 0.5 }, { name: 'Beta', share: 0.25 }, { name: 'Gamma', share: { odd: 1 } }],
    }
    const view = render(createElement(StudioSurfaceHost, { surfaceId: 'cf', operations: ops(data as never), onEvent: () => undefined }))
    await waitFor(() => expect(names(view.container)).toHaveLength(3))
    const cells = [...view.container.querySelectorAll('tbody tr td:nth-child(2)')].map(td => td.textContent?.trim())
    const chips = [...view.container.querySelectorAll('[aria-label="Share"] button')].map(b => b.textContent)
    expect(chips).toEqual([cells[1], cells[0]])
    fireEvent.click(chip(view.container, 'Share', cells[0]!))
    await waitFor(() => expect(names(view.container)).toEqual(['Alpha']))
  })
})

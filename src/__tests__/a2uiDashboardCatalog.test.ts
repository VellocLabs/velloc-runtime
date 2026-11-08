// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { A2uiSurface, type ReactCatalogComponent } from '@a2ui/react'
import { MessageProcessor } from '@a2ui/web_core/v1_0'
import { chartCatalogDefinitions } from '../browser/webview/a2ui/catalog/chartCatalogDefinitions'
import { badgeTone, metricTrend, vellocCatalog } from '../browser/webview/a2ui/catalog/vellocCatalog'
import { valueText } from '../browser/webview/a2ui/catalog/ChartViews'
import { createA2uiExpressCompiler } from '../toolkit/builtin/a2ui/express/a2uiExpressCompiler'
import { getRuntimeA2uiCompiler } from '../toolkit/builtin/a2ui/express/a2uiRuntimeCompiler'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const DASHBOARD = [
  'surface("sales")',
  '$/orders = [{id: "#1", total: "$9,420", status: "Paid"}, {id: "#2", total: "$3,990", status: "Failed"}, {id: "#3", total: "$10", status: "Lost"}, {id: "#4", total: "$5"}]',
  '$/kpi = {value: "$980K", delta: "-2.1%", trend: "down"}',
  '$/state = "warning"',
  '$/range = "Jan 1 – Mar 31, 2025"',
  'root = Column([title, sub, kpi, state, orders])',
  'title = Heading("Q1 2025 Sales Dashboard", 1, $/range)',
  'sub = Heading("Recent orders", 3, "Top 5 by value")',
  'kpi = Metric("AOV", $/kpi/value, $/kpi/delta, $/kpi/trend)',
  'state = Badge("Delayed", $/state)',
  'orders = DataTable([{key: "id", label: "Order"}, {key: "total", label: "Total", align: "end"}, {key: "status", label: "Status", badge: {Paid: "success", Failed: "danger"}}], $/orders)',
].join('\n')

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

async function draw(body: string): Promise<HTMLElement> {
  const processor = new MessageProcessor<ReactCatalogComponent>([vellocCatalog], () => {})
  const compiler = createA2uiExpressCompiler(vellocCatalog)
  const result = compiler.compile(body, compiler.stateFor(processor))
  expect(result).toMatchObject({ ok: true })
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(createElement(A2uiSurface, { surface: processor.getSurface('sales')! })))
  await act(async () => new Promise(resolve => setTimeout(resolve, 20)))
  return container
}

describe('the dashboard components of the Velloc catalog', () => {
  it('Heading and Badge are in the catalog; their props are checked', () => {
    for (const name of ['Heading', 'Badge']) expect(vellocCatalog.components.has(name), name).toBe(true)
    const heading = chartCatalogDefinitions.Heading.schema
    expect(heading.safeParse({ text: 'Q1', level: 1 }).success).toBe(true)
    expect(heading.safeParse({ text: { path: '/title' } }).success, 'text binds').toBe(true)
    expect(heading.safeParse({ text: 'Q1', level: 4 }).success, 'level is 1 to 3').toBe(false)
    expect(heading.safeParse({ text: 'Q1', subtitle: { path: '/range' } }).success, 'subtitle binds').toBe(true)
    const badge = chartCatalogDefinitions.Badge.schema
    expect(badge.safeParse({ text: 'Paid', tone: { path: '/tone' } }).success, 'tone binds').toBe(true)
    const table = chartCatalogDefinitions.DataTable.schema
    expect(table.safeParse({ columns: [{ key: 's', label: 'S', badge: { Paid: 'success' } }], rows: [] }).success).toBe(true)
    expect(table.safeParse({ columns: [{ key: 's', label: 'S', badge: { Paid: 'green' } }], rows: [] }).success, 'an unknown tone is drawn neutral, as on a Badge').toBe(true)
    expect(chartCatalogDefinitions.Metric.schema.safeParse({ label: 'A', value: 1, trend: { path: '/t' } }).success, 'trend binds').toBe(true)
    expect(chartCatalogDefinitions.BarChart.schema.safeParse({ data: [], xKey: 'm', series: [], valuePrefix: '$', valueSuffix: 'K' }).success).toBe(true)
  })

  it('a bound trend and tone fall back to flat and neutral; a unit wraps a value', () => {
    expect(metricTrend('up')).toBe('up')
    expect(metricTrend('neutral')).toBe('flat')
    expect(metricTrend(undefined)).toBe('flat')
    expect(badgeTone('danger')).toBe('danger')
    expect(badgeTone('green')).toBe('neutral')
    expect(valueText(360, '$', 'K')).toBe('$360K')
    expect(valueText(360)).toBe('360')
    expect(valueText(-20, '$', 'K'), 'the sign leads the unit').toBe('-$20K')
    expect(valueText('-5', '$')).toBe('-$5')
    expect(valueText(0, '$')).toBe('$0')
  })

  it('a dashboard written in Express draws its headings, a bound trend and tone, and badge cells by value', async () => {
    const view = await draw(DASHBOARD)
    const headings = [...view.querySelectorAll('[data-slot="a2ui-heading"]')]
    expect(headings.map(h => [h.textContent, h.getAttribute('aria-level')])).toEqual([
      ['Q1 2025 Sales Dashboard', '1'],
      ['Recent orders', '3'],
    ])
    const subtitles = [...view.querySelectorAll('[data-slot="a2ui-heading-subtitle"]')]
    expect(subtitles.map(s => s.textContent), 'a subtitle sits under its heading, outside its name').toEqual([
      'Jan 1 – Mar 31, 2025',
      'Top 5 by value',
    ])
    expect(subtitles.some(s => s.querySelector('em')), 'a subtitle is upright').toBe(false)
    expect(view.querySelector('[data-slot="a2ui-metric"] .text-destructive')?.textContent).toBe('-2.1%')
    const badges = [...view.querySelectorAll('[data-slot="a2ui-badge"]')].map(b => [b.textContent, b.getAttribute('data-tone')])
    expect(badges).toEqual([
      ['Delayed', 'warning'],
      ['Paid', 'success'],
      ['Failed', 'danger'],
      ['Lost', 'neutral'],
    ])
    const totals = [...view.querySelectorAll('[data-slot="a2ui-table"] td:nth-child(2)')]
    expect(totals).toHaveLength(4)
    expect(totals.every(td => td.className.includes('text-right'))).toBe(true)
    expect(view.querySelector('[data-slot="a2ui-table"] tr:nth-child(4) td:nth-child(3)')?.innerHTML, 'a missing value draws no pill').toBe('')
    expect(view.querySelector('[data-slot="a2ui-metric"] [data-trend]')?.getAttribute('data-trend')).toBe('down')
    const headers = [...view.querySelectorAll('[data-slot="a2ui-table"] th')]
    expect(headers.every(th => th.className.includes('uppercase')), 'table headers are uppercase').toBe(true)
    expect(view.querySelector('[data-slot="a2ui-metric"] > span')?.className, 'a Metric label is uppercase').toContain('uppercase')
  })

  it('the runtime compiler, built from the catalog document, accepts the same dashboard', async () => {
    const compiler = await getRuntimeA2uiCompiler()
    expect(compiler.compile(DASHBOARD, compiler.createState())).toMatchObject({ ok: true })
  })
})

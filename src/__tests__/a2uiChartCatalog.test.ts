import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  VELLOC_CATALOG_ID,
  asRows,
  chartCatalogDefinitions,
  chartHeight,
} from '../browser/webview/a2ui/catalog/chartCatalogDefinitions'
import { vellocCatalog } from '../browser/webview/a2ui/catalog/vellocCatalog'
import { BarChartView, PieChartView, colorAt } from '../browser/webview/a2ui/catalog/ChartViews'
import { commandsToA2uiMessages } from '../browser/webview/a2ui/toA2uiMessages'

/** Uses createElement (not JSX) to match the `*.test.ts` include glob. */
describe('Velloc A2UI chart catalog', () => {
  it('keeps the basic components and adds the chart and data ones under its own id', () => {
    expect(vellocCatalog.id).toBe(VELLOC_CATALOG_ID)
    for (const name of ['Text', 'Card', 'Button', 'PieChart', 'LineChart', 'BarChart', 'Metric', 'DataTable']) {
      expect(vellocCatalog.components.has(name), name).toBe(true)
    }
  })

  it('accepts literal data and a data-model binding for chart data', () => {
    const line = chartCatalogDefinitions.LineChart.props
    expect(
      line.safeParse({ data: [{ month: 'Jan', sales: 1 }], xKey: 'month', series: [{ key: 'sales' }] }).success,
    ).toBe(true)
    expect(line.safeParse({ data: { path: '/sales' }, xKey: 'month', series: [] }).success).toBe(true)
    expect(line.safeParse({ data: [], series: [] }).success, 'xKey is required').toBe(false)
    const pie = chartCatalogDefinitions.PieChart.props
    expect(pie.safeParse({ data: [{ label: 'A', value: 2 }], donut: true }).success).toBe(true)
    expect(pie.safeParse({ data: [{ label: 'A', value: '2' }] }).success, 'value is a number').toBe(false)
  })

  it('treats anything but an array as no rows', () => {
    expect(asRows({ path: '/x' })).toEqual([])
    expect(asRows(undefined)).toEqual([])
    expect(asRows([{ a: 1 }, null, 3])).toEqual([{ a: 1 }])
  })

  it('colours series from the theme palette unless a colour is given', () => {
    expect(colorAt(0)).toBe('var(--chart-1)')
    expect(colorAt(5)).toBe('var(--chart-1)')
    expect(colorAt(1, '#ff0000')).toBe('#ff0000')
  })

  it('shows the empty state for a chart with no rows', () => {
    const pie = renderToStaticMarkup(createElement(PieChartView, { data: [] }))
    expect(pie).toContain('No data to show.')
    const bar = renderToStaticMarkup(
      createElement(BarChartView, { data: [{ m: 'Jan', v: 1 }], xKey: 'm', series: [], title: 'Sales' }),
    )
    expect(bar).toContain('No data to show.')
    expect(bar).toContain('Sales')
  })

  it('keeps strings inside literal chart and table data, and metric text, as literals', () => {
    const [, update] = commandsToA2uiMessages(
      [{
        name: 'a2ui_create_surface',
        args: {
          surfaceId: 's',
          components: [
            { id: 'root', component: 'BarChart', xKey: 'route', series: [{ key: 'views' }], data: [{ route: '/pricing', views: 1 }] },
            { id: 'pie', component: 'PieChart', data: [{ label: '/home', value: 2 }] },
            { id: 'table', component: 'DataTable', columns: [{ key: 'file', label: '/File' }], rows: [{ file: '/src/a.ts' }] },
            { id: 'bound', component: 'LineChart', xKey: 'm', series: [], data: '/sales' },
            { id: 'metric', component: 'Metric', label: 'Load', value: '/stats/load', delta: '/ 5 min', caption: '/proc' },
          ],
        },
      }],
      VELLOC_CATALOG_ID,
    )
    const components = (update as { updateComponents: { components: Record<string, unknown>[] } })
      .updateComponents.components
    const byId = (id: string) => components.find(c => c.id === id)!
    expect(byId('root').data).toEqual([{ route: '/pricing', views: 1 }])
    expect(byId('pie').data).toEqual([{ label: '/home', value: 2 }])
    expect(chartCatalogDefinitions.PieChart.props.safeParse(byId('pie')).success).toBe(true)
    expect(byId('table').rows).toEqual([{ file: '/src/a.ts' }])
    expect(byId('table').columns).toEqual([{ key: 'file', label: '/File' }])
    expect(byId('bound').data, 'a bare pointer still binds the whole prop').toEqual({ path: '/sales' })
    expect(byId('metric').value).toEqual({ path: '/stats/load' })
    expect(byId('metric').delta).toBe('/ 5 min')
    expect(byId('metric').caption).toBe('/proc')
  })

  it('clamps a model-supplied chart height', () => {
    expect(chartHeight(undefined)).toBe(240)
    expect(chartHeight(0)).toBe(120)
    expect(chartHeight(-5)).toBe(120)
    expect(chartHeight(5000)).toBe(800)
    expect(chartHeight(300.4)).toBe(300)
    expect(chartHeight(Number.NaN)).toBe(240)
    const html = renderToStaticMarkup(createElement(PieChartView, { data: [], height: 0 }))
    expect(html).toContain('height:120px')
  })

  it('creates surfaces against the catalog id it is given', () => {
    const [message] = commandsToA2uiMessages(
      [{ name: 'a2ui_create_surface', args: { surfaceId: 's', components: [{ id: 'root', component: 'Metric', label: 'Total', value: 3 }] } }],
      VELLOC_CATALOG_ID,
    )
    expect(JSON.stringify(message)).toContain(VELLOC_CATALOG_ID)
  })
})

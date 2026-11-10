// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { A2uiSurface, type ReactCatalogComponent } from '@a2ui/react'
import { MessageProcessor } from '@a2ui/web_core/v1_0'
import { chartCatalogDefinitions } from '../browser/webview/a2ui/catalog/chartCatalogDefinitions'
import { badgeTone, metricBetter, metricSense, metricTrend, vellocCatalog } from '../browser/webview/a2ui/catalog/vellocCatalog'
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

const SURFACE_CSS = readFileSync(join(__dirname, '..', 'browser', 'webview', 'a2ui', 'a2ui-surface.css'), 'utf8')

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

async function draw(body: string, onAction: (action: unknown) => void = () => {}): Promise<HTMLElement> {
  const processor = new MessageProcessor<ReactCatalogComponent>([vellocCatalog], onAction)
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

  it('a Metric colours its delta by whether the move is the better way', () => {
    const matrix = (['up', 'down'] as const).map(better =>
      (['up', 'down', 'flat'] as const).map(trend => metricSense(trend, better)),
    )
    expect(matrix).toEqual([
      ['good', 'bad', 'flat'],
      ['bad', 'good', 'flat'],
    ])
    expect(metricBetter(undefined)).toBe('up')
    expect(metricBetter('sideways'), 'an unknown value reads as up').toBe('up')
    expect(metricSense('up', 'sideways')).toBe('good')
    const metric = chartCatalogDefinitions.Metric.schema
    expect(metric.safeParse({ label: 'A', value: 1, better: { path: '/b' } }).success, 'better binds').toBe(true)
    expect(metric.safeParse({ label: 'A', value: 1, action: { event: { name: 'why' } }, actionLabel: 'Ask' }).success).toBe(true)
  })

  it('better: "down" draws a rise red and a fall green, with the arrow following the trend', async () => {
    const view = await draw(
      [
        'surface("sales")',
        '$/sense = "down"',
        'root = Column([rise, fall, flat, plain])',
        'rise = Metric("Refund rate", "2.4%", "+0.6pt", "up", better=$/sense)',
        'fall = Metric("Churn", "1.1%", "-0.2pt", "down", better="down")',
        'flat = Metric("Latency", "120ms", "0ms", "flat", better="down")',
        'plain = Metric("Revenue", "$9K", "+3%", "up", better="sideways")',
      ].join('\n'),
    )
    const deltas = [...view.querySelectorAll('[data-slot="a2ui-metric"] [data-trend]')]
    expect(deltas.map(d => [d.getAttribute('data-trend'), d.getAttribute('data-sense')])).toEqual([
      ['up', 'bad'],
      ['down', 'good'],
      ['flat', 'flat'],
      ['up', 'good'],
    ])
    expect(deltas.map(d => d.className.match(/text-(success|destructive|muted-foreground)/)?.[1])).toEqual([
      'destructive',
      'success',
      'muted-foreground',
      'success',
    ])
    expect(deltas[0].querySelector('svg')?.getAttribute('class'), 'a rise keeps the up arrow').toContain('trending-up')
  })

  it('a Metric with an action and a label shows an ask button after its delta that dispatches like a Button', async () => {
    const actions: unknown[] = []
    const view = await draw(
      [
        'surface("sales")',
        'root = Column([rate, bare, button])',
        'rate = Metric("Refund rate", "2.4%", "+0.6pt", "up", "vs last week", better="down", action=Event("explain_metric", {metric: "Refund rate"}), actionLabel="Ask why")',
        'bare = Metric("Churn", "1.1%", "-0.2pt", "down", action=Event("explain_metric", {metric: "Churn"}))',
        'button = Button(Text("Ask why"), action=Event("explain_metric", {metric: "Refund rate"}))',
      ].join('\n'),
      action => actions.push(action),
    )
    const affordances = [...view.querySelectorAll<HTMLButtonElement>('[data-slot="a2ui-metric-action"]')]
    expect(affordances, 'no label, no button').toHaveLength(1)
    const ask = affordances[0]
    expect(ask.tagName).toBe('BUTTON')
    expect(ask.getAttribute('aria-label')).toBe('Ask why')
    expect(ask.textContent).toBe('Ask why')
    expect(ask.querySelector('svg')?.getAttribute('class')).toContain('sparkles')
    expect(ask.previousElementSibling?.hasAttribute('data-trend'), 'it sits right after the delta').toBe(true)
    expect(ask.previousElementSibling?.className, 'the delta does not wrap').toContain('whitespace-nowrap')
    expect(ask.querySelector('span')?.className, 'the label does not wrap').toContain('truncate')
    const caption = ask.nextElementSibling!
    expect(caption.textContent).toBe('vs last week')
    expect(caption.className, 'a long caption still wraps').not.toMatch(/truncate|whitespace-nowrap/)
    expect(ask.parentElement?.className).not.toContain('whitespace-nowrap')
    expect(ask.className.split(' ')).toEqual(
      expect.arrayContaining(['opacity-0', 'group-hover/metric:opacity-100', 'focus-visible:opacity-100', 'hover:text-foreground', 'rounded-full']),
    )
    expect(ask.closest('[data-slot="a2ui-metric"]')?.className).toContain('group/metric')
    await act(async () => ask.click())
    const press = [...view.querySelectorAll('button')].find(b => !b.hasAttribute('data-slot'))!
    await act(async () => press.click())
    expect(actions).toHaveLength(2)
    const [fromMetric, fromButton] = actions as { name: string; context: unknown }[]
    expect(fromMetric).toMatchObject({ name: 'explain_metric', context: { metric: 'Refund rate' } })
    expect({ ...fromMetric, sourceComponentId: '', timestamp: '' }).toEqual({ ...fromButton, sourceComponentId: '', timestamp: '' })
    expect(fromMetric).toMatchObject({ sourceComponentId: 'rate' })
  })

  it('a Metric\'s ask button in a Card takes the card\'s top-right corner, shown only while that card is hovered or keyboard-focused', async () => {
    const view = await draw(
      [
        'surface("sales")',
        'root = Card(Row([net, plain]))',
        'net = Card(Column([Heading("Net sales", 3, "vs. previous 7 days"), Metric("Net", "$27.6K", "+4.2%", "up", action=Event("ask", {metric: "net"}), actionLabel="Analyze")]), 1)',
        'plain = Card(Metric("Orders", "72", "+3.0%", "up"), 1)',
      ].join('\n'),
    )
    const ask = view.querySelector<HTMLButtonElement>('[data-slot="a2ui-metric-action"]')!
    expect(ask.dataset.placement, 'the card\'s only actionable figure takes the corner').toBe('corner')
    const cards = [...view.querySelectorAll('.a2ui-card')]
    expect(cards).toHaveLength(3)
    expect(ask.closest('.a2ui-card'), 'the nearest card is the figure\'s own').toBe(cards[1])
    const rule = (needle: string) => {
      const block = SURFACE_CSS.replace(/\/\*[\s\S]*?\*\//g, '').split('}').find(b => b.slice(0, b.indexOf('{')).includes(needle))
      expect(block, needle).toBeDefined()
      return block!.replace(/\s+/g, ' ')
    }
    expect(rule(".a2ui-card:has([data-slot='a2ui-metric-action'][data-placement='corner'])")).toContain('position: relative')
    const corner = rule(".a2ui-card [data-slot='a2ui-metric-action'][data-placement='corner']")
    for (const decl of ['position: absolute', 'top: 0.5rem', 'right: 0.5rem']) expect(corner).toContain(decl)
    const reveal = rule(':is(:hover, :has(:focus-visible))')
    expect(reveal).toContain('opacity: 1')
    expect(reveal, 'an outer card\'s hover does not reveal an inner card\'s button').toContain(
      ":not(.a2ui-card:not(:hover, :has(:focus-visible)) [data-slot='a2ui-metric-action'])",
    )
  })

  it('two actionable Metrics in one Card both keep their ask button after the delta, and each dispatches its own action', async () => {
    const actions: unknown[] = []
    const view = await draw(
      [
        'surface("sales")',
        'root = Card(Row([net, refunds, orders]))',
        'net = Metric("Net", "$27.6K", "+4.2%", "up", action=Event("ask", {metric: "net"}), actionLabel="Analyze")',
        'refunds = Metric("Refunds", "2.4%", "+0.6pt", "up", better="down", action=Event("ask", {metric: "refunds"}), actionLabel="Ask why")',
        'orders = Metric("Orders", "72", "+3.0%", "up")',
      ].join('\n'),
      action => actions.push(action),
    )
    const asks = [...view.querySelectorAll<HTMLButtonElement>('[data-slot="a2ui-metric-action"]')]
    expect(asks.map(b => b.textContent)).toEqual(['Analyze', 'Ask why'])
    for (const ask of asks) {
      expect(ask.dataset.placement, 'two in one card stay inline').toBe('inline')
      expect(ask.previousElementSibling?.hasAttribute('data-trend'), 'it sits right after the delta').toBe(true)
      expect(ask.closest('.a2ui-card')).toBe(view.querySelector('.a2ui-card'))
    }
    for (const ask of asks) await act(async () => ask.click())
    expect(actions).toMatchObject([
      { name: 'ask', context: { metric: 'net' }, sourceComponentId: 'net' },
      { name: 'ask', context: { metric: 'refunds' }, sourceComponentId: 'refunds' },
    ])
  })

  it('a Heading with an action and a label shows an ask button after its subtitle, or its title, that dispatches like a Button', async () => {
    const actions: unknown[] = []
    const view = await draw(
      [
        'surface("sales")',
        'root = Column([week, solo, quiet])',
        'week = Heading("Store sales", 1, "Nov 1 – Nov 7, 2026", action=Event("compose", {text: "Analyze all changes"}), actionLabel="Analyze all changes")',
        'solo = Heading("Refunds", 3, action=Event("ask", {what: "refunds"}), actionLabel="Ask")',
        'quiet = Heading("Orders", 3, "No label", action=Event("ask", {what: "orders"}))',
      ].join('\n'),
      action => actions.push(action),
    )
    const asks = [...view.querySelectorAll<HTMLButtonElement>('[data-slot="a2ui-heading-action"]')]
    expect(asks.map(b => b.textContent), 'no label, no button').toEqual(['Analyze all changes', 'Ask'])
    const [week, solo] = asks
    expect(week.previousElementSibling?.getAttribute('data-slot'), 'it sits right after the subtitle').toBe('a2ui-heading-subtitle')
    expect(solo.previousElementSibling?.getAttribute('data-slot'), 'with no subtitle, right after the title').toBe('a2ui-heading')
    for (const ask of asks) {
      expect(ask.className.split(' ')).toEqual(expect.arrayContaining(['opacity-0', 'group-hover/heading:opacity-100', 'focus-visible:opacity-100']))
      expect(ask.closest('.group\\/heading')).not.toBeNull()
      expect(ask.querySelector('svg')?.getAttribute('class')).toContain('sparkles')
    }
    expect(view.querySelectorAll('[data-slot="a2ui-heading"]')).toHaveLength(3)
    await act(async () => week.click())
    await act(async () => solo.click())
    expect(actions).toMatchObject([
      { name: 'compose', context: { text: 'Analyze all changes' }, sourceComponentId: 'week' },
      { name: 'ask', context: { what: 'refunds' }, sourceComponentId: 'solo' },
    ])
  })

  it('the runtime compiler, built from the catalog document, accepts the same dashboard', async () => {
    const compiler = await getRuntimeA2uiCompiler()
    expect(compiler.compile(DASHBOARD, compiler.createState())).toMatchObject({ ok: true })
  })
})

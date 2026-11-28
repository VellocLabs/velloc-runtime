// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  BarChartView,
  CHART_POINT_LIMIT,
  CHART_REDRAW_MS,
  LineChartView,
  PieChartView,
  samplePoints,
  sameChartProps,
} from '../browser/webview/a2ui/catalog/ChartViews'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The chart containers count their draws and keep the data they were last
// given (a pie's data is on its slice child); the sizing wrapper passes its
// child through (the test document has no layout); the rest is the library.
const draws = vi.hoisted(() => ({ count: 0, data: undefined as unknown }))
vi.mock('recharts', async original => {
  const actual = await original<typeof import('recharts')>()
  const { Children, isValidElement } = await import('react')
  const counted = (props: { data?: unknown, children?: unknown }) => {
    draws.count++
    const child = Children.toArray(props.children as never)
      .find(c => isValidElement(c) && (c.props as { data?: unknown }).data !== undefined)
    draws.data = props.data ?? (isValidElement(child) ? (child.props as { data?: unknown }).data : undefined)
    return null
  }
  return {
    ...actual,
    LineChart: counted,
    BarChart: counted,
    PieChart: counted,
    ResponsiveContainer: ({ children }: { children: unknown }) => children,
  }
})

let root: Root | null = null
beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  vi.useRealTimers()
})

const points = (shift: number, length = 20) => Array.from({ length }, (_, x) => ({ x: String(x), a: x + shift, b: x * 2 }))
const slices = (shift: number) => Array.from({ length: 4 }, (_, i) => ({ label: `s${i}`, value: i + 1 + shift }))
const SERIES = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]
const CHARTS = [
  ['LineChart', LineChartView, points],
  ['BarChart', BarChartView, points],
  ['PieChart', PieChartView, slices],
] as const

describe('an A2UI chart redraws only when what it shows changes, at most once per redraw period', () => {
  it('props are the same while each holds the same value, arrays and objects by content', () => {
    const base = { title: 'Sales', data: points(0), xKey: 'x', series: SERIES, stacked: true }
    expect(sameChartProps(base, { ...base, data: points(0), series: SERIES.map(s => ({ ...s })) })).toBe(true)
    expect(sameChartProps(base, { ...base, data: points(1) }), 'a changed point').toBe(false)
    expect(sameChartProps(base, { ...base, series: [SERIES[0]] }), 'a series fewer').toBe(false)
    expect(sameChartProps(base, { ...base, stacked: false }), 'a changed flag').toBe(false)
    expect(sameChartProps(base, { ...base, height: 300 }), 'a prop added').toBe(false)
  })

  for (const [name, View, make] of CHARTS) {
    it(`${name}: equal data draws nothing; changes within the period are drawn together at its end, with the latest data`, async () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)
      draws.count = 0
      const draw = (data: unknown) => act(async () => root!.render(createElement(View as unknown as ComponentType<Record<string, unknown>>, { data, xKey: 'x', series: SERIES })))
      const elapse = (ms: number) => act(async () => { vi.advanceTimersByTime(ms) })

      await draw(make(0))
      const first = draws.count
      expect(first, 'the first draw is at once').toBeGreaterThan(0)
      await draw(make(0))
      expect(draws.count, 'equal data in a new array draws nothing').toBe(first)

      await draw(make(1))
      expect(draws.count, 'the first change after mounting draws at once').toBe(first + 1)
      expect(draws.data).toEqual(make(1))

      await draw(make(5))
      await draw(make(6))
      expect(draws.count, 'changes inside the period wait').toBe(first + 1)
      await elapse(CHART_REDRAW_MS)
      expect(draws.count, 'one draw at the end of the period').toBe(first + 2)
      expect(draws.data, 'with the latest data').toEqual(make(6))

      await elapse(CHART_REDRAW_MS + 100)
      await draw(make(7))
      expect(draws.count, 'a change after a quiet period draws at once').toBe(first + 3)
      expect(draws.data).toEqual(make(7))
    })
  }

  for (const [name, View] of [['Line', LineChartView], ['Bar', BarChartView]] as const) {
    it(`a ${name} chart draws at most the point limit, sampled evenly with its first and last points`, async () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)
      const many = points(0, CHART_POINT_LIMIT * 3 + 7)
      await act(async () => root!.render(createElement(View, { data: many, xKey: 'x', series: SERIES })))
      const drawn = draws.data as typeof many
      expect(drawn).toHaveLength(CHART_POINT_LIMIT)
      expect(drawn[0]).toEqual(many[0])
      expect(drawn[drawn.length - 1]).toEqual(many[many.length - 1])
    })
  }

  it('a Pie chart is not sampled: every slice is drawn', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const many = Array.from({ length: CHART_POINT_LIMIT + 20 }, (_, i) => ({ label: `s${i}`, value: i + 1 }))
    await act(async () => root!.render(createElement(PieChartView, { data: many })))
    expect(draws.data).toHaveLength(many.length)
  })

  it('sampling keeps short data as it is and spaces long data evenly', () => {
    const short = [1, 2, 3]
    expect(samplePoints(short, 5)).toBe(short)
    expect(samplePoints([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3)).toEqual([0, 5, 10])
    expect(samplePoints([0, 1, 2, 3, 4], 1)).toEqual([0])
  })
})

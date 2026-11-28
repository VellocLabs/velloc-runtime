// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { BarChartView, LineChartView, PieChartView, sameChartProps } from '../browser/webview/a2ui/catalog/ChartViews'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The chart containers count their draws, and the sizing wrapper passes its
// child through (the test document has no layout); the rest is the library.
const draws = vi.hoisted(() => ({ count: 0 }))
vi.mock('recharts', async original => {
  const actual = await original<typeof import('recharts')>()
  const counted = () => { draws.count++; return null }
  return { ...actual, LineChart: counted, BarChart: counted, PieChart: counted, ResponsiveContainer: ({ children }: { children: unknown }) => children }
})

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

const points = (shift: number) => Array.from({ length: 20 }, (_, x) => ({ x: String(x), a: x + shift, b: x * 2 }))
const SERIES = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]

describe('an A2UI chart redraws only when what it shows changes', () => {
  it('props are the same while each holds the same value, arrays and objects by content', () => {
    const base = { title: 'Sales', data: points(0), xKey: 'x', series: SERIES, stacked: true }
    expect(sameChartProps(base, { ...base, data: points(0), series: SERIES.map(s => ({ ...s })) })).toBe(true)
    expect(sameChartProps(base, { ...base, data: points(1) }), 'a changed point').toBe(false)
    expect(sameChartProps(base, { ...base, series: [SERIES[0]] }), 'a series fewer').toBe(false)
    expect(sameChartProps(base, { ...base, stacked: false }), 'a changed flag').toBe(false)
    expect(sameChartProps(base, { ...base, height: 300 }), 'a prop added').toBe(false)
  })

  const slices = (shift: number) => points(shift).map(point => ({ label: point.x, value: point.a }))
  const cases: [string, ComponentType<{ data: unknown; xKey: string; series: typeof SERIES }>, (shift: number) => unknown][] = [
    ['LineChart', LineChartView, points],
    ['BarChart', BarChartView, points],
    ['PieChart', PieChartView, slices],
  ]
  for (const [name, View, dataOf] of cases) {
    it(`${name}: new data equal to the old draws nothing; changed data draws again`, async () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)
      draws.count = 0
      const draw = (data: unknown) => act(async () => root!.render(createElement(View, { data, xKey: 'x', series: SERIES })))
      await draw(dataOf(0))
      const first = draws.count
      expect(first, 'the first draw').toBeGreaterThan(0)
      await draw(dataOf(0))
      expect(draws.count, 'equal data in a new array draws nothing').toBe(first)
      await draw(dataOf(5))
      expect(draws.count, 'changed data draws again').toBeGreaterThan(first)
    })
  }
})

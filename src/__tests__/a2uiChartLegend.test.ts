// @vitest-environment happy-dom
/**
 * Chart legends (F-1): a legend lists the slices or series in the order the
 * author gave them, and a pie chart's legend is one column to the left of the
 * pie, each slice with its value in the chart's unit.
 */
import { cloneElement, createElement, isValidElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'

vi.mock('recharts', async importOriginal => {
  const actual = await importOriginal<typeof import('recharts')>()
  // A fixed-size container: happy-dom lays nothing out.
  const ResponsiveContainer = ({ children }: { children?: ReactNode }) =>
    isValidElement(children) ? cloneElement(children as never, { width: 600, height: 240 } as never) : null
  return { ...actual, ResponsiveContainer }
})

import { BarChartView, PieChartView } from '../browser/webview/a2ui/catalog/ChartViews'

afterEach(cleanup)

const legendTexts = (root: HTMLElement) =>
  [...root.querySelectorAll('.recharts-legend-item-text')].map(el => el.textContent)

describe('chart legends', () => {
  it('a pie lists its slices with their values in the given order, in a column left of the pie', async () => {
    const data = [
      { label: 'United States', value: 64 },
      { label: 'Canada', value: 14 },
      { label: 'Australia', value: 5 },
      { label: 'Other', value: 4 },
    ]
    const { container } = render(createElement(PieChartView, { data, donut: true, valueSuffix: '%' }))
    await waitFor(() => expect(legendTexts(container)).toEqual(['United States 64%', 'Canada 14%', 'Australia 5%', 'Other 4%']))
    const wrapper = container.querySelector<HTMLElement>('.recharts-legend-wrapper')!
    expect([wrapper.style.left, wrapper.style.bottom]).toEqual(['5px', ''])
    const items = [...container.querySelectorAll<HTMLElement>('.recharts-legend-item')]
    expect(items.every(item => item.style.display === 'block')).toBe(true)
  })

  it('a bar chart lists its series in the given order', () => {
    const series = [{ key: 'us', label: 'United States' }, { key: 'ca', label: 'Canada' }, { key: 'au', label: 'Australia' }]
    const { container } = render(createElement(BarChartView, { data: [{ x: 'a', us: 1, ca: 2, au: 3 }], xKey: 'x', series }))
    expect(legendTexts(container)).toEqual(['United States', 'Canada', 'Australia'])
  })
})

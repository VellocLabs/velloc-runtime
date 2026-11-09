// Chart renderers for the Velloc A2UI catalog (F-1). This module is the only
// importer of recharts and is itself lazy-imported, so the chart library loads
// the first time a surface draws a chart.

import type { ReactElement } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useT } from '../../i18n'
import { asRows, chartHeight } from './chartCatalogDefinitions'

const PALETTE = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)']
const AXIS_TICK = { fill: 'var(--muted-foreground)', fontSize: 12 }
const TOOLTIP_STYLE = {
  background: 'var(--popover)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  color: 'var(--popover-foreground)',
  fontSize: 12,
}

const LEGEND_STYLE = { fontSize: 12 }
/** Legend props shared by every chart: entries keep the order the author gave the slices or series. */
const LEGEND_PROPS = { itemSorter: null, wrapperStyle: LEGEND_STYLE }

export type SeriesSpec = { key: string; label?: string; color?: string }

export function colorAt(index: number, color?: string): string {
  return color ?? PALETTE[index % PALETTE.length]
}

/** A value with the chart's unit around it, a minus sign leading the prefix; no prefix or suffix leaves it as it is. */
export function valueText(value: unknown, prefix?: string, suffix?: string): string {
  const raw = typeof value === 'number' || typeof value === 'string' ? String(value) : ''
  const negative = raw.startsWith('-')
  return `${negative ? '-' : ''}${prefix ?? ''}${negative ? raw.slice(1) : raw}${suffix ?? ''}`
}

type ValueUnit = { valuePrefix?: string; valueSuffix?: string }

function unitProps({ valuePrefix, valueSuffix }: ValueUnit) {
  if (!valuePrefix && !valueSuffix) return { tick: {}, tooltip: {} }
  const format = (value: unknown) => valueText(value, valuePrefix, valueSuffix)
  return { tick: { tickFormatter: format }, tooltip: { formatter: format } }
}

function Frame({ title, height, empty, children }: {
  title?: unknown
  height?: number
  empty: boolean
  children: ReactElement
}): ReactElement {
  const t = useT()
  const h = chartHeight(height)
  return (
    <figure data-slot="a2ui-chart" className="m-0 w-full min-w-0">
      {typeof title === 'string' && title && (
        <figcaption className="mb-2 text-sm font-medium">{title}</figcaption>
      )}
      {empty ? (
        <div style={{ height: h }} className="flex items-center justify-center text-xs text-muted-foreground">
          {t('a2ui.chart.noData')}
        </div>
      ) : (
        <div style={{ height: h }} className="w-full min-w-0">
          <ResponsiveContainer width="100%" height="100%">
            {children}
          </ResponsiveContainer>
        </div>
      )}
    </figure>
  )
}

export function PieChartView({ title, data, donut, height, valuePrefix, valueSuffix }: {
  title?: unknown
  data: unknown
  donut?: boolean
  height?: number
} & ValueUnit): ReactElement {
  const slices = asRows(data).filter(row => typeof row.value === 'number')
  const format = (value: unknown) => valueText(value, valuePrefix, valueSuffix)
  // The legend's text is the slice's label; its value follows in the chart's unit.
  const legendText = (label: unknown, entry: { payload?: { value?: unknown } }) =>
    `${String(label)} ${format(entry.payload?.value)}`
  return (
    <Frame title={title} height={height} empty={slices.length === 0}>
      <PieChart>
        <Pie
          data={slices}
          dataKey="value"
          nameKey="label"
          innerRadius={donut ? '40%' : 0}
          outerRadius="80%"
          isAnimationActive={false}
        >
          {slices.map((slice, index) => (
            <Cell
              key={index}
              fill={colorAt(index, typeof slice.color === 'string' ? slice.color : undefined)}
            />
          ))}
        </Pie>
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={format} />
        <Legend
          layout="vertical"
          align="left"
          verticalAlign="middle"
          {...LEGEND_PROPS}
          formatter={legendText}
          wrapperStyle={{ ...LEGEND_STYLE, lineHeight: '22px' }}
        />
      </PieChart>
    </Frame>
  )
}

export function LineChartView({ title, data, xKey, series, curved, height, ...unit }: {
  title?: unknown
  data: unknown
  xKey: string
  series: readonly SeriesSpec[]
  curved?: boolean
  height?: number
} & ValueUnit): ReactElement {
  const rows = asRows(data)
  const units = unitProps(unit)
  return (
    <Frame title={title} height={height} empty={rows.length === 0 || series.length === 0}>
      <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="var(--border)" vertical={false} />
        <XAxis dataKey={xKey} tick={AXIS_TICK} stroke="var(--border)" />
        <YAxis tick={AXIS_TICK} stroke="var(--border)" width={56} {...units.tick} />
        <Tooltip contentStyle={TOOLTIP_STYLE} {...units.tooltip} />
        {series.length > 1 && <Legend {...LEGEND_PROPS} />}
        {series.map((s, index) => (
          <Line
            key={s.key}
            dataKey={s.key}
            name={s.label ?? s.key}
            type={curved ? 'monotone' : 'linear'}
            stroke={colorAt(index, s.color)}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </Frame>
  )
}

export function BarChartView({ title, data, xKey, series, stacked, height, ...unit }: {
  title?: unknown
  data: unknown
  xKey: string
  series: readonly SeriesSpec[]
  stacked?: boolean
  height?: number
} & ValueUnit): ReactElement {
  const rows = asRows(data)
  const units = unitProps(unit)
  return (
    <Frame title={title} height={height} empty={rows.length === 0 || series.length === 0}>
      <BarChart data={rows} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="var(--border)" vertical={false} />
        <XAxis dataKey={xKey} tick={AXIS_TICK} stroke="var(--border)" />
        <YAxis tick={AXIS_TICK} stroke="var(--border)" width={56} {...units.tick} />
        <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'var(--muted)' }} {...units.tooltip} />
        {series.length > 1 && <Legend {...LEGEND_PROPS} />}
        {series.map((s, index) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label ?? s.key}
            fill={colorAt(index, s.color)}
            stackId={stacked ? 'stack' : undefined}
            radius={stacked ? 0 : [4, 4, 0, 0]}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </Frame>
  )
}

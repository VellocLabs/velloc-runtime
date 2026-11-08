// The Velloc A2UI catalog (F-1): the v1.0 basic catalog plus the chart, data
// and dashboard components. Chart renderers are lazy, so recharts loads on the
// first chart.

import { lazy, Suspense, type ReactElement } from 'react'
import { createComponentImplementation, type ReactCatalogComponent } from '@a2ui/react'
import { Catalog, type ComponentApi } from '@a2ui/web_core/v1_0'
import { basicCatalog } from '@a2ui/web_core/catalogs/basic/v1'
import { TrendingDownIcon, TrendingUpIcon } from 'lucide-react'
import {
  BADGE_TONES,
  type BadgeTone,
  VELLOC_CATALOG_ID,
  CHART_CATALOG_INSTRUCTIONS,
  asRows,
  chartCatalogDefinitions,
  type ChartComponentName,
  chartHeight,
} from './chartCatalogDefinitions'
import type { CatalogPropNames } from '../toA2uiMessages'

const PieChartView = lazy(async () => ({
  default: (await import('./ChartViews')).PieChartView,
}))
const LineChartView = lazy(async () => ({
  default: (await import('./ChartViews')).LineChartView,
}))
const BarChartView = lazy(async () => ({
  default: (await import('./ChartViews')).BarChartView,
}))

function ChartPlaceholder({ height }: { height?: number }): ReactElement {
  return <div data-slot="a2ui-chart-loading" style={{ height: chartHeight(height) }} className="w-full" />
}

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

/** A bound trend as one of the three directions; "neutral" and anything unknown are flat. */
export function metricTrend(trend: unknown): 'up' | 'down' | 'flat' {
  return trend === 'up' || trend === 'down' ? trend : 'flat'
}

/** A bound tone as a known one; anything else is neutral. */
export function badgeTone(tone: unknown): BadgeTone {
  return typeof tone === 'string' && (BADGE_TONES as readonly string[]).includes(tone) ? (tone as BadgeTone) : 'neutral'
}

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  info: 'bg-info/15 text-info',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-destructive/15 text-destructive',
}

function BadgeView({ text: label, tone }: { text?: unknown; tone?: unknown }): ReactElement {
  const known = badgeTone(tone)
  return (
    <span
      data-slot="a2ui-badge"
      data-tone={known}
      className={`inline-flex w-fit items-center rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASS[known]}`}
    >
      {text(label)}
    </span>
  )
}

const HEADING_CLASS = ['text-2xl font-semibold', 'text-lg font-semibold', 'text-sm font-semibold'] as const

type HeadingProps = { text?: unknown; level?: number; subtitle?: unknown }

function HeadingView({ text: title, level, subtitle }: HeadingProps): ReactElement {
  const index = level === 1 || level === 3 ? level - 1 : 1
  const heading = (
    <div data-slot="a2ui-heading" role="heading" aria-level={index + 1} className={HEADING_CLASS[index]}>
      {text(title)}
    </div>
  )
  const sub = text(subtitle)
  if (!sub) return heading
  return (
    <div className="flex flex-col gap-1">
      {heading}
      <div data-slot="a2ui-heading-subtitle" className="text-xs text-muted-foreground">
        {sub}
      </div>
    </div>
  )
}

function MetricView({ label, value, delta, trend: bound, caption }: MetricProps): ReactElement {
  const trend = metricTrend(bound)
  const tone =
    trend === 'up'
      ? 'text-success'
      : trend === 'down'
        ? 'text-destructive'
        : 'text-muted-foreground'
  return (
    <div data-slot="a2ui-metric" className="flex min-w-0 flex-col gap-1">
      <span className="truncate text-xs font-medium uppercase tracking-wider text-muted-foreground">{text(label)}</span>
      <span className="text-2xl font-semibold tabular-nums">{text(value)}</span>
      {(text(delta) || text(caption)) && (
        <span className="flex items-center gap-1 text-xs">
          {text(delta) && (
            <span className={`inline-flex items-center gap-0.5 ${tone}`}>
              {trend === 'up' && <TrendingUpIcon className="size-3.5" />}
              {trend === 'down' && <TrendingDownIcon className="size-3.5" />}
              {text(delta)}
            </span>
          )}
          {text(caption) && <span className="text-muted-foreground">{text(caption)}</span>}
        </span>
      )}
    </div>
  )
}

function DataTableView({ columns = [], rows }: DataTableProps): ReactElement {
  const align = (column: TableColumn) => (column.align === 'end' ? 'text-right' : 'text-left')
  const list = asRows(rows)
  return (
    <div data-slot="a2ui-table" className="w-full overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                className={`border-b px-2 py-1.5 ${align(column)} text-[0.7rem] font-semibold uppercase tracking-wider text-muted-foreground`}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {list.map((row, index) => (
            <tr key={index} className="border-b last:border-b-0">
              {columns.map((column) => (
                <td key={column.key} className={`px-2 py-1.5 ${align(column)} tabular-nums`}>
                  {column.badge ? (
                    <BadgeView text={row[column.key]} tone={column.badge[text(row[column.key])]} />
                  ) : (
                    text(row[column.key])
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

type MetricProps = {
  label?: unknown
  value?: unknown
  delta?: unknown
  trend?: unknown
  caption?: unknown
}
type TableColumn = { key: string; label: string; align?: 'start' | 'end'; badge?: Record<string, BadgeTone> }
type DataTableProps = { columns?: TableColumn[]; rows?: unknown }
type ChartProps = {
  title?: unknown
  data?: unknown
  xKey?: string
  series?: { key: string; label?: string; color?: string }[]
  donut?: boolean
  curved?: boolean
  stacked?: boolean
  height?: number
  valuePrefix?: string
  valueSuffix?: string
}

const views: Record<ChartComponentName, (props: Record<string, unknown>) => ReactElement> = {
  PieChart: props => {
    const p = props as ChartProps
    return (
      <Suspense fallback={<ChartPlaceholder height={p.height} />}>
        <PieChartView title={p.title} data={p.data} donut={p.donut} height={p.height} />
      </Suspense>
    )
  },
  LineChart: props => {
    const p = props as ChartProps
    return (
      <Suspense fallback={<ChartPlaceholder height={p.height} />}>
        <LineChartView
          title={p.title}
          data={p.data}
          xKey={p.xKey ?? ''}
          series={p.series ?? []}
          curved={p.curved}
          height={p.height}
          valuePrefix={p.valuePrefix}
          valueSuffix={p.valueSuffix}
        />
      </Suspense>
    )
  },
  BarChart: props => {
    const p = props as ChartProps
    return (
      <Suspense fallback={<ChartPlaceholder height={p.height} />}>
        <BarChartView
          title={p.title}
          data={p.data}
          xKey={p.xKey ?? ''}
          series={p.series ?? []}
          stacked={p.stacked}
          height={p.height}
          valuePrefix={p.valuePrefix}
          valueSuffix={p.valueSuffix}
        />
      </Suspense>
    )
  },
  Metric: props => <MetricView {...(props as MetricProps)} />,
  DataTable: props => <DataTableView {...(props as DataTableProps)} />,
  Heading: props => <HeadingView {...(props as HeadingProps)} />,
  Badge: props => <BadgeView {...(props as { text?: unknown; tone?: unknown })} />,
}

const chartComponents: ReactCatalogComponent[] = (
  Object.keys(chartCatalogDefinitions) as ChartComponentName[]
).map(name => {
  const View = views[name]
  // Typed loosely: `zod/v3` and the renderer's own zod copy match at runtime
  // (the binder reads `_def`), and comparing their types exhausts the checker.
  const api = { name, schema: chartCatalogDefinitions[name].schema } as unknown as ComponentApi
  return createComponentImplementation(api, ({ props }) => (
    <View {...(props as Record<string, unknown>)} />
  ))
})

export const vellocCatalog = new Catalog<ReactCatalogComponent>(
  VELLOC_CATALOG_ID,
  'v1.0',
  [...basicCatalog.components.values(), ...chartComponents],
  [...basicCatalog.functions.values()],
  {
    instructions: [basicCatalog.instructions, CHART_CATALOG_INSTRUCTIONS].filter(Boolean).join('\n\n'),
  },
)

type SchemaDef = { typeName?: string; innerType?: SchemaLike; schema?: SchemaLike; shape?: () => Record<string, unknown> }
type SchemaLike = { _def?: SchemaDef }

// Reads an object schema's keys through the optional/default/effects wrappers.
function schemaKeys(schema: SchemaLike | undefined): string[] {
  let current = schema
  for (let depth = 0; current?._def && depth < 8; depth++) {
    const def: SchemaDef = current._def
    if (def.typeName === 'ZodObject' && def.shape) return Object.keys(def.shape())
    current = def.innerType ?? def.schema
  }
  return []
}

/** The props each Velloc catalog component accepts (F-1). */
export const vellocCatalogPropNames: CatalogPropNames = new Map(
  [...vellocCatalog.components.values()].map(component => [
    component.name,
    new Set(schemaKeys(component.schema as unknown as SchemaLike)),
  ]),
)

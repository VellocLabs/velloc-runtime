// The Velloc A2UI catalog (F-1): the v1.0 basic catalog plus the chart and
// data components. Chart renderers are lazy, so recharts loads on the first chart.

import { lazy, Suspense, type ReactElement } from 'react'
import { createComponentImplementation, type ReactCatalogComponent } from '@a2ui/react'
import { Catalog, type ComponentApi } from '@a2ui/web_core/v1_0'
import { basicCatalog } from '@a2ui/web_core/catalogs/basic/v1'
import { TrendingDownIcon, TrendingUpIcon } from 'lucide-react'
import {
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

function MetricView({ label, value, delta, trend, caption }: MetricProps): ReactElement {
  const tone =
    trend === 'up'
      ? 'text-success'
      : trend === 'down'
        ? 'text-destructive'
        : 'text-muted-foreground'
  return (
    <div data-slot="a2ui-metric" className="flex min-w-0 flex-col gap-1">
      <span className="truncate text-xs text-muted-foreground">{text(label)}</span>
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
  const list = asRows(rows)
  return (
    <div data-slot="a2ui-table" className="w-full overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                className="border-b px-2 py-1.5 text-left text-xs font-medium text-muted-foreground"
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
                <td key={column.key} className="px-2 py-1.5 tabular-nums">
                  {text(row[column.key])}
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
  trend?: 'up' | 'down' | 'flat'
  caption?: unknown
}
type DataTableProps = { columns?: { key: string; label: string }[]; rows?: unknown }
type ChartProps = {
  title?: unknown
  data?: unknown
  xKey?: string
  series?: { key: string; label?: string; color?: string }[]
  donut?: boolean
  curved?: boolean
  stacked?: boolean
  height?: number
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
        />
      </Suspense>
    )
  },
  Metric: props => <MetricView {...(props as MetricProps)} />,
  DataTable: props => <DataTableView {...(props as DataTableProps)} />,
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

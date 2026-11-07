// The Velloc A2UI catalog (F-1): the basic catalog plus the chart and data
// components. Chart renderers are lazy, so recharts loads on the first chart.

import { lazy, Suspense, type ComponentType, type ReactElement } from 'react'
import {
  createCatalog,
  type CatalogDefinitions,
  type CatalogRenderers,
} from '@copilotkit/a2ui-renderer'
import { TrendingDownIcon, TrendingUpIcon } from 'lucide-react'
import {
  VELLOC_CATALOG_ID,
  asRows,
  chartCatalogDefinitions,
  chartHeight,
  type ChartCatalogDefinitions,
  type PropsOfChart,
} from './chartCatalogDefinitions'

function lazyChart<P extends { height?: number }>(load: () => Promise<ComponentType<P>>) {
  const View = lazy(async () => ({ default: await load() }))
  return function LazyChart({ props }: { props: P }): ReactElement {
    return (
      <Suspense fallback={<ChartPlaceholder height={props.height} />}>
        <View {...props} />
      </Suspense>
    )
  }
}

function ChartPlaceholder({ height }: { height?: number }): ReactElement {
  return <div data-slot="a2ui-chart-loading" style={{ height: chartHeight(height) }} className="w-full" />
}

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function MetricView({ label, value, delta, trend, caption }: PropsOfChart<'Metric'>): ReactElement {
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

function DataTableView({ columns, rows }: PropsOfChart<'DataTable'>): ReactElement {
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

type ChartRenderers = {
  [K in keyof ChartCatalogDefinitions]: (input: { props: PropsOfChart<K> }) => ReactElement
}

const renderers: ChartRenderers = {
  PieChart: lazyChart<PropsOfChart<'PieChart'>>(async () => (await import('./ChartViews')).PieChartView),
  LineChart: lazyChart<PropsOfChart<'LineChart'>>(async () => (await import('./ChartViews')).LineChartView),
  BarChart: lazyChart<PropsOfChart<'BarChart'>>(async () => (await import('./ChartViews')).BarChartView),
  Metric: ({ props }) => <MetricView {...props} />,
  DataTable: ({ props }) => <DataTableView {...props} />,
}

// The definitions use `zod/v3`, the renderer its own zod 3 copy: the schemas
// match at runtime (the binder reads `_def`), not as nominal types.
export const vellocCatalog = createCatalog(
  chartCatalogDefinitions as unknown as CatalogDefinitions,
  renderers as unknown as CatalogRenderers<CatalogDefinitions>,
  { catalogId: VELLOC_CATALOG_ID, includeBasicCatalog: true },
)

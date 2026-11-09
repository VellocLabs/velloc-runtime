// The Velloc A2UI catalog (F-1): the v1.0 basic catalog with Velloc's own
// Tabs, plus the chart, data and dashboard components. Chart renderers are
// lazy, so recharts loads on the first chart.

import { createContext, lazy, Suspense, useContext, type ReactElement, type ReactNode } from 'react'
import { createComponentImplementation, type ReactCatalogComponent } from '@a2ui/react'
import { Catalog, type ComponentApi } from '@a2ui/web_core/v1_0'
import { basicCatalog } from '@a2ui/web_core/catalogs/basic/v1'
import { CircleHelpIcon, TrendingDownIcon, TrendingUpIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  BADGE_TONES,
  type BadgeTone,
  VELLOC_CATALOG_ID,
  CHART_CATALOG_INSTRUCTIONS,
  asRows,
  chartCatalogDefinitions,
  type ChartComponentName,
  chartHeight,
  gridMinWidth,
} from './chartCatalogDefinitions'
import { TABS_CATALOG_INSTRUCTIONS, tabsComponent } from './TabsView'
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

const TONE_VARIANT = {
  neutral: 'muted',
  info: 'info',
  success: 'success',
  warning: 'warning',
  danger: 'destructive',
} as const satisfies Record<BadgeTone, string>

function BadgeView({ text: label, tone }: { text?: unknown; tone?: unknown }): ReactElement {
  const known = badgeTone(tone)
  return (
    <Badge data-slot="a2ui-badge" data-tone={known} variant={TONE_VARIANT[known]} className="h-auto rounded-full">
      {text(label)}
    </Badge>
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

/** A bound `better` as the direction that is good; anything but "down" is "up". */
export function metricBetter(better: unknown): 'up' | 'down' {
  return better === 'down' ? 'down' : 'up'
}

/** Whether a move reads as good, bad or neither, given which direction is better. */
export function metricSense(trend: unknown, better: unknown): 'good' | 'bad' | 'flat' {
  const direction = metricTrend(trend)
  if (direction === 'flat') return 'flat'
  return direction === metricBetter(better) ? 'good' : 'bad'
}

const SENSE_TONE = {
  good: 'text-success',
  bad: 'text-destructive',
  flat: 'text-muted-foreground',
} as const

function MetricView({ label, value, delta, trend: bound, caption, better, action, actionLabel }: MetricProps): ReactElement {
  const trend = metricTrend(bound)
  const sense = metricSense(trend, better)
  const askLabel = typeof action === 'function' ? text(actionLabel) : ''
  return (
    <div data-slot="a2ui-metric" className="group/metric flex min-w-0 flex-col gap-1">
      <span className="truncate text-xs font-medium uppercase tracking-wider text-muted-foreground">{text(label)}</span>
      <span className="text-2xl font-semibold tabular-nums">{text(value)}</span>
      {(text(delta) || text(caption) || askLabel) && (
        <span className="flex min-w-0 items-center gap-1 text-xs">
          {text(delta) && (
            <span data-trend={trend} data-sense={sense} className={`inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap ${SENSE_TONE[sense]}`}>
              {trend === 'up' && <TrendingUpIcon className="size-3.5" />}
              {trend === 'down' && <TrendingDownIcon className="size-3.5" />}
              {text(delta)}
            </span>
          )}
          {askLabel && (
            <button
              type="button"
              data-slot="a2ui-metric-action"
              aria-label={askLabel}
              onClick={() => (action as () => void)()}
              className="inline-flex min-w-0 shrink items-center gap-0.5 rounded-sm text-muted-foreground opacity-0 transition-opacity outline-none hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring group-hover/metric:opacity-100"
            >
              <CircleHelpIcon aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="truncate">{askLabel}</span>
            </button>
          )}
          {text(caption) && <span className="min-w-0 text-muted-foreground">{text(caption)}</span>}
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
                  {column.badge && text(row[column.key]) ? (
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
  better?: unknown
  /** The binder's dispatch closure for the Metric's action, the same as a Button's. */
  action?: unknown
  actionLabel?: unknown
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

type BuildChild = (id: string, basePath?: string) => ReactNode
/** A resolved child-list entry: a fixed id, or a template cell with its data path. */
type ChildRef = string | { id: string; basePath?: string }

function childKey(child: ChildRef, index: number): string {
  return typeof child === 'string' ? child : `${child.basePath ?? index}/${child.id}`
}

/** True inside a Grid cell, where a HoverBar pins itself to the cell's corner. */
const GridCellContext = createContext(false)

function childList(children: unknown): ChildRef[] {
  return (Array.isArray(children) ? children : []).filter(
    (child): child is ChildRef => typeof child === 'string' || (!!child && typeof child === 'object' && typeof (child as { id?: unknown }).id === 'string'),
  )
}

function buildRef(child: ChildRef, buildChild: BuildChild): ReactNode {
  return typeof child === 'string' ? buildChild(child) : buildChild(child.id, child.basePath)
}

export function GridView({ children, minWidth, after, buildChild }: { children?: unknown; minWidth?: unknown; after?: unknown; buildChild: BuildChild }): ReactElement {
  const cells = childList(children)
  if (typeof after === 'string' && after && !cells.includes(after)) cells.push(after)
  return (
    <div
      data-slot="a2ui-grid"
      className="grid w-full gap-4"
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${gridMinWidth(minWidth)}px), 1fr))` }}
    >
      {cells.map((child, index) => (
        <div key={childKey(child, index)} data-slot="a2ui-grid-cell" className="group/cell relative flex min-w-0 *:min-w-0 *:flex-1">
          <GridCellContext.Provider value={true}>{buildRef(child, buildChild)}</GridCellContext.Provider>
        </div>
      ))}
    </div>
  )
}

/** The bar's buttons are small, the basic catalog's sizes scaled down inside it, with a rule between two buttons. */
const HOVER_BAR_COMPACT =
  'flex items-center [--a2ui-button-margin:0] [--a2ui-button-padding:2px_0] [--a2ui-button-border:none] [--a2ui-row-gap:4px] [--a2ui-icon-size:14px] [--a2ui-font-size-m:12px] [--a2ui-font-size-s:12px] [&>span+span]:border-l'
const HOVER_BAR_PINNED =
  'absolute -top-3 right-3 z-10 rounded-md border bg-popover p-0.5 shadow-sm opacity-0 transition-opacity group-hover/cell:opacity-100 group-focus-within/cell:opacity-100'

export function HoverBarView({ children, buildChild }: { children?: unknown; buildChild: BuildChild }): ReactElement {
  const pinned = useContext(GridCellContext)
  return (
    <div data-slot="a2ui-hover-bar" data-pinned={pinned} className={`${HOVER_BAR_COMPACT} ${pinned ? HOVER_BAR_PINNED : ''}`}>
      {childList(children).map((child, index) => (
        <span key={childKey(child, index)} className="flex items-center px-2">{buildRef(child, buildChild)}</span>
      ))}
    </div>
  )
}

export function AddCardView({ label, action }: { label?: unknown; action?: unknown }): ReactElement {
  const tip = text(label)
  const run = typeof action === 'function' && tip ? (action as () => void) : undefined
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-slot="a2ui-add-card"
            aria-label={tip}
            disabled={!run}
            onClick={() => run?.()}
            className="flex min-h-32 w-full items-center justify-center rounded-lg border-2 border-dashed text-muted-foreground transition-colors outline-none hover:border-ring hover:bg-muted/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="size-14" fill="none" stroke="currentColor" strokeWidth={1} strokeLinejoin="round">
              <path d="M9.5 3h5v6.5H21v5h-6.5V21h-5v-6.5H3v-5h6.5z" />
            </svg>
          </button>
        </TooltipTrigger>
        {tip && <TooltipContent>{tip}</TooltipContent>}
      </Tooltip>
    </TooltipProvider>
  )
}

const views: Record<ChartComponentName, (props: Record<string, unknown>, buildChild: BuildChild) => ReactElement> = {
  PieChart: props => {
    const p = props as ChartProps
    return (
      <Suspense fallback={<ChartPlaceholder height={p.height} />}>
        <PieChartView
          title={p.title}
          data={p.data}
          donut={p.donut}
          height={p.height}
          valuePrefix={p.valuePrefix}
          valueSuffix={p.valueSuffix}
        />
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
  Grid: (props, buildChild) => <GridView children={props.children} minWidth={props.minWidth} after={props.after} buildChild={buildChild} />,
  HoverBar: (props, buildChild) => <HoverBarView children={props.children} buildChild={buildChild} />,
  AddCard: props => <AddCardView label={props.label} action={props.action} />,
}

const chartComponents: ReactCatalogComponent[] = (
  Object.keys(chartCatalogDefinitions) as ChartComponentName[]
).map(name => {
  const View = views[name]
  // Typed loosely: `zod/v3` and the renderer's own zod copy match at runtime
  // (the binder reads `_def`), and comparing their types exhausts the checker.
  const api = { name, schema: chartCatalogDefinitions[name].schema } as unknown as ComponentApi
  return createComponentImplementation(api, ({ props, buildChild }) => View(props as Record<string, unknown>, buildChild))
})

export const vellocCatalog = new Catalog<ReactCatalogComponent>(
  VELLOC_CATALOG_ID,
  'v1.0',
  [...[...basicCatalog.components.values()].map(component => (component.name === 'Tabs' ? tabsComponent : component)), ...chartComponents],
  [...basicCatalog.functions.values()],
  {
    instructions: [basicCatalog.instructions, CHART_CATALOG_INSTRUCTIONS, TABS_CATALOG_INSTRUCTIONS].filter(Boolean).join('\n\n'),
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

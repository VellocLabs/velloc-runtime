// Velloc A2UI chart catalog definitions (F-1): the props contract of the data
// components added on top of the basic catalog. No React and no chart library.
// Schemas are zod v3 (`zod/v3`) built on the protocol's common schemas, so the
// renderer's binder resolves `{path}` / `{"@path"}` bindings in them.

import { z } from 'zod/v3'
import { CommonSchemas } from '@a2ui/web_core/v1_0'

export const VELLOC_CATALOG_ID = 'https://velloc.app/a2ui/catalog/v1'

// Typed loosely: the protocol schemas' full types are too deep to infer here.
const DynamicString = CommonSchemas.DynamicString as unknown as z.ZodTypeAny
const DynamicValue = CommonSchemas.DynamicValue as unknown as z.ZodTypeAny
const series = z
  .array(
    z.object({
      key: z.string().describe('The numeric field of each row this series draws.'),
      label: z.string().optional().describe('Legend label; defaults to the key.'),
      color: z.string().optional().describe('CSS color; leave out to use the theme palette.'),
    }),
  )
  .describe('One entry per line or bar group.')
const weight = z
  .number()
  .optional()
  .describe('Flex share inside a Row or Column; only on a direct child of one.')
const title = DynamicString.optional().describe('Heading drawn above the chart.')
const height = z.number().optional().describe('Chart height in pixels; default 240.')
const rows = (what: string) => DynamicValue.describe(what)
const xKey = z.string().describe('The field of each row used as the category axis.')

export const chartCatalogDefinitions = {
  PieChart: {
    description: 'Pie or donut chart of labelled values: data is [{label, value, color?}].',
    schema: z
      .object({
        title,
        data: rows('Slices: [{label, value, color?}], literal or a data binding.'),
        donut: z.boolean().optional().describe('Draw as a ring instead of a full pie.'),
        height,
        weight,
      })
      .strict()
      .describe('Pie or donut chart of labelled values: data is [{label, value, color?}].'),
  },
  LineChart: {
    description: 'Line chart: one line per series over rows keyed by xKey.',
    schema: z
      .object({
        title,
        data: rows('Row objects, literal or a data binding, e.g. [{month: "Jan", sales: 120}].'),
        xKey,
        series,
        curved: z.boolean().optional().describe('Smooth the lines.'),
        height,
        weight,
      })
      .strict()
      .describe('Line chart: one line per series over rows keyed by xKey.'),
  },
  BarChart: {
    description: 'Bar chart: one bar per series for each row keyed by xKey.',
    schema: z
      .object({
        title,
        data: rows('Row objects, literal or a data binding, e.g. [{month: "Jan", sales: 120}].'),
        xKey,
        series,
        stacked: z.boolean().optional().describe('Stack the series in one bar per row.'),
        height,
        weight,
      })
      .strict()
      .describe('Bar chart: one bar per series for each row keyed by xKey.'),
  },
  Metric: {
    description: 'A key figure with a label and an optional change.',
    schema: z
      .object({
        label: DynamicString.describe('What the figure measures.'),
        value: DynamicValue.describe('The figure, already formatted (e.g. "$980K").'),
        delta: DynamicString.optional().describe('Change versus the previous period, e.g. "+12%".'),
        trend: z.enum(['up', 'down', 'flat']).optional().describe('Direction of the change; colours the delta.'),
        caption: DynamicString.optional().describe('A short note under the figure.'),
        weight,
      })
      .strict()
      .describe('A key figure with a label and an optional change.'),
  },
  DataTable: {
    description: 'A table of rows with named columns.',
    schema: z
      .object({
        columns: z
          .array(z.object({ key: z.string(), label: z.string() }))
          .describe('Columns in order: key names the row field, label the header.'),
        rows: rows('Row objects keyed by the column keys, literal or a data binding.'),
        weight,
      })
      .strict()
      .describe('A table of rows with named columns.'),
  },
}

const CHART_EXAMPLE = [
  {
    version: '1.0',
    createSurface: {
      surfaceId: 'sales',
      catalogId: VELLOC_CATALOG_ID,
      components: [
        { id: 'root', component: 'Column', children: ['total', 'charts'] },
        { id: 'total', component: 'Metric', label: 'Revenue', value: { '@path': '/total' }, delta: '+12%', trend: 'up' },
        { id: 'charts', component: 'Row', children: ['shareCard', 'trendCard'] },
        { id: 'shareCard', component: 'Card', child: 'share', weight: 1 },
        { id: 'share', component: 'PieChart', title: 'By region', data: { '@path': '/regions' }, donut: true },
        { id: 'trendCard', component: 'Card', child: 'trend', weight: 1 },
        {
          id: 'trend',
          component: 'LineChart',
          title: 'Monthly',
          data: { '@path': '/months' },
          xKey: 'month',
          series: [{ key: 'sales', label: 'Sales' }],
        },
      ],
      dataModel: {
        total: '$980K',
        regions: [
          { label: 'North', value: 45 },
          { label: 'South', value: 30 },
        ],
        months: [
          { month: 'Jan', sales: 120 },
          { month: 'Feb', sales: 150 },
        ],
      },
    },
  },
]

/** Usage guidance for the chart components, appended to the catalog's instructions. */
export const CHART_CATALOG_INSTRUCTIONS = [
  '## Charts and data',
  '',
  'Draw numbers as charts, not prose: PieChart for shares, LineChart for a trend over time, ' +
    'BarChart to compare categories, Metric for one key figure, DataTable for rows. Put the rows ' +
    'in the data model and bind them, so a later update can change the data alone. Group charts ' +
    'in Cards inside a Row or Column for a dashboard. Leave colors out to use the theme palette.',
  '',
  'Example 3: Sales dashboard',
  '```json',
  JSON.stringify(CHART_EXAMPLE, null, 2),
  '```',
].join('\n')

export type ChartComponentName = keyof typeof chartCatalogDefinitions

const DEFAULT_CHART_HEIGHT = 240
const MIN_CHART_HEIGHT = 120
const MAX_CHART_HEIGHT = 800

/** A model-supplied height, clamped so a chart never collapses or outgrows the pane. */
export function chartHeight(height: unknown): number {
  if (typeof height !== 'number' || !Number.isFinite(height)) return DEFAULT_CHART_HEIGHT
  return Math.min(MAX_CHART_HEIGHT, Math.max(MIN_CHART_HEIGHT, Math.round(height)))
}

/** Bound values arrive resolved; anything else (still a binding, missing) is no rows. */
export function asRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
    : []
}

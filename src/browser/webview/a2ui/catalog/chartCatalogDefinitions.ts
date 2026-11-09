// Velloc A2UI chart catalog definitions (F-1): the props contract of the data
// and dashboard components added on top of the basic catalog. No React and no
// chart library.
// Schemas are zod v3 (`zod/v3`) built on the protocol's common schemas, so the
// renderer's binder resolves `{path}` / `{"@path"}` bindings in them.

import { z } from 'zod/v3'
import { CommonSchemas } from '@a2ui/web_core/v1_0'

export const VELLOC_CATALOG_ID = 'https://velloc.app/a2ui/catalog/v1'

// Typed loosely: the protocol schemas' full types are too deep to infer here.
const DynamicString = CommonSchemas.DynamicString as unknown as z.ZodTypeAny
const DynamicValue = CommonSchemas.DynamicValue as unknown as z.ZodTypeAny
const Action = CommonSchemas.Action as unknown as z.ZodTypeAny
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
const valuePrefix = z.string().optional().describe('Text before each value on the value axis and in the tooltip, e.g. "$".')
const valueSuffix = z.string().optional().describe('Text after each value on the value axis and in the tooltip, e.g. "K".')

/** A badge's colour, named by meaning so it follows the theme. */
export const BADGE_TONES = ['neutral', 'info', 'success', 'warning', 'danger'] as const
export type BadgeTone = (typeof BADGE_TONES)[number]

export const chartCatalogDefinitions = {
  PieChart: {
    description: 'Pie or donut chart of labelled values: data is [{label, value, color?}]. The legend, a column beside the pie, lists the slices in data order, each with its value.',
    schema: z
      .object({
        title,
        data: rows('Slices: [{label, value, color?}], literal or a data binding.'),
        donut: z.boolean().optional().describe('Draw as a ring instead of a full pie.'),
        height,
        valuePrefix: z.string().optional().describe('Text before each value in the legend and the tooltip, e.g. "$".'),
        valueSuffix: z.string().optional().describe('Text after each value in the legend and the tooltip, e.g. "%".'),
        weight,
      })
      .strict()
      .describe('Pie or donut chart of labelled values: data is [{label, value, color?}]. The legend, a column beside the pie, lists the slices in data order, each with its value.'),
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
        valuePrefix,
        valueSuffix,
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
        valuePrefix,
        valueSuffix,
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
        trend: DynamicString.optional().describe(
          'Direction of the change, "up", "down" or "flat" ("neutral" reads as "flat"), literal or a data binding; colours the delta.',
        ),
        caption: DynamicString.optional().describe('A short note under the figure.'),
        better: DynamicString.optional().describe(
          'Which direction is good, "up" (default) or "down", literal or a data binding. With "down" a rise is coloured as bad and a fall as good, e.g. for a refund rate; the arrow still follows trend.',
        ),
        action: Action.optional().describe(
          'REF:#/$defs/Action|Optional, unlike a Button\'s action: leave it out when there is nothing to ask. With actionLabel, a small help button after the delta sends this action when clicked, as a Button press does, e.g. Event("explain_metric", {metric: "Refund rate"}).',
        ),
        actionLabel: DynamicString.optional().describe(
          'The help button\'s label, e.g. "Ask why", literal or a data binding; it shows while the pointer is over the figure. Without it there is no button.',
        ),
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
          .array(
            z.object({
              key: z.string().describe('The row field this column shows.'),
              label: z.string().describe('The header.'),
              align: z.enum(['start', 'end']).optional().describe('"end" right-aligns the column, e.g. for amounts.'),
              badge: z
                .record(z.string(), z.string())
                .optional()
                .describe('Draw each cell as a badge, toned by its value, e.g. {Paid: "success", Failed: "danger"}; other values are neutral.'),
            }),
          )
          .describe('Columns in order: key names the row field, label the header.'),
        rows: rows('Row objects keyed by the column keys, literal or a data binding.'),
        weight,
      })
      .strict()
      .describe('A table of rows with named columns.'),
  },
  Heading: {
    description: 'A title: level 1 for the page, 2 for a section, 3 for a card.',
    schema: z
      .object({
        text: DynamicString.describe('The title text, literal or a data binding.'),
        level: z.number().int().min(1).max(3).optional().describe('1, 2 or 3; default 2.'),
        subtitle: DynamicString.optional().describe('A short line under the title in small muted text.'),
        weight,
      })
      .strict()
      .describe('A title: level 1 for the page, 2 for a section, 3 for a card.'),
  },
  Badge: {
    description: 'A short status label in a coloured pill.',
    schema: z
      .object({
        text: DynamicString.describe('The label, literal or a data binding.'),
        tone: DynamicString.optional().describe(
          `Its colour by meaning: ${BADGE_TONES.map(name => `"${name}"`).join(', ')}; literal or a data binding; default "neutral".`,
        ),
        weight,
      })
      .strict()
      .describe('A short status label in a coloured pill.'),
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
  'Title a dashboard with Heading (level 1 for the page, 3 for a card); its subtitle is the small line under it. Show a status with Badge, ' +
    'or give a DataTable column a badge map so each cell is one. Put units on a chart\'s value axis ' +
    'with valuePrefix / valueSuffix rather than in the numbers.',
  '',
  'Give a Metric better: "down" when a rise is bad (refund rate, churn, latency), so its delta is coloured by meaning. ' +
    'To let the user ask about a change where it is shown, give the Metric an action and an actionLabel, e.g. ' +
    'action=Event("explain_metric", {metric: "Refund rate"}), actionLabel="Ask why"; the action comes back to you like a Button press. A Metric\'s action is optional: ' +
    'leave both out on a plain figure, and never give it a placeholder Event("click").',
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

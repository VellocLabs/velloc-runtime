// Velloc A2UI chart catalog definitions (F-1): the props contract of the data
// components added on top of the basic catalog. No React and no chart library.
// The renderer's binder recognises bindings by zod v3 shape, hence `zod/v3`.

import { z } from 'zod/v3'

export const VELLOC_CATALOG_ID = 'https://velloc.app/a2ui/catalog/v1'

const binding = z.object({ path: z.string() })
const dynamicString = z.union([z.string(), binding])
const dynamicScalar = z.union([z.string(), z.number(), binding])
const rows = z.union([z.array(z.record(z.unknown())), binding])
const series = z.array(
  z.object({ key: z.string(), label: z.string().optional(), color: z.string().optional() }),
)

export const chartCatalogDefinitions = {
  PieChart: {
    description: 'Pie or donut chart of labelled values.',
    props: z.object({
      title: dynamicString.optional(),
      data: z.union([
        z.array(
          z.object({ label: z.string(), value: z.number(), color: z.string().optional() }),
        ),
        binding,
      ]),
      donut: z.boolean().optional(),
      height: z.number().optional(),
    }),
  },
  LineChart: {
    description: 'Line chart: one line per series over rows keyed by xKey.',
    props: z.object({
      title: dynamicString.optional(),
      data: rows,
      xKey: z.string(),
      series,
      curved: z.boolean().optional(),
      height: z.number().optional(),
    }),
  },
  BarChart: {
    description: 'Bar chart: one bar per series for each row keyed by xKey.',
    props: z.object({
      title: dynamicString.optional(),
      data: rows,
      xKey: z.string(),
      series,
      stacked: z.boolean().optional(),
      height: z.number().optional(),
    }),
  },
  Metric: {
    description: 'A key figure with a label and an optional change.',
    props: z.object({
      label: dynamicString,
      value: dynamicScalar,
      delta: dynamicString.optional(),
      trend: z.enum(['up', 'down', 'flat']).optional(),
      caption: dynamicString.optional(),
    }),
  },
  DataTable: {
    description: 'A table of rows with named columns.',
    props: z.object({
      columns: z.array(z.object({ key: z.string(), label: z.string() })),
      rows,
    }),
  },
}

export type ChartCatalogDefinitions = typeof chartCatalogDefinitions
export type PropsOfChart<K extends keyof ChartCatalogDefinitions> = z.infer<
  ChartCatalogDefinitions[K]['props']
>

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

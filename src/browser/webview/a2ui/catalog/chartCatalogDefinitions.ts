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
const series = z.array(
  z.object({ key: z.string(), label: z.string().optional(), color: z.string().optional() }),
)
const weight = z.number().optional()

export const chartCatalogDefinitions = {
  PieChart: {
    description: 'Pie or donut chart of labelled values: data is [{label, value, color?}].',
    schema: z
      .object({
        title: DynamicString.optional(),
        data: DynamicValue,
        donut: z.boolean().optional(),
        height: z.number().optional(),
        weight,
      })
      .strict(),
  },
  LineChart: {
    description: 'Line chart: one line per series over rows keyed by xKey.',
    schema: z
      .object({
        title: DynamicString.optional(),
        data: DynamicValue,
        xKey: z.string(),
        series,
        curved: z.boolean().optional(),
        height: z.number().optional(),
        weight,
      })
      .strict(),
  },
  BarChart: {
    description: 'Bar chart: one bar per series for each row keyed by xKey.',
    schema: z
      .object({
        title: DynamicString.optional(),
        data: DynamicValue,
        xKey: z.string(),
        series,
        stacked: z.boolean().optional(),
        height: z.number().optional(),
        weight,
      })
      .strict(),
  },
  Metric: {
    description: 'A key figure with a label and an optional change.',
    schema: z
      .object({
        label: DynamicString,
        value: DynamicValue,
        delta: DynamicString.optional(),
        trend: z.enum(['up', 'down', 'flat']).optional(),
        caption: DynamicString.optional(),
        weight,
      })
      .strict(),
  },
  DataTable: {
    description: 'A table of rows with named columns.',
    schema: z
      .object({
        columns: z.array(z.object({ key: z.string(), label: z.string() })),
        rows: DynamicValue,
        weight,
      })
      .strict(),
  },
}

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

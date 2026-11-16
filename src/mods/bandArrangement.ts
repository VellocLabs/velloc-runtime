/**
 * `ui.render` for `AbovePromptList` (F-25): the band above the prompt once its
 * rows settled, one row per plugin that drew. A hook hides or reorders the rows
 * it hands `next`, or wraps what `next` drew. Pure shapes and checks; the chain
 * runs in the extension runtime.
 */

import type { AbovePromptRenderProps, RenderElement, RenderSection } from './modRender'

export const BAND_LIST_COMPONENT = 'AbovePromptList'

/** `RenderPropsOf['AbovePromptList']`: the band's props, and its rows. */
export type AbovePromptListRenderProps = AbovePromptRenderProps & {
  rows: readonly RenderSection[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a hook hears `AbovePromptList`: one naming it, or a bare `*` hook;
 *  a `ui.render` hook naming no component does not. */
export function hearsBandList(link: { pattern: string; matcher?: unknown }): boolean {
  if (link.pattern === '*') return true
  return isRecord(link.matcher) && link.matcher.component === BAND_LIST_COMPONENT
}

/** The rows of a settled band: its sections, or the whole tree as the one
 *  plugin's row. */
export function bandRowsOf(tree: RenderElement, sections: readonly RenderSection[] | undefined, plugin: string | undefined): RenderSection[] {
  if (sections && sections.length > 0) return sections.map(section => ({ plugin: section.plugin, tree: section.tree }))
  return plugin === undefined ? [] : [{ plugin, tree }]
}

/** What core draws of `rows`: one under the other. */
export function stackRows(rows: readonly RenderSection[]): RenderElement {
  return { type: 'Box', props: { flexDirection: 'column' }, children: rows.map(row => row.tree) }
}

function rowKey(row: unknown): string | undefined {
  if (!isRecord(row) || typeof row.plugin !== 'string' || !isRecord(row.tree)) return undefined
  try {
    return JSON.stringify({ plugin: row.plugin, tree: row.tree })
  } catch {
    return undefined
  }
}

/**
 * The rows a rewrite hands `next`: only rows it was handed, by value, each no
 * more often than it came, in any order; every other prop as received.
 * Returns the reason it is refused, or null.
 */
export function bandListPropsProblem(handed: AbovePromptListRenderProps, arrived: unknown): string | null {
  if (!isRecord(arrived)) return 'props is not an object'
  if (!Array.isArray(arrived.rows)) return 'rows is not an array'
  const { rows: _handedRows, ...readOnly } = handed
  const { rows: _arrivedRows, ...arrivedReadOnly } = arrived
  if (JSON.stringify(readOnly) !== JSON.stringify(arrivedReadOnly)) return 'only rows may change'
  const left = new Map<string, number>()
  for (const row of handed.rows) {
    const key = rowKey(row)!
    left.set(key, (left.get(key) ?? 0) + 1)
  }
  for (const row of arrived.rows) {
    const key = rowKey(row)
    const count = key === undefined ? 0 : (left.get(key) ?? 0)
    if (count === 0) return 'a row is not one it was handed, or is repeated'
    left.set(key!, count - 1)
  }
  return null
}

/** Whether `tree` is exactly what core stacked of `rows`. */
export function isStackOf(tree: unknown, rows: readonly RenderSection[]): boolean {
  return JSON.stringify(tree) === JSON.stringify(stackRows(rows))
}

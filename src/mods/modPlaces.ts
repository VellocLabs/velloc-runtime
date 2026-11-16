/**
 * `$.ui.place({ id })` (F-25): one row at the transcript's end, drawn by what
 * `ui.render` answers for `{ component: 'Placed' }`. Display only: no model
 * request and no stored row carries it. Raised as the op event `ui.place`, its
 * `id` pinned: a hook above may answer it or `{ deny }` it. A row stands until its
 * plugin unloads; placing an id that stands hands back the same row.
 */

import { isPaneId } from './modRender'

/** `$.ui.place`'s argument and the event's `e`. */
export type UiPlaceArgs = { id: string }

/** What `$.ui.place` resolves to — `UiPlaceResult`. */
export type UiPlaceResult =
  | { isPlaced: true; requestId: string }
  | { isPlaced: false; requestId?: string; reason: string }

/** One placed row as the page draws it, in the order the rows were placed. */
export type ModPlacedRow = { plugin: string; id: string; requestId: string }

/** `RenderPropsOf['Placed']`: the row's id among its plugin's, and that plugin. */
export type PlacedRenderProps = { id: string; plugin: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function uiPlaceArgsOf(value: unknown): UiPlaceArgs {
  if (!isRecord(value) || !isPaneId(value.id)) {
    throw new TypeError('$.ui.place({ id }): id must be 1-64 of letters, digits, _ and -')
  }
  return { id: value.id }
}

/** Whether a hook's answer is one `ui.place` takes. */
export function isUiPlaceResult(value: unknown): value is UiPlaceResult {
  if (!isRecord(value)) return false
  if (value.isPlaced === true) return typeof value.requestId === 'string' && value.requestId !== ''
  return (
    value.isPlaced === false &&
    typeof value.reason === 'string' &&
    (value.requestId === undefined || (typeof value.requestId === 'string' && value.requestId !== ''))
  )
}

/** The `requestId` of `plugin`'s row `id`: its `ui.render` instance, and what
 *  `$.ui.scroll` takes. */
export function placedRequestIdOf(plugin: string, id: string): string {
  return `placed:${plugin}:${id}`
}

/** The session's placed rows; `changed` runs after each change. */
export class ModPlaceRegistry {
  private readonly rows: ModPlacedRow[] = []

  constructor(private readonly changed: () => void) {}

  /** `plugin`'s row `id`: placed at the end, or the one that stands. */
  place(plugin: string, id: string): ModPlacedRow {
    const standing = this.rows.find(row => row.plugin === plugin && row.id === id)
    if (standing) return standing
    const row = { plugin, id, requestId: placedRequestIdOf(plugin, id) }
    this.rows.push(row)
    this.changed()
    return row
  }

  list(): ModPlacedRow[] {
    return this.rows.map(row => ({ ...row }))
  }

  /** `plugin` unloaded: its rows go. Their request ids. */
  clearPlugin(plugin: string): string[] {
    const gone: string[] = []
    for (let index = this.rows.length - 1; index >= 0; index -= 1) {
      if (this.rows[index]!.plugin !== plugin) continue
      gone.push(this.rows[index]!.requestId)
      this.rows.splice(index, 1)
    }
    if (gone.length > 0) this.changed()
    return gone
  }
}

/** Core of `ui.place`: the row stands; it is drawn where a page draws the
 *  session, and waits for one otherwise. */
export function uiPlaceCore(registry: ModPlaceRegistry, plugin: string, id: string, drawn: boolean): UiPlaceResult {
  const row = registry.place(plugin, id)
  return drawn
    ? { isPlaced: true, requestId: row.requestId }
    : { isPlaced: false, requestId: row.requestId, reason: 'no page draws this session' }
}

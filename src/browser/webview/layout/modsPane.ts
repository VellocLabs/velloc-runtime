/**
 * The Plugins pane (F-25, F-9): the panes a session's mods open, as tabs of
 * one side pane in the session's layout. Pure decisions: which opens are new
 * since the last fold, whether they bring the pane into the layout, where a
 * pane not in view still places a mod's own open (`mods.seat` `places`), the
 * width an open's `columns` asks for, and the panes the person asked for.
 */

export type ModsPaneRow = {
  plugin: string
  id: string
  asked?: boolean
  focus?: boolean
  openSeq?: number
  columns?: number
}

/** Cells across the session area (beside the sidebar) from which panes dock
 *  beside the transcript; below, they draw inline above the prompt. */
export const DOCK_FLOOR_CELLS = 110
/** Cells across from which a mod's own open is placed. */
export const UNASKED_FLOOR_CELLS = 144
/** The floor for a pane the person asked for before and has not closed by hand. */
export const REMEMBERED_FLOOR_CELLS = 110
/** Remembered asked panes, the oldest dropped past it. */
export const ASKED_MEMORY_CAP = 200

export function modPaneKey(pane: { plugin: string; id: string }): string {
  return `${pane.plugin}\u0000${pane.id}`
}

export function modPaneOfKey(key: string): { plugin: string; id: string } | null {
  const at = key.indexOf('\u0000')
  if (at <= 0 || at === key.length - 1) return null
  return { plugin: key.slice(0, at), id: key.slice(at + 1) }
}

/**
 * The opens since the last fold: each pane whose `openSeq` moved past what
 * `seen` holds for it. At a session's first fold (`seen` undefined) every
 * pane counts as opened.
 */
export function newModPaneOpens(
  panes: readonly ModsPaneRow[],
  seen: ReadonlyMap<string, number> | undefined,
): { opens: ModsPaneRow[]; seen: Map<string, number> } {
  const next = new Map(panes.map(pane => [modPaneKey(pane), pane.openSeq ?? 0]))
  const opens = panes.filter(pane => {
    if (seen === undefined) return true
    const before = seen.get(modPaneKey(pane))
    return before === undefined || (pane.openSeq ?? 0) > before
  })
  return { opens, seen: next }
}

/**
 * Which of a mod's own opens a session's Plugins pane places while it is not
 * in the layout: `all` from `UNASKED_FLOOR_CELLS` across, the remembered ones
 * from `REMEMBERED_FLOOR_CELLS`, none below or once the person closed the
 * pane in this session (`dismissed`, until an asked open brings it back).
 */
export type ModsPanePlaces = 'all' | 'remembered' | 'none'

export function modsPanePlaces(env: { columns: number; dismissed: boolean }): ModsPanePlaces {
  if (env.dismissed) return 'none'
  if (env.columns >= UNASKED_FLOOR_CELLS) return 'all'
  if (env.columns >= REMEMBERED_FLOOR_CELLS) return 'remembered'
  return 'none'
}

/**
 * Whether these opens bring the Plugins pane into the layout: an asked or
 * `focus` open always does; a mod's own open where `places` admits it.
 */
export function opensBringModsPane(
  opens: readonly ModsPaneRow[],
  places: ModsPanePlaces,
  remembered: ReadonlySet<string>,
): boolean {
  return opens.some(
    open =>
      open.asked === true ||
      open.focus === true ||
      places === 'all' ||
      (places === 'remembered' && remembered.has(modPaneKey(open))),
  )
}

/** The asked memory with these opens' asked panes added (most recent last). */
export function rememberAskedPanes(memory: readonly string[], opens: readonly ModsPaneRow[]): readonly string[] {
  const asked = opens.filter(open => open.asked === true).map(modPaneKey)
  if (asked.length === 0) return memory
  const next = memory.filter(key => !asked.includes(key))
  next.push(...asked)
  return next.length > ASKED_MEMORY_CAP ? next.slice(next.length - ASKED_MEMORY_CAP) : next
}

/** The asked memory without a pane the person closed by hand. */
export function forgetAskedPane(memory: readonly string[], pane: { plugin: string; id: string }): readonly string[] {
  const key = modPaneKey(pane)
  return memory.includes(key) ? memory.filter(each => each !== key) : memory
}

/**
 * The weight (beside the chat's `chatWeight`) at which the pane is
 * `columns` cells wide in a row `rowWidth` px wide: the body's cells plus
 * `chromeWidth` (the frame and the body's insets). Null when nothing asks a
 * width or it would not leave the chat any room.
 */
export function modsPaneWeight(env: {
  columns: number | undefined
  cellWidth: number
  chromeWidth: number
  rowWidth: number
  chatWeight: number
}): number | null {
  if (env.columns === undefined || !(env.columns > 0) || !(env.cellWidth > 0)) return null
  const pane = env.columns * env.cellWidth + env.chromeWidth
  const chat = env.rowWidth - pane
  if (!(chat > 0)) return null
  return (env.chatWeight * pane) / chat
}

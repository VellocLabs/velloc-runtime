/**
 * Mods' docked panes in the session card stack (F-25): each open pane is a
 * card after the information cards, and at most one is open in front — the
 * pane this window shows (`mods.seat` `showing`). A new `openSeq` asked by the
 * PERSON or opened with `focus` comes to the front; a mod's other opens only
 * add their card. At a session's first fold only a `focus` open comes forward
 * (the runtime keeps `focus` and `asked` set until a window shows the pane).
 */

export type ModDockPane = { plugin: string; id: string; asked?: boolean; focus?: boolean; openSeq?: number }
export type ModDockFront = { plugin: string; id: string }

export function modDockKey(pane: ModDockFront): string {
  return `${pane.plugin}\u0000${pane.id}`
}

export function sameModDockFront(a: ModDockFront | null, b: ModDockFront | null): boolean {
  if (a === null || b === null) return a === b
  return a.plugin === b.plugin && a.id === b.id
}

export function foldModDock(params: {
  front: ModDockFront | null
  panes: readonly ModDockPane[]
  /** Each pane folded last time for this session, with the `openSeq` it
   *  had; undefined when the session has not been folded yet. */
  seen: ReadonlyMap<string, number> | undefined
}): { front: ModDockFront | null; seen: Map<string, number> } {
  const seen = new Map(params.panes.map(pane => [modDockKey(pane), pane.openSeq ?? 0]))
  let front =
    params.front && seen.has(modDockKey(params.front)) ? params.front : null
  let latest = 0
  for (const pane of params.panes) {
    const openSeq = pane.openSeq ?? 0
    const isBroughtForward =
      params.seen === undefined
        ? pane.focus === true
        : (pane.asked === true || pane.focus === true) && openSeq > (params.seen.get(modDockKey(pane)) ?? 0)
    if (isBroughtForward && openSeq >= latest) {
      latest = openSeq
      front = { plugin: pane.plugin, id: pane.id }
    }
  }
  return { front, seen }
}

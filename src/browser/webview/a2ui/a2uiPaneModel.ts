// A2UI side pane model (F-1): which surfaces the pane shows as tabs, which one
// is selected, and when the pane opens or closes. Pure; no React.

export type A2uiPaneInput = {
  /** Live surfaces' latest mention keys, in first-creation order. */
  latestMentionBySurface: ReadonlyMap<string, string>
  /**
   * An app's first surface (F-40): shown when nothing is selected, and when a
   * build changes it while the person is on none of the surfaces it changed.
   */
  preferred?: string
}

export type A2uiPaneState = {
  selected: string | null
  /** Surfaces open when the person closed the pane: their updates stay quiet. */
  dismissed: ReadonlySet<string>
  seen: ReadonlyMap<string, string>
}

export type A2uiPaneStep = {
  state: A2uiPaneState
  /** true: open the pane; false: close it; null: leave it. */
  open: boolean | null
}

export const EMPTY_A2UI_PANE_STATE: A2uiPaneState = {
  selected: null,
  dismissed: new Set(),
  seen: new Map(),
}

/** Tab order: the order the surfaces were first created in. */
export function paneSurfaceOrder(input: A2uiPaneInput): string[] {
  return [...input.latestMentionBySurface.keys()]
}

/**
 * Folds a new transcript derivation into the pane state. `live` is false for
 * a replay (a session loaded from disk): nothing opens then.
 */
export function stepA2uiPane(
  prev: A2uiPaneState,
  input: A2uiPaneInput,
  live: boolean,
): A2uiPaneStep {
  const order = paneSurfaceOrder(input)
  const dismissed = new Set([...prev.dismissed].filter(id => input.latestMentionBySurface.has(id)))
  let selected = prev.selected
  let open: boolean | null = null
  const changed: string[] = []
  for (const id of order) {
    const toolCallId = input.latestMentionBySurface.get(id)
    const before = prev.seen.get(id)
    if (before === toolCallId) continue
    // A surface the pane has not seen yet is new: it is shown even after a close.
    if (before === undefined) dismissed.delete(id)
    if (!dismissed.has(id)) changed.push(id)
  }
  const lastChanged = changed.at(-1)
  if (live && lastChanged) {
    const built = input.preferred !== undefined && changed.includes(input.preferred)
    selected = !built ? lastChanged : prev.selected !== null && changed.includes(prev.selected) ? prev.selected : input.preferred!
    open = true
  }
  if (selected === null || !input.latestMentionBySurface.has(selected)) {
    selected =
      input.preferred !== undefined && input.latestMentionBySurface.has(input.preferred)
        ? input.preferred
        : (order.at(-1) ?? null)
  }
  if (order.length === 0 && prev.seen.size > 0) open = false
  const unchanged =
    selected === prev.selected &&
    sameSet(dismissed, prev.dismissed) &&
    sameMap(input.latestMentionBySurface, prev.seen)
  return {
    state: unchanged
      ? prev
      : { selected, dismissed, seen: new Map(input.latestMentionBySurface) },
    open,
  }
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}

function sameMap(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false
  for (const [id, value] of a) if (b.get(id) !== value) return false
  return true
}

/** The person closed the pane: the surfaces now shown stop reopening it. */
export function dismissA2uiPane(prev: A2uiPaneState): A2uiPaneState {
  return { ...prev, dismissed: new Set(prev.seen.keys()) }
}

export function selectA2uiSurface(prev: A2uiPaneState, surfaceId: string): A2uiPaneState {
  if (!prev.seen.has(surfaceId)) return prev
  const dismissed = new Set(prev.dismissed)
  dismissed.delete(surfaceId)
  return { ...prev, selected: surfaceId, dismissed }
}

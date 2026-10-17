/**
 * The panes a slot's plugins opened (F-25): one per (plugin, id), in open order.
 * `isPlaced` and `isShown` come from the seats clients report (`mods.seat`); with no
 * seat ever reported, all are placed. An asked or focused open is published state
 * the client acts on, not a call into it.
 */

export type ModPaneOpenArgs = {
  id: string
  title?: string
  focus?: true
  closeOnEscape?: true
  holdToasts?: true
  rows?: number
  columns?: number
}

/** `$.ui.open`'s answer (the contract's `UiOpenResult`). */
export type ModPaneOpenResult = { isPlaced: true } | { isPlaced: false; reason: string }

export type ModPane = {
  plugin: string
  id: string
  title: string
  /** True for the pane in front of the roster; the rest are tabs. Where a
   *  client sees it is the seats' ({@link ModPaneRegistry.listFor}). */
  isShown: boolean
  /** "True while the person has given it the keyboard." Velloc's client
   *  reports no keyboard ownership yet: always false. */
  isFocused: boolean
  isPlaced: boolean
  closeOnEscape: boolean
  holdToasts: boolean
  /** Whether an open of the person's (a command, a prompt, a press) is
   *  still to be shown: a docked client answers it by showing the pane. Set
   *  until a seat shows the pane, so a later unasked open keeps it. */
  asked: boolean
  /** Whether an open with `focus` is still to be shown, which a docked
   *  client answers as it does an asked one. Set until a seat shows the
   *  pane. */
  focus: boolean
  /** Its latest open's place in the slot's opens, from 1. */
  openSeq: number
  rows?: number
  columns?: number
}

export type ModPaneCloseOrigin = 'plugin' | 'person' | 'unload'

/** Where one client draws a session's panes (`mods.seat`). `dock-visible`
 *  names the pane whose tab is active, absent when another tab is. */
export type ModPaneSeat =
  | { kind: 'inline' }
  | { kind: 'dock-visible'; showing?: { plugin: string; id: string } }
  | { kind: 'dock-hidden' }

/** Why an unasked open waits: no window showing the session has its panes
 *  in view; it is seated when one that does attaches. */
export const PANE_WAITS_REASON =
  'no window showing this session has its panes in view; the pane is placed when one does'

/** Why a `focus` open waits: no window shows the session. */
export const FOCUS_PANE_WAITS_REASON = 'no window shows this session; the pane is placed when one does'

/** A pane's identity across plugins: two plugins may each open `clock`. */
export function paneKeyOf(plugin: string, id: string): string {
  return `${plugin}\u0000${id}`
}

export class ModPaneRegistry {
  private readonly panes = new Map<string, ModPane>()
  private shown: string | undefined
  /** The panes opened with `focus`: "a pane opened with `focus` … takes the
   *  keys", so `$.ui.focus` may move its ring (`modPage.ts`). */
  private readonly keyed = new Set<string>()
  /** Each client's seat, by its connection id. */
  private readonly seats = new Map<string, ModPaneSeat>()
  /** Whether any client ever reported a seat: until one does, every pane is
   *  placed and the front one shown (a headless run, a test). */
  private seatsKnown = false
  private opens = 0

  constructor(private readonly onChanged: () => void = () => {}) {}

  list(): ModPane[] {
    return [...this.panes.values()]
  }

  /** "Lists this plugin's own open panes … in open order, placed ones
   *  first" — `isShown` as the seats see it. Copies. */
  listFor(plugin: string): ModPane[] {
    const own = this.list().filter(pane => pane.plugin === plugin)
    return [...own.filter(pane => pane.isPlaced), ...own.filter(pane => !pane.isPlaced)].map(pane => ({
      ...pane,
      isShown: this.isSeen(pane),
    }))
  }

  get(plugin: string, id: string): ModPane | undefined {
    return this.panes.get(paneKeyOf(plugin, id))
  }

  /** `$.ui.open`: a new pane, in front; an open id retitled in place, and
   *  brought to the front when `focus` asks for it or the person did.
   *  `asked`: the person's command, prompt or press is behind it. */
  open(plugin: string, args: ModPaneOpenArgs, asked = false): ModPaneOpenResult {
    const key = paneKeyOf(plugin, args.id)
    const title = typeof args.title === 'string' && args.title !== '' ? args.title : args.id
    const held = this.panes.get(key)
    const placeable = asked || this.placesUnasked() || (args.focus === true && this.placesFocused())
    this.opens += 1
    if (args.focus) this.keyed.add(key)
    if (held) {
      held.title = title
      held.closeOnEscape = args.closeOnEscape === true
      held.holdToasts = args.holdToasts === true
      held.isPlaced ||= placeable
      held.asked ||= asked
      held.focus ||= args.focus === true
      held.openSeq = this.opens
      if (args.rows !== undefined) held.rows = args.rows
      if (args.columns !== undefined) held.columns = args.columns
      if (args.focus || asked) this.show(key)
    } else {
      this.panes.set(key, {
        plugin,
        id: args.id,
        title,
        isShown: false,
        isFocused: false,
        isPlaced: placeable,
        closeOnEscape: args.closeOnEscape === true,
        holdToasts: args.holdToasts === true,
        asked,
        focus: args.focus === true,
        openSeq: this.opens,
        ...(args.rows !== undefined ? { rows: args.rows } : {}),
        ...(args.columns !== undefined ? { columns: args.columns } : {}),
      })
      // A new pane is the one in front — what the person asked for, or what
      // a plugin just put up.
      this.show(key)
    }
    this.settleShown()
    this.onChanged()
    // A `focus` open is placed only while a window shows the session, a pane
    // placed earlier included.
    if (args.focus === true && !placeable) return { isPlaced: false, reason: FOCUS_PANE_WAITS_REASON }
    return this.panes.get(key)!.isPlaced ? { isPlaced: true } : { isPlaced: false, reason: PANE_WAITS_REASON }
  }

  /** Removes the pane; true when one was there. The event around it
   *  (`ui.close`) is the runtime's. */
  close(plugin: string, id: string): boolean {
    const key = paneKeyOf(plugin, id)
    if (!this.panes.delete(key)) return false
    this.keyed.delete(key)
    if (this.shown === key) {
      this.shown = undefined
      const last = [...this.panes.keys()].pop()
      if (last !== undefined) this.show(last)
    }
    this.onChanged()
    return true
  }

  /** The person clicked a tab: that pane is in front. */
  showPane(plugin: string, id: string): boolean {
    const key = paneKeyOf(plugin, id)
    if (!this.panes.has(key) || this.shown === key) return false
    this.show(key)
    this.onChanged()
    return true
  }

  /** A client's seat for this session (`mods.seat`); null when it no longer
   *  draws the session (it left, or shows another one). A seat that places
   *  panes places every waiting one; a seat whose panes are out of view
   *  places the waiting `focus` ones. */
  setSeat(client: string, seat: ModPaneSeat | null): void {
    if (seat) {
      this.seats.set(client, seat)
      this.seatsKnown = true
    } else {
      this.seats.delete(client)
    }
    const unasked = this.placesUnasked()
    const focused = this.placesFocused()
    let placed = false
    for (const pane of this.panes.values()) {
      if (pane.isPlaced || !(unasked || (pane.focus && focused))) continue
      pane.isPlaced = true
      placed = true
    }
    if (this.settleShown() || placed) this.onChanged()
  }

  /** The plugin is gone (unloaded, its worker lost): its panes with it —
   *  "`unload` drops a pane nothing draws any more … it is gone before the
   *  hooks hear of it". Returns the ids dropped. */
  clearPlugin(plugin: string): string[] {
    const dropped: string[] = []
    for (const [key, pane] of [...this.panes]) {
      if (pane.plugin !== plugin) continue
      this.panes.delete(key)
      this.keyed.delete(key)
      dropped.push(pane.id)
      if (this.shown === key) this.shown = undefined
    }
    if (dropped.length === 0) return dropped
    if (this.shown === undefined) {
      const last = [...this.panes.keys()].pop()
      if (last !== undefined) this.show(last)
    }
    this.onChanged()
    return dropped
  }

  clear(): void {
    if (this.panes.size === 0) return
    this.panes.clear()
    this.keyed.clear()
    this.shown = undefined
    this.onChanged()
  }

  /** Whether the pane was opened with `focus`, so it holds the keys. */
  takesKeys(plugin: string, id: string): boolean {
    return this.keyed.has(paneKeyOf(plugin, id))
  }

  /** Whether an unasked open is placed now: some client draws panes, or
   *  none ever said where it does. */
  private placesUnasked(): boolean {
    if (!this.seatsKnown) return true
    for (const seat of this.seats.values()) {
      if (seat.kind !== 'dock-hidden') return true
    }
    return false
  }

  /** Whether a `focus` open is placed now: some client shows the session,
   *  its panes in view or not, or none ever said where it does. */
  private placesFocused(): boolean {
    return !this.seatsKnown || this.seats.size > 0
  }

  /** Whether some client shows the pane now. */
  private isSeen(pane: ModPane): boolean {
    if (!pane.isPlaced) return false
    if (!this.seatsKnown) return pane.isShown
    for (const seat of this.seats.values()) {
      if (seat.kind === 'inline' && pane.isShown) return true
      if (seat.kind === 'dock-visible' && seat.showing?.plugin === pane.plugin && seat.showing.id === pane.id) {
        return true
      }
    }
    return false
  }

  /** Clears `asked` and `focus` on the panes a seat shows now: those opens
   *  are answered. True when any changed. */
  private settleShown(): boolean {
    if (!this.seatsKnown) return false
    let changed = false
    for (const pane of this.panes.values()) {
      if ((pane.asked || pane.focus) && this.isSeen(pane)) {
        pane.asked = false
        pane.focus = false
        changed = true
      }
    }
    return changed
  }

  private show(key: string): void {
    for (const [each, pane] of this.panes) pane.isShown = each === key
    this.shown = key
  }
}

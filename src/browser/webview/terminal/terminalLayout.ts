/**
 * Which terminals a session's pane showed, remembered per viewer (F-31):
 * how many, which shell each ran, and which tab was active. In
 * `localStorage`, best-effort, bounded. On a later visit with no live
 * terminal the pane shows that many blank tabs and starts a shell only when
 * one is clicked, so a restored session costs nothing until it is used.
 * Only shell ids and counts are stored — never titles, paths or output.
 *
 * Also the page's in-memory slots: the blank tabs waiting to be started and
 * the tab order per session, shared by every mount of the pane.
 */

export const TERMINAL_LAYOUT_STORAGE_KEY = 'nexus.terminal.layout'

/** Sessions kept, least recently touched dropped first. */
export const TERMINAL_LAYOUT_MAX_SESSIONS = 32
/** Tabs remembered per session. */
export const TERMINAL_LAYOUT_MAX_SLOTS = 16

export type TerminalSlotMemory = { shell: string | null }

export type SessionTerminalMemory = {
  slots: TerminalSlotMemory[]
  /** Index into `slots` of the tab that was showing. */
  active: number
  /** Last write, ms since the epoch; orders the eviction. */
  at: number
}

export type TerminalLayoutMemory = { sessions: Record<string, SessionTerminalMemory> }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const SHELL_ID = /^[a-z][a-z0-9_-]{0,31}$/

function sanitizeSlot(value: unknown): TerminalSlotMemory | null {
  if (!isRecord(value)) return null
  const shell = value.shell
  if (shell === null || shell === undefined) return { shell: null }
  return typeof shell === 'string' && SHELL_ID.test(shell) ? { shell } : { shell: null }
}

/** The memory `value` describes; anything unreadable is dropped. */
export function sanitizeTerminalLayout(value: unknown): TerminalLayoutMemory {
  const out: TerminalLayoutMemory = { sessions: {} }
  if (!isRecord(value) || !isRecord(value.sessions)) return out
  for (const [sessionId, entry] of Object.entries(value.sessions)) {
    if (!sessionId || !isRecord(entry) || !Array.isArray(entry.slots)) continue
    const slots = entry.slots
      .slice(0, TERMINAL_LAYOUT_MAX_SLOTS)
      .map(sanitizeSlot)
      .filter((slot): slot is TerminalSlotMemory => slot !== null)
    const active =
      typeof entry.active === 'number' && Number.isInteger(entry.active) && entry.active >= 0 && entry.active < slots.length
        ? entry.active
        : Math.max(0, slots.length - 1)
    const at = typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : 0
    out.sessions[sessionId] = { slots, active, at }
  }
  return out
}

function readLayout(): TerminalLayoutMemory {
  try {
    const raw = globalThis.localStorage?.getItem(TERMINAL_LAYOUT_STORAGE_KEY)
    return sanitizeTerminalLayout(raw == null ? null : JSON.parse(raw))
  } catch {
    return { sessions: {} }
  }
}

function writeLayout(layout: TerminalLayoutMemory): void {
  try {
    globalThis.localStorage?.setItem(TERMINAL_LAYOUT_STORAGE_KEY, JSON.stringify(layout))
  } catch {
    // Storage may be unavailable or full; the pane still works for this visit.
  }
}

/** What is remembered now (read from storage each call; the store is small). */
export function loadTerminalLayout(): TerminalLayoutMemory {
  return readLayout()
}

/** Remember `slots` for `sessionId`, evicting the least recently touched sessions past the cap. */
export function rememberSessionTerminals(
  sessionId: string,
  slots: readonly TerminalSlotMemory[],
  active: number,
  now: number = Date.now(),
): void {
  const layout = readLayout()
  const kept = slots.slice(0, TERMINAL_LAYOUT_MAX_SLOTS).map(slot => ({ shell: slot.shell }))
  const previous = layout.sessions[sessionId]
  const next: SessionTerminalMemory = {
    slots: kept,
    active: Math.min(Math.max(0, active), Math.max(0, kept.length - 1)),
    at: now,
  }
  if (
    previous &&
    previous.active === next.active &&
    previous.slots.length === next.slots.length &&
    previous.slots.every((slot, index) => slot.shell === next.slots[index]?.shell)
  ) {
    return
  }
  layout.sessions[sessionId] = next
  const ids = Object.keys(layout.sessions)
  if (ids.length > TERMINAL_LAYOUT_MAX_SESSIONS) {
    ids
      .sort((a, b) => (layout.sessions[a]?.at ?? 0) - (layout.sessions[b]?.at ?? 0))
      .slice(0, ids.length - TERMINAL_LAYOUT_MAX_SESSIONS)
      .forEach(id => {
        delete layout.sessions[id]
      })
  }
  writeLayout(layout)
}

export function forgetSessionTerminals(sessionId: string): void {
  const layout = readLayout()
  if (!(sessionId in layout.sessions)) return
  delete layout.sessions[sessionId]
  writeLayout(layout)
}

// ---- the page's slots ------------------------------------------------------

/** A tab with no terminal behind it yet; a click starts `shell` (the default when null). */
export type TerminalPlaceholder = {
  id: string
  shell: string | null
  /** A create is in flight for it. */
  starting: boolean
}

export type SessionSlots = {
  /** Tab keys — terminal ids and placeholder ids — in display order. */
  order: readonly string[]
  placeholders: readonly TerminalPlaceholder[]
}

export const EMPTY_SLOTS: SessionSlots = { order: [], placeholders: [] }

const slotsBySession = new Map<string, SessionSlots>()
const slotListeners = new Set<() => void>()
let placeholderCounter = 0

function setSlots(sessionId: string, next: SessionSlots): void {
  if (next.order.length === 0 && next.placeholders.length === 0) slotsBySession.delete(sessionId)
  else slotsBySession.set(sessionId, next)
  for (const listener of [...slotListeners]) listener()
}

/** The session's slots; the same object until they change, so a store hook can compare. */
export function sessionSlots(sessionId: string): SessionSlots {
  return slotsBySession.get(sessionId) ?? EMPTY_SLOTS
}

export function subscribeTerminalSlots(listener: () => void): () => void {
  slotListeners.add(listener)
  return () => {
    slotListeners.delete(listener)
  }
}

/** Put one blank tab per entry of `shells` in the session; returns their ids in order. */
export function restorePlaceholders(sessionId: string, shells: readonly (string | null)[]): string[] {
  const current = sessionSlots(sessionId)
  const added: TerminalPlaceholder[] = shells.map(shell => ({
    id: `pending_${++placeholderCounter}`,
    shell,
    starting: false,
  }))
  setSlots(sessionId, {
    order: [...current.order, ...added.map(placeholder => placeholder.id)],
    placeholders: [...current.placeholders, ...added],
  })
  return added.map(placeholder => placeholder.id)
}

export function markPlaceholderStarting(sessionId: string, id: string, starting: boolean): void {
  const current = sessionSlots(sessionId)
  if (!current.placeholders.some(placeholder => placeholder.id === id && placeholder.starting !== starting)) return
  setSlots(sessionId, {
    order: current.order,
    placeholders: current.placeholders.map(placeholder =>
      placeholder.id === id ? { ...placeholder, starting } : placeholder,
    ),
  })
}

/** The placeholder became terminal `terminalId`: it takes the placeholder's place in the order. */
export function placeholderStarted(sessionId: string, id: string, terminalId: string): void {
  const current = sessionSlots(sessionId)
  if (!current.placeholders.some(placeholder => placeholder.id === id)) return
  setSlots(sessionId, {
    order: current.order.map(key => (key === id ? terminalId : key)),
    placeholders: current.placeholders.filter(placeholder => placeholder.id !== id),
  })
}

export function removePlaceholder(sessionId: string, id: string): void {
  const current = sessionSlots(sessionId)
  if (!current.placeholders.some(placeholder => placeholder.id === id)) return
  setSlots(sessionId, {
    order: current.order.filter(key => key !== id),
    placeholders: current.placeholders.filter(placeholder => placeholder.id !== id),
  })
}

/** Keep `order` to the keys still present, with the live ids it does not know yet appended in their own order. */
export function orderedKeys(order: readonly string[], liveIds: readonly string[], placeholderIds: readonly string[]): string[] {
  const known = new Set<string>([...liveIds, ...placeholderIds])
  const kept = order.filter(key => known.has(key))
  const seen = new Set(kept)
  for (const id of liveIds) if (!seen.has(id)) kept.push(id)
  return kept
}

/** Forget every session's slots (tests). */
export function resetTerminalSlotsForTests(): void {
  slotsBySession.clear()
  placeholderCounter = 0
}

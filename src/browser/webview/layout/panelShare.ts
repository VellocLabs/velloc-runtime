/**
 * The Right Panel's width as a share of the room it splits with the chat
 * (F-9): `panel / (chat + panel)`. Each view kind keeps its own share — a
 * splitter drag remembers it for the front view's kind — so a window resize
 * scales the panel with the window. Pure.
 */
import { isFileViewId, type RightPanelViewId } from './rightPanelManager'

export type RightPanelViewKind = 'plan' | 'tasks' | 'diff' | 'skill' | 'file'

/** Remembered shares by view kind; a kind with none uses its default. */
export type RightPanelShares = Partial<Record<RightPanelViewKind, number>>

const KINDS: readonly RightPanelViewKind[] = ['plan', 'tasks', 'diff', 'skill', 'file']

/** Reading views (a diff, a file) open at chat:panel 2:3; the rest at 2:1. */
const WIDE_KINDS: ReadonlySet<RightPanelViewKind> = new Set(['diff', 'file'])
export const RIGHT_PANEL_WIDE_SHARE = 3 / 5
export const RIGHT_PANEL_NARROW_SHARE = 1 / 3

const SHARE_MIN = 0.1
const SHARE_MAX = 0.9

export function rightPanelViewKind(view: RightPanelViewId | null): RightPanelViewKind {
  if (view === null) return 'tasks'
  return isFileViewId(view) ? 'file' : view
}

export function defaultRightPanelShare(kind: RightPanelViewKind): number {
  return WIDE_KINDS.has(kind) ? RIGHT_PANEL_WIDE_SHARE : RIGHT_PANEL_NARROW_SHARE
}

export function rightPanelShare(shares: RightPanelShares, kind: RightPanelViewKind): number {
  return shares[kind] ?? defaultRightPanelShare(kind)
}

export function clampRightPanelShare(share: number): number {
  return Math.min(Math.max(share, SHARE_MIN), SHARE_MAX)
}

/** Returns `shares` itself when the kind's share is already `share`. */
export function setRightPanelShare(
  shares: RightPanelShares,
  kind: RightPanelViewKind,
  share: number,
): RightPanelShares {
  if (!Number.isFinite(share)) return shares
  const next = Math.round(clampRightPanelShare(share) * 10_000) / 10_000
  return shares[kind] === next ? shares : { ...shares, [kind]: next }
}

/** The share a drawn panel width stands for, in the room it splits with the chat. */
export function shareFromWidth(width: number, room: number): number {
  return room > 0 ? width / room : Number.NaN
}

/** The panel's wanted width in `room`, inside `[minWidth, maxWidth]`. */
export function rightPanelWantWidth(
  share: number,
  room: number,
  minWidth: number,
  maxWidth: number,
): number {
  return Math.round(Math.min(Math.max(share * Math.max(0, room), minWidth), maxWidth))
}

export function rightPanelSharesEqual(a: RightPanelShares, b: RightPanelShares): boolean {
  return KINDS.every(kind => a[kind] === b[kind])
}

/** Security: drops unknown kinds and out-of-range or non-numeric shares from a stored blob. */
export function sanitizeRightPanelShares(raw: unknown): RightPanelShares {
  if (typeof raw !== 'object' || raw === null) return {}
  const obj = raw as Record<string, unknown>
  let out: RightPanelShares = {}
  for (const kind of KINDS) {
    const value = obj[kind]
    if (typeof value === 'number' && Number.isFinite(value)) out = setRightPanelShare(out, kind, value)
  }
  return out
}

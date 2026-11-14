/**
 * The one way a side pane opens (F-9): every caller — a topbar toggle, a
 * transcript link, an app's icon, the agent, a mod — names the pane and how it
 * opens, and this places it in a session's layout record.
 */
import type { ActionDispatch, RefObject } from 'react'

import { hasPane, openPane, setMaximized, type PaneWeightByKind, type SessionPaneRecord, type SidePaneKind } from './layout/paneLayout'
import type { RightPanelPresenceEvent } from './layout/rightPanelPresence'

/** How a side pane opens. Every field is optional. */
export interface SidePaneOpenOptions {
  /** The session whose layout changes; the shown session when omitted. */
  sessionId?: string
  /** The pane covers the chat. Default false: it opens beside the chat. */
  maximized?: boolean
  /** The pane's share of the root row when it is placed; the remembered weight when omitted. */
  weight?: number
  /**
   * Opened for the person: the pane becomes the session's focused pane and
   * the side area is presented. Default: true for the shown session.
   */
  foreground?: boolean
  /**
   * When another pane covers the chat, the opened pane takes its place so it
   * is seen. Default: the value of `foreground`.
   */
  takeExpansion?: boolean
}

export type OpenSidePane = (kind: SidePaneKind, options?: SidePaneOpenOptions) => void

/** `record` with `kind` open as `options` ask; the same record when nothing changes. */
export function openSidePaneRecord(
  record: SessionPaneRecord,
  kind: SidePaneKind,
  weights: PaneWeightByKind,
  options: Pick<SidePaneOpenOptions, 'maximized' | 'weight' | 'takeExpansion'> = {},
): SessionPaneRecord {
  const opened = openPane(record, kind, options.weight === undefined ? weights : { ...weights, [kind]: options.weight })
  if (options.maximized === true) return setMaximized(opened, kind)
  return options.takeExpansion === true && opened.maximized !== null ? setMaximized(opened, kind) : opened
}

/**
 * Contract: the shell's `openSidePane`. A pane a CLI session does not offer
 * (`cliPanes`) is ignored when it is asked for that session in the
 * foreground; a background open places the pane without focusing or
 * presenting it. A pane of the shown session that ends up beside the chat
 * (not maximized, and nothing else covering the chat) has its header
 * flashed: on every foreground open, even of a pane open already; on a
 * background open only when the pane was not there before.
 */
export function createShellOpenSidePane(
  activeSessionIdRef: RefObject<string>,
  activeCliRef: RefObject<string | undefined>,
  cliPanes: readonly SidePaneKind[],
  updatePaneRecord: (fn: (prev: SessionPaneRecord) => SessionPaneRecord, sessionId?: string) => void,
  sessionLayoutsStore: { getSnapshot(): { weights: PaneWeightByKind } },
  focusedPaneRef: RefObject<Map<string, SidePaneKind>>,
  presentRightPanel: ActionDispatch<[event: RightPanelPresenceEvent]> | ((event: RightPanelPresenceEvent) => void),
  flashPane: (kind: SidePaneKind) => void,
): OpenSidePane {
  return (kind, options = {}) => {
    const shownId = activeSessionIdRef.current
    const sessionId = options.sessionId ?? shownId
    if (!sessionId) return
    const shown = sessionId === shownId
    const foreground = options.foreground ?? shown
    if (foreground && shown && activeCliRef.current && !cliPanes.includes(kind)) return
    const takeExpansion = options.takeExpansion ?? foreground
    let flash = false
    updatePaneRecord(r => {
      const placed = openSidePaneRecord(r, kind, sessionLayoutsStore.getSnapshot().weights, {
        maximized: options.maximized,
        weight: options.weight,
        takeExpansion,
      })
      flash = placed.maximized === null && (foreground || !hasPane(r.layout, kind))
      return placed
    }, sessionId)
    if (shown && flash) flashPane(kind)
    if (!foreground) return
    focusedPaneRef.current.set(sessionId, kind)
    presentRightPanel({ type: 'personOpen', view: kind })
  }
}

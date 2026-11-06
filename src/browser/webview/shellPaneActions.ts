import { type RefObject, type Dispatch, type SetStateAction, type ActionDispatch } from 'react'
import type { RightPanelPresenceEvent } from './layout/rightPanelPresence'
import type { CapabilityQuery } from './useCan'
import type { BrowserBridgeTransport } from '../bridge/browserBridgeProtocol'
import { PANE_GUTTER_PX } from './layout/layoutConstants'
import {
  closePane,
  hasPane,
  browserToggleAction,
  openPane,
  movePane,
  paneLayoutEquals,
  panesIn,
  paneToggleAction,
  pruneUnrestorable,
  keepOnlyPanes,
  resetPaneLayout,
  setMaximized,
  type FilesPaneState,
  type PaneDropTarget,
  type PaneLayout,
  type SessionPaneRecord,
  type SidePaneKind,
} from './layout/paneLayout'
import { fitRootRowAfterOpen } from './layout/paneFit'
import { rootPaneWeightsByKind } from './layout/paneResize'
import {
  activateFileTab,
  closeAllTabs,
  closeFileTab,
  closeOtherTabs,
  closeTabsAfter,
  emptyFilesPane,
  openFileTab,
} from './layout/filesPane'
import { createQuotedAttachmentPrefix } from './BrowserComposerAttachmentAdapter'
import type { FilesBulkClose } from './panes/FilesPane'
import { type SessionLayoutsStore } from './layout/sessionLayouts'
import {
  type RightPanelDiffTarget,
  type RightPanelSkillTarget,
  type RightPanelFileTarget,
} from '@/components/assistant-ui/right-panel-content-context'
import {
  activateSessionTab,
  closeSessionTab,
  navigateSessionTab,
  openSessionTab,
} from './nexusBridgeActions'
import { fileOpenKind } from '@/utils/fileOpenKind'
import { requestTerminalFocus } from './terminal/terminalFocus'
import { cliOfTemplateType } from '../../prompting/templateCatalog'

// The side panes a CLI session offers (F-34); every other pane stays closed.
export const CLI_SESSION_PANES: readonly SidePaneKind[] = ['browser', 'terminal']
/**
 * Per-session, in-memory pane content that is not layout (F-9): the Diff and
 * Skill targets and a file's reveal request. The layout itself is the
 * session's persisted record (`sessionLayouts`).
 */
export interface PaneSessionUi {
  // The diff the Diff pane shows: the last one the person opened.
  diffTarget: RightPanelDiffTarget | null
  // The skill whose instructions the Skill pane shows (Skill card "View skill").
  skillTarget: RightPanelSkillTarget | null
  // Line-reveal request for a file, from a `path:42` transcript mention. The
  // nonce edge-triggers delivery, so clicking the same `path:42` twice
  // re-centers.
  fileReveal: { path: string; line: number; nonce: number } | null
}
export const EMPTY_PANE_UI: PaneSessionUi = { diffTarget: null, skillTarget: null, fileReveal: null }
export const EMPTY_FILES_PANE: FilesPaneState = emptyFilesPane()
export function createShellReadPaneRecord(
  sessionLayoutsStore: SessionLayoutsStore,
  sessionTabCountsRef: RefObject<ReadonlyMap<string, { nexus: number; total: number; }>>,
  modPaneCountsRef: RefObject<Map<string, number>>,
  getSessionTemplateType: (sessionId: string) => string | undefined,
) {
  return (sessionId: string) => {
    const record = pruneUnrestorable(sessionLayoutsStore.get(sessionId), {
      browserTabs: sessionTabCountsRef.current.get(sessionId)?.nexus ?? 0,
      modPanes: modPaneCountsRef.current.get(sessionId),
    })
    return cliOfTemplateType(getSessionTemplateType(sessionId)) ? keepOnlyPanes(record, CLI_SESSION_PANES) : record
  }
}
export function createShellUpdatePaneRecord(
  activeSessionIdRef: RefObject<string>,
  readPaneRecord: (sessionId: string) => SessionPaneRecord,
  rowWidthForRef: RefObject<(layout: PaneLayout) => number | null>,
  presentRightPanel: ActionDispatch<[event: RightPanelPresenceEvent]>,
  sessionLayoutsStore: SessionLayoutsStore,
) {
  return (fn: (prev: SessionPaneRecord) => SessionPaneRecord, sessionId = activeSessionIdRef.current) => {
    if (!sessionId) return
    const prev = readPaneRecord(sessionId)
    let next = fn(prev)
    if (next === prev) return
    for (const kind of panesIn(next.layout)) {
      if (hasPane(prev.layout, kind)) continue
      const rowWidth = rowWidthForRef.current(next.layout)
      if (rowWidth === null) continue
      const layout = fitRootRowAfterOpen(next.layout, kind, { rowWidth, gutter: PANE_GUTTER_PX })
      if (layout !== next.layout) next = { ...next, layout }
    }
    if (panesIn(prev.layout).length > 0 && panesIn(next.layout).length === 0) {
      presentRightPanel({ type: 'close' })
    }
    sessionLayoutsStore.put(sessionId, next)
  }
}
export function createShellFocusPane(
  activeSessionIdRef: RefObject<string>,
  focusedPaneRef: RefObject<Map<string, SidePaneKind>>,
) {
  return (kind: SidePaneKind) => {
    const id = activeSessionIdRef.current
    if (id) focusedPaneRef.current.set(id, kind)
  }
}
export function createShellOpenPaneFor(
  activeCliRef: RefObject<string | undefined>,
  updatePaneRecord: (fn: (prev: SessionPaneRecord) => SessionPaneRecord, sessionId?: string) => void,
  sessionLayoutsStore: SessionLayoutsStore,
  focusPane: (kind: SidePaneKind) => void,
  presentRightPanel: ActionDispatch<[event: RightPanelPresenceEvent]>,
) {
  return (kind: SidePaneKind) => {
    if (activeCliRef.current && !CLI_SESSION_PANES.includes(kind)) return
    updatePaneRecord(r => {
      const opened = openPane(r, kind, sessionLayoutsStore.getSnapshot().weights)
      return opened.maximized !== null ? setMaximized(opened, kind) : opened
    })
    focusPane(kind)
    presentRightPanel({ type: 'personOpen', view: kind })
  }
}
export function createShellSetModsPaneDismissedFor(
  setModsPaneDismissed: Dispatch<SetStateAction<ReadonlySet<string>>>,
) {
  return (sessionId: string, dismissed: boolean) => {
    setModsPaneDismissed(prev => {
      if (prev.has(sessionId) === dismissed) return prev
      const next = new Set(prev)
      if (dismissed) next.add(sessionId)
      else next.delete(sessionId)
      return next
    })
  }
}
export function createShellClosePaneFor(
  activeSessionIdRef: RefObject<string>,
  readPaneRecord: (sessionId: string) => SessionPaneRecord,
  updatePaneRecord: (fn: (prev: SessionPaneRecord) => SessionPaneRecord, sessionId?: string) => void,
  lastClosedPaneRef: RefObject<Map<string, SidePaneKind>>,
  focusedPaneRef: RefObject<Map<string, SidePaneKind>>,
  browserDismissedAtRef: RefObject<Map<string, number>>,
  sessionTabCountsRef: RefObject<ReadonlyMap<string, { nexus: number; total: number; }>>,
  setModsPaneDismissedFor: (sessionId: string, dismissed: boolean) => void,
) {
  return (kind: SidePaneKind) => {
    const id = activeSessionIdRef.current
    if (!id) return
    if (!hasPane(readPaneRecord(id).layout, kind)) return
    updatePaneRecord(r => closePane(r, kind))
    lastClosedPaneRef.current.set(id, kind)
    if (focusedPaneRef.current.get(id) === kind) focusedPaneRef.current.delete(id)
    if (kind === 'browser') {
      browserDismissedAtRef.current.set(id, sessionTabCountsRef.current.get(id)?.nexus ?? 0)
    }
    if (kind === 'mods') setModsPaneDismissedFor(id, true)
  }
}
export function createShellOpenBrowserTab(
  browserDismissedAtRef: RefObject<Map<string, number>>,
  hostBridgeTransport: BrowserBridgeTransport,
) {
  return (sessionId: string) => {
    browserDismissedAtRef.current.delete(sessionId)
    void openSessionTab(hostBridgeTransport, sessionId).catch(() => {
      /* no Nexus window (a remote page, the dev mock): nothing to show */
    })
  }
}
export function createShellActivateBrowserTab(
  activeSessionId: string,
  hostBridgeTransport: BrowserBridgeTransport,
) {
  return (tabId: number) => {
    if (!activeSessionId) return
    void activateSessionTab(hostBridgeTransport, activeSessionId, tabId).catch(() => {})
  }
}
export function createShellCloseBrowserTab(
  activeSessionId: string,
  hostBridgeTransport: BrowserBridgeTransport,
) {
  return (tabId: number) => {
    if (!activeSessionId) return
    void closeSessionTab(hostBridgeTransport, activeSessionId, tabId).catch(() => {})
  }
}
export function createShellNavigateBrowserTab(
  activeSessionId: string,
  hostBridgeTransport: BrowserBridgeTransport,
) {
  return (tabId: number, text: string) => {
    if (!activeSessionId) return
    void navigateSessionTab(hostBridgeTransport, activeSessionId, tabId, text).catch(() => {})
  }
}
export function createShellTogglePane(
  activeSessionIdRef: RefObject<string>,
  activeCliRef: RefObject<string | undefined>,
  setBackgroundTaskFocusSessionId: Dispatch<SetStateAction<string | null>>,
  readPaneRecord: (sessionId: string) => SessionPaneRecord,
  sessionTabCountsRef: RefObject<ReadonlyMap<string, { nexus: number; total: number; }>>,
  openBrowserTab: (sessionId: string) => void,
  browserDismissedAtRef: RefObject<Map<string, number>>,
  setModsPaneDismissedFor: (sessionId: string, dismissed: boolean) => void,
  openPaneFor: (kind: SidePaneKind) => void,
  updatePaneRecord: (fn: (prev: SessionPaneRecord) => SessionPaneRecord, sessionId?: string) => void,
  focusPane: (kind: SidePaneKind) => void,
  closePaneFor: (kind: SidePaneKind) => void,
) {
  return (kind: SidePaneKind) => {
    const id = activeSessionIdRef.current
    if (!id) return
    if (activeCliRef.current && !CLI_SESSION_PANES.includes(kind)) return
    setBackgroundTaskFocusSessionId(null)
    const action =
      kind === 'browser'
        ? browserToggleAction(readPaneRecord(id), {
            browserTabs: sessionTabCountsRef.current.get(id)?.nexus ?? 0,
          })
        : paneToggleAction(readPaneRecord(id), kind)
    switch (action) {
      case 'new-tab':
        openBrowserTab(id)
        break
      case 'open':
        if (kind === 'browser') browserDismissedAtRef.current.delete(id)
        if (kind === 'mods') setModsPaneDismissedFor(id, false)
        openPaneFor(kind)
        break
      case 'move-expansion':
        updatePaneRecord(r => setMaximized(r, kind))
        focusPane(kind)
        break
      case 'close':
        closePaneFor(kind)
        break
    }
  }
}
export function createShellHandleResetLayout(
  updatePaneRecord: (fn: (prev: SessionPaneRecord) => SessionPaneRecord, sessionId?: string) => void,
) {
  return () => {
    updatePaneRecord(resetPaneLayout)
  }
}
export function createShellCommitPaneResize(
  updatePaneRecord: (fn: (prev: SessionPaneRecord) => SessionPaneRecord, sessionId?: string) => void,
  sessionLayoutsStore: SessionLayoutsStore,
  presentRightPanel: ActionDispatch<[event: RightPanelPresenceEvent]>,
) {
  return (layout: PaneLayout) => {
    updatePaneRecord(r => (paneLayoutEquals(r.layout, layout) ? r : { ...r, layout }))
    for (const [kind, weight] of Object.entries(rootPaneWeightsByKind(layout))) {
      if (typeof weight === 'number') sessionLayoutsStore.setWeight(kind as SidePaneKind, weight)
    }
    presentRightPanel({ type: 'drag' })
  }
}
export function createShellCommitPaneMove(
  updatePaneRecord: (fn: (prev: SessionPaneRecord) => SessionPaneRecord, sessionId?: string) => void,
  sessionLayoutsStore: SessionLayoutsStore,
) {
  return (kind: SidePaneKind, target: PaneDropTarget) => {
    updatePaneRecord(r => {
      const layout = movePane(r.layout, kind, target, sessionLayoutsStore.getSnapshot().weights)
      return layout === r.layout ? r : { ...r, layout }
    })
  }
}
export function createShellUpdatePaneUi(
  setPaneSessionUi: Dispatch<SetStateAction<Map<string, PaneSessionUi>>>,
) {
  return (sessionId: string, fn: (prev: PaneSessionUi) => PaneSessionUi) => {
    setPaneSessionUi(prev => {
      const cur = prev.get(sessionId) ?? EMPTY_PANE_UI
      const next = fn(cur)
      if (next === cur) return prev
      const m = new Map(prev)
      m.set(sessionId, next)
      return m
    })
  }
}
export function createShellHandleFileDirtyChange(
  setDirtyFilePaths: Dispatch<SetStateAction<ReadonlySet<string>>>,
) {
  return (path: string, dirty: boolean) => {
    setDirtyFilePaths(prev => {
      if (prev.has(path) === dirty) return prev
      const next = new Set(prev)
      if (dirty) next.add(path)
      else next.delete(path)
      return next
    })
  }
}
export function createShellOpenFileInPanel(
  activeSessionIdRef: RefObject<string>,
  updatePaneRecord: (fn: (prev: SessionPaneRecord) => SessionPaneRecord, sessionId?: string) => void,
  dirtyFilePathsRef: RefObject<ReadonlySet<string>>,
  sessionLayoutsStore: SessionLayoutsStore,
  focusPane: (kind: SidePaneKind) => void,
  updatePaneUi: (sessionId: string, fn: (prev: PaneSessionUi) => PaneSessionUi) => void,
  fileRevealNonceRef: RefObject<number>,
  presentRightPanel: ActionDispatch<[event: RightPanelPresenceEvent]>,
) {
  return (target: RightPanelFileTarget) => {
    const id = activeSessionIdRef.current
    if (!id) return
    updatePaneRecord(r => {
      const files = openFileTab(r.files ?? EMPTY_FILES_PANE, target.path, {
        protectedPaths: dirtyFilePathsRef.current,
      })
      const opened = openPane(r, 'files', sessionLayoutsStore.getSnapshot().weights)
      return files === r.files ? opened : { ...opened, files }
    })
    focusPane('files')
    // A `path:42` mention carries a landing line — record the reveal even
    // for an already-open tab (the click means "take me THERE, again").
    if (target.line !== undefined) {
      const line = target.line
      updatePaneUi(id, cur => ({
        ...cur,
        fileReveal: { path: target.path, line, nonce: ++fileRevealNonceRef.current },
      }))
    }
    presentRightPanel({ type: 'personOpen', view: 'files' })
  }
}
export function createShellOpenFile(
  runtimeCapabilities: CapabilityQuery,
  openFileInPanel: (target: RightPanelFileTarget) => void,
  openFileInWindow: (path: string) => Promise<boolean>,
) {
  return (target: RightPanelFileTarget) => {
    if (fileOpenKind(target.path) !== 'media' || !runtimeCapabilities.can('fsx', 'openInWindow')) {
      openFileInPanel(target)
      return
    }
    openFileInWindow(target.path).then(
      opened => {
        if (!opened) openFileInPanel(target)
      },
      () => openFileInPanel(target),
    )
  }
}
export function createShellOpenTerminalInPanel(
  openPaneFor: (kind: SidePaneKind) => void,
) {
  return (sessionId: string, terminalId: string) => {
    requestTerminalFocus(sessionId, terminalId)
    openPaneFor('terminal')
  }
}
export function createShellOpenFileFromTree(
  openFile: (target: RightPanelFileTarget) => void,
) {
  return (path: string, line?: number) => openFile(line === undefined ? { path } : { path, line })
}
export function createShellOpenFileTabInWindow(
  openFileInWindow: (path: string) => Promise<boolean>,
) {
  return (path: string) => void openFileInWindow(path).catch(() => {})
}
export function createShellHandleActivateFileTab(
  updatePaneRecord: (fn: (prev: SessionPaneRecord) => SessionPaneRecord, sessionId?: string) => void,
) {
  return (path: string) => {
    updatePaneRecord(r => {
      const files = activateFileTab(r.files ?? EMPTY_FILES_PANE, path)
      return files === r.files ? r : { ...r, files }
    })
  }
}
export function createShellHandleCloseFileTab(
  updatePaneRecord: (fn: (prev: SessionPaneRecord) => SessionPaneRecord, sessionId?: string) => void,
) {
  return (path: string) => {
    updatePaneRecord(r => {
      const files = closeFileTab(r.files ?? EMPTY_FILES_PANE, path)
      return files === r.files ? r : { ...r, files }
    })
  }
}
export function createShellHandleCloseFileTabs(
  updatePaneRecord: (fn: (prev: SessionPaneRecord) => SessionPaneRecord, sessionId?: string) => void,
  dirtyFilePathsRef: RefObject<ReadonlySet<string>>,
) {
  return (close: FilesBulkClose, path: string) => {
    updatePaneRecord(r => {
      const current = r.files ?? EMPTY_FILES_PANE
      const dirty = dirtyFilePathsRef.current
      const files =
        close === 'others'
          ? closeOtherTabs(current, path, dirty)
          : close === 'right'
            ? closeTabsAfter(current, path, dirty)
            : closeAllTabs(current, dirty)
      return files === r.files ? r : { ...r, files }
    })
  }
}
export function createShellAttachPathToComposer(
  activeSessionIdRef: RefObject<string>,
  setComposerInsert: Dispatch<SetStateAction<{ sessionId: string; text: string; nonce: number; } | null>>,
  composerInsertNonceRef: RefObject<number>,
) {
  return (path: string) => {
    const sessionId = activeSessionIdRef.current
    if (!sessionId) return
    setComposerInsert({
      sessionId,
      text: createQuotedAttachmentPrefix([path]),
      nonce: ++composerInsertNonceRef.current,
    })
  }
}
export function createShellOpenDiffInPanel(
  activeSessionIdRef: RefObject<string>,
  updatePaneUi: (sessionId: string, fn: (prev: PaneSessionUi) => PaneSessionUi) => void,
  openPaneFor: (kind: SidePaneKind) => void,
) {
  return (target: RightPanelDiffTarget) => {
    const id = activeSessionIdRef.current
    if (!id) return
    updatePaneUi(id, cur => ({ ...cur, diffTarget: target }))
    openPaneFor('diff')
  }
}
export function createShellOpenSkillInPanel(
  activeSessionIdRef: RefObject<string>,
  updatePaneUi: (sessionId: string, fn: (prev: PaneSessionUi) => PaneSessionUi) => void,
  openPaneFor: (kind: SidePaneKind) => void,
) {
  return (target: RightPanelSkillTarget) => {
    const id = activeSessionIdRef.current
    if (!id) return
    updatePaneUi(id, cur => ({ ...cur, skillTarget: target }))
    openPaneFor('skill')
  }
}

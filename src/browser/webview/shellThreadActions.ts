import { type RefObject, type Dispatch, type SetStateAction } from 'react'
import type { AppendMessage } from '@assistant-ui/react'
import type { CapabilityQuery } from './useCan'
import type { LocalSessionEntry, SessionMetaUpdate } from './useSessionManager'
import type { BrowserBridgeTransport } from '../bridge/browserBridgeProtocol'
import type { BrowserSessionMetadata } from '../../sessions/sessionStore'
import type { SessionListItem } from './Sidebar'
import type { BrowserRuntimeClientState } from './BrowserRuntimeClient'
import { type SessionLayoutsStore } from './layout/sessionLayouts'
import { readSectionCollapsed, readSessionListView } from './sessionListView'
import { sidebarRowOrder } from './sessionPinning'
import { openInClientTab } from './externalLinkClicks'
import { createCopyTranscriptPath } from './copyTranscriptPath'
import {
  openUrl,
  pickProjectFolder,
  revealProjectFolder,
} from './nexusBridgeActions'
import { addRecentFolder } from './recentFoldersStorage'
import { writeLastFolderForType } from './lastFolderByTypeStorage'
import { isForcedFolderTemplateType } from '../../utils/conversationStoragePaths'
import { addProject } from './projectsStorage'
import {
  SESSION_REMOVAL_TIMEOUT_MS,
  type SessionDeleteOrigin,
  type SessionDeleteTarget,
} from './SessionDeleteDialog'
import { writeClipboard } from '@/utils/clipboard'
import { markCliSessionFresh } from './terminal/freshCliSessions'
import { cliOfTemplateType } from '../../prompting/templateCatalog'
import type { ForkRetarget } from '../worker/sharedWorkerProtocol'
import type { ContinueInCodeFolder } from './sessionMessageCallbacks'
import { getModContributions } from './mods/modContributionsView'
import type { PaneSessionUi } from './shellPaneActions'

function getTranscriptUpdatedAt(state: BrowserRuntimeClientState): number {
  for (let index = state.transcriptMessages.length - 1; index >= 0; index -= 1) {
    const timestamp = (
      state.transcriptMessages[index] as { timestamp?: unknown } | undefined
    )?.timestamp
    if (typeof timestamp !== 'string') {
      continue
    }

    const parsed = Date.parse(timestamp)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return Date.now()
}
export function createShellHandleDeleteThread(
  sessionsRef: RefObject<LocalSessionEntry[]>,
  disposeClient: (sessionId: string) => void,
  sessionItemsRef: RefObject<SessionListItem[]>,
  sidebarRailRef: RefObject<boolean>,
  deleteSession: (sessionId: string, rowOrders?: readonly (readonly string[])[]) => void,
  setMountedSessionIds: Dispatch<SetStateAction<string[]>>,
  sessionLayoutsStore: SessionLayoutsStore,
  setPaneSessionUi: Dispatch<SetStateAction<Map<string, PaneSessionUi>>>,
) {
  return (sessionId: string) => {
    // The runtime deletes a lead's teammates with it, so their threads go too;
    // a session's side chats go with it as well (F-36).
    const doomed = new Set([
      sessionId,
      ...sessionsRef.current
        .filter(session => session.spawnerSessionId === sessionId)
        .map(session => session.sessionId),
    ])
    for (const id of doomed) disposeClient(id)
    // The successor of a deleted on-screen session is its neighbor among the
    // rows the sidebar shows; a row a collapsed section hides takes its
    // neighbor in the full order. The rail ignores collapse.
    const view = readSessionListView()
    const now = Date.now()
    const ids = (collapsed?: { pinned: boolean; recents: boolean }) =>
      sidebarRowOrder(sessionItemsRef.current, view, now, collapsed).map(
        session => session.sessionId,
      )
    const full = ids()
    const rowOrders = sidebarRailRef.current
      ? [full]
      : [
          ids({
            pinned: readSectionCollapsed('pinned'),
            recents: readSectionCollapsed('recents'),
          }),
          full,
        ]
    deleteSession(sessionId, rowOrders)
    setMountedSessionIds(prev => prev.filter(id => !doomed.has(id)))
    // Drop the deleted sessions' pane records and content (no leak).
    sessionLayoutsStore.remove(doomed)
    setPaneSessionUi(prev => {
      if (![...doomed].some(id => prev.has(id))) return prev
      const m = new Map(prev)
      for (const id of doomed) m.delete(id)
      return m
    })
  }
}
export function createShellHandleComposerEdit(
  updateSessionMeta: (sessionId: string, meta: SessionMetaUpdate) => void,
  updateSessionMetadata: (sessionId: string, metadata: Partial<BrowserSessionMetadata>) => Promise<void>,
) {
  return (sessionId: string, composerDraft: string, editedAt: number) => {
    // Optimistic local cache update so the sidebar reorders before
    // the fs round-trip completes.
    updateSessionMeta(sessionId, {
      composerDraft,
      lastComposerEditAt: editedAt,
    })
    // Authoritative persist via the worker → conversation store →
    // fs. The SharedWorker manager will rebroadcast `session.updated`
    // back to us; mergeSessions reconciles by `lastComposerEditAt`.
    void updateSessionMetadata(sessionId, {
      composerDraft,
      lastComposerEditAt: editedAt,
    }).catch(error => {
      console.warn(
        'Failed to persist composer draft for session',
        sessionId,
        error,
      )
    })
  }
}
export function createShellHandleSendInForkedSession(
  forkSendRegistry: { register(requestId: string, payload: AppendMessage): Promise<boolean>; take(requestId: string | undefined): { payload: AppendMessage; settle: (ok: boolean) => void; } | undefined; },
  forkSession: (fromSessionId: string, cutUuid: string | undefined, options?: { keepCutMessage?: boolean; retarget?: ForkRetarget; sideChat?: boolean; initialDraft?: string; }) => string,
) {
  return (fromSessionId: string, cutUuid: string, message: AppendMessage) =>
      forkSendRegistry.register(
        forkSession(fromSessionId, cutUuid, { keepCutMessage: true }),
        message,
      )
}
export function createShellHandleContinueInCode(
  hostBridgeTransport: BrowserBridgeTransport,
  forkSession: (fromSessionId: string, cutUuid: string | undefined, options?: { keepCutMessage?: boolean; retarget?: ForkRetarget; sideChat?: boolean; initialDraft?: string; }) => string,
) {
  return async (fromSessionId: string, cutUuid: string, folder: ContinueInCodeFolder) => {
    let path = 'path' in folder ? folder.path.trim() : ''
    if ('pick' in folder) {
      try {
        const result = await pickProjectFolder(hostBridgeTransport)
        if (result.canceled || !result.path) return false
        path = result.path.trim()
      } catch (error) {
        console.warn('Failed to open the project-folder picker:', error)
        return false
      }
    }
    if (!path) return false
    addRecentFolder(path)
    writeLastFolderForType('code', path)
    forkSession(fromSessionId, cutUuid, { retarget: { templateType: 'code', projectRoot: path } })
    return true
  }
}
export function createShellHandleForkAfterMessage(
  forkSession: (fromSessionId: string, cutUuid: string | undefined, options?: { keepCutMessage?: boolean; retarget?: ForkRetarget; sideChat?: boolean; initialDraft?: string; }) => string,
) {
  return (sessionId: string, cutUuid: string) => {
    forkSession(sessionId, cutUuid, { keepCutMessage: true })
  }
}
export function createShellHandleForkThread(
  forkSession: (fromSessionId: string, cutUuid: string | undefined, options?: { keepCutMessage?: boolean; retarget?: ForkRetarget; sideChat?: boolean; initialDraft?: string; }) => string,
) {
  return (sessionId: string) => {
    forkSession(sessionId, undefined, { keepCutMessage: true })
  }
}
export function createShellHandleSelectProjectFolder(
  rebindProjectFolder: (sessionId: string, projectRoot: string) => Promise<boolean>,
  getSessionTemplateType: (sessionId: string) => string | undefined,
  updateSessionMetadata: (sessionId: string, metadata: Partial<BrowserSessionMetadata>) => Promise<void>,
) {
  return (sessionId: string, path: string) => {
    const trimmed = path.trim()
    if (!trimmed) return
    void rebindProjectFolder(sessionId, trimmed).then(bound => {
      if (!bound) return
      addRecentFolder(trimmed)
      // Remember this folder as the default for a NEW session of the SAME
      // forced-folder type (`code`/`safe_code`, or a plugin type that
      // requires a folder) — the only types that inherit their last-bound
      // folder (`isForcedFolderTemplateType`; the runtime's `session.open`
      // composer), each in its OWN bucket. Never for other types: an
      // agent/chat bind must not leak into the bucket new sessions read, and
      // defaulting an unknown type to `'agent'` here is exactly how the
      // `'agent'` bucket got polluted and opened agent sessions blank.
      const boundType = getSessionTemplateType(sessionId)
      if (isForcedFolderTemplateType(boundType, getModContributions().templates)) {
        writeLastFolderForType(boundType, trimmed)
      }
      // Authoritative persist (worker → conversation store → fs). On resume /
      // reload `createSessionInitPayload` reads it back via
      // `getSessionProjectRoot` and re-binds the same folder. The current
      // session is already live on the new folder from the rebind above, so
      // no optimistic local write is needed.
      void updateSessionMetadata(sessionId, { projectRoot: trimmed }).catch(
        error => {
          console.warn(
            'Failed to persist project folder for session',
            sessionId,
            error,
          )
        },
      )
    })
  }
}
export function createShellHandleOpenProjectFolder(
  hostBridgeTransport: BrowserBridgeTransport,
  handleSelectProjectFolder: (sessionId: string, path: string) => void,
) {
  return async (sessionId: string) => {
    let result: Awaited<ReturnType<typeof pickProjectFolder>>
    try {
      result = await pickProjectFolder(hostBridgeTransport)
    } catch (error) {
      console.warn('Failed to open the project-folder picker:', error)
      return
    }
    if (result.canceled || !result.path) return
    handleSelectProjectFolder(sessionId, result.path)
  }
}
export function createShellHandleAddProject(
  hostBridgeTransport: BrowserBridgeTransport,
) {
  return async () => {
    let result: Awaited<ReturnType<typeof pickProjectFolder>>
    try {
      result = await pickProjectFolder(hostBridgeTransport)
    } catch (error) {
      console.warn('Failed to open the project-folder picker:', error)
      return
    }
    if (result.canceled || !result.path) return
    addProject(result.path)
    // Also feed the type-agnostic MRU the composer chip's quick-picks read, so
    // a folder added here is offered there too.
    addRecentFolder(result.path)
  }
}
export function createShellHandleLaunchInProject(
  openNewSession: (templateType?: string, projectRoot?: string) => string,
) {
  return (projectRoot: string, templateType: string) => {
    const trimmed = projectRoot.trim()
    if (!trimmed) return
    const sessionId = openNewSession(templateType, trimmed)
    // A CLI session launched here starts its CLI on first sight (F-34).
    if (cliOfTemplateType(templateType)) markCliSessionFresh(sessionId)
    addRecentFolder(trimmed)
    writeLastFolderForType(templateType, trimmed)
  }
}
export function createShellRequestSessionDelete(
  setSessionDeleteTarget: Dispatch<SetStateAction<SessionDeleteTarget | null>>,
) {
  return (sessionId: string, origin?: SessionDeleteOrigin) =>
    setSessionDeleteTarget({ ...origin, sessionId })
}
export function createShellHandleLaunchThread(
  setCliLaunchType: Dispatch<SetStateAction<string | null>>,
  openNewSession: (templateType?: string, projectRoot?: string) => string,
) {
  return (templateType?: string) => {
    if (cliOfTemplateType(templateType)) setCliLaunchType(templateType ?? null)
    else openNewSession(templateType)
  }
}
export function createShellLaunchCliIn(
  cliLaunchType: string | null,
  setCliLaunchType: Dispatch<SetStateAction<string | null>>,
  handleLaunchInProject: (projectRoot: string, templateType: string) => void,
) {
  return (path: string) => {
    const type = cliLaunchType
    setCliLaunchType(null)
    if (type) handleLaunchInProject(path, type)
  }
}
export function createShellPickCliFolder(
  hostBridgeTransport: BrowserBridgeTransport,
  launchCliIn: (path: string) => void,
) {
  return async () => {
    let result: Awaited<ReturnType<typeof pickProjectFolder>>
    try {
      result = await pickProjectFolder(hostBridgeTransport)
    } catch (error) {
      console.warn('Failed to open the project-folder picker:', error)
      return
    }
    if (result.canceled || !result.path) return
    launchCliIn(result.path)
  }
}
export function createShellHandleCopyTranscriptPath(
  resolveHomeDir: () => Promise<string>,
  sessionItemsRef: RefObject<SessionListItem[]>,
) {
  const copy = createCopyTranscriptPath(resolveHomeDir, () => sessionItemsRef.current, writeClipboard)
  return (sessionId: string) => void copy(sessionId)
}
export function createShellHandleCopyProjectPath(

) {
  return (path: string) => {
    // Through the shared util: it falls back to execCommand where
    // `navigator.clipboard` is missing (non-secure context / guest webview).
    void writeClipboard(path).then(ok => {
      if (!ok) console.warn('Failed to copy the project path')
    })
  }
}
export function createShellDeleteAndAwaitRemoval(
  handleDeleteThread: (sessionId: string) => void,
  waitersRef: RefObject<Map<string, (removed: boolean) => void>>,
) {
  return (sessionId: string) =>
    new Promise<boolean>(resolve => {
      const settle = (removed: boolean) => {
        clearTimeout(timer)
        if (waitersRef.current.get(sessionId) === settle) waitersRef.current.delete(sessionId)
        resolve(removed)
      }
      const timer = setTimeout(() => settle(false), SESSION_REMOVAL_TIMEOUT_MS)
      waitersRef.current.set(sessionId, settle)
      handleDeleteThread(sessionId)
    })
}
export function createShellHandleRevealProjectFolder(
  hostBridgeTransport: BrowserBridgeTransport,
) {
  return (path: string) => {
    const trimmed = path.trim()
    if (!trimmed) return
    void revealProjectFolder(hostBridgeTransport, trimmed).catch(error => {
      console.warn('Failed to reveal the project folder:', error)
    })
  }
}
export function createShellOpenTerminalLink(
  runtimeCapabilities: CapabilityQuery,
  hostBridgeTransport: BrowserBridgeTransport,
) {
  return (url: string) => {
    if (runtimeCapabilities.can('ui', 'openUrl')) {
      void openUrl(hostBridgeTransport, url).catch(() => {})
    } else {
      openInClientTab(url)
    }
  }
}
export function createShellOnSessionStateChange(
  updateSessionMeta: (sessionId: string, meta: SessionMetaUpdate) => void,
) {
  return (
    sessionId: string,
    state: BrowserRuntimeClientState,
    metadata: BrowserSessionMetadata,
  ) => {
    updateSessionMeta(sessionId, {
      title: metadata.firstPrompt || 'New Thread',
      previewText: metadata.previewText || metadata.firstPrompt || '',
      updatedAt: getTranscriptUpdatedAt(state),
      // Forward the live transcript length (or a pending prompt) so `openNewSession` never
      // reuses a thread that is no longer empty.
      messageCount: Math.max(
        state.transcriptMessages.length,
        typeof metadata.messageCount === 'number' ? metadata.messageCount : 0,
      ),
    })
  }
}

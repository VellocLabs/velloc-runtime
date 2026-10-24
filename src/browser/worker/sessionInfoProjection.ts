/**
 * Pure assembly of the sidebar `SessionCard` from the live session entry, the live metadata overlay
 * and the persisted fs summary.
 */
import type { AgentRuntimeWorkerSnapshot } from './workerProtocol'
import type { SessionCard } from './sharedWorkerProtocol'
import type { LiveMeta } from './SessionSummaryRepository'
import type { BrowserSessionSummary } from '../../sessions/sessionStore'

/** The live-entry fields the projection reads (a SessionEntry view). */
export type SessionInfoLiveView = {
  templateType?: string
  projectRoot?: string
  spawnerSessionId?: string
  teammateName?: string
  snapshot: AgentRuntimeWorkerSnapshot
}

export function projectSessionInfo(args: {
  sessionId: string
  entry: SessionInfoLiveView | undefined
  live: LiveMeta | undefined
  fs: BrowserSessionSummary | undefined
}): SessionCard | null {
  const { sessionId, entry, live, fs } = args
  if (!entry && !fs) return null

  // Manual rename (`customTitle`) wins over any derived title, from
  // either the live overlay or the persisted summary — so a streamed
  // re-derivation (`updateSessionMeta`) can never clobber it. Tombstone
  // a live `null` means the user explicitly CLEARED the
  // rename — surface no customTitle rather than falling back to the fs
  // cache's stale one.
  const customTitle =
    live && live.customTitle !== undefined
      ? live.customTitle ?? undefined
      : fs?.customTitle
  const templateType = entry?.templateType ?? fs?.templateType
  // Real bound folder only: `entry.projectRoot` is the init-payload value
  // (unset for sandbox sessions), `fs.projectRoot` the persisted one. Never
  // the worker snapshot's resolved path, which would leak the sandbox.
  const projectRoot = entry?.projectRoot ?? fs?.projectRoot
  // Immutable identity — the live entry (init payload) is authoritative while
  // a worker runs; the persisted summary carries it across a reload.
  const spawnerSessionId = entry?.spawnerSessionId ?? fs?.spawnerSessionId
  const teammateName = entry?.teammateName ?? fs?.teammateName
  const shutdown = fs?.shutdown === true
  const shutdownAt = fs?.shutdownAt
  // A cleared rename falls back to the persisted title only when the summary
  // marks it automatic; any other persisted `customTitle` may be the cleared rename.
  const clearedTo = live?.customTitle === null && fs?.renamed === false ? fs.customTitle : undefined
  const title = customTitle ?? clearedTo ?? live?.title ?? fs?.firstPrompt
  const previewText = live?.previewText ?? fs?.previewText
  // `updatedAt` is an activity clock that only moves forward (F-17): the newer of live and persisted
  // (a rename floats the persisted one).
  const updatedAt =
    live?.updatedAt !== undefined && fs?.updatedAt !== undefined
      ? Math.max(live.updatedAt, fs.updatedAt)
      : live?.updatedAt ?? fs?.updatedAt
  // Composer draft: live wins over fs because the UI's optimistic
  // 500 ms-debounced edit lands here BEFORE the worker's fs round-trip
  // completes. Once the round-trip closes, both will agree. Tombstone
  // a live `null` is an explicit clear — never resurrect
  // the fs cache's old draft while the round-trip is in flight.
  const composerDraft =
    live && live.composerDraft !== undefined
      ? live.composerDraft ?? undefined
      : fs?.composerDraft
  const lastComposerEditAt =
    live?.lastComposerEditAt ?? fs?.lastComposerEditAt
  const pinned = live?.pinned ?? fs?.pinned === true
  // A live rename (or its `null` clear) is ahead of the persisted summary.
  const renamed =
    live && live.customTitle !== undefined ? live.customTitle !== null : fs?.renamed === true
  // messageCount: prefer the live runtime snapshot (it's the
  // authoritative count for an open session) and fall back to the
  // fs summary for sessions we know only by their persisted file.
  // Composer drafts do NOT bump this — that's the whole point of
  // the field as a "is this session empty" signal.
  const liveMessageCount = entry?.snapshot.messageCount
  const messageCount =
    typeof liveMessageCount === 'number'
      ? liveMessageCount
      : fs?.messageCount

  return {
    sessionId,
    initialized: entry?.snapshot.initialized ?? false,
    ...(title ? { title } : {}),
    ...(customTitle ? { customTitle } : {}),
    ...(templateType ? { templateType } : {}),
    ...(projectRoot ? { projectRoot } : {}),
    ...(spawnerSessionId ? { spawnerSessionId } : {}),
    ...(teammateName ? { teammateName } : {}),
    ...(shutdown ? { shutdown: true } : {}),
    ...(typeof shutdownAt === 'number' ? { shutdownAt } : {}),
    ...(previewText ? { previewText } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(typeof messageCount === 'number' ? { messageCount } : {}),
    ...(fs ? { persisted: true } : {}),
    ...(composerDraft !== undefined ? { composerDraft } : {}),
    ...(lastComposerEditAt !== undefined ? { lastComposerEditAt } : {}),
    ...(fs?.createdAt !== undefined ? { createdAt: fs.createdAt } : {}),
    ...(pinned ? { pinned: true } : {}),
    ...(renamed ? { renamed: true } : {}),
  }
}

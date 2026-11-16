import { snapshotNeedsAnswer } from '../../utils/sessionNeedsAnswer'
import { type BrowserSessionMetadata, applyDiskOnlyMetadataPatch } from '../../sessions/sessionStore'
import { lineageInputFromRelationFields, type SessionLineageInput } from '../../sessions/sessionLineage'
import { sanitizeChildReportText } from '../../sessions/childReports'
import type { ChapterMark } from '../../sessions/chapterMarks'
import type { SessionWorkerInboundMessage } from './sharedWorkerProtocol'
import type { ChildReportHost } from './ChildReportCoordinator'
import { modSlotFor } from '../../mods/modSlotRegistry'
import { SUBMIT_PRIORITY } from './submitPriority'
import type { SharedWorkerSessionManager } from './SharedWorkerSessionManager'

type Manager = SharedWorkerSessionManager

/** The manager state and callbacks the session meta records read; owned by the manager. */
export type SessionMetaRecordsDeps = {
  sessions: Manager['sessions']
  runtimeHub: Manager['runtimeHub']
  storageCoordinator: Manager['storageCoordinator']
  deletingSessions: Manager['deletingSessions']
  startStates: Manager['startStates']
  taskDelivery: Manager['taskDelivery']
  tracer: Manager['tracer']
  getStorage: () => Manager['storage']
  getGroupedStorage: () => Manager['groupedStorage']
  getFsSummaries: () => Manager['fsSummaries']
  getHostEnvironment: () => Manager['hostEnvironment']
  getTeams: () => Manager['teams']
  awaitsStoreBind: Manager['awaitsStoreBind']
  patchSessionRecord: Manager['patchSessionRecord']
  readPersistedEntries: Manager['readPersistedEntries']
}

/**
 * Contract: per-session records kept in session metadata — chapter marks,
 * child proposals, the stored review snapshot — read from the live store
 * when one is bound, else from routed disk storage; and the host the
 * child-report queue reads. Owns no state; every map belongs to the manager.
 */
export class SessionMetaRecords {
  constructor(private readonly deps: SessionMetaRecordsDeps) {}

  /** A session's stored chapter marks: a list stashed for a bind that has not
   *  written it yet, else its live store, else disk (F-37). */
  async readStoredReviewSnapshot(sessionId: string): Promise<import('../../codeReview/review-protocol').ReviewSessionSnapshot | undefined> {
    if (!/^[A-Za-z0-9_-]{1,300}$/.test(sessionId)) throw new Error('invalid-review-session')
    const storage = await this.routedStorageFor(sessionId)
    const meta = await storage.readSessionMeta(sessionId)
    if (!meta) return undefined
    if (meta.sessionId !== sessionId) throw new Error('review-session-mismatch')
    const groupedStorage = this.deps.getGroupedStorage()
    const base = groupedStorage ? groupedStorage.projectRouteOf(sessionId) : storage.getBasePath?.()
    if (!base) return undefined
    const { readStoredReviewSnapshot } = await import('../../codeReview/stored-snapshot')
    return readStoredReviewSnapshot({ fs: this.deps.runtimeHub.context.fs, sessionBase: base, sessionId })
  }

  async readChapterMarks(sessionId: string): Promise<unknown> {
    const entry = this.deps.sessions.get(sessionId)
    if (entry?.pendingChapterMarks !== undefined) return entry.pendingChapterMarks
    if (entry?.conversationStore) return (await entry.conversationStore.getSessionMetadata())?.chapterMarks
    const storage = await this.routedStorageFor(sessionId)
    return (await storage.readSessionMeta(sessionId))?.metadata.chapterMarks
  }

  /** Writes a session's chapter marks where they will last: its bound store, the
   *  pre-bind stash (the bind writes it, so the store's next save keeps it), or
   *  disk. Throws when nothing was written (F-37). */
  async writeChapterMarks(sessionId: string, chapterMarks: ChapterMark[]): Promise<void> {
    const entry = this.deps.sessions.get(sessionId)
    if (entry?.conversationStore) {
      // A stash still present means the bind has not written it: the new list
      // replaces it until the store holds the list, so a bind that reads the
      // stash later writes this list, not the older one.
      const stashed = entry.pendingChapterMarks
      if (stashed !== undefined) entry.pendingChapterMarks = chapterMarks
      try {
        await entry.conversationStore.updateSessionMetadata({ chapterMarks })
      } catch (error) {
        if (entry.pendingChapterMarks === chapterMarks) entry.pendingChapterMarks = stashed
        throw error
      }
      if (entry.pendingChapterMarks === chapterMarks) entry.pendingChapterMarks = undefined
      return
    }
    if (entry && this.deps.awaitsStoreBind(entry)) {
      entry.pendingChapterMarks = chapterMarks
      return
    }
    const storage = await this.routedStorageFor(sessionId)
    if (!(await applyDiskOnlyMetadataPatch(storage, sessionId, { chapterMarks }))) {
      throw new Error(`no stored session ${sessionId}`)
    }
    // A runtime that opened during the write loaded the sidecar without this
    // list; hand it over so its own next save keeps it.
    const opened = this.deps.sessions.get(sessionId)
    if (opened?.conversationStore) await opened.conversationStore.updateSessionMetadata({ chapterMarks })
    else if (opened && this.deps.awaitsStoreBind(opened)) opened.pendingChapterMarks = chapterMarks
  }

  /** Session storage brought up and routed for `sessionId`, for a disk read or
   *  write made without a live store. */
  async routedStorageFor(sessionId: string) {
    // A client that may not open sessions can be the runtime's first reader.
    const hostEnvironment = this.deps.getHostEnvironment()
    if (!this.deps.getStorage() && hostEnvironment?.sessionStoragePath) {
      await this.deps.storageCoordinator.ensureStorage(hostEnvironment.sessionStoragePath)
    }
    const storage = this.deps.getStorage()
    if (!storage) throw new Error('session storage is not available')
    // Grouped storage answers EMPTY from the default dir until the session is routed.
    await this.deps.getGroupedStorage()?.routeSessionFromMeta(sessionId)
    return storage
  }

  /** The transcript a mark is checked against: the live store's (the disk copy
   *  can lag appends in flight), else the persisted one (F-37). */
  async readChapterEntries(sessionId: string): Promise<readonly unknown[]> {
    const store = this.deps.sessions.get(sessionId)?.conversationStore
    if (store) return store.getRecordedMessages()
    return this.deps.readPersistedEntries(sessionId)
  }

  /** A session's stored proposals: from its live store when it has one (the
   *  live store owns the record), else from disk (F-36). */
  async readChildProposals(sessionId: string): Promise<unknown> {
    const store = this.deps.sessions.get(sessionId)?.conversationStore
    if (store) return (await store.getSessionMetadata())?.childProposals
    return (await this.deps.getStorage()?.readSessionMeta(sessionId))?.metadata.childProposals
  }

  async writeChildProposals(
    sessionId: string,
    childProposals: NonNullable<BrowserSessionMetadata['childProposals']>,
  ): Promise<void> {
    const store = this.deps.sessions.get(sessionId)?.conversationStore
    if (store) {
      await store.updateSessionMetadata({ childProposals })
      return
    }
    const storage = this.deps.getStorage()
    if (storage) await applyDiskOnlyMetadataPatch(storage, sessionId, { childProposals })
  }

  /** The session state and storage the child-report queue and the wake read
   *  (F-36). */
  childReportHost(): ChildReportHost {
    const summaryRelation = (sessionId: string): SessionLineageInput | undefined => {
      const summary = this.deps.getFsSummaries().peek(sessionId)
      return summary ? lineageInputFromRelationFields(summary) : undefined
    }
    return {
      wakeGateOpen: () => true,
      liveStore: sessionId => this.deps.sessions.get(sessionId)?.conversationStore ?? null,
      readStoredMeta: async sessionId =>
        (await this.deps.getStorage()?.readSessionMeta(sessionId))?.metadata ?? null,
      patchStoredMeta: (sessionId, patch) => this.deps.patchSessionRecord(sessionId, patch, { touch: true }),
      relationIndex: () => {
        const index = new Map<string, SessionLineageInput>()
        for (const id of this.deps.getFsSummaries().keys()) {
          const relation = summaryRelation(id)
          if (relation) index.set(id, relation)
        }
        return index
      },
      relationOf: summaryRelation,
      sessionExists: sessionId => {
        const summary = this.deps.getFsSummaries().peek(sessionId)
        return (
          summary !== undefined &&
          (summary as { archived?: unknown }).archived !== true &&
          !this.deps.deletingSessions.has(sessionId)
        )
      },
      familyNameOf: sessionId => this.deps.getFsSummaries().peek(sessionId)?.familyName,
      activity: sessionId => {
        const entry = this.deps.sessions.get(sessionId)
        return {
          busy: entry?.worker.isBusy() ?? false,
          needsAnswer: entry?.needsAnswer ?? false,
          starting: this.deps.startStates.get(sessionId)?.state === 'starting',
        }
      },
      parentHold: sessionId => {
        const entry = this.deps.sessions.get(sessionId)
        if (!entry) return 'not_live'
        if (entry.worker.isBusy()) return 'busy'
        if (this.deps.taskDelivery.isSuppressed(sessionId)) return 'stopped'
        if (snapshotNeedsAnswer(entry.worker.getSnapshot())) return 'needs_answer'
        if (this.deps.deletingSessions.has(sessionId)) return 'deleting'
        if (this.deps.getTeams().hasQueuedFrames(sessionId)) return 'queued'
        return null
      },
      finalAssistant: sessionId => {
        const worker = this.deps.sessions.get(sessionId)?.worker
        return {
          text: worker?.getFinalAssistantText?.() ?? '',
          uuid: worker?.getFinalAssistantMessageUuid?.(),
          error: worker?.finalAssistantIsError?.() ?? false,
        }
      },
      enqueueWake: (sessionId, prompt) => {
        const session = this.deps.sessions.get(sessionId)
        if (!session) return false
        session.worker.enqueueSubmit(
          {
            type: 'worker.submitMessage',
            sessionId,
            payload: { prompt, isMeta: true },
          } as SessionWorkerInboundMessage,
          SUBMIT_PRIORITY.mailbox,
          'auto_continuation',
        )
        return true
      },
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
      trace: (event, attrs) => this.deps.tracer.event(event, { attrs }),
      raiseReport: (parentId, input) => {
        const slot = modSlotFor(parentId)
        return slot?.sessionReport && slot.hasSessionReportHooks?.()
          ? slot.sessionReport(input, sanitizeChildReportText)
          : null
      },
      raiseWake: (parentId, input) => {
        const slot = modSlotFor(parentId)
        return slot?.sessionWake && slot.hasSessionWakeHooks?.() ? slot.sessionWake(input) : null
      },
    }
  }
}

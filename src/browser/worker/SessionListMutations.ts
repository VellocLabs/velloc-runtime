import { awaitMemoryExtractions } from '../../memory/extract/extractionRunner'
import { applyDiskOnlyMetadataPatch, applyDiskOnlyRename } from '../../sessions/sessionStore'
import { endProviderSessions } from '../../mods/provider/providerSessionEnd'
import { closeSessionMCPPool } from '../../mcp/sessionPools'
import { hasTemplate } from '../../prompting/templateRegistry'
import { currentRenderCachePolicy } from '../../renderCache/runtimeRenderCache'
import type { CliConversationRecord } from '../../terminal/TerminalService'
import type { SessionWorkerInboundMessage, ForkRetarget } from './sharedWorkerProtocol'
import type { SharedWorkerSessionManager } from './SharedWorkerSessionManager'

type Manager = SharedWorkerSessionManager
type SessionEntry = NonNullable<ReturnType<Manager['sessions']['get']>>

/** The manager state and callbacks the list mutations read; owned by the manager. */
export type SessionListMutationsDeps = {
  sessions: Manager['sessions']
  deletingSessions: Manager['deletingSessions']
  dirtySessionCounters: Manager['dirtySessionCounters']
  legacyStreamEndedSessions: Manager['legacyStreamEndedSessions']
  recoveredRunJs: Manager['recoveredRunJs']
  recoveredBash: Manager['recoveredBash']
  recoveredSuperShell: Manager['recoveredSuperShell']
  recoveredTitles: Manager['recoveredTitles']
  backgroundRecovered: Manager['backgroundRecovered']
  skillEventsWriteTimers: Manager['skillEventsWriteTimers']
  recordedCliConversations: Manager['recordedCliConversations']
  startStates: Manager['startStates']
  panelOfSession: Manager['panelOfSession']
  summaryRepo: Manager['summaryRepo']
  bundles: Manager['bundles']
  taskDelivery: Manager['taskDelivery']
  toolDetailLoader: Manager['toolDetailLoader']
  getStorage: () => Manager['storage']
  getGroupedStorage: () => Manager['groupedStorage']
  getSessionMeta: () => Manager['sessionMeta']
  getFsSummaries: () => Manager['fsSummaries']
  getBootServices: () => Manager['bootServices']
  getCloseTerminalsForSession: () => Manager['closeTerminalsForSession']
  getRuntimeSessionSurface: () => Manager['runtimeSessionSurface']
  getFeed: () => Manager['feed']
  getTeams: () => Manager['teams']
  getChildReports: () => Manager['childReports']
  getProposals: () => Manager['proposals']
  getFamily: () => Manager['family']
  buildSessionInfo: Manager['buildSessionInfo']
  getSubscribersFor: Manager['getSubscribersFor']
  cascadeSubAgentsOnParentClose: Manager['cascadeSubAgentsOnParentClose']
  awaitsStoreBind: Manager['awaitsStoreBind']
  patchSessionRecord: Manager['patchSessionRecord']
  cliConversationStore: Manager['cliConversationStore']
  sessionTerminalCwd: Manager['sessionTerminalCwd']
}

/**
 * Contract: the session-list mutations — delete (queued, one at a time),
 * rename, pin, archive, detach and fork — and the disposal every
 * session-ending path shares. Owns only the delete queue; every map it
 * reads or clears belongs to the manager.
 */
export class SessionListMutations {
  constructor(private readonly deps: SessionListMutationsDeps) {}

  /** The tail of the `session.delete` queue: deletes run one at a time, in arrival order. */
  private sessionDeleteQueue: Promise<void> = Promise.resolve()
  private get sessions() {
    return this.deps.sessions
  }
  private get deletingSessions() {
    return this.deps.deletingSessions
  }
  private get dirtySessionCounters() {
    return this.deps.dirtySessionCounters
  }
  private get legacyStreamEndedSessions() {
    return this.deps.legacyStreamEndedSessions
  }
  private get recoveredRunJs() {
    return this.deps.recoveredRunJs
  }
  private get recoveredBash() {
    return this.deps.recoveredBash
  }
  private get recoveredSuperShell() {
    return this.deps.recoveredSuperShell
  }
  private get recoveredTitles() {
    return this.deps.recoveredTitles
  }
  private get backgroundRecovered() {
    return this.deps.backgroundRecovered
  }
  private get skillEventsWriteTimers() {
    return this.deps.skillEventsWriteTimers
  }
  private get recordedCliConversations() {
    return this.deps.recordedCliConversations
  }
  private get startStates() {
    return this.deps.startStates
  }
  private get panelOfSession() {
    return this.deps.panelOfSession
  }
  private get summaryRepo() {
    return this.deps.summaryRepo
  }
  private get bundles() {
    return this.deps.bundles
  }
  private get taskDelivery() {
    return this.deps.taskDelivery
  }
  private get toolDetailLoader() {
    return this.deps.toolDetailLoader
  }
  private get storage() {
    return this.deps.getStorage()
  }
  private get groupedStorage() {
    return this.deps.getGroupedStorage()
  }
  private get sessionMeta() {
    return this.deps.getSessionMeta()
  }
  private get fsSummaries() {
    return this.deps.getFsSummaries()
  }
  private get bootServices() {
    return this.deps.getBootServices()
  }
  private get closeTerminalsForSession() {
    return this.deps.getCloseTerminalsForSession()
  }
  private get runtimeSessionSurface() {
    return this.deps.getRuntimeSessionSurface()
  }
  private get feed() {
    return this.deps.getFeed()
  }
  private get teams() {
    return this.deps.getTeams()
  }
  private get childReports() {
    return this.deps.getChildReports()
  }
  private get proposals() {
    return this.deps.getProposals()
  }
  private get family() {
    return this.deps.getFamily()
  }
  private get buildSessionInfo() {
    return this.deps.buildSessionInfo
  }
  private get getSubscribersFor() {
    return this.deps.getSubscribersFor
  }
  private get cascadeSubAgentsOnParentClose() {
    return this.deps.cascadeSubAgentsOnParentClose
  }
  private get awaitsStoreBind() {
    return this.deps.awaitsStoreBind
  }
  private get patchSessionRecord() {
    return this.deps.patchSessionRecord
  }
  private get cliConversationStore() {
    return this.deps.cliConversationStore
  }
  private get sessionTerminalCwd() {
    return this.deps.sessionTerminalCwd
  }

  /**
   * Contract: unified session disposal, in fixed order for every delete path: drop queued deliveries,
   * fire the C++ session_deleted stop, clear ports, dispose the worker, remove the entry. Best-effort per step.
   */
  async disposeManagedSession(
    sessionId: string,
    opts: { fireStop?: boolean } = {},
  ): Promise<void> {
    try {
      this.childReports.sessionGone(sessionId, { byPerson: this.deletingSessions.has(sessionId) })
    } catch (err) {
      console.warn('[SharedWorker] child report on disposal failed', err)
    }
    this.taskDelivery.dropParent(sessionId)
    this.dirtySessionCounters.delete(sessionId)
    this.legacyStreamEndedSessions.delete(sessionId)
    this.recoveredRunJs.delete(sessionId)
    this.recoveredBash.delete(sessionId)
    this.recoveredSuperShell.delete(sessionId)
    this.recoveredTitles.delete(sessionId)
    this.backgroundRecovered.delete(sessionId)
    // Flush any pending skill-events write so a debounced burst isn't lost when
    // the session is torn down (the flush no-ops for a deleted session via the
    // storage tombstone guard). The recovery-cache entry is intentionally kept:
    // it holds a resolved read, and the realm-global log persists across a
    // dispose, so a re-open needs no second sidecar read.
    if (this.skillEventsWriteTimers.has(sessionId)) {
      void this.toolDetailLoader.flushSkillEventsPersist(sessionId)
    }
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (opts.fireStop && session.worker.fireSessionDeletedStop) {
      try {
        await session.worker.fireSessionDeletedStop()
      } catch {
        // best-effort; JS-side teardown continues
      }
    }
    await this.disposeSessionWorker(sessionId, session)
    // A stopped sub-agent can be resumed while the old worker is still
    // awaiting native teardown. Never delete a replacement registered under
    // the same session id.
    if (this.sessions.get(sessionId) === session) {
      this.sessions.delete(sessionId)
      this.flushPendingRename(sessionId, session)
      // The feed's prev-snapshot cache is keyed per session and grew an entry
      // for every sub-agent / teammate / routine run (the router refreshes
      // status BEFORE the background interceptors), but only the UI delete
      // path forgot it. Idempotent — the delete path forgets again.
      this.feed.forgetStatus(sessionId)
      // A session removed mid-turn never reports its turn ending.
      currentRenderCachePolicy()?.noteBusyChanged()
    }
  }

  /**
   * A rename or pin stashed for a runtime that never bound is written the disk-only way as the entry goes.
   */
  private flushPendingRename(sessionId: string, entry: SessionEntry): void {
    const pendingPinned = entry.pendingPinned
    if (pendingPinned !== undefined && this.storage) {
      entry.pendingPinned = undefined
      void applyDiskOnlyMetadataPatch(this.storage, sessionId, {
        pinned: pendingPinned,
      })
        .catch(() => false)
        .then(persisted => {
          if (!persisted) this.dropPinnedOverlay(sessionId)
        })
    }
    const pendingChapterMarks = entry.pendingChapterMarks
    if (pendingChapterMarks !== undefined && this.storage) {
      entry.pendingChapterMarks = undefined
      void applyDiskOnlyMetadataPatch(this.storage, sessionId, {
        chapterMarks: pendingChapterMarks,
      }).catch(() => false)
    }
    const pendingRename = entry.pendingRename
    if (pendingRename === undefined || !this.storage) return
    entry.pendingRename = undefined
    void applyDiskOnlyRename(
      this.storage,
      sessionId,
      pendingRename,
      Date.now(),
    ).catch(() => {})
  }

  /** The live overlay stops claiming a pin that never reached storage; the summary falls back to disk. */
  private dropPinnedOverlay(sessionId: string): void {
    const prev = this.sessionMeta.get(sessionId)
    if (!prev || prev.pinned === undefined) return
    const { pinned: _unsaved, ...rest } = prev
    this.sessionMeta.set(sessionId, rest)
    void this.summaryRepo.refreshFsSummary(sessionId).catch(() => {})
  }

  reapSessionEntrySync(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    this.dirtySessionCounters.delete(sessionId)
    this.legacyStreamEndedSessions.delete(sessionId)
    this.sessions.delete(sessionId)
    if (session) {
      this.flushPendingRename(sessionId, session)
      this.taskDelivery.dropParent(sessionId)
      void this.disposeSessionWorker(sessionId, session)
    }
    // See `disposeManagedSession`: a reaped background run must not leave its
    // status cache entry behind.
    this.feed.forgetStatus(sessionId)
  }

  /**
   * The step every session-ending path shares — the awaited dispose and the
   * sync reap alike: detach the ports, end the session's terminals (they
   * belong to the session and die with it, F-31), dispose the worker. The
   * terminals go before the worker's own teardown is awaited, so a path that
   * does not wait still ends them at once. Best-effort.
   */
  private async disposeSessionWorker(sessionId: string, session: SessionEntry): Promise<void> {
    session.ports.clear()
    try {
      this.closeTerminalsForSession(sessionId)
    } catch {
      // best-effort
    }
    try {
      await session.worker.dispose?.()
    } catch {
      // best-effort
    }
  }

  /** A CLI session's recorded conversation and its folder, for erasing it with the session (F-34). */
  private async cliConversationToErase(
    sessionId: string,
  ): Promise<{ record: CliConversationRecord; cwd: string } | undefined> {
    try {
      // What this runtime recorded wins: a store write ahead of its bind can have overwritten it on disk.
      const record =
        this.recordedCliConversations.get(sessionId) ??
        (await this.cliConversationStore()
          .read(sessionId)
          .catch(() => undefined))
      if (!record?.id) return undefined
      // The folder the CLI started in keys its log: the worktree when it runs in one.
      const cwd =
        this.sessionTerminalCwd(sessionId) ??
        this.fsSummaries.peek(sessionId)?.projectRoot ??
        (await this.storage?.readSessionMeta(sessionId))?.metadata?.projectRoot
      return typeof cwd === 'string' && cwd ? { record, cwd } : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Queues a `session.delete` behind the ones already running. Concurrent
   * deletes contend for the session index's lock, and a delete whose row
   * delete loses keeps its files. A failed delete is logged; the queue goes on.
   */
  enqueueSessionDelete(
    port: MessagePort,
    sessionId: string,
    requestId?: string,
  ): Promise<void> {
    const run = this.sessionDeleteQueue.then(() =>
      this.handleSessionDelete(port, sessionId, requestId),
    )
    this.sessionDeleteQueue = run.catch(err => {
      console.warn(`[SharedWorker] delete of ${sessionId} failed`, err)
    })
    return this.sessionDeleteQueue
  }

  async handleSessionDelete(
    port: MessagePort,
    sessionId: string,
    requestId?: string,
  ): Promise<void> {
    this.deletingSessions.add(sessionId)
    // Deleting a lead shuts its teammates down, AWAITED before the storage delete below (their teardown
    // writes under this dir). Ids are collected before the abort: record rows plus running ones.
    const teammateIds = new Set(
      this.teams.listTeammatesOf(sessionId).map(tm => tm.sessionId),
    )
    try {
      try {
        for (const child of (await this.groupedStorage?.listTeammateChildren(
          sessionId,
        )) ?? []) {
          teammateIds.add(child.sessionId)
        }
      } catch {
        // best-effort; the live roster still covers the running children
      }
      await this.teams.abortTeammatesOf(sessionId)
      // What the coordinator remembered about this lead goes with it — after
      // the children's teardown, which is what writes the last of it.
      this.teams.forgetLead(sessionId)

      // Cascade: deleting a parent abandons its in-flight background
      // sub-agents — abort + tear them down so they don't keep running / leak, and
      // drop any results queued for the vanishing parent. AWAITED: the children's
      // transcripts live under the parent dir the
      // storage delete below removes, and each child's worktree cleanup is
      // sequenced after its worker dispose inside the cascade.
      await this.cascadeSubAgentsOnParentClose(sessionId)

      // Read while the session's metadata is still there; erased once its CLI is gone.
      const cliLog = await this.cliConversationToErase(sessionId)

      // Unified disposal (drop deliveries, fire C++ stop, clear ports,
      // dispose worker, remove entry).
      await this.disposeManagedSession(sessionId, { fireStop: true })
      if (cliLog) await this.bootServices.terminals.eraseCliConversation(cliLog.record, cliLog.cwd)
      this.recordedCliConversations.delete(sessionId)
      this.sessionMeta.delete(sessionId)
      this.fsSummaries.delete(sessionId)
      this.startStates.delete(sessionId)
      this.family.forget(sessionId)
      this.proposals.forget(sessionId)
      this.toolDetailLoader.forgetSkillEvents(sessionId)
      // Written on every `session.open`; this is its only removal.
      this.panelOfSession.delete(sessionId)
      this.runtimeSessionSurface?.dropSessionTopics(sessionId)

      // A deleted session must not leave its prev-snapshot cache
      // behind, so nothing stale can re-emit for the dead id.
      this.feed.forgetStatus(sessionId)

      // Provider mods: `provider.sessionEnd` in the modules that hook it, then
      // the session's provider stores go (5 s at most, never rejects; a no-op in
      // a realm with no provider mod). The teammates' sessions end with the lead.
      await endProviderSessions([sessionId, ...teammateIds])
      // The session's MCP servers stop now rather than after the release grace.
      void closeSessionMCPPool(sessionId)

      if (this.storage) {
        // A background extract fork spawned by this session's last turn may
        // still be mid-flight, appending its sidechain transcript under the
        // session dir the delete below removes. Give it a bounded window to
        // finish (memory writes land in the memory dir, so this mainly
        // prevents the fork erroring against vanished storage). The timeout
        // is short — a
        // user-initiated delete must not hang on a slow model call.
        try {
          await awaitMemoryExtractions(5_000)
        } catch {
          // drain is best-effort; deletion proceeds regardless
        }
        try {
          await this.storage.deleteSession(sessionId)
        } catch (err) {
          // The in-memory state is already gone; the files stay with the
          // surviving row, and the session lists again on the next start.
          console.warn(`[SharedWorker] storage delete of ${sessionId} failed`, err)
        }
        // Cascade the meta ROWS of this session's teammates. Their FILES are
        // already gone — they live under the directory just removed — but the
        // rows are in the one global sessions DB and would otherwise leak:
        // never listed (their parent no longer exists) and never removed.
        try {
          await this.groupedStorage?.deleteMetaByParent(sessionId)
        } catch {
          // best-effort; an orphan row is hidden, not harmful
        }
      }

      // A write that landed while the delete awaited must not outlive it.
      this.sessionMeta.delete(sessionId)
      this.fsSummaries.delete(sessionId)
    } finally {
      // A throw above leaves the session alive; its pins must not stay refused.
      this.deletingSessions.delete(sessionId)
    }

    const removedMessage = {
      type: 'session.removed' as const,
      payload: { sessionId, ...(requestId ? { requestId } : {}) },
    }
    // Only the ports that asked (either targeted or 'all') learn about the
    // removal. Ports with no interest in this session don't get woken up.
    const targets = new Set<MessagePort>(this.getSubscribersFor(sessionId))
    if (requestId) targets.add(port)
    for (const p of targets) {
      p.postMessage(removedMessage)
    }
    // The children went with the lead — their files under its directory, their
    // rows via `deleteMetaByParent` — but only the lead was announced, so the
    // tab strip kept a child the user could click into a teammate id with no
    // storage behind it, and the children's summaries stayed cached here and in
    // every client list until a restart. Each one is dropped and announced like
    // a session of its own, to its own subscribers and to whoever learned of
    // the lead's removal.
    teammateIds.delete(sessionId)
    for (const teammateId of teammateIds) {
      this.sessionMeta.delete(teammateId)
      this.fsSummaries.delete(teammateId)
      this.panelOfSession.delete(teammateId)
      this.runtimeSessionSurface?.dropSessionTopics(teammateId)
      this.feed.forgetStatus(teammateId)
      this.toolDetailLoader.forgetSkillEvents(teammateId)
      const childRemoved = {
        type: 'session.removed' as const,
        payload: { sessionId: teammateId },
      }
      const childTargets = new Set<MessagePort>([
        ...targets,
        ...this.getSubscribersFor(teammateId),
      ])
      for (const p of childTargets) {
        p.postMessage(childRemoved)
      }
    }
  }

  /**
   * Rename via a manual `customTitle`; ONLY the bound store writes `meta.json` while a runtime is bound
   * (pre-bind: stashed; no runtime: `applyDiskOnlyRename`). `customTitle` wins at every read; empty clears it.
   */
  async handleSessionRename(
    port: MessagePort,
    sessionId: string,
    title: string,
    requestId?: string,
  ): Promise<void> {
    const trimmed = title.trim()
    const entry = this.sessions.get(sessionId)

    // A manual rename supersedes any in-flight auto-title generation: tell the
    // live worker to abort its fast-model title call so it doesn't land and
    // race the user's choice. (The `/rename` command path cancels in-engine;
    // this covers the sidebar `session.rename` path.)
    if (entry) {
      const cancelMessage: SessionWorkerInboundMessage = {
        type: 'worker.cancelAutoTitle',
        sessionId,
      }
      void entry.worker.receiveFrame(cancelMessage)
    }

    if (entry?.conversationStore) {
      // Live session: route through the store, which logs ONE `custom-title`
      // record and rewrites `meta.json`.
      try {
        await entry.conversationStore.storeUserTitle(trimmed, 'user')
      } catch {
        // best-effort; the live overlay + broadcast below still reflect it
      }
    } else if (entry && this.awaitsStoreBind(entry)) {
      // Runtime exists, store not bound yet: the store already loaded its
      // state, so a disk write here would be overwritten by its first persist.
      // Stash it; `bindSessionRuntime` applies it through the store.
      entry.pendingRename = trimmed
    } else if (this.storage) {
      // Disk-only session (no live worker): fresh read-modify-write of
      // `meta.json` plus one `custom-title` log record, shared with the store's
      // own rename path so the two writers cannot drift. The session's
      // project dir must be KNOWN first — before the routing scan has mapped
      // it, the grouped storage would probe the default dir, find nothing,
      // and the rename would be silently dropped.
      let persisted = false
      try {
        await this.summaryRepo.ensureSessionRouting()
        persisted = await applyDiskOnlyRename(
          this.storage,
          sessionId,
          trimmed,
          Date.now(),
        )
      } catch {
        // best-effort
      }
      if (!persisted) {
        // Nothing on disk describes this session (or it could not be read):
        // there is nothing to rename. Do not paint the overlay with a title
        // that has no durable counterpart — the row keeps its real title.
        console.warn(
          `[SharedWorkerSessionManager] rename of ${sessionId} not persisted: ` +
            'no meta.json or transcript found for it',
        )
        return
      }
    }

    // Reflect the rename in the live overlay immediately (before the fs
    // round-trip in refreshFsSummary lands) so an open session's row
    // updates without waiting on disk. A cleared rename writes the `null`
    // TOMBSTONE — `undefined` would let the projection fall
    // back to the fs cache's old title until the refresh below lands.
    const prev = this.sessionMeta.get(sessionId) ?? {}
    this.sessionMeta.set(sessionId, {
      ...prev,
      customTitle: trimmed.length > 0 ? trimmed : null,
    })

    // Re-read the persisted summary (now carrying customTitle) into the LRU
    // and broadcast session.updated to subscribers.
    await this.summaryRepo.refreshFsSummary(sessionId)

    // Ack the requesting port even if it isn't a session subscriber, so an
    // optimistic UI can reconcile (mirrors handleSessionDelete's ack).
    if (requestId) {
      const session = this.buildSessionInfo(sessionId)
      if (session) {
        port.postMessage({
          type: 'session.updated' as const,
          payload: { session },
        })
      }
    }
  }

  /**
   * The person archives or unarchives a session from the list (F-36). The
   * family coordinator applies the archive rule and writes the flag; the list
   * learns it from the summary refresh. A refusal leaves the row where it is;
   * the asking port gets the unchanged card back.
   */
  async handleSessionArchive(
    port: MessagePort,
    sessionId: string,
    archived: boolean,
    requestId?: string,
  ): Promise<void> {
    if (this.deletingSessions.has(sessionId)) return
    let refused: string | undefined
    try {
      const outcome = await this.family.setArchivedByUser(sessionId, archived)
      if (!outcome.ok) refused = `${outcome.code}: ${outcome.reason}`
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error)
    }
    if (refused === undefined) return
    console.warn(`[SharedWorkerSessionManager] archive of ${sessionId} refused: ${refused}`)
    if (!requestId) return
    const session = this.buildSessionInfo(sessionId)
    if (session) port.postMessage({ type: 'session.updated' as const, payload: { session } })
  }

  /**
   * Pin or unpin a session by writing `pinned` into its metadata, through the
   * same three owners as a rename: the bound store, the pre-bind stash, or a
   * disk-only write of `meta.json`.
   */
  async handleSessionPin(
    port: MessagePort,
    sessionId: string,
    pinned: boolean,
    requestId?: string,
  ): Promise<void> {
    if (this.deletingSessions.has(sessionId)) {
      console.warn(`[SharedWorkerSessionManager] pin of ${sessionId} refused: it is being deleted`)
      return
    }
    const entry = this.sessions.get(sessionId)
    if (entry?.conversationStore) {
      // This choice supersedes a pre-bind stash, so a bind still in flight
      // does not write the older value after it.
      entry.pendingPinned = undefined
      try {
        await entry.conversationStore.updateSessionMetadata({ pinned })
      } catch (error) {
        console.warn(`[SharedWorkerSessionManager] pin of ${sessionId} not persisted`, error)
        return
      }
    } else if (entry && this.awaitsStoreBind(entry)) {
      entry.pendingPinned = pinned
    } else if (this.storage) {
      let persisted = false
      try {
        await this.summaryRepo.ensureSessionRouting()
        persisted = await applyDiskOnlyMetadataPatch(this.storage, sessionId, {
          pinned,
        })
      } catch {
        // best-effort
      }
      if (!persisted) {
        console.warn(
          `[SharedWorkerSessionManager] pin of ${sessionId} not persisted: ` +
            'no meta.json or transcript found for it',
        )
        return
      }
      // A runtime that opened during the write loaded the sidecar without the
      // pin; hand it the value so its own next save keeps it.
      const opened = this.sessions.get(sessionId)
      if (opened?.conversationStore) {
        await opened.conversationStore
          .updateSessionMetadata({ pinned })
          .catch(() => {})
      } else if (opened && this.awaitsStoreBind(opened)) {
        opened.pendingPinned = pinned
      }
    }

    const prev = this.sessionMeta.get(sessionId) ?? {}
    this.sessionMeta.set(sessionId, { ...prev, pinned })
    await this.summaryRepo.refreshFsSummary(sessionId)

    if (requestId) {
      const session = this.buildSessionInfo(sessionId)
      if (session) {
        port.postMessage({
          type: 'session.updated' as const,
          payload: { session },
        })
      }
    }
  }

  /**
   * Take a session out from under its parent: persist `lineageDetached` on the
   * live store or in meta.json, refresh the summary, ack with the card. (F-36)
   */
  async handleSessionDetach(
    port: MessagePort,
    sessionId: string,
    requestId?: string,
  ): Promise<void> {
    if (this.deletingSessions.has(sessionId)) return
    try {
      await this.summaryRepo.ensureSessionRouting()
      await this.patchSessionRecord(sessionId, { lineageDetached: true })
    } catch (error) {
      console.warn(`[SharedWorkerSessionManager] detach of ${sessionId} not persisted`, error)
      return
    }
    if (requestId) {
      const session = this.buildSessionInfo(sessionId)
      if (session) {
        port.postMessage({ type: 'session.updated' as const, payload: { session } })
      }
    }
  }

  /**
   * Fork a session at `cutUuid` into a NEW session (prefix copied via `buildForkedTranscriptEntries`,
   * sidecars copied), refresh its summary and ack. Best-effort: no ack on failure.
   */
  async handleSessionFork(
    port: MessagePort,
    fromSessionId: string,
    cutUuid: string | undefined,
    requestId?: string,
    moveCutMessageToDraft?: boolean,
    title?: string,
    replacesSource?: boolean,
    retarget?: ForkRetarget,
    sideChat?: { enabled: boolean; initialDraft?: string },
  ): Promise<void> {
    if (retarget && !hasTemplate(retarget.templateType)) {
      console.warn('[nexus] fork skipped: unknown template type', retarget.templateType)
      return
    }
    try {
      const forked = await this.bundles.forkSessionCore(fromSessionId, cutUuid, {
        moveCutMessageToDraft,
        title,
        replacesSource,
        retarget,
        sideChat,
        personFork: true,
      })
      if (!forked) return
      port.postMessage({
        type: 'session.forked' as const,
        payload: { fromSessionId, newSessionId: forked.newSessionId, requestId },
      })
    } catch (error) {
      // No ack means no fork happened.
      console.warn('[nexus] fork failed', fromSessionId, error)
    }
  }
}

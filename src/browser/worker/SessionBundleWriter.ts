import { SUBAGENT_TASK_FILE_NAME } from './subAgentTaskFile'
import { getNexusWorkspaceDirForType, projectHomeFor } from '../../utils/conversationStoragePaths'
import type { SessionStorageCoordinator } from './SessionStorageCoordinator'
import type { SessionSummaryRepository } from './SessionSummaryRepository'
import type { BrowserSessionMetadata, BrowserTranscriptWriteEntry, SessionMetaFile } from '../../sessions/sessionStore'
import { buildForkedTranscriptEntries, modelForkCut } from '../../sessions/sessionStore'
import { personForkOrigin } from '../../sessions/sessionLineage'
import { CHILD_SESSION_TEMPLATE_TYPES } from '../../sessions/childSessionSpec'
import type { BrowserToolCallDetailRecord } from '../../utils/toolCallDetails'
import { DEFAULT_TEMPLATE_TYPE } from './workerProtocol'
import type { ForkRetarget } from './sharedWorkerProtocol'
import { templateChannel } from '../../prompting/templateCatalog'
import { type SessionMode } from '../../permissions/sessionModes'

/**
 * Contract: writes complete sessions to storage (log, `meta.json`, sidecars)
 * and copies a session's prefix into a fork. Owns no state; reads storage
 * routing through the storage coordinator and publishes through the summary
 * repository. Shared by fork, child sessions (F-36) and session import.
 */
export class SessionBundleWriter {
  constructor(
    private readonly storageCoordinator: SessionStorageCoordinator,
    private readonly summaryRepo: SessionSummaryRepository,
  ) {}

  private get storage() {
    return this.storageCoordinator.getStorage()
  }
  private get groupedStorage() {
    return this.storageCoordinator.getGroupedStorage()
  }
  private get homeDir() {
    return this.storageCoordinator.getHomeDir()
  }

  /**
   * The fork itself: copy the prefix, the sidecars and the carried config into
   * a NEW session and publish it. `metadataPatch` is written into the copy's
   * record (a child session's origin). Null when there is nothing to copy;
   * throws when the write fails.
   */
  async forkSessionCore(
    fromSessionId: string,
    cutUuid: string | undefined,
    opts: {
      moveCutMessageToDraft?: boolean
      title?: string
      replacesSource?: boolean
      retarget?: ForkRetarget
      sideChat?: { enabled: boolean; initialDraft?: string }
      metadataPatch?: Partial<BrowserSessionMetadata>
      resolvePermissionMode?: () => SessionMode
      /** A person's own fork: it records the person as its origin (F-36). */
      personFork?: boolean
    },
  ): Promise<{ newSessionId: string } | null> {
    const storage = this.storage
    if (!storage) return null
    const { moveCutMessageToDraft, title, replacesSource, retarget, sideChat } = opts
    {
      const payload = await storage.load(fromSessionId)
      const sourceEntries = Array.isArray(payload) ? payload : []
      if (sourceEntries.length === 0) {
        console.warn('[nexus] fork skipped: the source has no saved messages', fromSessionId)
        return null
      }
      const newSessionId =
        globalThis.crypto?.randomUUID?.() ??
        `fork-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`
      // Carry the source session's config (type / bound folder / title / model /
      // permission mode) into the fork so the copy is a faithful duplicate, not
      // a reset-to-default thread — the same tail read the rename flow trusts.
      // Transcript-derived fields are recomputed from the cut prefix.
      const loadedMetadata =
        (await storage.loadSessionMetadata?.(fromSessionId)) ?? undefined
      const sourceMetadata = retarget
        ? { ...loadedMetadata, templateType: retarget.templateType, projectRoot: retarget.projectRoot }
        : loadedMetadata
      const built = buildForkedTranscriptEntries(
        sourceEntries,
        cutUuid,
        newSessionId,
        Date.now(),
        sourceMetadata,
        // Carry the source id so the fork copies its plan file on init.
        fromSessionId,
        // "Fork from here" cuts EXCLUSIVE, re-opens the cut prompt in the
        // fork's composer, and names the copy after the source ("<title>
        // (fork)", localized by the page); rewind keeps the inclusive cut and
        // the source's exact title.
        {
          moveCutMessageToDraft,
          title,
          ...(replacesSource ? { as: 'rewind' as const } : {}),
          ...(sideChat?.enabled ? { sideChat: true } : {}),
          ...(sideChat?.initialDraft ? { composerDraft: sideChat.initialDraft } : {}),
        },
      )
      if (!built) {
        console.warn('[nexus] fork skipped: no message to cut at', fromSessionId)
        return null
      }
      // A plain fork of a session that can have children reports its turns
      // to the source as the person's relation; a rewind or a retarget is a
      // replacement, not a child, and a side chat records no origin.
      const personOrigin =
        opts.personFork === true &&
        !replacesSource &&
        !retarget &&
        sideChat?.enabled !== true &&
        templateChannel() === 'beta' &&
        CHILD_SESSION_TEMPLATE_TYPES.includes(sourceMetadata?.templateType ?? '')
          ? { spawnedFrom: personForkOrigin(fromSessionId) }
          : undefined
      const patch = { ...personOrigin, ...opts.metadataPatch }
      if (Object.keys(patch).length > 0) {
        built.meta = {
          ...built.meta,
          metadata: { ...built.meta.metadata, ...patch },
        }
      }
      // Tool details are lazy-loaded per session by toolCallId; copy the
      // referenced sidecars so the fork's tool cards don't get stuck loading.
      const toolDetails: BrowserToolCallDetailRecord[] = []
      for (const toolCallId of built.toolCallIds) {
        try {
          const detail = await storage.loadToolCallDetail?.(
            fromSessionId,
            toolCallId,
          )
          if (detail) toolDetails.push(detail)
        } catch {
          // best-effort; a missing sidecar just leaves that card to lazy-load
        }
      }
      // The fork is written BEFORE the new session's worker.init runs, so it
      // is routed to the source's project dir (else the effective one for its
      // type/folder) up front — see `writeSessionBundle`.
      if (opts.resolvePermissionMode) {
        built.meta.metadata.permissionMode = opts.resolvePermissionMode()
      }
      await this.writeSessionBundle({
        sessionId: newSessionId,
        entries: built.entries,
        meta: built.meta,
        toolDetails,
        // A retargeted copy lives with its new folder, not its source.
        projectDir: retarget ? undefined : this.groupedStorage?.projectRouteOf(fromSessionId),
        projectRoot: sourceMetadata?.projectRoot,
        templateType: sourceMetadata?.templateType,
      })
      return { newSessionId }
    }
  }

  /** Where a model's fork of `parentSessionId` would be cut (F-36). */
  async planModelFork(
    parentSessionId: string,
  ): Promise<{ ok: true; cutUuid: string } | { ok: false; reason: string }> {
    const storage = this.storage
    if (!storage) return { ok: false, reason: 'session storage is not available.' }
    const payload = await storage.load(parentSessionId)
    const sourceEntries = Array.isArray(payload) ? payload : []
    return modelForkCut(sourceEntries)
  }

  /** A child session forked from `parentSessionId` at `cutUuid`, its record
   *  carrying `patch` (F-36). */
  async forkForChild(
    parentSessionId: string,
    cutUuid: string,
    patch: Partial<BrowserSessionMetadata>,
    title: string,
    resolvePermissionMode: () => SessionMode,
  ): Promise<{ ok: true; sessionId: string } | { ok: false; reason: string }> {
    try {
      const forked = await this.forkSessionCore(parentSessionId, cutUuid, {
        title,
        metadataPatch: patch,
        resolvePermissionMode,
      })
      return forked
        ? { ok: true, sessionId: forked.newSessionId }
        : { ok: false, reason: 'the cut message is not in the saved transcript.' }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Write a COMPLETE session (log, `meta.json`, sidecars) and publish it; shared by fork and import.
   * Order: route the id first, then the log, the projection, the sidecars, the summary refresh.
   * `projectDir` wins when given, else derived as `worker.init` would.
   */
  async writeSessionBundle(args: {
    sessionId: string
    entries: readonly BrowserTranscriptWriteEntry[]
    meta: SessionMetaFile
    toolDetails: readonly BrowserToolCallDetailRecord[]
    projectDir?: string
    projectRoot?: string
    templateType?: string
    /** Skip the summary refresh / `session.updated` broadcast. For sessions
     *  the sidebar must NOT list (a background sub-agent's own session). */
    publish?: boolean
  }): Promise<void> {
    const storage = this.storage
    if (!storage) {
      throw new Error('session storage is not available')
    }
    if (this.groupedStorage) {
      const projectDir =
        args.projectDir ??
        (this.homeDir
          ? projectHomeFor(
              this.homeDir,
              args.projectRoot ??
                getNexusWorkspaceDirForType(
                  this.homeDir,
                  args.templateType ?? DEFAULT_TEMPLATE_TYPE,
                ),
            )
          : undefined)
      if (projectDir) {
        this.groupedStorage.setSessionProjectDir(args.sessionId, projectDir)
      }
    }
    for (const entry of args.entries) {
      await storage.append(args.sessionId, entry)
    }
    await storage.writeSessionMeta(args.sessionId, args.meta)
    for (const detail of args.toolDetails) {
      try {
        await storage.saveToolCallDetail?.(args.sessionId, detail)
      } catch {
        // best-effort; a missing sidecar just leaves that card to lazy-load
      }
    }
    if (args.publish !== false) {
      await this.summaryRepo.refreshFsSummary(args.sessionId)
    }
  }

  /**
   * Write an IMPORTED sub-agent as a finished background sub-agent of `spawnerSessionId` (bundle under
   * `<projectDir>/<parent>/subagents/<sessionId>/` + `task.json`); nothing is published. Commits the
   * parent's routing from the sub-agent's `projectRoot`; without one it throws.
   */
  async writeSubAgentBundle(
    spawnerSessionId: string,
    bundle: {
      sessionId: string
      entries: readonly BrowserTranscriptWriteEntry[]
      meta: SessionMetaFile
      toolDetails: readonly BrowserToolCallDetailRecord[]
      task: Record<string, unknown>
    },
  ): Promise<void> {
    let subagentsDir =
      this.storageCoordinator.getSubAgentsDirForParent(spawnerSessionId)
    if (!subagentsDir) {
      const projectRoot = bundle.meta.metadata?.projectRoot
      if (this.groupedStorage && this.homeDir && projectRoot) {
        this.groupedStorage.setSessionProjectDir(
          spawnerSessionId,
          projectHomeFor(this.homeDir, projectRoot),
        )
        subagentsDir =
          this.storageCoordinator.getSubAgentsDirForParent(spawnerSessionId)
      }
    }
    if (!subagentsDir) {
      throw new Error('parent session is not routed; write it first')
    }
    await this.writeSessionBundle({
      sessionId: bundle.sessionId,
      entries: bundle.entries,
      meta: bundle.meta,
      toolDetails: bundle.toolDetails,
      projectDir: subagentsDir,
      publish: false,
    })
    await this.storageCoordinator.writeSubAgentTaskFile(
      spawnerSessionId,
      bundle.sessionId,
      SUBAGENT_TASK_FILE_NAME,
      JSON.stringify(bundle.task),
    )
  }
}

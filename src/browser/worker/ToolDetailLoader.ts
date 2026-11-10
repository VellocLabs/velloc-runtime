import { getAllSkillInvocationEvents, seedSkillInvocationEvents, clearSkillInvocationLogForSession } from '../../skillLibrary/skillInvocationLog'
import { mintTaskHandle } from '../../backgroundTasks/taskId'
import type { BrowserToolCallDetailRecord } from '../../utils/toolCallDetails'
import { PLUGIN_TASK_DIR, pluginTaskRecordFromFile } from './PluginTaskCoordinator'
import { isSubAgentSessionId } from './taskProjection'
import type { FinishedSubAgentRecord } from './taskTypes'
import type { RunJsSidecarDetail, SuperShellSidecarDetail } from './TaskControlSurface'
import { SUBAGENT_TASK_FILE_NAME, parseSubAgentTaskFile, finishedRecordFromTaskFile, finishedRecordFromSessionMeta } from './subAgentTaskFile'
import { SHELL_LAUNCH_TOOL_IDS, extractRecoveredBashRows } from './recoverBashRows'
import { extractRecoveredRunJsRows } from './recoverRunJsRows'
import { extractRecoveredTitleRows } from './recoverTitleRows'
import { extractRecoveredSuperShellRows, parseSuperShellDetachedTaskId, parseSuperShellTaskOutputResult, resolveRecoveredSuperShellRows } from './recoverSuperShellRows'
import type { SharedWorkerSessionManager } from './SharedWorkerSessionManager'

type Manager = SharedWorkerSessionManager

// Super Edit's wire name. Inline literal (matching `SUPER_EDIT_TOOL_NAME` in
// browser/runJs/runJsProtocol.ts) for the same reason the renderer utils
// inline theirs — this module has no business importing a tool module.
const SUPER_EDIT_TOOL_NAME = 'SuperEdit'
// SuperShell's wire name — same inline-literal rule (`SUPER_SHELL_TOOL_NAME`).
const SUPER_SHELL_TOOL_NAME = 'SuperShell'

/** Coalesce window for `skill-events.json` writes: several invocations in one
 *  turn collapse into a single truncate-and-rewrite of the capped log. */
const SKILL_EVENTS_WRITE_COALESCE_MS = 250

/** The manager state and callbacks the loader reads; owned by the manager. */
export type ToolDetailLoaderDeps = {
  sessions: Manager['sessions']
  portHub: Manager['portHub']
  toolDetails: Manager['toolDetails']
  recoveredRunJs: Manager['recoveredRunJs']
  recoveredBash: Manager['recoveredBash']
  recoveredSuperShell: Manager['recoveredSuperShell']
  recoveredTitles: Manager['recoveredTitles']
  lifetimeStartedAt: Manager['lifetimeStartedAt']
  backgroundRecoveries: Manager['backgroundRecoveries']
  skillEventsWriteTimers: Manager['skillEventsWriteTimers']
  skillEventsRecovery: Manager['skillEventsRecovery']
  storageCoordinator: Manager['storageCoordinator']
  getStorage: () => Manager['storage']
  getFsSummaries: () => Manager['fsSummaries']
  taskRegistry: Manager['taskRegistry']
  pluginTaskRestores: Manager['pluginTaskRestores']
  getFeed: () => Manager['feed']
  getPluginTasks: () => Manager['pluginTasks']
  getSubAgents: () => Manager['subAgents']
  notifyToolDetailReady: Manager['notifyToolDetailReady']
}

/**
 * Contract: answers tool-call detail requests (cache, then the sessions'
 * sidecars on disk), rebuilds restart-recovered drawer rows from loaded
 * transcripts, persists and restores the Skills-tab event log, and restores a
 * parent's finished sub-agents and plugin tasks from disk. Owns no state
 * except the restored-parent guard; every map it fills belongs to the manager.
 */
export class ToolDetailLoader {
  constructor(private readonly deps: ToolDetailLoaderDeps) {}

  private get sessions() {
    return this.deps.sessions
  }
  private get portHub() {
    return this.deps.portHub
  }
  private get toolDetails() {
    return this.deps.toolDetails
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
  private get lifetimeStartedAt() {
    return this.deps.lifetimeStartedAt
  }
  private get backgroundRecoveries() {
    return this.deps.backgroundRecoveries
  }
  private get skillEventsWriteTimers() {
    return this.deps.skillEventsWriteTimers
  }
  private get skillEventsRecovery() {
    return this.deps.skillEventsRecovery
  }
  private get storageCoordinator() {
    return this.deps.storageCoordinator
  }
  private get taskRegistry() {
    return this.deps.taskRegistry
  }
  private get pluginTaskRestores() {
    return this.deps.pluginTaskRestores
  }
  private get storage() {
    return this.deps.getStorage()
  }
  private get fsSummaries() {
    return this.deps.getFsSummaries()
  }
  private get feed() {
    return this.deps.getFeed()
  }
  private get pluginTasks() {
    return this.deps.getPluginTasks()
  }
  private get subAgents() {
    return this.deps.getSubAgents()
  }
  private notifyToolDetailReady(
    ...args: Parameters<Manager['notifyToolDetailReady']>
  ): void {
    this.deps.notifyToolDetailReady(...args)
  }

  handleToolDetailSubscribe(
    port: MessagePort,
    toolCallIds: string[],
    sessionIdHint: string | undefined,
  ): void {
    this.portHub.subscribeToolDetail(port, toolCallIds)
    for (const toolCallId of toolCallIds) {
      // Immediate flush from cache so the UI doesn't wait if the detail
      // is already known. `null` cached means "looked and nothing there"
      // — still a valid terminal answer.
      if (this.toolDetails.has(toolCallId)) {
        port.postMessage({
          type: 'toolDetail.ready',
          payload: {
            toolCallId,
            detail: this.toolDetails.get(toolCallId) ?? null,
          },
        })
        continue
      }

      // Not cached — try to pull it from disk. If the session isn't
      // known we try every known session (cheap: it's one stat per).
      void this.lookupToolDetailFromDisk(toolCallId, sessionIdHint)
    }
  }

  handleToolDetailUnsubscribe(
    port: MessagePort,
    toolCallIds: string[],
  ): void {
    this.portHub.unsubscribeToolDetail(port, toolCallIds)
  }

  private async lookupToolDetailFromDisk(
    toolCallId: string,
    sessionIdHint: string | undefined,
  ): Promise<void> {
    const storage = this.storage
    if (!storage) return

    const candidates: string[] = []
    if (sessionIdHint) candidates.push(sessionIdHint)
    for (const sessionId of this.sessions.keys()) {
      if (sessionId !== sessionIdHint) candidates.push(sessionId)
    }
    for (const sessionId of this.fsSummaries.keys()) {
      if (!candidates.includes(sessionId)) candidates.push(sessionId)
    }

    for (const sessionId of candidates) {
      try {
        const detail = await storage.loadToolCallDetail(sessionId, toolCallId)
        if (detail) {
          this.toolDetails.set(toolCallId, detail)
          this.notifyToolDetailReady(toolCallId, detail)
          return
        }
      } catch {
        // try the next candidate
      }
    }

    // Not on disk (yet). Leave the subscription open and DO NOT push
    // `null` — a still-running tool call will produce the sidecar later
    // via `worker.toolDetailPersisted`, and we want the UI to see that
    // instead of a premature terminal-null. The UI's own timeout is the
    // only escape hatch for "this truly doesn't exist."
  }

  /**
   * Recover a SuperEdit's persisted detail for the drawer when its registry record is gone, by tool call
   * id (cache, then candidate sessions). Null when absent or not a SuperEdit call.
   */
  async loadRunJsSidecar(
    toolCallId: string,
  ): Promise<RunJsSidecarDetail | null> {
    const storage = this.storage
    if (!storage?.loadToolCallDetail) return null

    let detail: BrowserToolCallDetailRecord | null =
      this.toolDetails.get(toolCallId) ?? null
    if (!detail) {
      const candidates: string[] = []
      const push = (sessionId: string | null | undefined): void => {
        if (sessionId && !candidates.includes(sessionId)) {
          candidates.push(sessionId)
        }
      }
      push(this.sessionOfRecoveredCall(toolCallId))
      for (const sessionId of this.sessions.keys()) push(sessionId)
      for (const sessionId of this.fsSummaries.keys()) push(sessionId)
      for (const sessionId of candidates) {
        try {
          detail = await storage.loadToolCallDetail(sessionId, toolCallId)
        } catch {
          detail = null
        }
        if (detail) break
      }
    }

    if (!detail || detail.toolName !== SUPER_EDIT_TOOL_NAME) return null
    const args =
      detail.args && typeof detail.args === 'object'
        ? (detail.args as Record<string, unknown>)
        : {}
    const path = typeof args.path === 'string' ? args.path : undefined
    const resultText =
      typeof detail.result === 'string'
        ? detail.result
        : detail.result != null
          ? JSON.stringify(detail.result)
          : undefined
    return {
      code: typeof args.code === 'string' ? args.code : '',
      description:
        typeof args.description === 'string' ? args.description : undefined,
      path,
      inputs:
        args.inputs && typeof args.inputs === 'object' && !Array.isArray(args.inputs)
          ? (args.inputs as Record<string, unknown>)
          : undefined,
      timeoutSec: typeof args.timeoutSec === 'number' ? args.timeoutSec : undefined,
      inlineCode: !path,
      resultText,
    }
  }

  /**
   * Recover a SuperShell call's persisted detail for the drawer by tool call id, preferring the run's
   * own recovered result over the hand-off. Null when absent or not a SuperShell call.
   */
  async loadSuperShellSidecar(
    toolCallId: string,
  ): Promise<SuperShellSidecarDetail | null> {
    const detail = await this.loadToolCallDetailAcrossSessions(toolCallId)
    if (!detail || detail.toolName !== SUPER_SHELL_TOOL_NAME) return null
    const args =
      detail.args && typeof detail.args === 'object'
        ? (detail.args as Record<string, unknown>)
        : {}
    const callResult =
      typeof detail.result === 'string'
        ? detail.result
        : detail.result != null
          ? JSON.stringify(detail.result)
          : undefined
    const resultText =
      callResult !== undefined && parseSuperShellDetachedTaskId(callResult) !== null
        ? ((await this.recoveredSuperShellResult(toolCallId)) ?? callResult)
        : callResult
    return {
      code: typeof args.code === 'string' ? args.code : '',
      description:
        typeof args.description === 'string' ? args.description : undefined,
      inputs:
        args.inputs && typeof args.inputs === 'object' && !Array.isArray(args.inputs)
          ? (args.inputs as Record<string, unknown>)
          : undefined,
      resultText,
    }
  }

  /**
   * The result of a detached SuperShell run that restart recovery found — from
   * its `<task-notification>`, or from the TaskOutput call that read it — else
   * undefined. Waits for recoveries still in flight first: a card's jump asks for
   * the detail while the drawer, opening, recovers the rows, and a detail loaded
   * before that ends would show the hand-off.
   */
  private async recoveredSuperShellResult(
    toolCallId: string,
  ): Promise<string | undefined> {
    await Promise.allSettled(this.backgroundRecoveries.values())
    for (const rows of this.recoveredSuperShell.values()) {
      const row = rows.find(r => r.callId === toolCallId)
      if (!row) continue
      if (row.resultText !== undefined) return row.resultText
      if (!row.resultDetailId) return undefined
      const read = await this.loadToolCallDetailAcrossSessions(row.resultDetailId)
      return typeof read?.result === 'string'
        ? parseSuperShellTaskOutputResult(read.result)?.resultText
        : undefined
    }
    return undefined
  }

  /**
   * Rebuild `sessionId`'s recovered run_js drawer rows from a full
   * transcript emission. Registry-known ids are NOT filtered here (the map
   * is rebuilt only on full loads, but a run can start/finish after it) —
   * the publisher filters at read time, where the registry state is
   * current.
   */
  recoverRunJsRowsFromTranscript(
    sessionId: string,
    messages: unknown[],
  ): void {
    const rows = extractRecoveredRunJsRows(messages)
    const prev = this.recoveredRunJs.get(sessionId)
    if (rows.length === 0) {
      if (!prev) return
      this.recoveredRunJs.delete(sessionId)
    } else {
      this.recoveredRunJs.set(sessionId, rows)
    }
    this.feed.scheduleSummary()
  }

  /**
   * Rebuild `sessionId`'s recovered session-title rows from the transcript's
   * stored titles — those written before this worker lifetime (see
   * `recoveredTitles`).
   */
  recoverTitleRowsFromTranscript(
    sessionId: string,
    messages: unknown[],
  ): void {
    const rows = extractRecoveredTitleRows(
      sessionId,
      messages,
      this.lifetimeStartedAt,
    )
    if (rows.length === 0) {
      if (!this.recoveredTitles.delete(sessionId)) return
    } else {
      this.recoveredTitles.set(sessionId, rows)
    }
    this.feed.scheduleSummary()
  }

  /**
   * Rebuild `sessionId`'s recovered `local_bash` drawer rows from a full transcript; the publisher
   * filters registry-known ids at read time. `excludeTaskIds` are recovered SuperShell steps.
   */
  recoverBashRowsFromTranscript(
    sessionId: string,
    messages: unknown[],
    excludeTaskIds: ReadonlySet<string> = new Set(),
  ): void {
    const rows = extractRecoveredBashRows(messages).filter(
      row => !excludeTaskIds.has(row.taskId),
    )
    const prev = this.recoveredBash.get(sessionId)
    if (rows.length === 0) {
      if (!prev) return
      this.recoveredBash.delete(sessionId)
    } else {
      this.recoveredBash.set(sessionId, rows)
    }
    this.feed.scheduleSummary()
  }

  /**
   * Rebuild `sessionId`'s recovered `local_supershell` drawer rows: the
   * transcript scan, completed from each call's tool-detail sidecar — whether the
   * run ended inline or continued in the background, and how a detached run
   * ended (recoverSuperShellRows.ts). Registry-known runs are filtered by the
   * publisher at read time, as for run_js. Returns the task ids of the
   * `background: true` steps the recovered runs started.
   */
  async recoverSuperShellRowsFromTranscript(
    sessionId: string,
    messages: unknown[],
  ): Promise<ReadonlySet<string>> {
    const { rows, backgroundStepTaskIds } = await resolveRecoveredSuperShellRows(
      extractRecoveredSuperShellRows(messages),
      toolCallId => this.loadToolDetailForRuntime(sessionId, toolCallId),
    )
    const prev = this.recoveredSuperShell.get(sessionId)
    if (rows.length === 0) {
      if (!prev) return backgroundStepTaskIds
      this.recoveredSuperShell.delete(sessionId)
    } else {
      this.recoveredSuperShell.set(sessionId, rows)
    }
    this.feed.scheduleSummary()
    return backgroundStepTaskIds
  }

  /**
   * Merge `sessionId`'s `skill-events.json` sidecar into the realm-global `skillInvocationLog` once per
   * lifetime (promise-cached). Best-effort.
   */
  ensureSkillEventsRecovered(sessionId: string): Promise<void> {
    const inflight = this.skillEventsRecovery.get(sessionId)
    if (inflight) return inflight
    const promise = (async () => {
      const storage = this.storage
      if (!storage?.loadSkillEvents) return
      try {
        const events = await storage.loadSkillEvents(sessionId)
        if (
          events &&
          events.length > 0 &&
          seedSkillInvocationEvents(sessionId, events)
        ) {
          this.feed.scheduleSummary()
        }
      } catch {
        // best-effort — a missing/torn sidecar leaves the transcript-scan
        // fallback; drop the cache entry so a later open can retry.
        this.skillEventsRecovery.delete(sessionId)
      }
    })()
    this.skillEventsRecovery.set(sessionId, promise)
    return promise
  }

  /** A DELETED session's skill event log and its recovery entry go with it.
   *  (A dispose keeps both on purpose — see `disposeManagedSession` — but a
   *  deleted id never re-opens, so without this the realm-global log and the
   *  recovery cache grew by one session for every delete in the worker's
   *  lifetime.) Runs after `disposeManagedSession`, whose flush has already
   *  taken the pending write. */
  forgetSkillEvents(sessionId: string): void {
    const timer = this.skillEventsWriteTimers.get(sessionId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.skillEventsWriteTimers.delete(sessionId)
    }
    this.skillEventsRecovery.delete(sessionId)
    clearSkillInvocationLogForSession(sessionId)
  }

  /** Queue a coalesced write of `sessionId`'s skill event log to its sidecar.
   *  Called (via the registered persister) on every logged invocation; a burst
   *  in one turn collapses into a single write. */
  scheduleSkillEventsPersist(sessionId: string): void {
    if (this.skillEventsWriteTimers.has(sessionId)) return
    const timer = setTimeout(() => {
      void this.flushSkillEventsPersist(sessionId)
    }, SKILL_EVENTS_WRITE_COALESCE_MS)
    this.skillEventsWriteTimers.set(sessionId, timer)
  }

  /** Write `sessionId`'s current skill event log to its sidecar now. Recovers
   *  the pre-restart log FIRST so this write can never clobber the on-disk
   *  history with only this lifetime's newer events (the first post-restart
   *  invocation would otherwise overwrite it before recovery had run). */
  async flushSkillEventsPersist(sessionId: string): Promise<void> {
    const timer = this.skillEventsWriteTimers.get(sessionId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.skillEventsWriteTimers.delete(sessionId)
    }
    const storage = this.storage
    if (!storage?.saveSkillEvents) return
    try {
      await this.ensureSkillEventsRecovered(sessionId)
    } catch {
      // best-effort — proceed with whatever is in memory
    }
    try {
      await storage.saveSkillEvents(
        sessionId,
        getAllSkillInvocationEvents(sessionId),
      )
    } catch {
      // best-effort — a failed persist just leaves the log live-session-only
    }
  }

  /**
   * The drawer's detail fallback for a background shell whose live/finished
   * registry record is gone (session reloaded after an app restart). Looks the
   * recovered row up by public task id across every loaded session's rebuilt
   * rows and returns its command + output-file path so
   * `TaskControlSurface.loadInfoWithOutput` can read the persisted log lazily.
   */
  loadRecoveredTitle(taskId: string): { title: string } | null {
    for (const rows of this.recoveredTitles.values()) {
      const row = rows.find(r => r.taskId === taskId)
      if (row) return { title: row.title }
    }
    return null
  }

  loadRecoveredShell(
    taskId: string,
  ): { command?: string; outputFilePath?: string; detailId?: string } | null {
    for (const rows of this.recoveredBash.values()) {
      const row = rows.find(r => r.taskId === taskId)
      if (row) {
        return {
          command: row.command,
          outputFilePath: row.outputFilePath,
          detailId: row.detailId,
        }
      }
    }
    return null
  }

  /** The protocol's `session.getToolDetail`: the hinted session first (one
   *  stat), then the cache-first search across every candidate session. */
  async loadToolDetailForRuntime(
    sessionId: string,
    toolCallId: string,
  ): Promise<BrowserToolCallDetailRecord | null> {
    const cached = this.toolDetails.get(toolCallId)
    if (cached) return cached
    const storage = this.storage
    if (storage?.loadToolCallDetail && sessionId) {
      try {
        const detail = await storage.loadToolCallDetail(sessionId, toolCallId)
        if (detail) return detail
      } catch {
        // fall through to the cross-session search
      }
    }
    // WITH the session as the hint: this is the loader the session's own
    // background recovery runs, and a hint-less search waits on every
    // in-flight recovery to learn the session — including the one asking,
    // which then waited on itself for good (a SuperShell sidecar the
    // session's storage did not hold).
    return this.loadToolCallDetailAcrossSessions(toolCallId, sessionId)
  }

  /**
   * The session a recovered drawer row with this tool call id (or result
   * sidecar id) was rebuilt from — the first place its sidecar can be. There is
   * no "current session" to guess with instead.
   */
  private sessionOfRecoveredCall(id: string): string | undefined {
    for (const [sessionId, rows] of this.recoveredRunJs) {
      if (rows.some(row => row.callId === id)) return sessionId
    }
    for (const [sessionId, rows] of this.recoveredSuperShell) {
      if (rows.some(row => row.callId === id || row.resultDetailId === id)) return sessionId
    }
    for (const [sessionId, rows] of this.recoveredBash) {
      if (rows.some(row => row.detailId === id)) return sessionId
    }
    return undefined
  }

  private async loadToolCallDetailAcrossSessions(
    toolCallId: string,
    sessionHint?: string,
  ): Promise<BrowserToolCallDetailRecord | null> {
    const storage = this.storage
    if (!storage?.loadToolCallDetail) return null
    const cached = this.toolDetails.get(toolCallId)
    if (cached) return cached
    const candidates: string[] = []
    const push = (sessionId: string | null | undefined): void => {
      if (sessionId && !candidates.includes(sessionId)) candidates.push(sessionId)
    }
    let hint = sessionHint ?? this.sessionOfRecoveredCall(toolCallId)
    if (hint === undefined && this.backgroundRecoveries.size > 0) {
      // A drawer jump can ask while its session's recovery is still reading the
      // transcript: the row that names the session is not there yet.
      await Promise.allSettled(this.backgroundRecoveries.values())
      hint = this.sessionOfRecoveredCall(toolCallId)
    }
    push(hint)
    for (const sessionId of this.sessions.keys()) push(sessionId)
    for (const sessionId of this.fsSummaries.keys()) push(sessionId)
    for (const sessionId of candidates) {
      try {
        const detail = await storage.loadToolCallDetail(sessionId, toolCallId)
        if (detail) return detail
      } catch {
        // try the next candidate session
      }
    }
    return null
  }

  /**
   * After a lazy recovery, upgrade a recovered row to `'error'` when its sidecar records `isError`;
   * never downgrades.
   */
  async markRecoveredTaskErrors(sessionId: string): Promise<void> {
    const sidecarIsError = async (id: string | undefined): Promise<boolean> => {
      if (!id) return false
      const detail = await this.loadToolCallDetailAcrossSessions(id, sessionId)
      return detail?.isError === true
    }
    let changed = false
    for (const row of this.recoveredRunJs.get(sessionId) ?? []) {
      if (row.status !== 'error' && (await sidecarIsError(row.callId))) {
        row.status = 'error'
        changed = true
      }
    }
    for (const row of this.recoveredBash.get(sessionId) ?? []) {
      if (row.status !== 'error' && (await sidecarIsError(row.detailId))) {
        row.status = 'error'
        changed = true
      }
    }
    if (changed) this.feed.scheduleSummary()
  }

  async loadRecoveredShellDetail(
    toolCallId: string,
  ): Promise<{ outputFilePath?: string; outputText?: string } | null> {
    const detail = await this.loadToolCallDetailAcrossSessions(toolCallId)
    if (!detail || !SHELL_LAUNCH_TOOL_IDS.has(detail.toolName ?? '')) return null
    const result =
      detail.result && typeof detail.result === 'object'
        ? (detail.result as Record<string, unknown>)
        : {}
    const outputFilePath =
      typeof result.output_file === 'string' && result.output_file.length > 0
        ? result.output_file
        : undefined
    const outputText =
      typeof result.output === 'string' ? result.output : undefined
    return { outputFilePath, outputText }
  }

  /** Parents whose finished sub-agents were already restored from disk this
   *  worker lifetime (`restoreFinishedSubAgentsFromDisk`). */
  private readonly restoredSubAgentParents = new Set<string>()

  /**
   * Restore a parent's FINISHED background sub-agents into the task registry from their `task.json`
   * seeds (or `meta.json`), once per parent per lifetime after its routing commits; released on failure.
   * Restored sub-agents re-register their storage routing.
   */
  async restoreFinishedSubAgentsFromDisk(
    spawnerSessionId: string,
  ): Promise<void> {
    if (
      isSubAgentSessionId(spawnerSessionId) ||
      this.restoredSubAgentParents.has(spawnerSessionId)
    ) {
      return
    }
    this.restoredSubAgentParents.add(spawnerSessionId)
    try {
      const dirs =
        await this.storageCoordinator.listSubAgentSessionDirs(spawnerSessionId)
      let seeded = 0
      for (const subagentSessionId of dirs) {
        if (
          this.taskRegistry.getLive(subagentSessionId) ||
          this.taskRegistry.getFinished(subagentSessionId)
        ) {
          continue
        }
        const record = await this.readRestoredSubAgentRecord(
          spawnerSessionId,
          subagentSessionId,
        )
        if (!record) continue
        if (this.subAgents.seedRestoredRecord(record)) {
          this.storageCoordinator.registerSubAgentRouting(
            spawnerSessionId,
            subagentSessionId,
          )
          seeded++
        }
      }
      if (seeded > 0) this.feed.scheduleSummary()
    } catch {
      // Storage not up yet / bridge hiccup: release the guard so the next
      // session upsert retries.
      this.restoredSubAgentParents.delete(spawnerSessionId)
    }
  }

  /** One restored record: `task.json` first, `meta.json` fallback. */
  private async readRestoredSubAgentRecord(
    spawnerSessionId: string,
    subagentSessionId: string,
  ): Promise<FinishedSubAgentRecord | null> {
    const now = Date.now()
    const taskText = await this.storageCoordinator.readSubAgentFile(
      spawnerSessionId,
      subagentSessionId,
      SUBAGENT_TASK_FILE_NAME,
    )
    if (taskText) {
      const file = parseSubAgentTaskFile(taskText)
      if (file && file.sessionId === subagentSessionId) {
        return finishedRecordFromTaskFile(file, now)
      }
    }
    // A sub-agent's meta now lives as a ROW in the single sqlite store (keyed by
    // its sessionId), not a `subagents/<id>/meta.json` FILE — new sub-agents no
    // longer write that file. `readSessionMeta` does not filter sub-agent ids
    // (only the sidebar `listAll` does), so it answers here.
    const meta = await this.storage?.readSessionMeta(subagentSessionId)
    if (!meta) return null
    return finishedRecordFromSessionMeta({
      sessionId: subagentSessionId,
      spawnerSessionId,
      taskId: mintTaskHandle('local_agent'),
      firstPrompt: meta.metadata.firstPrompt,
      previewText: meta.metadata.previewText,
      lastTerminalReason: meta.metadata.lastTerminalReason,
      updatedAt: meta.updatedAt,
      now,
    })
  }

  /**
   * Read a session's plugin task files back into the registry, once per
   * session per lifetime; a task that was running when the app closed comes
   * back stopped and interrupted. A failed read is retried on the next call.
   */
  restorePluginTasksFromDisk(spawnerSessionId: string): Promise<void> {
    if (isSubAgentSessionId(spawnerSessionId)) return Promise.resolve()
    const known = this.pluginTaskRestores.get(spawnerSessionId)
    if (known) return known
    const restore = (async () => {
      const names = await this.storageCoordinator.listSubAgentFiles(spawnerSessionId, PLUGIN_TASK_DIR)
      const now = Date.now()
      let seeded = 0
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const text = await this.storageCoordinator.readSubAgentFile(spawnerSessionId, PLUGIN_TASK_DIR, name)
        const record = text ? pluginTaskRecordFromFile(text, now) : null
        if (!record || record.spawnerSessionId !== spawnerSessionId) continue
        if (this.pluginTasks.seedRestored(record)) seeded++
      }
      if (seeded > 0) this.feed.scheduleSummary()
    })().catch(() => {
      this.pluginTaskRestores.delete(spawnerSessionId)
    })
    this.pluginTaskRestores.set(spawnerSessionId, restore)
    return restore
  }
}

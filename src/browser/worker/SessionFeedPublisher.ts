/**
 * SessionFeedPublisher — the two coalesced UI feeds: the per-session `session.currentState` feed
 * (every session publishes its own; turn-end notifications only for viewed sessions) and the
 * `session.summary` feed (sidebar + Background Tasks), coalesced on a timer and deduped.
 */
import type { AgentRuntimeWorkerHandle } from './AgentRuntimeWorkerHandle'
import type { LruMap } from './LruMap'
import type { TaskRegistry } from './TaskRegistry'
import type {
  NexusCurrentSessionActive,
  NexusCurrentSessionDelta,
  NexusCurrentSessionPayload,
  NexusCurrentSessionPhase,
  NexusCurrentSessionSnapshot,
  NexusSessionSkillRow,
  NexusSessionsSummaryPayload,
  NexusSessionsSummaryRow,
  NexusTaskSummaryRow,
} from '../bridge/protocol/ui'
import { getSkillInvocationEventsForAgent } from '../../skillLibrary/skillInvocationLog'
import type { BrowserLlmSelection } from '../bridge/protocol/nexus_llm'
import type {
  BrowserSessionCounters,
  BrowserSessionMetadata,
  BrowserSessionSummary,
} from '../../sessions/sessionStore'
import {
  MAX_SUBAGENT_SUMMARY_FINISHED,
  ZERO_COUNTERS,
  type HeadlessRunState,
  type NexusFinishedTaskRecord,
  type NexusTaskState,
} from './taskTypes'
import {
  fastCallDisplayLabel,
  isSubAgentSessionId,
  runJsDisplayLabel,
} from './taskProjection'
import type { RecoveredRunJsRow } from './recoverRunJsRows'
import type { RecoveredBashRow } from './recoverBashRows'
import type { RecoveredSuperShellRow } from './recoverSuperShellRows'
import {
  SESSION_TITLE_QUERY_SOURCE,
  type RecoveredTitleRow,
} from './recoverTitleRows'
import { superShellDisplayLabel } from './SuperShellTaskCoordinator'

const SUMMARY_COALESCE_MS = 100

/**
 * The slice of a Manager `SessionEntry` the feeds read (and, for the
 * metadata refresh, write). Structural — the Manager hands its entries
 * through the host seam without copying.
 */
export type FeedSessionView = {
  worker: Pick<AgentRuntimeWorkerHandle, 'getPhase'>
  model: BrowserLlmSelection | null
  counters: BrowserSessionCounters
  needsAnswer: boolean
}

export interface SessionFeedHost {
  getSessionEntry(sessionId: string): FeedSessionView | undefined
  sessionEntries(): Iterable<[string, FeedSessionView]>
  getSubscribersFor(sessionId: string): Iterable<Pick<MessagePort, 'postMessage'>>
  getListSubscribers(): Iterable<Pick<MessagePort, 'postMessage'>>
  /** Whether any client is viewing `sessionId` right now (`presence.setViewing`). */
  isViewed(sessionId: string): boolean
  /** Fires on a status emit of a VIEWED session with the previous/next display
   *  phase — the host owns turn-end notification policy + the lead-inbox drain. */
  notifyTurnEnd(
    sessionId: string,
    prevPhase: NexusCurrentSessionPhase | null,
    nextPhase: NexusCurrentSessionPhase,
  ): void
  /** The fs-persisted summary LRU (SessionSummaryRepository's) — disk-resident
   *  sessions' counters for the summary rows. */
  getFsSummaries(): Pick<LruMap<string, BrowserSessionSummary>, 'keys' | 'peek'>
  /** Live headless routine runs (RoutineCoordinator's own live map). */
  routineTasks(): Iterable<HeadlessRunState>
  /** RECOVERED run_js rows per loaded session (Manager's transcript-derived
   *  map — restart recovery for the drawer's "Super Edit" section). The
   *  publisher skips any call id the registry still knows: a registry
   *  record is from THIS worker lifetime and already published above. */
  recoveredRunJsRows(): Iterable<[string, RecoveredRunJsRow[]]>
  /** RECOVERED local_bash rows per loaded session (Manager's transcript-derived
   *  map — restart recovery for the drawer's background-shell entries). The
   *  publisher skips any task id the registry still knows: a registry record is
   *  from THIS worker lifetime and already published above. Read-only history —
   *  the process is long dead, so these rows carry no live status/Stop. */
  recoveredBashRows(): Iterable<[string, RecoveredBashRow[]]>
  /** RECOVERED local_supershell rows per loaded session (Manager's map, rebuilt
   *  from the transcript and each call's sidecar — restart recovery for the
   *  drawer's "Super Shell" section). The publisher skips a run the registry
   *  still knows, by its tool call id or its task id. */
  recoveredSuperShellRows(): Iterable<[string, RecoveredSuperShellRow[]]>
  /** RECOVERED session-title namer rows per loaded session (Manager's map,
   *  rebuilt from the transcript's stored titles — restart recovery for the
   *  drawer's Sub-agents section). The Manager keeps only titles stored before
   *  this worker lifetime, so none duplicates a registry record. Optional for
   *  hosts that never recover. */
  recoveredTitleRows?(): Iterable<[string, RecoveredTitleRow[]]>
  /** Whether a CLI session's CLI is working (F-34); a CLI session has no turn of its own. */
  isCliBusy?(sessionId: string): boolean
}

export class SessionFeedPublisher {
  // Last status snapshot fanned out per session — deltas are computed against
  // it. A session with no entry (never emitted, forgotten, or `announceStatus`)
  // gets a full snapshot on its next emit.
  private readonly prevStatus = new Map<string, NexusCurrentSessionSnapshot>()
  // Last summary payload — used to dedup no-op coalesce emissions.
  private prevSummary: NexusSessionsSummaryPayload | null = null
  private summaryFlushHandle: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly registry: TaskRegistry<
      NexusTaskState,
      NexusFinishedTaskRecord
    >,
    private readonly host: SessionFeedHost,
  ) {}

  /**
   * Publish a FULL status snapshot for `sessionId` now — a client just started
   * viewing it, or it just (re)bound, so whoever reads it needs a baseline
   * rather than a delta against a state they never saw.
   */
  announceStatus(sessionId: string): void {
    this.prevStatus.delete(sessionId)
    this.emitStatus(sessionId)
  }

  /** Drop a removed session's delta cache. */
  forgetStatus(sessionId: string): void {
    this.prevStatus.delete(sessionId)
  }

  /** Hydrate an entry's runtime overlay (model + counters) from persisted
   *  session metadata. */
  refreshSessionFromMetadata(
    entry: FeedSessionView,
    metadata: BrowserSessionMetadata | undefined,
  ): void {
    entry.model = metadata?.llmSelection ?? null
    const c = metadata?.counters
    entry.counters = c
      ? {
          tool: c.tool ?? 0,
          toolFail: c.toolFail ?? 0,
          mcp: c.mcp ?? 0,
          mcpFail: c.mcpFail ?? 0,
        }
      : { ...ZERO_COUNTERS }
  }

  private derivePhase(entry: FeedSessionView): NexusCurrentSessionPhase {
    // Map the unified SessionPhase enum onto the legacy topbar pill phase.
    // `running/tools` → tool|mcp (off the top-of-stack tool's kind);
    // `running/streaming` and `running/retry` → thinking; `idle` → idle.
    const phase = entry.worker.getPhase()
    if (phase.kind === 'idle') return 'idle'
    const sub = phase.sub
    if (sub.type === 'tools') {
      const top = sub.tools[sub.tools.length - 1]
      return top && top.kind === 'mcp' ? 'mcp' : 'tool'
    }
    return 'thinking'
  }

  private buildCurrentSnapshot(
    entry: FeedSessionView,
    sessionId: string,
  ): NexusCurrentSessionSnapshot {
    const phase = entry.worker.getPhase()
    // Derive the display-only `active` descriptor from the phase sub-state.
    // A retry takes priority for display (it can't coincide with a tool —
    // retries happen between model calls), then the top-of-stack tool.
    const active =
      phase.kind === 'running' && phase.sub.type === 'retry'
        ? (() => {
            const now = Date.now()
            const remainingSeconds = Math.max(
              0,
              Math.ceil((phase.sub.deadlineMs - now) / 1000),
            )
            return {
              name: 'Retrying',
              retry: {
                remainingSeconds,
                // Past the deadline the attempt is in flight — count UP from
                // it so the ticks (AgentTurnController.beginRetry) keep
                // changing the payload; a constant remainingSeconds of 0
                // would dedupe every delta and freeze the indicator.
                ...(remainingSeconds === 0
                  ? {
                      inFlightSeconds: Math.max(
                        0,
                        Math.floor((now - phase.sub.deadlineMs) / 1000),
                      ),
                    }
                  : {}),
                attempt: phase.sub.attempt,
                maxRetries: phase.sub.maxRetries,
                ...(phase.sub.errorKind !== undefined
                  ? { errorKind: phase.sub.errorKind }
                  : {}),
                ...(phase.sub.errorTitleKey !== undefined
                  ? { errorTitleKey: phase.sub.errorTitleKey }
                  : {}),
                ...(phase.sub.errorTitle !== undefined
                  ? { errorTitle: phase.sub.errorTitle }
                  : {}),
                ...(phase.sub.errorDetail !== undefined
                  ? { errorDetail: phase.sub.errorDetail }
                  : {}),
              },
            }
          })()
        : phase.kind === 'running' && phase.sub.type === 'tools'
          ? (() => {
              const top = phase.sub.tools[phase.sub.tools.length - 1]!
              return {
                name: top.name,
                // Tool category — the panel's agent-zone reveal gates on
                // kind === 'browser' (see protocol/ui.ts).
                kind: top.kind,
                ...(top.actionType !== undefined
                  ? { actionType: top.actionType }
                  : {}),
              }
            })()
          : null
    return {
      kind: 'snapshot',
      sessionId,
      model: entry.model,
      phase: this.derivePhase(entry),
      // The raw unified phase enum — the composer gate reads this (input
      // allowed only when `kind === 'idle'`). The legacy `phase`/`active`
      // fields above stay for the topbar pill + running-indicator.
      sessionPhase: phase,
      active,
      counters: { ...entry.counters },
    }
  }

  /** Publish `sessionId`'s status: a snapshot the first time, then only what changed. */
  emitStatus(sessionId: string): void {
    const entry = this.host.getSessionEntry(sessionId)
    if (!entry) return
    const next = this.buildCurrentSnapshot(entry, sessionId)
    const prev = this.prevStatus.get(sessionId) ?? null

    let payload: NexusCurrentSessionPayload
    if (!prev) {
      payload = next
    } else {
      const delta: NexusCurrentSessionDelta = {
        kind: 'delta',
        sessionId,
      }
      let changed = false
      if (!modelEquals(prev.model, next.model)) {
        delta.model = next.model
        changed = true
      }
      if (prev.phase !== next.phase) {
        delta.phase = next.phase
        changed = true
      }
      if (!activeEquals(prev.active, next.active)) {
        delta.active = next.active
        changed = true
      }
      const cdiff = counterDiff(prev.counters, next.counters)
      if (cdiff) {
        delta.counters = cdiff
        changed = true
      }
      if (!changed) return
      // The raw enum rides every delta that changed anything — it's the source
      // the composer gate reads, and any visible change (phase/active/counters)
      // implies the enum moved too. Cheap (one small object) and keeps the
      // guest's cached sessionPhase consistent without a separate diff fn.
      delta.sessionPhase = next.sessionPhase
      payload = delta
    }

    const prevPhaseForNotify = prev ? prev.phase : null
    this.prevStatus.set(sessionId, next)

    const portMessage = { type: 'session.currentState' as const, payload }
    for (const port of this.host.getSubscribersFor(sessionId)) {
      port.postMessage(portMessage)
    }
    // Turn-end policy (notification, lead-inbox drain) is for sessions a user
    // is looking at — with one desktop client, exactly the old "current" one.
    if (this.host.isViewed(sessionId)) {
      this.host.notifyTurnEnd(sessionId, prevPhaseForNotify, next.phase)
    }
  }

  /**
   * True iff a background task of this session is still in flight that will send a
   * `<task-notification>` turn; `local_fork` / `local_fast` are excluded (they never do).
   */
  private hasRunningTasksFor(spawnerSessionId: string): boolean {
    for (const t of this.registry.allLive()) {
      if (t.type === 'local_fork' || t.type === 'local_fast') continue
      if (t.spawnerSessionId === spawnerSessionId) return true
    }
    return false
  }

  buildSummaryPayload(): NexusSessionsSummaryPayload {
    const seen = new Set<string>()
    const rows: NexusSessionsSummaryRow[] = []
    for (const [sessionId, entry] of this.host.sessionEntries()) {
      // Background sub-agents have their own read-only surface; keep them out
      // of the user-facing session summary (they ride `subAgents`, not here).
      if (isSubAgentSessionId(sessionId)) continue
      seen.add(sessionId)
      rows.push({
        sessionId,
        // Busy = the turn is non-idle OR a background task it launched is
        // still running (the session WILL receive that task's notification
        // turn — it isn't really done). Drives the sidebar row's running
        // spinner/shimmer, so a settled session with live background work
        // keeps reading as active. Task register/finalize and every phase
        // transition both scheduleSummary(), so the flip re-broadcasts.
        running:
          this.derivePhase(entry) !== 'idle' ||
          this.hasRunningTasksFor(sessionId) ||
          (this.host.isCliBusy?.(sessionId) ?? false),
        // Halted-on-ask flag (cached from worker.state by the Manager) —
        // the sidebar dot's client-independent source.
        needsAnswer: entry.needsAnswer,
        tool: entry.counters.tool,
        toolFail: entry.counters.toolFail,
        mcp: entry.counters.mcp,
        mcpFail: entry.counters.mcpFail,
      })
    }
    // Disk-resident sessions: use `peek`, not `get` — `get` reorders the LRU during `keys()` iteration
    // and loops forever.
    const fsSummaries = this.host.getFsSummaries()
    for (const sessionId of fsSummaries.keys()) {
      if (seen.has(sessionId) || isSubAgentSessionId(sessionId)) continue
      const summary = fsSummaries.peek(sessionId)
      const c = summary?.counters
      rows.push({
        sessionId,
        running: this.host.isCliBusy?.(sessionId) ?? false,
        tool: c?.tool ?? 0,
        toolFail: c?.toolFail ?? 0,
        mcp: c?.mcp ?? 0,
        mcpFail: c?.mcpFail ?? 0,
      })
    }
    rows.sort((a, b) => a.sessionId.localeCompare(b.sessionId))
    return {
      sessions: rows,
      subAgents: this.buildSubAgentSummaryRows(),
      skills: this.buildSessionSkillRows(),
    }
  }

  /**
   * Skill invocations per live session from the realm-global `skillInvocationLog` (main session only,
   * newest first), sent with the coalesced summary broadcast.
   */
  private buildSessionSkillRows(): NexusSessionSkillRow[] {
    const rows: NexusSessionSkillRow[] = []
    for (const [sessionId] of this.host.sessionEntries()) {
      if (isSubAgentSessionId(sessionId)) continue
      for (const event of getSkillInvocationEventsForAgent(sessionId, null)) {
        rows.push({
          spawnerSessionId: sessionId,
          name: event.skillName,
          path: event.skillPath,
          invokedAt: event.invokedAt,
          // Byte length of the body injected at this invocation (a `failed`
          // event carries the matched live body's size; `failed` has none).
          size: event.size,
          id: event.id,
          status: event.status,
          detailId: event.detailId,
          error: event.error,
        })
      }
    }
    // Within a session the log is already newest-first; concatenating across
    // sessions needs a re-sort to interleave by recency.
    rows.sort((a, b) => b.invokedAt - a.invokedAt)
    return rows
  }

  /**
   * Background sub-agents for the human-facing surface (G2/G5): all in-flight
   * runs plus a bounded most-recent finished tail, shaped for the webview. The
   * webview filters by `spawnerSessionId` to the active thread (the drawer is
   * per-session). Running first, then finished
   * most-recent-first.
   */
  private buildSubAgentSummaryRows(): NexusTaskSummaryRow[] {
    const rows: NexusTaskSummaryRow[] = []
    for (const run of this.registry.liveByType('local_agent')) {
      rows.push({
        sessionId: run.taskId ?? run.sessionId,
        spawnerSessionId: run.spawnerSessionId,
        status: 'running',
        type: 'local_agent',
        description: run.description,
        agentType: run.agentType,
        updates: run.messages.length,
        startedAt: run.startedAt,
        lastActivityAt: run.lastActivityAt,
      })
    }
    const recentFinished = [...this.registry.finishedByType('local_agent')]
      .sort((a, b) => b.finishedAt - a.finishedAt)
      .slice(0, MAX_SUBAGENT_SUMMARY_FINISHED)
    for (const rec of recentFinished) {
      rows.push({
        sessionId: rec.taskId ?? rec.sessionId,
        spawnerSessionId: rec.spawnerSessionId,
        status: rec.status,
        type: 'local_agent',
        description: rec.description,
        agentType: rec.agentType,
        startedAt: rec.startedAt,
        finishedAt: rec.finishedAt,
      })
    }
    // local_bash tasks (background shells) — running first, then a finished tail.
    // Same shape; `command` rides the row so the drawer renders it (mono) in
    // place of an agent description (see BackgroundTasksDrawer kind-switch).
    // A SuperShell step carries its invocation's id, so the drawer lists it
    // under that invocation rather than under Shell.
    for (const run of this.registry.liveByType('local_bash')) {
      rows.push({
        sessionId: run.taskId,
        spawnerSessionId: run.spawnerSessionId,
        status: 'running',
        type: 'local_bash',
        description: run.command,
        command: run.command,
        ...(run.superShellTaskId ? { superShellTaskId: run.superShellTaskId } : {}),
        updates: run.polls,
        startedAt: run.startedAt,
        lastActivityAt: run.lastActivityAt,
      })
    }
    // SuperShell steps and the model's own shells get separate finished tails:
    // a script's many settled steps (which the drawer files under their
    // invocation) must not push the model's shells out of the summary.
    const finishedShells = [...this.registry.finishedByType('local_bash')]
      .sort((a, b) => b.finishedAt - a.finishedAt)
    const recentFinishedShells = [
      ...finishedShells.filter(rec => !rec.superShellTaskId).slice(0, MAX_SUBAGENT_SUMMARY_FINISHED),
      ...finishedShells.filter(rec => rec.superShellTaskId).slice(0, MAX_SUBAGENT_SUMMARY_FINISHED),
    ]
    for (const rec of recentFinishedShells) {
      rows.push({
        sessionId: rec.taskId,
        spawnerSessionId: rec.spawnerSessionId,
        status: rec.status,
        type: 'local_bash',
        description: rec.command,
        command: rec.command,
        ...(rec.superShellTaskId ? { superShellTaskId: rec.superShellTaskId } : {}),
        startedAt: rec.startedAt,
        finishedAt: rec.finishedAt,
      })
    }
    // Recovered local_bash rows — backgrounded shells read back from loaded
    // session transcripts, so the drawer's shell entries survive an app
    // restart (the registry above holds only this worker lifetime's shells).
    // Registry-known task ids are skipped here, at read time: a live/finished
    // record is fresher than the transcript scan. The process is long dead —
    // these rows are read-only history (no Stop/Resume); the drawer detail
    // reads the persisted output file lazily from `outputFilePath` when opened.
    for (const [ownerSessionId, recovered] of this.host.recoveredBashRows()) {
      for (const rec of recovered) {
        // A recovered row carries the PUBLIC task id; the registry keys shells
        // by their NATIVE shell_id — so resolve before the freshness check
        // (unlike run_js, whose public id IS its native id). If this lifetime
        // still holds the shell live/finished, its row is fresher; skip.
        const nativeId = this.registry.resolveNative(rec.taskId)
        if (this.registry.getLiveByType(nativeId, 'local_bash')) continue
        if (this.registry.getFinishedByType(nativeId, 'local_bash')) continue
        rows.push({
          sessionId: rec.taskId,
          spawnerSessionId: ownerSessionId,
          status: rec.status,
          type: 'local_bash',
          // `command` is the drawer's preferred label; `description` is the
          // required-string fallback. A real backgrounded shell always kept its
          // command in the transcript, so the '' only guards a pathological row.
          description: rec.command ?? '',
          command: rec.command,
          startedAt: rec.startedAt,
          finishedAt: rec.finishedAt,
        })
      }
    }
    // local_fork tasks (in-process forks) — running first, then a finished tail.
    for (const run of this.registry.liveByType('local_fork')) {
      rows.push({
        sessionId: run.taskId,
        spawnerSessionId: run.spawnerSessionId,
        status: 'running',
        type: 'local_fork',
        description: run.description,
        agentType: run.agentType,
        querySource: run.querySource,
        updates: run.messages.length,
        startedAt: run.startedAt,
        lastActivityAt: run.lastActivityAt,
      })
    }
    const recentFinishedForks = [...this.registry.finishedByType('local_fork')]
      .sort((a, b) => b.finishedAt - a.finishedAt)
      .slice(0, MAX_SUBAGENT_SUMMARY_FINISHED)
    for (const rec of recentFinishedForks) {
      rows.push({
        sessionId: rec.taskId,
        spawnerSessionId: rec.spawnerSessionId,
        status: rec.status,
        type: 'local_fork',
        description: rec.description,
        agentType: rec.agentType,
        querySource: rec.querySource,
        startedAt: rec.startedAt,
        finishedAt: rec.finishedAt,
      })
    }
    // local_fast tasks (one-shot fast-model calls) — usually sub-second, so a
    // running row is a brief flash; the finished tail is the useful record.
    for (const run of this.registry.liveByType('local_fast')) {
      rows.push({
        sessionId: run.taskId,
        spawnerSessionId: run.spawnerSessionId,
        status: 'running',
        type: 'local_fast',
        description: run.description,
        querySource: run.querySource,
        startedAt: run.startedAt,
      })
    }
    const recentFinishedFastCalls = [
      ...this.registry.finishedByType('local_fast'),
    ]
      .sort((a, b) => b.finishedAt - a.finishedAt)
      .slice(0, MAX_SUBAGENT_SUMMARY_FINISHED)
    for (const rec of recentFinishedFastCalls) {
      rows.push({
        sessionId: rec.taskId,
        spawnerSessionId: rec.spawnerSessionId,
        status: rec.status,
        type: 'local_fast',
        description: rec.description,
        querySource: rec.querySource,
        startedAt: rec.startedAt,
        finishedAt: rec.finishedAt,
      })
    }
    // Recovered session-title rows — the namer's calls from before this
    // worker lifetime, read back from loaded transcripts' stored titles, so
    // the Sub-agents section keeps them across an app restart. Newest first,
    // like the finished tails above.
    for (const [ownerSessionId, recovered] of this.host.recoveredTitleRows?.() ?? []) {
      for (const rec of [...recovered].reverse()) {
        rows.push({
          sessionId: rec.taskId,
          spawnerSessionId: ownerSessionId,
          status: 'success',
          type: 'local_fast',
          description: fastCallDisplayLabel(SESSION_TITLE_QUERY_SOURCE),
          querySource: SESSION_TITLE_QUERY_SOURCE,
          // Only the store time survives — no span, so no "took …".
          startedAt: rec.storedAt,
        })
      }
    }
    // local_supershell tasks (SuperShell invocations): running rows for the
    // whole run — inline or in the background — then the finished tail, which
    // the drawer files under Super Shell. Like a local_js row, the row id is the
    // tool call id, so the conversation card focuses the drawer with the id it
    // already holds; the coordinator accepts it wherever the drawer addresses
    // the task (the model keeps the minted public id).
    for (const run of this.registry.liveByType('local_supershell')) {
      rows.push({
        sessionId: run.toolCallId ?? run.taskId,
        spawnerSessionId: run.spawnerSessionId,
        status: 'running',
        type: 'local_supershell',
        description: run.description,
        startedAt: run.startedAt,
      })
    }
    const recentFinishedSuperShells = [...this.registry.finishedByType('local_supershell')]
      .sort((a, b) => b.finishedAt - a.finishedAt)
      .slice(0, MAX_SUBAGENT_SUMMARY_FINISHED)
    for (const rec of recentFinishedSuperShells) {
      rows.push({
        sessionId: rec.toolCallId ?? rec.taskId,
        spawnerSessionId: rec.spawnerSessionId,
        status: rec.status,
        type: 'local_supershell',
        description: rec.description,
        startedAt: rec.startedAt,
        finishedAt: rec.finishedAt,
      })
    }
    // Recovered local_supershell rows — SuperShell runs read back from loaded
    // session transcripts and their sidecars, so the "Super Shell" section
    // survives an app restart. A run the registry still knows is from THIS
    // lifetime and already published above: skip it by its tool call id (the
    // row id) or, for a run that continued in the background, its task id.
    const knownSuperShellIds = new Set<string>()
    for (const run of [
      ...this.registry.liveByType('local_supershell'),
      ...this.registry.finishedByType('local_supershell'),
    ]) {
      knownSuperShellIds.add(run.taskId)
      if (run.toolCallId) knownSuperShellIds.add(run.toolCallId)
    }
    for (const [ownerSessionId, recovered] of this.host.recoveredSuperShellRows()) {
      for (const rec of recovered) {
        if (knownSuperShellIds.has(rec.callId)) continue
        if (rec.taskId !== undefined && knownSuperShellIds.has(rec.taskId)) continue
        rows.push({
          sessionId: rec.callId,
          spawnerSessionId: ownerSessionId,
          status: rec.status,
          type: 'local_supershell',
          description: rec.description ?? superShellDisplayLabel(),
          startedAt: rec.startedAt,
          finishedAt: rec.finishedAt,
        })
      }
    }
    // local_js tasks (run_js executions). A synchronous run is usually a brief
    // flash while running; the finished tail is the useful record. The row's
    // sessionId is the tool call id (== the public task id), so the conversation
    // card focuses the drawer with the id it already holds.
    for (const run of this.registry.liveByType('local_js')) {
      rows.push({
        sessionId: run.taskId,
        spawnerSessionId: run.spawnerSessionId,
        status: 'running',
        type: 'local_js',
        description: run.description,
        startedAt: run.startedAt,
      })
    }
    const recentFinishedRunJs = [...this.registry.finishedByType('local_js')]
      .sort((a, b) => b.finishedAt - a.finishedAt)
      .slice(0, MAX_SUBAGENT_SUMMARY_FINISHED)
    for (const rec of recentFinishedRunJs) {
      rows.push({
        sessionId: rec.taskId,
        spawnerSessionId: rec.spawnerSessionId,
        status: rec.status,
        type: 'local_js',
        description: rec.description,
        startedAt: rec.startedAt,
        finishedAt: rec.finishedAt,
      })
    }
    // Recovered local_js rows — run_js calls read back from loaded session
    // transcripts, so the "Super Edit" section survives an app restart (the
    // registry above holds only this worker lifetime's runs). Registry-known
    // ids are skipped here, at read time: a live/finished record is fresher
    // than the transcript scan. The drawer detail for a recovered row loads
    // from the tool-detail sidecar (TaskControlSurface's loadRunJsSidecar
    // fallback), so the row needs no code/result payload.
    for (const [ownerSessionId, recovered] of this.host.recoveredRunJsRows()) {
      for (const rec of recovered) {
        if (this.registry.getLiveByType(rec.callId, 'local_js')) continue
        if (this.registry.getFinishedByType(rec.callId, 'local_js')) continue
        rows.push({
          sessionId: rec.callId,
          spawnerSessionId: ownerSessionId,
          status: rec.status,
          type: 'local_js',
          description: rec.description ?? runJsDisplayLabel(),
          startedAt: rec.startedAt,
          finishedAt: rec.finishedAt,
        })
      }
    }
    // local_routine tasks (headless routine runs). Live rows read straight
    // from the RoutineCoordinator's live map (routines never enter the shared
    // registry's live map). No parent session — `spawnerSessionId: ''` + the
    // webview filter shows them in EVERY session's drawer (they're global
    // work, not children of a thread).
    for (const run of this.host.routineTasks()) {
      rows.push({
        sessionId: run.taskId,
        spawnerSessionId: '',
        status: 'running',
        type: 'local_routine',
        description: run.description,
        updates: run.messages.length,
        startedAt: run.startedAt,
        lastActivityAt: run.lastActivityAt,
      })
    }
    const recentFinishedRoutines = [
      ...this.registry.finishedByType('local_routine'),
    ]
      .sort((a, b) => b.finishedAt - a.finishedAt)
      .slice(0, MAX_SUBAGENT_SUMMARY_FINISHED)
    for (const rec of recentFinishedRoutines) {
      rows.push({
        sessionId: rec.taskId,
        spawnerSessionId: '',
        status: rec.status,
        type: 'local_routine',
        description: rec.description,
        startedAt: rec.startedAt,
        finishedAt: rec.finishedAt,
      })
    }
    return rows
  }

  private flushSummary(): void {
    this.summaryFlushHandle = null
    const next = this.buildSummaryPayload()
    if (summariesEqual(this.prevSummary, next)) return
    this.prevSummary = next
    const portMessage = { type: 'session.summary' as const, payload: next }
    for (const port of this.host.getListSubscribers()) {
      port.postMessage(portMessage)
    }
  }

  scheduleSummary(): void {
    if (this.summaryFlushHandle !== null) return
    this.summaryFlushHandle = setTimeout(
      () => this.flushSummary(),
      SUMMARY_COALESCE_MS,
    )
  }
}

// ---------- Comparison helpers (private to this file) ----------

function modelEquals(
  a: BrowserLlmSelection | null,
  b: BrowserLlmSelection | null,
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.providerId === b.providerId &&
    a.modelId === b.modelId &&
    a.thinkingTier === b.thinkingTier
  )
}

function activeEquals(
  a: NexusCurrentSessionActive | null,
  b: NexusCurrentSessionActive | null,
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.name !== b.name || a.actionType !== b.actionType || a.kind !== b.kind) {
    return false
  }
  // Retry countdown fields: the wire type carries them and the
  // topbar renders them — comparing only name/actionType froze the countdown
  // at its first paint (every tick compared "equal" and was deduped).
  const ra = a.retry
  const rb = b.retry
  if (ra === rb) return true
  if (!ra || !rb) return false
  return (
    ra.remainingSeconds === rb.remainingSeconds &&
    ra.inFlightSeconds === rb.inFlightSeconds &&
    ra.attempt === rb.attempt &&
    ra.maxRetries === rb.maxRetries &&
    ra.errorKind === rb.errorKind &&
    ra.errorTitleKey === rb.errorTitleKey &&
    ra.errorTitle === rb.errorTitle &&
    ra.errorDetail === rb.errorDetail
  )
}

function counterDiff(
  prev: BrowserSessionCounters,
  next: BrowserSessionCounters,
): Partial<BrowserSessionCounters> | undefined {
  const out: Partial<BrowserSessionCounters> = {}
  let changed = false
  if (prev.tool !== next.tool) {
    out.tool = next.tool
    changed = true
  }
  if (prev.toolFail !== next.toolFail) {
    out.toolFail = next.toolFail
    changed = true
  }
  if (prev.mcp !== next.mcp) {
    out.mcp = next.mcp
    changed = true
  }
  if (prev.mcpFail !== next.mcpFail) {
    out.mcpFail = next.mcpFail
    changed = true
  }
  return changed ? out : undefined
}

function summariesEqual(
  a: NexusSessionsSummaryPayload | null,
  b: NexusSessionsSummaryPayload,
): boolean {
  if (!a) return false
  if (a.sessions.length !== b.sessions.length) return false
  for (let i = 0; i < a.sessions.length; i++) {
    const x = a.sessions[i]
    const y = b.sessions[i]
    if (
      x.sessionId !== y.sessionId ||
      x.running !== y.running ||
      // Without this, a needsAnswer-ONLY flip (an ask appearing mid-tool is
      // not a phase transition, so nothing else changes) would be judged
      // "equal" and deduped — the flag would never reach the sidebar.
      x.needsAnswer !== y.needsAnswer ||
      x.tool !== y.tool ||
      x.toolFail !== y.toolFail ||
      x.mcp !== y.mcp ||
      x.mcpFail !== y.mcpFail
    ) {
      return false
    }
  }
  const aSub = a.subAgents ?? []
  const bSub = b.subAgents ?? []
  if (aSub.length !== bSub.length) return false
  for (let i = 0; i < aSub.length; i++) {
    const x = aSub[i]
    const y = bSub[i]
    if (
      x.sessionId !== y.sessionId ||
      x.spawnerSessionId !== y.spawnerSessionId ||
      x.status !== y.status ||
      x.type !== y.type ||
      x.description !== y.description ||
      x.command !== y.command ||
      x.superShellTaskId !== y.superShellTaskId ||
      x.agentType !== y.agentType ||
      x.querySource !== y.querySource ||
      x.updates !== y.updates ||
      x.startedAt !== y.startedAt ||
      x.lastActivityAt !== y.lastActivityAt
    ) {
      return false
    }
  }
  const aSkills = a.skills ?? []
  const bSkills = b.skills ?? []
  if (aSkills.length !== bSkills.length) return false
  for (let i = 0; i < aSkills.length; i++) {
    const x = aSkills[i]
    const y = bSkills[i]
    if (
      x.spawnerSessionId !== y.spawnerSessionId ||
      x.name !== y.name ||
      x.path !== y.path ||
      x.invokedAt !== y.invokedAt ||
      x.id !== y.id ||
      x.status !== y.status
    ) {
      return false
    }
  }
  return true
}

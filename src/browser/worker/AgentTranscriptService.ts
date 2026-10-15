/**
 * AgentTranscriptService — turn diffs (cache, history, rewind detection) and tool-call detail
 * persistence and hydration. One per RuntimeScope, bound via `bindRuntime`.
 */
import type { AgentRuntimeState } from '../runtime/AgentRuntimeState'
import type { AgentWorkerOutboundMessage } from './workerProtocol'
import {
  getToolCallDetailsFromMessage,
  mergeToolCallDetails,
} from '../../utils/toolCallDetails'
import type { BrowserToolCallDetailRecord } from '../../utils/toolCallDetails'
import {
  collectAllEditTurns,
  computeTurnDiff,
  toTurnDiffMeta,
  byTurnStartDesc,
  SESSION_TOTAL_TURN_INDEX,
  type TurnDiffMeta,
  type TurnFileChange,
  type TurnFullDiff,
} from '../../utils/turnDiffs'
import type { SnapshotFileDiff } from '../../sessions/fileSnapshots/snapshotDiff'
import type {
  FileSnapshotRecorder,
  SessionTotalFileDiff,
} from '../../sessions/fileSnapshots/snapshotRecorder'
import {
  EDIT_TOOL_ID,
  WRITE_TOOL_ID,
} from '../../prompting/fileToolNames'
import { SUPER_EDIT_TOOL_NAME } from '../runJs/runJsProtocol'

/** A snapshot-store file diff in the Diff panel's edit-based shape — the
 *  bridge that lets snapshot-backed sessions reuse the whole turn-diff pipe.
 *  Binary / not-captured files keep their row (0/0 counts, no hunks) so the
 *  panel can at least say the file changed. */
function snapshotDiffToTurnFileDiff(diff: SnapshotFileDiff): TurnFileChange {
  return {
    filePath: diff.displayPath,
    hunks: diff.hunks,
    fileWasCreated: diff.fileWasCreated,
    plusLines: diff.plusLines,
    minusLines: diff.minusLines,
  }
}

/** A whole-session total entry → the panel's TurnFileChange shape, carrying the
 *  external-change marker so the "Whole session" row can warn that a file's
 *  diff includes work done outside this session. */
function snapshotTotalToTurnFileDiff(total: SessionTotalFileDiff): TurnFileChange {
  const base = snapshotDiffToTurnFileDiff(total.diff)
  return total.provenance === 'external' && total.externalBetween
    ? { ...base, externalChange: total.externalBetween }
    : base
}

/** The worker-provided seam: outbound pushes only (sidecar persisted /
 *  turn-diff history). Runtime access is via scope-bound `bindRuntime`. */
export interface AgentTranscriptServiceHost {
  emit(message: AgentWorkerOutboundMessage): void
}

export class AgentTranscriptService {
  private turnDiffCompletedCache = new Map<number, TurnFullDiff>()
  private turnDiffHistoryFull: TurnFullDiff[] = []
  private turnDiffLastMessageCount = 0
  private runtime: AgentRuntimeState | null = null
  /** Newest diff computation wins — an older overlapping
   *  run must not overwrite a newer run's committed history/emit. */
  private diffRevision = 0
  /** Single-flight + dirty coalescing for `emitTurnDiffHistory`. */
  private diffInFlight = false
  private diffDirty = false

  constructor(private readonly host: AgentTranscriptServiceHost) {}

  bindRuntime(runtime: AgentRuntimeState): void {
    this.runtime = runtime
  }

  getCompletedCache(): Map<number, TurnFullDiff> {
    return this.turnDiffCompletedCache
  }

  getHistoryFull(): TurnFullDiff[] {
    return this.turnDiffHistoryFull
  }

  setHistoryFull(history: TurnFullDiff[]): void {
    this.turnDiffHistoryFull = history
  }

  getLastMessageCount(): number {
    return this.turnDiffLastMessageCount
  }

  setLastMessageCount(count: number): void {
    this.turnDiffLastMessageCount = count
  }

  reset(): void {
    this.turnDiffCompletedCache.clear()
    this.turnDiffHistoryFull = []
    this.turnDiffLastMessageCount = 0
    this.runtime = null
  }

  /**
   * Persist the tool-call-detail sidecars a stream event carries and push `worker.toolDetailPersisted`
   * for each. Best-effort per detail: a failed write never fails the turn.
   */
  async persistStreamDetails(event: unknown): Promise<void> {
    const runtime = this.runtime
    if (!runtime || !event || typeof event !== 'object') {
      return
    }
    let persistedEditDetail = false
    for (const detail of getToolCallDetailsFromMessage(
      event as Parameters<typeof getToolCallDetailsFromMessage>[0],
    )) {
      try {
        await runtime.conversationStore.saveToolCallDetail(detail)
      } catch {
        // Skip the push for a detail that did not persist — the UI's
        // on-demand getToolCallDetail path re-hydrates from the transcript.
        continue
      }
      // A reset() during the await means this scope is done — its host emit
      // channel must not push a dead scope's sidecar events.
      if (this.runtime !== runtime) return
      // Proactive push: as soon as the sidecar is persisted, let any
      // subscriber (UI tool-card, test harness, etc.) know it's
      // available. Replaces the UI-side retry ladder.
      this.host.emit({
        type: 'worker.toolDetailPersisted',
        payload: { toolCallId: detail.toolCallId, detail },
      })
      if (
        detail.toolName === EDIT_TOOL_ID ||
        detail.toolName === WRITE_TOOL_ID ||
        // SuperEdit mutates through its own facade, not Edit/Write — but it IS
        // a snapshot-recorder capture site, so a snapshot-backed session
        // (`code`/`safe_code`) must refresh the Diff panel mid-turn when a
        // SuperEdit result persists, exactly as Edit/Write do above. Without
        // this the panel only caught up at turn finalize.
        detail.toolName === SUPER_EDIT_TOOL_NAME
      ) {
        persistedEditDetail = true
      }
    }
    // Refresh the "Changes this turn" strip MID-TURN: without this, the
    // history was only recomputed on session load and turn completion
    // (worker.getMessages / worker.getMessagesSince), so the Diff panel showed
    // the previous turn's state while the current turn's edits streamed in.
    // Fire-and-forget after the sidecar is safely persisted; the single-flight
    // + dirty coalescing in emitTurnDiffHistory absorbs bursts of edits.
    if (persistedEditDetail) {
      void this.emitTurnDiffHistory()
    }
  }

  // Turn-diff history cache — populated ONLY for this LOADED session. The
  // session-list path (SharedWorkerSessionManager) never computes diffs, so
  // sidebar entries that aren't open cost nothing. Completed turns are cached by
  // turnIndex; the current (last) turn is always recomputed since it may still
  // be growing. `turnDiffHistoryFull` holds the latest full computation (with
  // hunks) so worker.getTurnDiffDetail serves a turn's hunks without recomputing.

  /**
   * Recompute and push the turn-diff history; best-effort, after the boot-critical messages emit.
   * Completed turns are cached (reset on rewind). Single-flight: mid-flight calls trigger one rerun.
   */
  async emitTurnDiffHistory(): Promise<void> {
    if (this.diffInFlight) {
      this.diffDirty = true
      return
    }
    this.diffInFlight = true
    try {
      do {
        this.diffDirty = false
        await this.computeAndEmitTurnDiffHistory()
      } while (this.diffDirty)
    } finally {
      this.diffInFlight = false
    }
  }

  private async computeAndEmitTurnDiffHistory(): Promise<void> {
    const runtime = this.runtime
    if (!runtime) return
    // Belt-and-braces alongside single-flight: a stale run (or one whose
    // scope was reset mid-await) must never commit or emit.
    const revision = ++this.diffRevision
    const isCurrent = (): boolean =>
      this.runtime === runtime && revision === this.diffRevision
    try {
      // Snapshot-backed sessions (`fileSnapshots: true` — SafeCode) mutate
      // through run_js's workspace facade, which the edit-call scan below is
      // blind to — their history comes from the snapshot store instead
      // (the feature doc's designed source switch). Same TurnFullDiff shape,
      // so the whole downstream pipe (meta push, getTurnDiffDetail, panel)
      // is unchanged.
      const recorder = runtime.fileSnapshotRecorder
      if (recorder) {
        const turns = await recorder.getTurnDiffs()
        if (!isCurrent()) return
        const history: TurnFullDiff[] = []
        for (const turn of turns) {
          const files = turn.files.map(snapshotDiffToTurnFileDiff)
          if (files.length === 0) continue
          let plusLines = 0
          let minusLines = 0
          for (const file of files) {
            plusLines += file.plusLines
            minusLines += file.minusLines
          }
          history.push({
            turnIndex: turn.turnSeq,
            promptPreview: turn.promptPreview,
            timestamp: new Date(turn.startedAt).toISOString(),
            files,
            stats: { touchedFiles: files.length, plusLines, minusLines },
          })
        }
        this.turnDiffHistoryFull = history
        const metas = history.map(toTurnDiffMeta).sort(byTurnStartDesc)
        // Whole-session total row (sentinel turnIndex 0), only when more than one turn changed
        // files; its diffs come from `getSessionSnapshotDiff`.
        if (history.length > 1) {
          const sessionMeta = await this.buildSessionTotalMeta(recorder)
          if (!isCurrent()) return
          if (sessionMeta) metas.unshift(sessionMeta)
        }
        this.host.emit({
          type: 'worker.turnDiffHistory',
          payload: { turns: metas },
        })
        return
      }

      const messages = runtime.engine.transcriptRows()
      if (messages.length < this.turnDiffLastMessageCount) {
        this.turnDiffCompletedCache.clear()
      }
      this.turnDiffLastMessageCount = messages.length

      const groups = collectAllEditTurns(messages)
      const history: TurnFullDiff[] = []
      for (let i = 0; i < groups.length; i++) {
        const group = groups[i]!
        const isLast = i === groups.length - 1
        const cached = isLast
          ? undefined
          : this.turnDiffCompletedCache.get(group.turnIndex)
        if (cached) {
          history.push(cached)
          continue
        }
        const full = await computeTurnDiff(group, id =>
          this.getToolCallDetail(id),
        )
        // Cache only completed turns; the current turn may still grow.
        if (!isLast) this.turnDiffCompletedCache.set(group.turnIndex, full)
        history.push(full)
      }

      if (!isCurrent()) return
      this.turnDiffHistoryFull = history
      this.host.emit({
        type: 'worker.turnDiffHistory',
        // Per-turn newest-first; wire-light (no hunks). No synthetic combined
        // entry: stacking every turn's snapshot-relative hunks into one "All
        // changes" view repeated intermediate states (a line added in turn 1
        // and replaced in turn 2 showed up as +, then -/+ again), which read
        // as duplicate changes. The per-turn rows are the honest unit.
        payload: { turns: history.map(toTurnDiffMeta).sort(byTurnStartDesc) },
      })
    } catch {
      // best-effort — never let a history failure disrupt the turn
    }
  }

  /**
   * The whole-session per-file diff (`turnIndex 0`), snapshot-anchored and continuity-checked via
   * `getSessionTotalDiffs`, not disk-anchored. `null` without a recorder.
   */
  async getSessionSnapshotDiff(): Promise<TurnFullDiff['files'] | null> {
    const runtime = this.runtime
    const recorder = runtime?.fileSnapshotRecorder
    if (!runtime || !recorder) return null
    try {
      const totals = await recorder.getSessionTotalDiffs()
      if (this.runtime !== runtime) return null
      return totals.map(snapshotTotalToTurnFileDiff)
    } catch {
      return null
    }
  }

  /** Build the "Whole session" (turnIndex 0) history meta row from the
   *  snapshot-anchored session total — its per-file external-change markers
   *  drive the panel's warning. Null when nothing net-changed this session. */
  private async buildSessionTotalMeta(
    recorder: FileSnapshotRecorder,
  ): Promise<TurnDiffMeta | null> {
    const totals = await recorder.getSessionTotalDiffs()
    if (totals.length === 0) return null
    const files = totals.map(snapshotTotalToTurnFileDiff)
    let plusLines = 0
    let minusLines = 0
    for (const file of files) {
      plusLines += file.plusLines
      minusLines += file.minusLines
    }
    return toTurnDiffMeta({
      turnIndex: SESSION_TOTAL_TURN_INDEX,
      promptPreview: '',
      files,
      stats: { touchedFiles: files.length, plusLines, minusLines },
    })
  }

  /**
   * Read a tool-call detail sidecar, hydrating (and persisting) it from the
   * in-memory transcript when the store has no record yet.
   */
  async getToolCallDetail(
    toolCallId: string,
  ): Promise<BrowserToolCallDetailRecord | null> {
    const runtime = this.runtime
    if (!runtime) {
      return null
    }

    const stored = await runtime.conversationStore.getToolCallDetail(
      toolCallId,
    )
    if (this.runtime !== runtime) {
      return null
    }
    if (stored) {
      return stored
    }

    let hydrated: BrowserToolCallDetailRecord | undefined
    for (const message of runtime.engine.transcriptRows()) {
      for (const detail of getToolCallDetailsFromMessage(message)) {
        if (detail.toolCallId !== toolCallId) {
          continue
        }

        hydrated = mergeToolCallDetails(hydrated, detail)
      }
    }

    if (!hydrated) {
      return null
    }

    // Best-effort: the read already succeeded from the
    // in-memory transcript — a failed persist must not turn a successful
    // hydration into a caller-visible failure.
    try {
      await runtime.conversationStore.saveToolCallDetail(hydrated)
    } catch {
      // next read re-hydrates
    }
    return this.runtime === runtime ? hydrated : null
  }
}

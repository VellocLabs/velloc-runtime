/**
 * Contract: session file snapshots (F-6). A mutation surface calls
 * `trackBeforeMutation(absPath, turn)` BEFORE mutating: the current bytes are
 * written as a blob, then the rows in one atomic batch, then the caller
 * mutates. After-states are captured at turn end. A capture failure THROWS and
 * the caller must not mutate; reads are best-effort. One recorder per session
 * runtime via `ToolUseContext.options.fileSnapshotRecorder`, never a module
 * global.
 */

import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import { isFsNotFoundError } from '../../utils/fsTransportFailure'
import { normalizePathKey } from '../../utils/paths'
import {
  computeSnapshotFileDiff,
  decodeSnapshotBytes,
  type SnapshotFileDiff,
  type SnapshotSideContent,
} from './snapshotDiff'
import type {
  SessionSnapshotStore,
  SnapshotFileState,
  SnapshotSessionFileRow,
  SnapshotTurnFileRow,
  SnapshotTurnRow,
} from './snapshotStore'

/** Which transcript turn a mutation belongs to — derived by the caller from
 *  the live message array (`deriveSnapshotTurnInfo`, utils/turnDiffs.ts) so
 *  `seq` lines up with the Diff panel's 1-based `turnIndex`. */
export type SnapshotTurnInfo = {
  seq: number
  uuid?: string
  preview: string
}

/** Default per-file capture cap (32 MB). Over it, the mutation proceeds and
 *  the row records `skipped` — diff/revert then mark the file untracked. */
export const DEFAULT_MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024

/** Directory-removal walk cap: a tree with more files than this (e.g. a
 *  node_modules delete) is recorded as ONE skipped placeholder row instead
 *  of thousands of blobs. */
export const MAX_DIR_REMOVAL_CAPTURE_FILES = 512

/** One side of the session diff, with content when captured. */
export type SnapshotContentState = {
  exists: boolean
  /** Content deliberately not captured (size cap / directory placeholder). */
  skipped: boolean
  /** Bytes when `exists && !skipped`; null otherwise (or unreadable blob). */
  bytes: Uint8Array | null
}

export type SessionFileChange = {
  /** Normalized identity key. */
  path: string
  displayPath: string
  original: SnapshotContentState
  current: SnapshotContentState
}

export type SnapshotRevertResult = {
  restored: string[]
  /** Rows whose content was never captured — left untouched. */
  skipped: string[]
  failed: string[]
}

/** The adjacent turn boundary at which an EXTERNAL change to a file was
 *  detected — the prior turn's after-image did not match the next turn's
 *  before-image, so something mutated the file outside this session between
 *  those two turns. */
export type SnapshotExternalBreak = { afterTurn: number; beforeTurn: number }

/**
 * One file's whole-session diff, from captured blobs only (never current
 * disk). `provenance`: 'clean' when every turn's after equals the next turn's
 * before; 'external' when a link broke, so it includes an outside change.
 */
export type SessionTotalFileDiff = {
  diff: SnapshotFileDiff
  provenance: 'clean' | 'external'
  externalBetween?: SnapshotExternalBreak
}

/** Thrown when a before-capture cannot be made durable. Callers surface it
 *  and MUST NOT perform the mutation. */
export class SnapshotCaptureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SnapshotCaptureError'
  }
}

export type FileSnapshotRecorderOptions = {
  store: SessionSnapshotStore
  fs: RuntimeFs
  /** Paths under which mutations are never captured (the session-storage
   *  tree — capturing our own blobs/DB would recurse). The store's own
   *  session dir is always excluded. */
  excludeRoots?: string[]
  maxSnapshotBytes?: number
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** One diff side from a captured/disk content state — the shared conversion
 *  the diff-computing read paths use (mirrors WorkspaceDiffTool's local
 *  `toSideContent`). */
export function snapshotContentToSide(
  state: SnapshotContentState,
): SnapshotSideContent {
  if (state.skipped) return { kind: 'notCaptured' }
  if (!state.exists) return { kind: 'absent' }
  return decodeSnapshotBytes(state.bytes)
}

export class FileSnapshotRecorder {
  private readonly store: SessionSnapshotStore
  private readonly fs: RuntimeFs
  private readonly excludeKeys: string[]
  private readonly maxSnapshotBytes: number
  /** Serializes every recorder op — the store is single-writer per session
   *  and this chain is what makes that true under concurrent tool calls. */
  private tail: Promise<unknown> = Promise.resolve()
  /** (turnSeq → set of captured path keys) — the fast idempotency check so
   *  a script writing one file in a loop pays one capture, not N queries. */
  private readonly capturedByTurn = new Map<number, Set<string>>()

  constructor(options: FileSnapshotRecorderOptions) {
    this.store = options.store
    this.fs = options.fs
    this.excludeKeys = [
      options.store.snapshotRoot(),
      ...(options.excludeRoots ?? []),
    ].map(root => normalizePathKey(root).replace(/\/+$/, ''))
    this.maxSnapshotBytes = options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES
  }

  /** Serialize an op onto the recorder's single-writer chain. The stored
   *  tail never rejects (one failed capture must not poison later ones);
   *  callers still get the real promise. */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.tail.then(op, op)
    this.tail = run.catch(() => {})
    return run
  }

  private isExcluded(pathKey: string): boolean {
    return this.excludeKeys.some(
      root => pathKey === root || pathKey.startsWith(`${root}/`),
    )
  }

  /**
   * Capture `absPath`'s current state as this turn's before-image (and the
   * session original on first-in-session touch). Idempotent per (turn, path).
   * MUST be awaited before the caller mutates the file; throws
   * {@link SnapshotCaptureError} when the capture cannot be made durable.
   */
  trackBeforeMutation(absPath: string, turn: SnapshotTurnInfo): Promise<void> {
    return this.enqueue(async () => {
      const pathKey = normalizePathKey(absPath)
      if (this.isExcluded(pathKey)) return
      const captured = this.capturedByTurn.get(turn.seq)
      if (captured?.has(pathKey)) return
      try {
        if (!captured && !(await this.store.getTurnFile(turn.seq, pathKey))) {
          // Fresh instance over an existing DB (recovery/reload): fall
          // through to capture. With a row already present, just re-seed the
          // in-memory set below.
        } else if (!captured) {
          this.remember(turn.seq, pathKey)
          return
        }
        const before = await this.captureState(absPath)
        const deduped = await this.reusePriorSnapshot(pathKey, turn.seq, before)
        await this.store.recordBeforeCapture({
          turn,
          path: pathKey,
          displayPath: absPath,
          before: deduped,
        })
        this.remember(turn.seq, pathKey)
      } catch (err) {
        throw new SnapshotCaptureError(
          `File snapshot capture failed for ${absPath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    })
  }

  /**
   * Before a RECURSIVE directory removal: capture every file under `absDir`
   * (bounded walk). Past {@link MAX_DIR_REMOVAL_CAPTURE_FILES} the directory
   * is recorded as ONE skipped placeholder row instead — the removal still
   * proceeds (record-and-skip, same policy as the size cap).
   */
  async trackBeforeDirectoryRemoval(
    absDir: string,
    turn: SnapshotTurnInfo,
  ): Promise<void> {
    const dirKey = normalizePathKey(absDir)
    if (this.isExcluded(dirKey)) return
    let files: string[] | null
    try {
      files = await this.walkFiles(absDir, MAX_DIR_REMOVAL_CAPTURE_FILES)
    } catch (err) {
      throw new SnapshotCaptureError(
        `File snapshot capture failed for ${absDir}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
    if (files === null) {
      // Too many files — one placeholder row marks the whole tree untracked.
      await this.enqueue(async () => {
        const captured = this.capturedByTurn.get(turn.seq)
        if (captured?.has(dirKey)) return
        await this.store.recordBeforeCapture({
          turn,
          path: dirKey,
          displayPath: absDir,
          before: { exists: true, snapshotId: null, skipped: true },
        })
        this.remember(turn.seq, dirKey)
      })
      return
    }
    for (const file of files) {
      await this.trackBeforeMutation(file, turn)
    }
  }

  /** Depth-first file list under `dir`, or null once `limit` is exceeded. */
  private async walkFiles(dir: string, limit: number): Promise<string[] | null> {
    const out: string[] = []
    const stack = [dir]
    while (stack.length > 0) {
      const current = stack.pop()!
      const entries = await this.fs.readdir(current)
      for (const entry of entries) {
        const child = `${current.replace(/[\\/]+$/, '')}/${entry.name}`
        if (entry.isDirectory()) {
          stack.push(child)
        } else {
          out.push(child)
          if (out.length > limit) return null
        }
      }
    }
    return out
  }

  /**
   * Finalize every open turn (turn end, and on session open after a crash).
   * For a path a later turn touched, that turn's before is this turn's after.
   */
  finalizeOpenTurns(): Promise<void> {
    return this.enqueue(async () => {
      if (!(await this.store.hasPersistedState())) return
      const open = await this.store.listUnfinalizedTurns()
      for (const turn of open) {
        await this.finalizeTurn(turn)
      }
    })
  }

  private async finalizeTurn(turn: SnapshotTurnRow): Promise<void> {
    const files = await this.store.listTurnFiles(turn.turnSeq)
    for (const row of files) {
      if (row.after !== null) continue
      const next = await this.store.getNextTurnFile(row.path, row.turnSeq)
      let after: SnapshotFileState
      if (next) {
        after = next.before
      } else {
        after = await this.captureAfterState(row)
      }
      await this.store.setTurnFileAfter(row.turnSeq, row.path, after)
    }
    await this.store.markTurnFinalized(turn.turnSeq)
  }

  /** After-state for a finalizing row: reuse the before snapshot when the
   *  disk content is unchanged; else capture a new blob. */
  private async captureAfterState(
    row: SnapshotTurnFileRow,
  ): Promise<SnapshotFileState> {
    // A skipped before (size cap / dir placeholder) has nothing to compare
    // against — mirror it as a skipped after so the row stays "untracked".
    if (row.before.skipped) {
      return { ...row.before }
    }
    const current = await this.captureState(row.displayPath, { noThrow: true })
    if (current.skipped) return current
    if (!current.exists) {
      return row.before.exists
        ? { exists: false, snapshotId: null, skipped: false }
        : row.before
    }
    const bytes = current.bytes!
    if (row.before.exists && row.before.snapshotId !== null) {
      const beforeBytes = await this.store.readSnapshotBlob(row.before.snapshotId)
      if (beforeBytes && bytesEqual(beforeBytes, bytes)) {
        return { ...row.before }
      }
    }
    const snapshotId = await this.store.writeSnapshotBlob(bytes)
    return { exists: true, snapshotId, skipped: false }
  }

  /** Alias for the session-open recovery call site — same op as turn end. */
  recoverUnfinalized(): Promise<void> {
    return this.finalizeOpenTurns()
  }

  /**
   * The whole-session diff sources: every touched file's ORIGINAL state
   * (with blob content) and its CURRENT disk state. Unchanged files are
   * filtered out; not-captured rows are kept (marked) so the UI/tool can
   * say so. Best-effort read path — throws only on store-level failure.
   */
  getSessionDiff(): Promise<SessionFileChange[]> {
    return this.enqueue(async () => {
      if (!(await this.store.hasPersistedState())) return []
      const rows = await this.store.listSessionFiles()
      const out: SessionFileChange[] = []
      for (const row of rows) {
        const original = await this.resolveContent(row.original)
        const current = await this.diskContent(row.displayPath)
        if (
          !row.original.skipped &&
          !current.skipped &&
          original.exists === current.exists &&
          (original.bytes === null) === (current.bytes === null) &&
          (original.bytes === null ||
            bytesEqual(original.bytes, current.bytes!))
        ) {
          continue
        }
        out.push({
          path: row.path,
          displayPath: row.displayPath,
          original,
          current,
        })
      }
      return out
    })
  }

  /** All recorded turns with their file rows — the Diff-panel history
   *  source for snapshot-backed sessions (UI wiring is a later change). */
  listTurns(): Promise<Array<SnapshotTurnRow & { files: SnapshotTurnFileRow[] }>> {
    return this.enqueue(async () => {
      if (!(await this.store.hasPersistedState())) return []
      const turns = await this.store.listTurns()
      const out: Array<SnapshotTurnRow & { files: SnapshotTurnFileRow[] }> = []
      for (const turn of turns) {
        out.push({ ...turn, files: await this.store.listTurnFiles(turn.turnSeq) })
      }
      return out
    })
  }

  /**
   * Per-turn file diffs: before-image against finalized after-image; an open
   * turn diffs against current disk. Unchanged files dropped; store failures
   * throw.
   */
  getTurnDiffs(): Promise<
    Array<{
      turnSeq: number
      promptPreview: string
      startedAt: number
      finalized: boolean
      files: SnapshotFileDiff[]
    }>
  > {
    return this.enqueue(async () => {
      if (!(await this.store.hasPersistedState())) return []
      const turns = await this.store.listTurns()
      const out: Array<{
        turnSeq: number
        promptPreview: string
        startedAt: number
        finalized: boolean
        files: SnapshotFileDiff[]
      }> = []
      for (const turn of turns) {
        const rows = await this.store.listTurnFiles(turn.turnSeq)
        const files: SnapshotFileDiff[] = []
        for (const row of rows) {
          const before = await this.resolveContent(row.before)
          const after = row.after
            ? await this.resolveContent(row.after)
            : await this.diskContent(row.displayPath)
          const diff = computeSnapshotFileDiff({
            displayPath: row.displayPath,
            before: snapshotContentToSide(before),
            after: snapshotContentToSide(after),
          })
          if (diff.kind !== 'unchanged') files.push(diff)
        }
        out.push({
          turnSeq: turn.turnSeq,
          promptPreview: turn.promptPreview,
          startedAt: turn.startedAt,
          finalized: turn.finalized,
          files,
        })
      }
      return out
    })
  }

  /**
   * The whole-session diff, COMPUTED per file (original → current disk) —
   * what the `WorkspaceDiff` card's file jump and the Diff panel's
   * session-level view read. Same sources as {@link getSessionDiff}, one
   * diff object per changed file instead of raw content pairs.
   */
  async getSessionFileDiffs(): Promise<SnapshotFileDiff[]> {
    const changes = await this.getSessionDiff()
    return changes
      .map(change =>
        computeSnapshotFileDiff({
          displayPath: change.displayPath,
          before: snapshotContentToSide(change.original),
          after: snapshotContentToSide(change.current),
        }),
      )
      .filter(diff => diff.kind !== 'unchanged')
  }

  /**
   * The WHOLE-SESSION total diff, per file — the panel's "Whole session" row.
   * Snapshot-anchored (session original → last captured after-image), NOT
   * disk-anchored, and continuity-checked: see {@link SessionTotalFileDiff}.
   * Net-unchanged files (including edit-then-revert round-trips) are dropped.
   * Best-effort read path — store-level failures throw like getSessionDiff.
   */
  getSessionTotalDiffs(): Promise<SessionTotalFileDiff[]> {
    return this.enqueue(async () => {
      if (!(await this.store.hasPersistedState())) return []
      const sessionFiles = await this.store.listSessionFiles()
      const out: SessionTotalFileDiff[] = []
      for (const file of sessionFiles) {
        const turnRows = await this.store.listTurnFilesForPath(file.path)
        if (turnRows.length === 0) continue
        // Endpoints from captured blobs (never live disk) — except the
        // still-open tail of a LIVE session (last turn not finalized, after
        // unstamped), where we fall back to disk for that one file so the
        // in-progress turn is visible. A REOPENED session has no open turn
        // (recovery finalizes on load), so its total is fully snapshot-anchored
        // and immune to other sessions' disk drift — the whole point.
        const original = await this.resolveContent(file.original)
        const lastRow = turnRows[turnRows.length - 1]!
        const after = lastRow.after
          ? await this.resolveContent(lastRow.after)
          : await this.diskContent(lastRow.displayPath)
        const diff = computeSnapshotFileDiff({
          displayPath: file.displayPath,
          before: snapshotContentToSide(original),
          after: snapshotContentToSide(after),
        })
        if (diff.kind === 'unchanged') continue
        // Continuity: the first adjacent link we can prove broken flips the
        // file to 'external' and records the boundary; unprovable links are
        // never treated as breaks (see statesContinuous).
        let provenance: 'clean' | 'external' = 'clean'
        let externalBetween: SnapshotExternalBreak | undefined
        for (let i = 1; i < turnRows.length; i++) {
          const prevAfter = turnRows[i - 1]!.after
          const curBefore = turnRows[i]!.before
          if (!(await this.statesContinuous(prevAfter, curBefore))) {
            provenance = 'external'
            externalBetween = {
              afterTurn: turnRows[i - 1]!.turnSeq,
              beforeTurn: turnRows[i]!.turnSeq,
            }
            break
          }
        }
        out.push({ diff, provenance, externalBetween })
      }
      return out
    })
  }

  /** Whether a turn's finalized after-state carried into the next turn's
   *  before-state unchanged — the link that proves NO external write happened
   *  in the gap. GENUINELY-incomparable links (an unfinalized prior after, a
   *  skipped side, or a state that carries no blob to compare) are NOT breaks —
   *  those are expected shapes, not evidence of drift. But when both sides DO
   *  carry a captured blob and one is UNREADABLE, we cannot prove the link
   *  held, so we fail toward the warning (treat it as a break) rather than
   *  silently clear a possible external change — the whole point of the flag. */
  private async statesContinuous(
    prevAfter: SnapshotFileState | null,
    curBefore: SnapshotFileState,
  ): Promise<boolean> {
    if (!prevAfter) return true
    if (prevAfter.skipped || curBefore.skipped) return true
    if (prevAfter.exists !== curBefore.exists) return false
    if (!prevAfter.exists && !curBefore.exists) return true
    if (
      prevAfter.snapshotId !== null &&
      prevAfter.snapshotId === curBefore.snapshotId
    ) {
      return true
    }
    // Both sides exist and are non-skipped, so both SHOULD carry a blob. A null
    // id is an unexpected-but-benign shape (nothing to compare) — not drift, so
    // don't fabricate a break.
    if (prevAfter.snapshotId === null || curBefore.snapshotId === null) {
      return true
    }
    const a = await this.store.readSnapshotBlob(prevAfter.snapshotId)
    const b = await this.store.readSnapshotBlob(curBefore.snapshotId)
    // A blob that should exist but won't read leaves the link UNPROVEN — flag
    // external rather than hide a change we simply couldn't verify.
    if (!a || !b) return false
    return bytesEqual(a, b)
  }

  /** Blob content for a captured state; null-bytes shape for absent rows. */
  async resolveContent(state: SnapshotFileState): Promise<SnapshotContentState> {
    if (!state.exists || state.skipped || state.snapshotId === null) {
      return { exists: state.exists, skipped: state.skipped, bytes: null }
    }
    return {
      exists: true,
      skipped: false,
      bytes: await this.store.readSnapshotBlob(state.snapshotId),
    }
  }

  /**
   * Restore every touched file to its SESSION ORIGINAL (the "discard the
   * whole session's changes" action). Only files that
   * differ are written; not-captured rows are reported, never touched.
   */
  revertSession(): Promise<SnapshotRevertResult> {
    return this.enqueue(async () => {
      if (!(await this.store.hasPersistedState())) {
        return { restored: [], skipped: [], failed: [] }
      }
      const rows = await this.store.listSessionFiles()
      return this.restoreStates(
        rows.map(row => ({ displayPath: row.displayPath, state: row.original })),
      )
    })
  }

  /**
   * Restore the workspace to the state it had BEFORE turn `turnSeq`: for
   * every path touched at or after that turn, the before-state of the
   * SMALLEST turn_seq ≥ turnSeq that touched it (rewind-to-point, not
   * "undo one turn" — a naive per-turn revert leaves later turns' writes
   * behind and produces an incoherent mix).
   */
  revertToTurnStart(turnSeq: number): Promise<SnapshotRevertResult> {
    return this.enqueue(async () => {
      if (!(await this.store.hasPersistedState())) {
        return { restored: [], skipped: [], failed: [] }
      }
      const rows = await this.store.listTurnFilesFrom(turnSeq)
      const earliestByPath = new Map<
        string,
        { displayPath: string; state: SnapshotFileState }
      >()
      for (const row of rows) {
        // Rows arrive ordered by turn_seq: first row per path wins.
        if (!earliestByPath.has(row.path)) {
          earliestByPath.set(row.path, {
            displayPath: row.displayPath,
            state: row.before,
          })
        }
      }
      return this.restoreStates([...earliestByPath.values()])
    })
  }

  private async restoreStates(
    targets: Array<{ displayPath: string; state: SnapshotFileState }>,
  ): Promise<SnapshotRevertResult> {
    const result: SnapshotRevertResult = { restored: [], skipped: [], failed: [] }
    for (const target of targets) {
      const { displayPath, state } = target
      if (state.skipped) {
        result.skipped.push(displayPath)
        continue
      }
      try {
        if (!state.exists) {
          // Target state: absent. Delete if present (restore-only-if-changed).
          try {
            await this.fs.unlink(displayPath)
            result.restored.push(displayPath)
          } catch {
            // already absent — nothing to do
          }
          continue
        }
        const bytes =
          state.snapshotId !== null
            ? await this.store.readSnapshotBlob(state.snapshotId)
            : null
        if (bytes === null) {
          result.failed.push(displayPath)
          continue
        }
        const current = await this.diskContent(displayPath)
        if (
          current.exists &&
          current.bytes !== null &&
          bytesEqual(current.bytes, bytes)
        ) {
          continue // unchanged — don't rewrite
        }
        await this.fs.writeFile(displayPath, bytes)
        result.restored.push(displayPath)
      } catch {
        result.failed.push(displayPath)
      }
    }
    return result
  }

  private remember(turnSeq: number, pathKey: string): void {
    let set = this.capturedByTurn.get(turnSeq)
    if (!set) {
      set = new Set()
      this.capturedByTurn.set(turnSeq, set)
    }
    set.add(pathKey)
  }

  /** Current disk state as a {@link SnapshotFileState}-shaped capture:
   *  absent / skipped (dir or over-cap) / bytes. */
  private async captureState(
    absPath: string,
    opts?: { noThrow?: boolean },
  ): Promise<SnapshotContentState & SnapshotFileState> {
    let size: number
    let isDirectory = false
    try {
      const st = await this.fs.stat(absPath)
      size = st.size
      isDirectory = st.isDirectory()
    } catch (err) {
      // Only a genuinely-absent path may read as exists:false — that state
      // DRIVES A DELETE on revert ("restore to absent"), so collapsing a
      // transient EACCES/EBUSY/dead-bridge stat into it poisons the
      // before-image (INSERT OR IGNORE makes the first capture permanent)
      // and turns a later revert destructive.
      if (isFsNotFoundError(err)) {
        return { exists: false, snapshotId: null, skipped: false, bytes: null }
      }
      if (opts?.noThrow) {
        // Finalize/inspection paths: `skipped` is the established safe
        // "state unknown / untracked" encoding — restore leaves it alone
        // and continuity checks treat it as non-evidence.
        return { exists: true, snapshotId: null, skipped: true, bytes: null }
      }
      // Capture path: "mutated but unsnapshotted" is the one state the
      // safety net refuses to create — fail the capture loudly.
      throw err
    }
    if (isDirectory || size > this.maxSnapshotBytes) {
      return { exists: true, snapshotId: null, skipped: true, bytes: null }
    }
    try {
      const bytes = await this.fs.readFileBytes(absPath)
      return { exists: true, snapshotId: null, skipped: false, bytes }
    } catch (err) {
      if (opts?.noThrow) {
        // Finalize path: a read race (file deleted between stat and read)
        // degrades to "absent now" rather than failing the whole finalize.
        return { exists: false, snapshotId: null, skipped: false, bytes: null }
      }
      throw err
    }
  }

  private async diskContent(absPath: string): Promise<SnapshotContentState> {
    const state = await this.captureState(absPath, { noThrow: true })
    return { exists: state.exists, skipped: state.skipped, bytes: state.bytes }
  }

  /** Dedup: when the immediately-prior turn's AFTER for this path captured
   *  content byte-identical to the new before, reuse its snapshot id
   *  ("turn N+1's before is turn N's after" — no second blob). */
  private async reusePriorSnapshot(
    pathKey: string,
    turnSeq: number,
    before: SnapshotContentState & SnapshotFileState,
  ): Promise<SnapshotFileState> {
    if (before.skipped) {
      return { exists: before.exists, snapshotId: null, skipped: true }
    }
    if (!before.exists) {
      return { exists: false, snapshotId: null, skipped: false }
    }
    const bytes = before.bytes!
    const prior = await this.store.getPriorTurnFile(pathKey, turnSeq)
    const candidate = prior?.after ?? null
    if (
      candidate &&
      candidate.exists &&
      !candidate.skipped &&
      candidate.snapshotId !== null
    ) {
      const priorBytes = await this.store.readSnapshotBlob(candidate.snapshotId)
      if (priorBytes && bytesEqual(priorBytes, bytes)) {
        return { exists: true, snapshotId: candidate.snapshotId, skipped: false }
      }
    }
    const snapshotId = await this.store.writeSnapshotBlob(bytes)
    return { exists: true, snapshotId, skipped: false }
  }
}

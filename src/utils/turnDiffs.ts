import type { StructuredPatchHunk } from 'diff'
import type { ModelReplyRow, Message } from '../runtime/RuntimeTypes'
import {
  MSG_TYPE_USER,
  PART_TOOL_CALL,
  PART_TOOL_RESULT_CANONICAL,
  isAssistantMessage,
} from '../runtime/VercelModelConstants'
import {
  EDIT_TOOL_ID,
  WRITE_TOOL_ID,
} from '../prompting/fileToolNames'
import { summarizeFileChange, type FileChangeDiff } from './fileChangeHunks'
import { normalizePathKey } from './paths'

/**
 * Turn-diff history: which files each user turn changed, with their hunks (from
 * each Edit/Write detail record's `editDiff`). Pure; driven by the worker for
 * loaded sessions only.
 */

/** When set on a WHOLE-SESSION (turnIndex 0) file row: the file was changed
 *  OUTSIDE this session between these two turns, so its session-total diff
 *  includes work that is not this session's. Absent on per-turn rows. */
export type ExternalChangeMarker = { afterTurn: number; beforeTurn: number }

/** Sentinel `turnIndex` for the synthetic WHOLE-SESSION total row (real turns
 *  are 1-based). Its detail hunks come from `getSessionSnapshotDiff`; the UI
 *  renders it as "Whole session" rather than "Turn N". */
export const SESSION_TOTAL_TURN_INDEX = 0

export type TurnFileChange = {
  filePath: string
  hunks: StructuredPatchHunk[]
  fileWasCreated: boolean
  plusLines: number
  minusLines: number
  externalChange?: ExternalChangeMarker
}

/** Aggregate of one turn's per-file diffs. */
export type TurnDiffSummary = {
  files: TurnFileChange[]
  touchedFiles: number
  plusLines: number
  minusLines: number
}

export type TurnEditCall = {
  toolCallId: string
  toolName: string
}

/** One turn's edit calls + prompt metadata (before its diffs are computed). */
export type TurnEditCallGroup = {
  turnIndex: number
  promptPreview: string
  timestamp?: string
  calls: TurnEditCall[]
}

/** A fully computed turn diff (WITH hunks). Cached in the worker; its hunks are
 *  served on demand via `worker.getTurnDiffDetail`. */
export type TurnFullDiff = {
  turnIndex: number
  promptPreview: string
  timestamp?: string
  files: TurnFileChange[]
  stats: { touchedFiles: number; plusLines: number; minusLines: number }
}

/** Per-file metadata (NO hunks) — the wire-light projection for the bar. */
export type TurnDiffFileMeta = {
  filePath: string
  fileWasCreated: boolean
  plusLines: number
  minusLines: number
  externalChange?: ExternalChangeMarker
}

/** Per-turn metadata (NO hunks) pushed to the webview to render the history bar. */
export type TurnDiffMeta = {
  turnIndex: number
  promptPreview: string
  timestamp?: string
  stats: { touchedFiles: number; plusLines: number; minusLines: number }
  files: TurnDiffFileMeta[]
}
/**
 * Newest-first by the turn's start `timestamp` (survives compaction, unlike
 * `turnIndex`). Missing timestamps sink to the bottom; `turnIndex` breaks ties.
 */
export function byTurnStartDesc(
  a: { timestamp?: string; turnIndex: number },
  b: { timestamp?: string; turnIndex: number },
): number {
  const ta = a.timestamp ? Date.parse(a.timestamp) : NaN
  const tb = b.timestamp ? Date.parse(b.timestamp) : NaN
  const aMissing = Number.isNaN(ta)
  const bMissing = Number.isNaN(tb)
  if (aMissing && bMissing) return b.turnIndex - a.turnIndex
  if (aMissing) return 1
  if (bMissing) return -1
  if (tb !== ta) return tb - ta
  return b.turnIndex - a.turnIndex
}


/** Structural shape `editDiffForCall` needs from a detail record. */
export type EditDetailLike = { editDiff?: FileChangeDiff; args?: unknown }

function getString(
  record: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

/**
 * A real user prompt that opens a new turn — NOT a tool-result message and not
 * a synthetic/meta message (`!isToolResult && !message.isMeta`). Exported: the file-snapshot recorder
 * derives its `turn_seq` from the SAME boundary rule
 * ({@link deriveSnapshotTurnInfo}) so snapshot turns line up with the Diff
 * panel's `turnIndex`.
 */
export function isTurnBoundary(message: Message): boolean {
  if (message.type !== MSG_TYPE_USER) return false
  if ((message as { isMeta?: boolean }).isMeta) return false
  if ((message as { toolCallDetailRef?: unknown }).toolCallDetailRef) return false
  const content = (message as { message?: { content?: unknown } }).message?.content
  if (
    Array.isArray(content) &&
    (content[0] as { type?: unknown } | undefined)?.type ===
      PART_TOOL_RESULT_CANONICAL
  ) {
    return false
  }
  return true
}

/** First ~40 chars of a user prompt. */
export function promptSnippet(message: Message): string {
  const content = (message as { message?: { content?: unknown } }).message?.content
  let text = ''
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    text = content
      .map(part =>
        part &&
        typeof part === 'object' &&
        typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('')
  }
  const trimmed = text.trim()
  return trimmed.length <= 40 ? trimmed : trimmed.slice(0, 39) + '…'
}

function rowTime(message: Message): string | undefined {
  const ts = (message as { timestamp?: unknown }).timestamp
  return typeof ts === 'string' ? ts : undefined
}

/**
 * The turn the current mutation belongs to: `seq` counts turn boundaries in the
 * live messages (same 1-based numbering as `turnIndex`). A meta-resumed turn
 * attributes to the last boundary; no boundary yields seq 1.
 */
export function deriveSnapshotTurnInfo(messages: readonly Message[]): {
  seq: number
  uuid?: string
  preview: string
} {
  let seq = 0
  let opening: Message | null = null
  for (const message of messages) {
    if (isTurnBoundary(message)) {
      seq += 1
      opening = message
    }
  }
  if (seq === 0 || !opening) {
    return { seq: 1, preview: '' }
  }
  const uuid = (opening as { uuid?: unknown }).uuid
  return {
    seq,
    uuid: typeof uuid === 'string' ? uuid : undefined,
    preview: promptSnippet(opening),
  }
}

/** Edit/Write calls in messages[start, end), in order, deduped by id. */
function collectEditCallsInRange(
  messages: readonly Message[],
  start: number,
  end: number,
): TurnEditCall[] {
  const calls: TurnEditCall[] = []
  const seen = new Set<string>()
  for (let i = start; i < end; i++) {
    const message = messages[i]
    if (!message || !isAssistantMessage(message)) continue
    const content = (message as ModelReplyRow).message.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const record = part as Record<string, unknown>
      if (record.type !== PART_TOOL_CALL) continue
      const toolName = getString(record, 'toolName', 'name')
      if (toolName !== EDIT_TOOL_ID && toolName !== WRITE_TOOL_ID) {
        continue
      }
      const toolCallId = getString(record, 'toolCallId', 'id')
      if (!toolCallId || seen.has(toolCallId)) continue
      seen.add(toolCallId)
      calls.push({ toolCallId, toolName })
    }
  }
  return calls
}

/**
 * Every edit-turn in the transcript, oldest→newest. `turnIndex` is 1-based and
 * counts ALL user-prompt boundaries, so non-editing turns are
 * skipped but don't shift the numbering. The pre-diff grouping the worker turns
 * into a {@link TurnFullDiff} via {@link computeTurnDiff}.
 */
export function collectAllEditTurns(
  messages: readonly Message[],
): TurnEditCallGroup[] {
  const boundaries: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (isTurnBoundary(messages[i]!)) boundaries.push(i)
  }
  const turns: TurnEditCallGroup[] = []
  for (let k = 0; k < boundaries.length; k++) {
    const start = boundaries[k]!
    const end = k + 1 < boundaries.length ? boundaries[k + 1]! : messages.length
    const calls = collectEditCallsInRange(messages, start, end)
    if (calls.length === 0) continue
    turns.push({
      turnIndex: k + 1,
      promptPreview: promptSnippet(messages[start]!),
      timestamp: rowTime(messages[start]!),
      calls,
    })
  }
  return turns
}

/**
 * Resolve the {@link FileChangeDiff} for one edit call from its detail record.
 * Prefers the host-sourced, file-relative `editDiff`; otherwise falls back to a
 * snippet-relative diff from the call ARGS (Edit only — a Write without the
 * host's `original_file` can't be reliably classed create-vs-update). The
 * fallback's line numbers are 1-based, but file list + ± counts + changed lines
 * are correct.
 */
export function editDiffForCall(
  toolName: string,
  detail: EditDetailLike | null | undefined,
): FileChangeDiff | null {
  if (!detail) return null
  if (detail.editDiff) return detail.editDiff
  const args = detail.args
  if (!args || typeof args !== 'object') return null
  if (toolName !== EDIT_TOOL_ID) return null
  const record = args as Record<string, unknown>
  if (
    typeof record.old_string !== 'string' ||
    typeof record.new_string !== 'string'
  ) {
    return null
  }
  return summarizeFileChange({
    op: 'replace',
    path: typeof record.file_path === 'string' ? record.file_path : '',
    find: record.old_string,
    put: record.new_string,
    everywhere: record.replace_all === true,
  })
}

/**
 * Fold per-call `FileChangeDiff`s into one turn summary, grouping by file path (a
 * file edited several times in a turn appends its hunks and sums its counts).
 */
export function aggregateTurnDiffs(
  diffs: ReadonlyArray<FileChangeDiff | null | undefined>,
): TurnDiffSummary {
  // Key on a canonical path so the SAME file spelled two ways in one turn
  // (`D:\a\b` vs `D:/a/b` — e.g. an image upload + a later edit) folds into one
  // row instead of appearing twice. The first-seen spelling is kept for display.
  const fileMap = new Map<string, TurnFileChange>()
  // Per file, the signatures of diffs already folded in — so a byte-identical
  // RE-REPORT of the same edit (the same file written under several path
  // spellings, or a duplicated tool call) contributes its hunks + counts ONCE.
  // Without this the merged row renders the same diff two or three times.
  const seenPerFile = new Map<string, Set<string>>()
  for (const diff of diffs) {
    if (!diff) continue
    const key = normalizePathKey(diff.filePath)
    const signature = JSON.stringify(diff.patchHunks)
    let seen = seenPerFile.get(key)
    if (!seen) {
      seen = new Set()
      seenPerFile.set(key, seen)
    }
    if (seen.has(signature)) continue
    seen.add(signature)

    let entry = fileMap.get(key)
    if (!entry) {
      entry = {
        filePath: diff.filePath,
        hunks: [],
        fileWasCreated: diff.fileWasCreated,
        plusLines: 0,
        minusLines: 0,
      }
      fileMap.set(key, entry)
    }
    entry.hunks.push(...diff.patchHunks)
    entry.plusLines += diff.plusLines
    entry.minusLines += diff.minusLines
    if (diff.fileWasCreated) entry.fileWasCreated = true
  }

  const files = Array.from(fileMap.values())
  let plusLines = 0
  let minusLines = 0
  for (const file of files) {
    plusLines += file.plusLines
    minusLines += file.minusLines
  }
  return {
    files,
    touchedFiles: files.length,
    plusLines,
    minusLines,
  }
}

/**
 * Compute one turn's full diff (with hunks). Pure except for the injected async
 * `getDetail` (the worker's `getToolCallDetail`, which reads persisted
 * sidecars). Unit-testable with a mock `getDetail`.
 */
export async function computeTurnDiff(
  group: TurnEditCallGroup,
  getDetail: (toolCallId: string) => Promise<EditDetailLike | null>,
): Promise<TurnFullDiff> {
  const diffs = await Promise.all(
    group.calls.map(async call =>
      editDiffForCall(call.toolName, await getDetail(call.toolCallId)),
    ),
  )
  const agg = aggregateTurnDiffs(diffs)
  return {
    turnIndex: group.turnIndex,
    promptPreview: group.promptPreview,
    timestamp: group.timestamp,
    files: agg.files,
    stats: {
      touchedFiles: agg.touchedFiles,
      plusLines: agg.plusLines,
      minusLines: agg.minusLines,
    },
  }
}

/** Drop hunks → the wire-light {@link TurnDiffMeta} the bar renders. */
export function toTurnDiffMeta(turn: TurnFullDiff): TurnDiffMeta {
  return {
    turnIndex: turn.turnIndex,
    promptPreview: turn.promptPreview,
    timestamp: turn.timestamp,
    stats: turn.stats,
    files: turn.files.map(f => ({
      filePath: f.filePath,
      fileWasCreated: f.fileWasCreated,
      plusLines: f.plusLines,
      minusLines: f.minusLines,
      ...(f.externalChange ? { externalChange: f.externalChange } : {}),
    })),
  }
}

/** Lower-cased, '/'-separated, trailing-slash-free — for containment tests
 *  between a model-supplied path and a recorded displayPath. */
function comparablePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * Which of `files` a `WorkspaceDiff` call's (model-supplied, possibly
 * relative) `path` names. Exact normalized match first; then a
 * path-boundary suffix match (`…/src/a.ts` for `src/a.ts`); then a unique
 * basename match. Null when nothing (or more than one basename candidate)
 * matches — the caller falls back to the turn-history tab rather than
 * guessing.
 */
export function findWorkspaceDiffFile(
  files: readonly TurnFileChange[] | null,
  path: string,
): TurnFileChange | null {
  if (!files || files.length === 0) return null
  const wanted = comparablePath(path.trim())
  if (!wanted) return null
  for (const file of files) {
    if (comparablePath(file.filePath) === wanted) return file
  }
  const suffixMatches = files.filter(file =>
    comparablePath(file.filePath).endsWith(`/${wanted}`),
  )
  if (suffixMatches.length === 1) return suffixMatches[0]!
  if (suffixMatches.length > 1) return null
  const wantedBase = wanted.slice(wanted.lastIndexOf('/') + 1)
  const baseMatches = files.filter(file => {
    const comparable = comparablePath(file.filePath)
    return comparable.slice(comparable.lastIndexOf('/') + 1) === wantedBase
  })
  return baseMatches.length === 1 ? baseMatches[0]! : null
}

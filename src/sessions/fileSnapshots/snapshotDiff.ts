/**
 * Snapshot → diff: structured-patch hunks (via `utils/fileChangeHunks.ts`, as
 * Edit/Write) and unified diff text for `WorkspaceDiff`. Pure.
 */

import type { StructuredPatchHunk } from 'diff'
import {
  hunksBetween,
  hunksForCreation,
  tallyHunkRows,
} from '../../utils/fileChangeHunks'

/** Content resolved for one side of a diff. */
export type SnapshotSideContent =
  | { kind: 'absent' }
  | { kind: 'text'; text: string }
  | { kind: 'binary' }
  /** Content was never captured (size cap / directory placeholder). */
  | { kind: 'notCaptured' }

export type SnapshotFileDiff = {
  displayPath: string
  kind: 'text' | 'binary' | 'notCaptured' | 'unchanged'
  /** Only for kind 'text'. */
  hunks: StructuredPatchHunk[]
  fileWasCreated: boolean
  isDeleted: boolean
  plusLines: number
  minusLines: number
}

/** NUL byte in the first 8KB ⇒ treat as binary (git's heuristic). */
const BINARY_SNIFF_BYTES = 8192

export function decodeSnapshotBytes(
  bytes: Uint8Array | null | undefined,
): SnapshotSideContent {
  if (bytes == null) return { kind: 'absent' }
  const sniffEnd = Math.min(bytes.length, BINARY_SNIFF_BYTES)
  for (let i = 0; i < sniffEnd; i++) {
    if (bytes[i] === 0) return { kind: 'binary' }
  }
  return { kind: 'text', text: new TextDecoder('utf-8').decode(bytes) }
}

/**
 * Diff one file's two sides: either notCaptured → 'notCaptured'; both absent
 * or equal text → 'unchanged'; a present binary side → 'binary' (no hunks);
 * else text hunks (create all-`+`, delete to empty, edit full-content patch).
 */
export function computeSnapshotFileDiff(args: {
  displayPath: string
  before: SnapshotSideContent
  after: SnapshotSideContent
}): SnapshotFileDiff {
  const { displayPath, before, after } = args
  const base: Omit<SnapshotFileDiff, 'kind'> = {
    displayPath,
    hunks: [],
    fileWasCreated: before.kind === 'absent' && after.kind !== 'absent',
    isDeleted: before.kind !== 'absent' && after.kind === 'absent',
    plusLines: 0,
    minusLines: 0,
  }
  if (before.kind === 'notCaptured' || after.kind === 'notCaptured') {
    return { ...base, kind: 'notCaptured' }
  }
  if (before.kind === 'absent' && after.kind === 'absent') {
    return { ...base, kind: 'unchanged' }
  }
  if (before.kind === 'binary' || after.kind === 'binary') {
    return { ...base, kind: 'binary' }
  }
  const beforeText = before.kind === 'text' ? before.text : null
  const afterText = after.kind === 'text' ? after.text : null
  if (beforeText === afterText) {
    return { ...base, kind: 'unchanged' }
  }
  let hunks: StructuredPatchHunk[]
  if (beforeText === null) {
    hunks = hunksForCreation(afterText ?? '')
  } else {
    hunks = hunksBetween(displayPath, beforeText, afterText ?? '')
  }
  if (hunks.length === 0) {
    // Contents differ only in ways the patch normalizes (e.g. leading-tab
    // rendering) — report unchanged rather than an empty diff body.
    return { ...base, kind: 'unchanged' }
  }
  const { added, removed } = tallyHunkRows(hunks)
  return { ...base, kind: 'text', hunks, plusLines: added, minusLines: removed }
}

/**
 * Git-style unified diff text over a set of per-file diffs — the
 * `WorkspaceDiff` tool's output body. Unchanged files are skipped by the
 * caller; binary / not-captured files render one marker line each.
 */
export function formatUnifiedDiffText(diffs: readonly SnapshotFileDiff[]): string {
  const parts: string[] = []
  for (const diff of diffs) {
    if (diff.kind === 'unchanged') continue
    const p = diff.displayPath.replace(/\\/g, '/')
    parts.push(`diff --git a/${p} b/${p}`)
    if (diff.kind === 'binary') {
      parts.push(`Binary file ${p} changed`)
      continue
    }
    if (diff.kind === 'notCaptured') {
      parts.push(
        `${p}: changes not captured (file exceeded the snapshot size limit)`,
      )
      continue
    }
    if (diff.fileWasCreated) parts.push('new file')
    if (diff.isDeleted) parts.push('deleted file')
    parts.push(diff.fileWasCreated ? '--- /dev/null' : `--- a/${p}`)
    parts.push(diff.isDeleted ? '+++ /dev/null' : `+++ b/${p}`)
    for (const hunk of diff.hunks) {
      parts.push(
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      )
      for (const line of hunk.lines) parts.push(line)
    }
  }
  return parts.join('\n')
}

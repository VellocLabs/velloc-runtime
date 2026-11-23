/**
 * Contract: the usage log's rows for a SuperEdit commit (F-27). One row per
 * file the commit wrote, removed or moved, handed to the log as one batch
 * when the commit ends, whether it finished or stopped part way; a `mkdir`
 * writes no row, and an op that did not land writes none. A write's
 * `added`/`removed` are a line diff of the file's bytes before the commit
 * against the bytes written; a file removal counts its lines as removed. The
 * earlier bytes are the commit's own earlier op on that path, else those the
 * script read through the overlay, else one read from disk just before the
 * op. A binary side, or a side over `LINE_COUNT_MAX_BYTES`, counts no lines;
 * once a commit has spent `LINE_COUNT_BUDGET_MS` diffing, an edit counts no
 * lines. Nothing here throws.
 */

import type { CommitOp, OverlayFs } from '../../browser/runJs/overlayFs'
import { SUPER_EDIT_TOOL_NAME } from '../../browser/runJs/runJsProtocol'
import { decodeSnapshotBytes, type SnapshotSideContent } from '../../sessions/fileSnapshots/snapshotDiff'
import { hunksBetween, tallyHunkRows } from '../../utils/fileChangeHunks'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import { isFsNotFoundError } from '../../utils/fsTransportFailure'
import type { ToolCallContext } from '../toolCallContext'
import { recordFileBatch, type FileBatchItem } from './host/fileActivity'

/** The largest side a commit row diffs for its line counts. */
export const LINE_COUNT_MAX_BYTES = 2 * 1024 * 1024

/** The time one commit may spend diffing edited files, in all. */
export const LINE_COUNT_BUDGET_MS = 1_000

/** What a file held before an op: its bytes, absent, a directory, or not known. */
type Before = { kind: 'bytes'; bytes: Uint8Array } | { kind: 'absent' } | { kind: 'dir' } | { kind: 'unknown' }

export type CommitFileRows = {
  /** Before `op` runs: takes what its row needs from disk. */
  before(op: CommitOp): Promise<void>
  /** After `op` landed on disk. */
  landed(op: CommitOp): void
  /** Hands the landed ops' rows to the log. */
  flush(): void
}

const UNKNOWN: Before = { kind: 'unknown' }
const NO_LINES = { added: 0, removed: 0 }

const isUnder = (root: string, path: string): boolean => path === root || path.startsWith(`${root}/`)

function sideOf(before: Before): SnapshotSideContent {
  if (before.kind === 'absent') return { kind: 'absent' }
  if (before.kind !== 'bytes' || before.bytes.length > LINE_COUNT_MAX_BYTES) return { kind: 'notCaptured' }
  return decodeSnapshotBytes(before.bytes)
}

const afterSide = (bytes: Uint8Array | null): SnapshotSideContent =>
  bytes !== null && bytes.length > LINE_COUNT_MAX_BYTES ? { kind: 'notCaptured' } : decodeSnapshotBytes(bytes)

const textOf = (side: SnapshotSideContent): string | undefined => (side.kind === 'absent' ? '' : side.kind === 'text' ? side.text : undefined)

export function startCommitFileRows(context: ToolCallContext, fs: RuntimeFs, overlay: OverlayFs): CommitFileRows {
  /** A path's bytes as this commit's own earlier ops left them. */
  const written = new Map<string, Before>()
  /** Paths this commit removed or moved: the script's reads under them no longer match the disk. */
  const gone: string[] = []
  const items: FileBatchItem[] = []
  let current: { op: CommitOp; before: Before } | undefined
  let budgetMs = LINE_COUNT_BUDGET_MS

  /** Lines added and removed from `before` to `after`; none when either side is binary or not known. An absent side is empty. */
  function lineCounts(path: string, before: SnapshotSideContent, after: SnapshotSideContent): { added: number; removed: number } {
    const from = textOf(before)
    const to = textOf(after)
    if (from === undefined || to === undefined || from === to) return NO_LINES
    const edit = from !== '' && to !== ''
    if (edit && budgetMs <= 0) return NO_LINES
    const start = Date.now()
    try {
      return tallyHunkRows(edit ? hunksBetween(path, from, to, budgetMs) : hunksBetween(path, from, to))
    } catch {
      return NO_LINES
    } finally {
      if (edit) budgetMs -= Date.now() - start
    }
  }

  function keptOf(path: string): Before | undefined {
    if (gone.some(root => isUnder(root, path))) return undefined
    const kept = overlay.pristineBytesOf(path)
    return kept ? { kind: 'bytes', bytes: kept } : undefined
  }

  function forget(root: string): void {
    for (const key of [...written.keys()]) if (isUnder(root, key)) written.delete(key)
    gone.push(root)
  }

  async function diskBefore(path: string): Promise<Before> {
    const own = written.get(path) ?? keptOf(path)
    if (own) return own
    try {
      const stat = await fs.stat(path)
      if (stat.isDirectory()) return { kind: 'dir' }
      if (stat.size > LINE_COUNT_MAX_BYTES) return UNKNOWN
      const bytes: unknown = await fs.readFileBytes(path)
      return bytes instanceof Uint8Array ? { kind: 'bytes', bytes } : UNKNOWN
    } catch (error) {
      return isFsNotFoundError(error) ? { kind: 'absent' } : UNKNOWN
    }
  }

  function rowFor(op: CommitOp, before: Before): void {
    if (op.op === 'mkdir') return
    if (op.op === 'move') {
      forget(op.from)
      forget(op.to)
      if (before.kind === 'bytes') written.set(op.to, before)
      written.set(op.from, { kind: 'absent' })
      items.push({ filePath: op.to, fromPath: op.from, facts: { tool: SUPER_EDIT_TOOL_NAME, op: 'move', outcome: 'ok' } })
      return
    }
    if (op.op === 'remove') {
      forget(op.path)
      written.set(op.path, { kind: 'absent' })
      const removed = before.kind === 'dir' ? 0 : lineCounts(op.path, sideOf(before), { kind: 'absent' }).removed
      items.push({ filePath: op.path, facts: { tool: SUPER_EDIT_TOOL_NAME, op: 'remove', removed, outcome: 'ok' } })
      return
    }
    written.set(op.path, { kind: 'bytes', bytes: op.bytes })
    const lines = lineCounts(op.path, sideOf(before), afterSide(op.bytes))
    items.push({
      filePath: op.path,
      facts: {
        tool: SUPER_EDIT_TOOL_NAME,
        op: 'write',
        bytes: op.bytes.length,
        added: lines.added,
        removed: lines.removed,
        ...(before.kind === 'absent' ? { created: true } : {}),
        outcome: 'ok',
      },
    })
  }

  return {
    async before(op) {
      current = undefined
      try {
        if (op.op === 'writeFile' || op.op === 'remove') current = { op, before: await diskBefore(op.path) }
        else if (op.op === 'move') current = { op, before: written.get(op.from) ?? keptOf(op.from) ?? UNKNOWN }
      } catch {
        current = { op, before: UNKNOWN }
      }
    },
    landed(op) {
      const taken = current?.op === op ? current.before : undefined
      current = undefined
      try {
        rowFor(op, taken ?? UNKNOWN)
      } catch {
        // A row that cannot be built is left out; the commit is never affected.
      }
    },
    flush() {
      try {
        recordFileBatch(context, items.splice(0))
      } catch {
        // Runs in the commit's `finally`: a throw here would replace the commit's outcome.
      }
    },
  }
}

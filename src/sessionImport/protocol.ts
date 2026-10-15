/**
 * Session import protocol, shared by the SharedWorker adapter and the
 * dedicated import Worker. The Worker is pure (bytes in, rows or an
 * `ImportConvertResult` out; no fs bridge), so a crash or hang stays contained.
 * Requests carry an `ImportSource` dispatched to `sources/<source>/`. Types
 * only: keep runtime imports out of the Worker chunk.
 */

import type {
  BrowserTranscriptWriteEntry,
  SessionMetaFile,
} from '../sessions/sessionStore'
import type { BrowserToolCallDetailRecord } from '../utils/toolCallDetails'

/** Providers whose sessions can be imported. Extend here, then add
 *  `sources/<source>/`. Values are protocol (wire + `importedFrom.source`),
 *  never user-visible text. */
export type ImportSource = 'claude-code' | 'codex'

export const IMPORT_SOURCES: readonly ImportSource[] = ['claude-code', 'codex']

export function isImportSource(value: unknown): value is ImportSource {
  return (
    typeof value === 'string' &&
    (IMPORT_SOURCES as readonly string[]).includes(value)
  )
}

/** Rows per dialog page. The adapter lite-reads exactly one page of files
 *  per `listSessions` call, so this bounds the per-call read budget. */
export const IMPORT_PAGE_SIZE = 50

/** Bytes of head and of tail read per file for the lite (title) pass:
 *  64 KiB each. */
export const IMPORT_LITE_READ_BYTES = 64 * 1024

/** One file handed to `parseLite`: the head and tail slices as text. */
export type ImportLiteItem = {
  path: string
  head: string
  tail: string
  size: number
  mtimeMs: number
}

/** One row of the dialog's session list. Everything the UI shows comes
 *  from here; `alreadyImported` is added by the adapter (it needs the
 *  Velloc store, which the Worker does not have). */
export type ImportSessionLiteRow = {
  source: ImportSource
  path: string
  /** The source's own session id — kept unchanged as the Velloc session id. */
  sessionId: string
  /** Resolved display title, or null when the file has none (the UI shows
   *  its "Untitled session" label). */
  title: string | null
  /** The working directory the session ran in, if the file records one. */
  projectPath: string | null
  /** ISO timestamp of the first entry, if any. */
  createdAt: string | null
  mtimeMs: number
  size: number
  /** False for files that cannot become a Velloc session (a sub-agent
   *  sidechain file, or a metadata-only file with no cwd). The row renders
   *  disabled with a reason. */
  importable: boolean
}

/** A fully converted session, in native Velloc shape, ready to write. */
export type ImportConvertResult = {
  source: ImportSource
  sessionId: string
  /** The transcript log: a `custom-title` record (when titled) followed by
   *  the messages, every one already passed through
   *  `sanitizeMessageForPersistence`. */
  entries: BrowserTranscriptWriteEntry[]
  /** The `meta.json` projection. `updatedAt` is the import time. */
  meta: SessionMetaFile
  /** `tool-details/<toolCallId>.json` sidecars split out of the messages. */
  toolDetails: BrowserToolCallDetailRecord[]
  /** The project folder the session binds to (the transcript's cwd). */
  projectRoot: string
  /** The session's sub-agent transcripts, each as its own background
   *  sub-agent session under `<session>/subagents/` (see
   *  `ImportSubAgentBundle`). Empty when the source has none. */
  subAgents: ImportSubAgentBundle[]
  /** Diagnostics for the handoff/debug ring; never user-visible. */
  stats: {
    lines: number
    skippedLines: number
    droppedRecords: number
    droppedSidechain: number
    messages: number
    subAgents: number
  }
}

/**
 * One sub-agent transcript handed to `convert` alongside its parent: the
 * source keeps them as separate files (`<session>/subagents/**\/agent-<id>.jsonl`
 * plus an optional `.meta.json` sidecar). Legacy sources inline them in the
 * parent file instead; those are grouped by the converter itself.
 */
export type ImportSubAgentInput = {
  agentId: string
  path: string
  bytes: ArrayBuffer
  meta?: { agentType?: string; description?: string }
}

/**
 * A finished BACKGROUND sub-agent: its session dir
 * `<parent>/subagents/<sessionId>/` plus a `task.json` restore seed. The
 * parent's Agent result carries `(task id <taskId>)`, which the Agent card and
 * Background Tasks drawer key on.
 */
export type ImportSubAgentBundle = {
  agentId: string
  /** Public task id, `a<8 base36>` (TASK_ID_PATTERN), derived
   *  deterministically from the agent id so re-imports are stable. */
  taskId: string
  /** `subagent-<agentId>` — the native sub-agent session id shape. */
  sessionId: string
  /** The parent Agent tool call this sub-agent answers, when the result line
   *  linked one. The write path stamps `(task id <taskId>)` onto that parent
   *  tool result — via `applyAgentTaskAck` — ONLY after this bundle lands, so a
   *  failed sub-agent write never leaves a dead "Open in Background Tasks" jump.
   *  Absent for a sub-agent with no linkable parent Agent result. */
  parentToolCallId?: string
  entries: BrowserTranscriptWriteEntry[]
  meta: SessionMetaFile
  toolDetails: BrowserToolCallDetailRecord[]
  /** The `task.json` body (a `SubAgentTaskFile`; typed loosely here so this
   *  module stays free of worker imports). */
  task: Record<string, unknown>
}

export type ImportWorkerRequest =
  | {
      id: string
      kind: 'parseLite'
      source: ImportSource
      items: ImportLiteItem[]
    }
  | {
      id: string
      kind: 'convert'
      source: ImportSource
      path: string
      bytes: ArrayBuffer
      /** Import time (epoch ms) — becomes `meta.updatedAt`. */
      now: number
      /** The session's sub-agent transcript files, if the source keeps them
       *  separately. */
      subagents?: ImportSubAgentInput[]
    }

export type ImportWorkerError = { code: string; message: string }

export type ImportWorkerResponse =
  | { id: string; ok: true; result: ImportSessionLiteRow[] | ImportConvertResult }
  | { id: string; ok: false; error: ImportWorkerError }

/** What every `sources/<source>/index.ts` exports. Pure functions only. */
export type ImportSourceAdapter = {
  source: ImportSource
  parseLite(items: readonly ImportLiteItem[]): ImportSessionLiteRow[]
  convert(args: {
    path: string
    bytes: ArrayBuffer
    now: number
    subagents?: ImportSubAgentInput[]
  }): ImportConvertResult
}

/** Thrown by a source adapter for a file it cannot convert. `code` is
 *  protocol (the UI maps it to a catalog key). */
export class ImportConvertError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ImportConvertError'
    this.code = code
  }
}

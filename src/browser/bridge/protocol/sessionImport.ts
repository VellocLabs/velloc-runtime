/**
 * `sessionImport` WebUI-bridge capability — import sessions from another agent
 * product's on-disk transcripts (worker-side; NOT routed to C++). Conversion runs
 * in a Worker owned by the WINDOW. Session ids are kept verbatim, so a re-import
 * answers `skipped:true`.
 */

import type {
  ImportConvertResult,
  ImportSessionLiteRow,
  ImportSource,
} from '../../../sessionImport/protocol'

export type { ImportSessionLiteRow, ImportSource }

/** A detected source: where its sessions live on this machine. */
export type DetectedImportSource = {
  source: ImportSource
  /** Absolute path of the source's sessions root (e.g. `~/.claude/projects`). */
  rootPath: string
}

export type ImportSessionListRow = ImportSessionLiteRow & {
  /** A Velloc session with this id already exists on disk — the UI renders
   *  the Import button disabled as "Imported". Live check, not remembered. */
  alreadyImported: boolean
}

export type SessionImportBridgeActionMap = {
  /** Which sources have sessions on this machine. Empty ⇒ no topbar button. */
  detect: {
    payload: Record<string, never>
    result: { sources: DetectedImportSource[] }
  }
  /** One page of a source's sessions, newest first. Only the requested page
   *  is lite-read, so a call costs O(pageSize) reads regardless of `total`. */
  listSessions: {
    payload: { source: ImportSource; page: number; pageSize?: number }
    result: {
      source: ImportSource
      rootPath: string
      total: number
      page: number
      pageSize: number
      rows: ImportSessionListRow[]
    }
  }
  /** The whole transcript for the window's import Worker to convert. The
   *  path must sit under the source root. `skipped:true` (no bytes) when a
   *  Velloc session with that id already exists — the dedup check happens
   *  BEFORE a byte is read. */
  readSession: {
    payload: { source: ImportSource; path: string }
    result:
      | { sessionId: string; skipped: true }
      | {
          sessionId: string
          skipped: false
          bytes: Uint8Array
          /** The session's sub-agent transcript files
           *  (`<session>/subagents/**\/agent-<id>.jsonl` + `.meta.json`),
           *  each read whole, for the Worker to convert with the parent. */
          subagents: Array<{
            agentId: string
            path: string
            bytes: Uint8Array
            meta?: { agentType?: string; description?: string }
          }>
        }
  }
  /** Write a converted session bundle into the store (the same path a fork
   *  takes). Idempotent: an id already on disk is left untouched. */
  writeSession: {
    payload: { source: ImportSource; result: ImportConvertResult }
    result: { sessionId: string; skipped: boolean }
  }
}

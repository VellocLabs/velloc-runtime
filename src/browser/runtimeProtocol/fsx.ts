/**
 * The `fsx` capability's wire shapes — file access for clients (P-3).
 *
 * Security: every action names its `sessionId` (a relative `path` resolves against
 * that session's cwd; a scoped connection is judged against its roots); bytes travel
 * only as a `BlobRef`; an upload names a file, never a destination — the runtime
 * picks the path. Bare `fs.*` is never advertised to a client.
 */
import type { BlobRef, ScopeMode } from './frames'

export const FSX_CAPABILITY = 'fsx'

/**
 * Declared scope per action. Reads are `observe` (and root-bound below
 * `full`); writing a named path is `manager` (the handler root-binds it below
 * `full` — a manager can edit its sessions' files, not the machine); an upload
 * lands where the runtime decides, so `control` may make one.
 */
export const FSX_ACTION_SCOPES = {
  userHome: 'observe',
  statBatch: 'observe',
  readText: 'observe',
  readBlob: 'observe',
  writeText: 'manager',
  commitUpload: 'control',
} as const satisfies Record<string, ScopeMode>

export type FsxAction = keyof typeof FSX_ACTION_SCOPES

/** `userHome` takes no payload: the host user's home directory, which anchors `~/.velloc`. */
export type FsxUserHomeResult = { path: string }

/** Most paths one `statBatch` may name. */
export const FSX_STAT_BATCH_MAX_PATHS = 500

export type FsxStatBatchPayload = { sessionId: string; paths: readonly string[] }
/** One entry per requested path, in order. A path the connection may not see reads as absent. */
export type FsxStatEntry = { path: string; exists: boolean; isFile: boolean; isDirectory: boolean }
export type FsxStatBatchResult = FsxStatEntry[]

export type FsxReadPayload = { sessionId: string; path: string }
export type FsxReadTextResult = { text: string }
export type FsxReadBlobResult = { blob: BlobRef }

export type FsxWriteTextPayload = { sessionId: string; path: string; text: string }

export type FsxCommitUploadPayload = { sessionId: string; blob: BlobRef; name: string }
/** The absolute host path the upload was written to. */
export type FsxCommitUploadResult = { path: string }

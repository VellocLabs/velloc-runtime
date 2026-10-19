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
  listDir: 'observe',
  listTree: 'observe',
  findFiles: 'observe',
  searchText: 'observe',
  cancelSearch: 'observe',
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

/** Most entries one `listDir` answers; past it the listing is cut and `truncated`. */
export const FSX_LIST_MAX_ENTRIES = 2000
/** Most entries one `listTree` answers over its whole walk; past it the walk stops and `truncated`. */
export const FSX_TREE_MAX_ENTRIES = 20000
/** Deepest `listTree` a client may ask for: levels below the requested path. */
export const FSX_TREE_MAX_DEPTH = 8
/** Levels a `listTree` walks when the payload names no `depth`. */
export const FSX_TREE_DEFAULT_DEPTH = 4

export type FsxListDirPayload = { sessionId: string; path: string }
/**
 * One entry of a directory as the host reports it. `isSymbolicLink` is the host's word and today's
 * host reports none from a directory read (a junction reads as a directory), so no boundary may
 * rest on it: the runtime decides what a walk enters by the root rule, never by this flag.
 */
export type FsxDirEntry = {
  name: string
  isFile: boolean
  isDirectory: boolean
  isSymbolicLink: boolean
}
/** Folders first, then names in case-insensitive order; cut at `FSX_LIST_MAX_ENTRIES`. */
export type FsxListDirResult = { entries: FsxDirEntry[]; truncated: boolean }

/** `depth`: an integer 1..`FSX_TREE_MAX_DEPTH`; 1 is the directory itself, as `listDir`. */
export type FsxListTreePayload = { sessionId: string; path: string; depth?: number }
/**
 * `path` is '/'-separated and relative to the request's `path` (wire contract, as the host's
 * `readdirTree`). Entries come level by level, each level folders first then names. `size` is
 * 0 for a directory and for a file the host could not stat. Below `full` a directory is entered
 * only when it passes the connection's root check (a link out of the project is listed, not
 * entered); `full` walks through links.
 */
export type FsxTreeEntry = { path: string; isDirectory: boolean; size: number }
export type FsxListTreeResult = { entries: FsxTreeEntry[]; truncated: boolean }

export type FsxCommitUploadPayload = { sessionId: string; blob: BlobRef; name: string }
/** The absolute host path the upload was written to. */
export type FsxCommitUploadResult = { path: string }

/**
 * File search (F-9 Files pane): `findFiles` ranks file names, `searchText` searches file contents. Each
 * call answers `{ searchId }` at once; results are STATE on the topic `fsxSearchTopic(searchId)`, which
 * only the connection that started the search may read: the whole `FsxSearchState` as the snapshot and
 * again in every `state` delta. A newer search from the same connection for the same session, a
 * `cancelSearch`, or the connection going away ends the older one.
 */
export const FSX_SEARCH_STATE_EVENT = 'state'
/** Results one `findFiles` publishes when the payload names no `limit`. */
export const FSX_FIND_DEFAULT_LIMIT = 50
/** Most results a `findFiles` may ask for. */
export const FSX_FIND_MAX_LIMIT = 200
/** Most file paths the runtime lists below one root for `findFiles`; past it `indexTruncated`. */
export const FSX_FIND_INDEX_MAX_FILES = 200_000
/** Hit lines one `searchText` publishes when the payload names no `limit`. */
export const FSX_SEARCH_TEXT_DEFAULT_LIMIT = 500
/** Most hit lines a `searchText` may ask for. */
export const FSX_SEARCH_TEXT_MAX_LIMIT = 2000
/** Most hit lines kept per file; past it the file says `moreInFile`. */
export const FSX_SEARCH_TEXT_MAX_PER_FILE = 20
/** Longest query either search accepts, in UTF-16 code units. */
export const FSX_SEARCH_QUERY_MAX_LENGTH = 1000

const FSX_SEARCH_TOPIC_PREFIX = 'fsx/search/'

/** The topic a search's results are published on. `searchId` is the runtime's, slash-free. */
export function fsxSearchTopic(searchId: string): string {
  return `${FSX_SEARCH_TOPIC_PREFIX}${searchId}`
}

/** The search id a topic names, or `null` for any other topic. */
export function parseFsxSearchTopic(topicId: string): string | null {
  if (!topicId.startsWith(FSX_SEARCH_TOPIC_PREFIX)) return null
  const searchId = topicId.slice(FSX_SEARCH_TOPIC_PREFIX.length)
  return searchId.length > 0 && !searchId.includes('/') ? searchId : null
}

/**
 * `path` is the folder searched (relative to the session's cwd, or absolute). `refresh` drops the
 * runtime's file list for that folder and lists it again; otherwise a list from an earlier search is
 * reused until the session's turn ends.
 */
export type FsxFindFilesPayload = {
  sessionId: string
  path: string
  query: string
  limit?: number
  refresh?: boolean
}

export type FsxSearchTextPayload = {
  sessionId: string
  path: string
  query: string
  caseSensitive?: boolean
  wholeWord?: boolean
  /** The query is a regular expression (the search tool's syntax); otherwise a literal. */
  regex?: boolean
  limit?: number
}

export type FsxSearchStartResult = { searchId: string }
export type FsxCancelSearchPayload = { searchId: string }

/**
 * `ranges` are flat `[start, end)` pairs of UTF-16 offsets into the text they belong to. Paths are
 * '/'-separated and relative to the searched folder.
 */
export type FsxFileMatch = { path: string; ranges: number[] }
/** `line` is 1-based; `text` is the line without its end, cut around the first hit when long. */
export type FsxTextHit = { line: number; text: string; ranges: number[] }
export type FsxTextFileHits = { path: string; hits: FsxTextHit[]; moreInFile: boolean }

/** Why a search ended without results: a bad regular expression, no search binary, or anything else. */
export type FsxSearchError = 'invalid_regex' | 'unavailable' | 'failed'

/** `scanning` is true while the host is still walking the folder; the last state of a search has it false. */
export type FsxSearchState =
  | {
      kind: 'files'
      searchId: string
      scanning: boolean
      /** Ranked best first, at most the request's `limit`. */
      files: FsxFileMatch[]
      /** Every file that matched, of which `files` is the head. */
      matched: number
      /** The folder held more files than the runtime lists, so some were not searched. */
      indexTruncated: boolean
      error?: FsxSearchError
    }
  | {
      kind: 'text'
      searchId: string
      scanning: boolean
      /** In the order the host found them. */
      files: FsxTextFileHits[]
      /** The search stopped at the request's `limit`. */
      truncated: boolean
      error?: FsxSearchError
    }

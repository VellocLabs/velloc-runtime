/**
 * Security: file search (`fsx.findFiles` / `fsx.searchText`, F-9) runs the host's search binary as a
 * streaming child (argv, no shell) in a folder the caller has already root-checked. The child never
 * follows links (no `--follow`), so it stays below that folder; VCS internals and the runtime directory
 * are never listed. Each search's topic is readable only by the connection that started it.
 * `findFiles` lists a folder once, keeps the list until `invalidate()` or a `refresh`, and ranks it here
 * per query; `searchText` runs one `--json` child per query. A newer search from the same connection
 * for the same session, `cancel`, the last unsubscribe, or the owner being gone ends a search.
 */
import { RUNTIME_DIR_NAME } from '../../branding/runtimeDir'
import {
  NativePrimitiveError,
  isNativePrimitiveUnsupported,
  type NativeStreamChild,
  type NativeStreamExit,
  type NativeStreamHandlers,
} from '../bridge/nativePrimitives'
import {
  FSX_FIND_DEFAULT_LIMIT,
  FSX_FIND_INDEX_MAX_FILES,
  FSX_SEARCH_STATE_EVENT,
  FSX_SEARCH_TEXT_DEFAULT_LIMIT,
  FSX_SEARCH_TEXT_MAX_PER_FILE,
  fsxSearchTopic,
  parseFsxSearchTopic,
  type FsxFindFilesPayload,
  type FsxSearchError,
  type FsxSearchState,
  type FsxSearchTextPayload,
  type FsxTextFileHits,
  type FsxTextHit,
  type TopicId,
} from '../runtimeProtocol'
import { rankFilePaths } from './fsxFileRank'
import type { ConnectionInfo, PublishOptions, SnapshotPage, TopicProvider } from './types'

/** Runs `file` with `args` in `cwd` as a live child (`shell.spawnArgvStream` on the runtime's host port). */
export type FsxStreamSpawner = (
  spec: { file: string; args: string[]; cwd: string },
  handlers: NativeStreamHandlers,
) => Promise<NativeStreamChild>

export type FsxSearchDeps = {
  /** The spawner for this moment, or `null` while the runtime has no host port. */
  spawner(): FsxStreamSpawner | null
  publish(topic: TopicId, payload: unknown, opts?: PublishOptions): number
  dropTopic(topic: TopicId): void
  /** The live connections: a search whose owner is gone is stopped at its next publish. */
  connections(): readonly ConnectionInfo[]
  /** Most paths one file list holds; `FSX_FIND_INDEX_MAX_FILES` when absent. */
  indexMaxFiles?: number
}

/** The search binary, by its host tool id. */
export const FSX_SEARCH_BINARY = 'rg'
/** Least time between two published states of one search while its child runs. */
export const FSX_SEARCH_PUBLISH_INTERVAL_MS = 100
/** File lists kept at once; the least recently used finished one goes first. */
export const FSX_FIND_MAX_CACHED_INDEXES = 4
/** Searches one connection may hold at once; past it the oldest is forgotten. */
export const FSX_MAX_SEARCHES_PER_CONNECTION = 8
/** Longest line text a content hit carries; a longer line is cut around its first hit. */
export const FSX_SEARCH_TEXT_MAX_SNIPPET = 240

const SNIPPET_LEAD = 40
const STDERR_KEEP = 4096
const ELLIPSIS = '…'

const EXCLUDE_ARGS = ['--glob', '!.git', '--glob', `!${RUNTIME_DIR_NAME}`]
// `--no-require-git`: a folder's `.gitignore` applies whether or not it is inside a repository.
const WALK_ARGS = ['--hidden', '--no-require-git', ...EXCLUDE_ARGS, '--no-messages', '--line-buffered']

/** The file listing's argv: every file below the cwd that the ignore files keep, one per line. */
export function findFilesArgs(): string[] {
  return ['--files', ...WALK_ARGS, '--', '.']
}

/** The content search's argv for one query; at most `FSX_SEARCH_TEXT_MAX_PER_FILE + 1` lines per file. */
export function searchTextArgs(payload: Pick<FsxSearchTextPayload, 'query' | 'caseSensitive' | 'wholeWord' | 'regex'>): string[] {
  return [
    '--json',
    ...WALK_ARGS,
    '--max-count',
    String(FSX_SEARCH_TEXT_MAX_PER_FILE + 1),
    ...(payload.regex ? [] : ['--fixed-strings']),
    payload.caseSensitive ? '--case-sensitive' : '--ignore-case',
    ...(payload.wholeWord ? ['--word-regexp'] : []),
    '--regexp',
    payload.query,
    '--',
    '.',
  ]
}

/** A path as the child printed it, made '/'-separated and relative to the searched folder. */
export function normalizeFoundPath(raw: string, windows: boolean): string {
  const path = windows ? raw.replace(/\\/g, '/') : raw
  return path.startsWith('./') ? path.slice(2) : path
}

function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/** The UTF-16 offset in `text` of byte `offset` of its UTF-8 form. */
export function utf16Offset(text: string, offset: number): number {
  let bytes = 0
  for (let i = 0; i < text.length; i += 1) {
    if (bytes >= offset) return i
    const code = text.codePointAt(i)!
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
    if (code >= 0x10000) i += 1
  }
  return text.length
}

/** `text` cut to `FSX_SEARCH_TEXT_MAX_SNIPPET` around its first range, the ranges moved with it. */
export function snippetOf(text: string, ranges: number[]): { text: string; ranges: number[] } {
  if (text.length <= FSX_SEARCH_TEXT_MAX_SNIPPET) return { text, ranges }
  const first = ranges[0] ?? 0
  const start = Math.max(0, Math.min(first - SNIPPET_LEAD, text.length - FSX_SEARCH_TEXT_MAX_SNIPPET))
  const end = Math.min(text.length, start + FSX_SEARCH_TEXT_MAX_SNIPPET)
  const lead = start > 0 ? ELLIPSIS : ''
  const shift = lead.length - start
  const moved: number[] = []
  for (let i = 0; i + 1 < ranges.length; i += 2) {
    const from = Math.max(ranges[i]!, start)
    const to = Math.min(ranges[i + 1]!, end)
    if (to > from) moved.push(from + shift, to + shift)
  }
  return { text: `${lead}${text.slice(start, end)}${end < text.length ? ELLIPSIS : ''}`, ranges: moved }
}

/** Splits a byte stream into lines; the last, unterminated piece waits for the next chunk. */
class LineSplitter {
  private readonly decoder = new TextDecoder()
  private rest = ''

  push(bytes: Uint8Array): string[] {
    return this.split(this.decoder.decode(bytes, { stream: true }))
  }

  end(): string[] {
    const lines = this.split(this.decoder.decode())
    const last = this.rest.replace(/\r$/, '')
    this.rest = ''
    return last ? [...lines, last] : lines
  }

  private split(text: string): string[] {
    const parts = (this.rest + text).split('\n')
    this.rest = parts.pop() ?? ''
    return parts.map(line => line.replace(/\r$/, ''))
  }
}

function spawnError(error: unknown): FsxSearchError {
  if (isNativePrimitiveUnsupported(error)) return 'unavailable'
  if (error instanceof NativePrimitiveError && error.code === 'BINARY_NOT_FOUND') return 'unavailable'
  return 'failed'
}

/** One folder's file list, filled as the listing child prints it. */
type FileIndex = {
  root: string
  paths: string[]
  scanning: boolean
  truncated: boolean
  error?: FsxSearchError
  child: NativeStreamChild | null
  /** Called on every change; one per search reading this list. */
  readers: Set<() => void>
  lastUsed: number
}

type Owner = { connectionId: string; sessionId: string }

type Search = Owner & {
  id: string
  state: FsxSearchState
  /** Recompute `state` from what the child has produced so far (file search ranks here). */
  refresh?: () => void
  /** Stop producing: kill or detach the child. Idempotent. */
  halt: () => void
  timer: ReturnType<typeof setTimeout> | null
  lastPublishedAt: number
  finished: boolean
}

export class FsxSearchService {
  private readonly searches = new Map<string, Search>()
  private readonly indexes = new Map<string, FileIndex>()
  private clock = 0

  constructor(private readonly deps: FsxSearchDeps) {}

  /** The provider for `fsx/search/<id>`: the owner alone reads it; the last unsubscribe ends the search. */
  topicProvider(): TopicProvider {
    const searchOf = (id: TopicId): Search | undefined => {
      const searchId = parseFsxSearchTopic(id)
      return searchId === null ? undefined : this.searches.get(searchId)
    }
    return {
      matches: id => searchOf(id) !== undefined,
      authorize: (id, conn) => searchOf(id)?.connectionId === conn.connectionId,
      snapshot: async function* (this: void, id: TopicId): AsyncIterable<SnapshotPage> {
        const search = searchOf(id)
        if (search) yield { type: FSX_SEARCH_STATE_EVENT, payload: search.state }
      },
      onUnsubscribe: (id, _conn, last) => {
        const search = searchOf(id)
        if (search && last) this.forget(search)
      },
    }
  }

  /** Start ranking the files below `root` (absolute, already root-checked) for `payload.query`. */
  startFindFiles(owner: Owner, root: string, payload: FsxFindFilesPayload): string {
    const limit = payload.limit ?? FSX_FIND_DEFAULT_LIMIT
    const id = crypto.randomUUID()
    const index = this.acquireIndex(root, payload.refresh === true)
    const search: Search = {
      ...owner,
      id,
      state: { kind: 'files', searchId: id, scanning: true, files: [], matched: 0, indexTruncated: false },
      halt: () => {},
      timer: null,
      lastPublishedAt: 0,
      finished: false,
    }
    search.refresh = () => {
      const ranked = rankFilePaths(index.paths, payload.query, limit)
      search.state = {
        kind: 'files',
        searchId: id,
        scanning: index.scanning,
        files: ranked.files.map(file => ({ path: index.paths[file.index]!, ranges: file.ranges })),
        matched: ranked.matched,
        indexTruncated: index.truncated,
        ...(index.error ? { error: index.error } : {}),
      }
    }
    const onChange = () => this.changed(search, !index.scanning)
    index.readers.add(onChange)
    search.halt = () => {
      if (!index.readers.delete(onChange)) return
      this.releaseIndex(index)
    }
    this.add(search)
    search.refresh()
    if (!index.scanning) search.finished = true
    return id
  }

  /** Start searching the contents of the files below `root` (absolute, already root-checked). */
  startSearchText(owner: Owner, root: string, payload: FsxSearchTextPayload): string {
    const limit = payload.limit ?? FSX_SEARCH_TEXT_DEFAULT_LIMIT
    const id = crypto.randomUUID()
    const windows = isWindowsPath(root)
    const files: FsxTextFileHits[] = []
    const byPath = new Map<string, FsxTextFileHits>()
    let lines = 0
    let truncated = false
    let stderr = ''
    let child: NativeStreamChild | null = null
    let halted = false
    const search: Search = {
      ...owner,
      id,
      state: { kind: 'text', searchId: id, scanning: true, files: [], truncated: false },
      halt: () => {
        if (halted) return
        halted = true
        void child?.kill().catch(() => {})
        child?.detach()
      },
      timer: null,
      lastPublishedAt: 0,
      finished: false,
    }
    const snapshotState = (scanning: boolean, error?: FsxSearchError): void => {
      search.state = {
        kind: 'text',
        searchId: id,
        scanning,
        files: files.map(file => ({ ...file, hits: [...file.hits] })),
        truncated,
        ...(error ? { error } : {}),
      }
    }
    search.refresh = () => snapshotState(!search.finished)
    const onLine = (line: string): void => {
      if (truncated || line === '') return
      let message: { type?: unknown; data?: Record<string, unknown> }
      try {
        message = JSON.parse(line) as typeof message
      } catch {
        return
      }
      if (message.type !== 'match' || !message.data) return
      const data = message.data as {
        path?: { text?: unknown }
        lines?: { text?: unknown }
        line_number?: unknown
        submatches?: Array<{ start?: unknown; end?: unknown }>
      }
      // A path or line that is not valid UTF-8 arrives as bytes: not shown.
      if (typeof data.path?.text !== 'string' || typeof data.lines?.text !== 'string') return
      if (typeof data.line_number !== 'number') return
      const path = normalizeFoundPath(data.path.text, windows)
      let file = byPath.get(path)
      if (file && file.hits.length >= FSX_SEARCH_TEXT_MAX_PER_FILE) {
        file.moreInFile = true
        return
      }
      if (lines >= limit) {
        truncated = true
        search.halt()
        this.finish(search, () => snapshotState(false))
        return
      }
      if (!file) {
        file = { path, hits: [], moreInFile: false }
        byPath.set(path, file)
        files.push(file)
      }
      lines += 1
      const text = data.lines.text.replace(/\r?\n$/, '')
      const ranges: number[] = []
      for (const sub of data.submatches ?? []) {
        if (typeof sub.start !== 'number' || typeof sub.end !== 'number') continue
        ranges.push(utf16Offset(text, sub.start), utf16Offset(text, sub.end))
      }
      const hit: FsxTextHit = { line: data.line_number, ...snippetOf(text, ranges) }
      file.hits.push(hit)
      this.changed(search, false)
    }
    const splitter = new LineSplitter()
    const errors = new TextDecoder()
    const handlers: NativeStreamHandlers = {
      onOutput: (stream, bytes) => {
        if (stream === 'stderr') {
          if (stderr.length < STDERR_KEEP) stderr += errors.decode(bytes, { stream: true })
          return
        }
        for (const line of splitter.push(bytes)) onLine(line)
      },
      onExit: (exit: NativeStreamExit) => {
        for (const line of splitter.end()) onLine(line)
        if (search.finished) return
        let error: FsxSearchError | undefined
        if (exit.exitCode === 2 && !halted) {
          if (payload.regex && /regex/i.test(stderr)) error = 'invalid_regex'
          else if (files.length === 0) error = 'failed'
        }
        this.finish(search, () => snapshotState(false, error))
      },
    }
    this.add(search)
    const spawner = this.deps.spawner()
    if (!spawner) {
      this.finish(search, () => snapshotState(false, 'unavailable'))
      return id
    }
    spawner({ file: FSX_SEARCH_BINARY, args: searchTextArgs(payload), cwd: root }, handlers).then(
      started => {
        child = started
        if (halted) {
          void started.kill().catch(() => {})
          started.detach()
        }
      },
      (error: unknown) => this.finish(search, () => snapshotState(false, spawnError(error))),
    )
    return id
  }

  /** End `searchId` if `connectionId` owns it. */
  cancel(connectionId: string, searchId: string): boolean {
    const search = this.searches.get(searchId)
    if (!search || search.connectionId !== connectionId) return false
    this.forget(search)
    return true
  }

  /** Drop every finished file list, so the next search lists its folder again (a turn has ended). */
  invalidate(): void {
    for (const [root, index] of this.indexes) {
      if (!index.scanning) this.indexes.delete(root)
    }
  }

  /** Stop every search and child. */
  dispose(): void {
    for (const search of [...this.searches.values()]) this.forget(search)
    for (const index of this.indexes.values()) void index.child?.kill().catch(() => {})
    this.indexes.clear()
  }

  // ---- searches ----------------------------------------------------------------

  private add(search: Search): void {
    // A newer search from the same client for the same session replaces the older ones. The
    // new search is registered (and holds its file list) first, so a shared list keeps listing.
    const owned = [...this.searches.values()].filter(other => other.connectionId === search.connectionId)
    this.searches.set(search.id, search)
    for (const other of owned) {
      if (other.sessionId === search.sessionId) this.stop(other)
    }
    const live = owned.filter(other => this.searches.has(other.id))
    for (const old of live.slice(0, Math.max(0, live.length + 1 - FSX_MAX_SEARCHES_PER_CONNECTION))) {
      this.forget(old)
    }
  }

  /** Stop producing results; the last state stays readable until the search is forgotten. */
  private stop(search: Search): void {
    search.halt()
    if (search.timer !== null) clearTimeout(search.timer)
    search.timer = null
    search.finished = true
  }

  private forget(search: Search): void {
    this.stop(search)
    if (this.searches.delete(search.id)) this.deps.dropTopic(fsxSearchTopic(search.id) as TopicId)
  }

  /** New results: publish now if the last publish is old enough, else once the interval has passed. */
  private changed(search: Search, final: boolean): void {
    if (search.finished) return
    if (final) {
      this.finish(search, () => search.refresh?.())
      return
    }
    if (search.timer !== null) return
    const wait = search.lastPublishedAt + FSX_SEARCH_PUBLISH_INTERVAL_MS - Date.now()
    if (wait <= 0) {
      this.publish(search)
      return
    }
    search.timer = setTimeout(() => {
      search.timer = null
      if (!search.finished) this.publish(search)
    }, wait)
  }

  private finish(search: Search, settle: () => void): void {
    if (search.finished) return
    this.stop(search)
    settle()
    this.publish(search, true)
  }

  private publish(search: Search, settled = false): void {
    if (!this.searches.has(search.id)) return
    if (!this.deps.connections().some(conn => conn.connectionId === search.connectionId)) {
      this.forget(search)
      return
    }
    if (!settled) search.refresh?.()
    search.lastPublishedAt = Date.now()
    this.deps.publish(fsxSearchTopic(search.id) as TopicId, search.state, { type: FSX_SEARCH_STATE_EVENT })
  }

  // ---- file lists --------------------------------------------------------------

  private acquireIndex(root: string, refresh: boolean): FileIndex {
    let index = this.indexes.get(root)
    if (index && (index.error || (refresh && !index.scanning))) {
      this.indexes.delete(root)
      index = undefined
    }
    if (!index) {
      index = { root, paths: [], scanning: true, truncated: false, child: null, readers: new Set(), lastUsed: 0 }
      this.indexes.set(root, index)
      this.evictIndexes()
      this.scan(index)
    }
    index.lastUsed = ++this.clock
    return index
  }

  /** A list nobody reads any more: a finished one stays cached, a listing in progress is killed. */
  private releaseIndex(index: FileIndex): void {
    if (index.readers.size > 0 || !index.scanning) return
    void index.child?.kill().catch(() => {})
    index.child?.detach()
    index.child = null
    if (this.indexes.get(index.root) === index) this.indexes.delete(index.root)
  }

  private evictIndexes(): void {
    const idle = [...this.indexes.values()]
      .filter(index => !index.scanning && index.readers.size === 0)
      .sort((a, b) => a.lastUsed - b.lastUsed)
    let excess = this.indexes.size - FSX_FIND_MAX_CACHED_INDEXES
    for (const index of idle) {
      if (excess <= 0) break
      this.indexes.delete(index.root)
      excess -= 1
    }
  }

  private scan(index: FileIndex): void {
    const windows = isWindowsPath(index.root)
    const splitter = new LineSplitter()
    const notify = () => {
      for (const reader of [...index.readers]) reader()
    }
    const end = (error?: FsxSearchError) => {
      if (!index.scanning) return
      index.scanning = false
      if (error) index.error = error
      index.child?.detach()
      index.child = null
      notify()
    }
    const take = (lines: string[]) => {
      let added = false
      for (const line of lines) {
        if (line === '' || index.truncated) continue
        if (index.paths.length >= (this.deps.indexMaxFiles ?? FSX_FIND_INDEX_MAX_FILES)) {
          index.truncated = true
          void index.child?.kill().catch(() => {})
          end()
          return
        }
        index.paths.push(normalizeFoundPath(line, windows))
        added = true
      }
      if (added) notify()
    }
    const spawner = this.deps.spawner()
    if (!spawner) {
      end('unavailable')
      return
    }
    spawner(
      { file: FSX_SEARCH_BINARY, args: findFilesArgs(), cwd: index.root },
      {
        onOutput: (stream, bytes) => {
          if (stream === 'stdout' && index.scanning) take(splitter.push(bytes))
        },
        onExit: exit => {
          if (!index.scanning) return
          take(splitter.end())
          // 1 is "nothing listed"; 2 is an error, which only counts when nothing was listed.
          end(exit.exitCode === 2 && index.paths.length === 0 && !exit.killed ? 'failed' : undefined)
        },
      },
    ).then(
      child => {
        if (!index.scanning || this.indexes.get(index.root) !== index) {
          void child.kill().catch(() => {})
          child.detach()
          return
        }
        index.child = child
      },
      (error: unknown) => end(spawnError(error)),
    )
  }
}

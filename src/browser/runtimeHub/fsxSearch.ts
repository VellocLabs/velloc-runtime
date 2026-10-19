/**
 * Security: file search (`fsx.findFiles` / `fsx.searchText`, F-9) runs the host's search binary as a
 * streaming child (argv, no shell) in a folder the caller has already root-checked. The child never
 * follows links (no `--follow`), so it stays below that folder; VCS internals and the runtime directory
 * are never listed. A repository below the folder that the folder's ignore files leave out is listed
 * by a child started inside it, found by a probe that reads no ignore files but stays as shallow as
 * `FSX_FIND_NESTED_REPO_DEPTH`. Each search's topic is readable only by the connection that started it.
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

/** Repositories at most this many folders below a listed folder are found by the probe. */
export const FSX_FIND_NESTED_REPO_DEPTH = 3

const GIT_HEAD_SUFFIX = '/.git/HEAD'

function escapeGlob(text: string): string {
  return text.replace(/[\\*?[\]{}]/g, char => `\\${char}`)
}

/**
 * The file listing's argv: every file below the cwd that the ignore files keep, one per line.
 * `exclude`: folders ('/'-separated, relative to the cwd) left out, because they are listed on their own.
 */
export function findFilesArgs(exclude: readonly string[] = []): string[] {
  return ['--files', ...WALK_ARGS, ...exclude.flatMap(dir => ['--glob', `!/${escapeGlob(dir)}/**`]), '--', '.']
}

/**
 * The probe's argv: the `.git/HEAD` of every repository up to `FSX_FIND_NESTED_REPO_DEPTH` folders
 * below the cwd, ignore files not read. A `.git` file (a linked worktree or a submodule) is not a match.
 */
export function nestedRepoProbeArgs(): string[] {
  return [
    '--files',
    '--hidden',
    '--no-ignore',
    '--max-depth',
    String(FSX_FIND_NESTED_REPO_DEPTH + 2),
    '--glob',
    `**${GIT_HEAD_SUFFIX}`,
    '--glob',
    '!node_modules',
    '--glob',
    `!${RUNTIME_DIR_NAME}`,
    '--no-messages',
    '--',
    '.',
  ]
}

/**
 * The repositories among `probed` (normalized probe lines) that the folder's own listing left out
 * (no path in `listed` lies inside them), deepest first so an outer one can leave them out in turn.
 */
export function unlistedRepoRoots(probed: readonly string[], listed: readonly string[]): string[] {
  const roots = probed
    .filter(path => path.endsWith(GIT_HEAD_SUFFIX))
    .map(path => path.slice(0, -GIT_HEAD_SUFFIX.length))
    .filter(root => root !== '')
  const unlisted = [...new Set(roots)].filter(root => {
    const inside = `${root}/`
    return !listed.some(path => path.startsWith(inside))
  })
  const depth = (path: string) => path.split('/').length
  return unlisted.sort((a, b) => depth(b) - depth(a) || (a < b ? -1 : a > b ? 1 : 0))
}

function joinUnderRoot(root: string, relative: string): string {
  const windows = isWindowsPath(root)
  const sep = windows ? '\\' : '/'
  const base = root.endsWith('/') || root.endsWith('\\') ? root.slice(0, -1) : root
  return `${base}${sep}${windows ? relative.replace(/\//g, '\\') : relative}`
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
  /** The listing and probe children still running. */
  children: Set<NativeStreamChild>
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
    for (const index of this.indexes.values()) this.stopIndex(index)
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
      index = { root, paths: [], scanning: true, truncated: false, children: new Set(), readers: new Set(), lastUsed: 0 }
      this.indexes.set(root, index)
      this.evictIndexes()
      this.scan(index)
    }
    index.lastUsed = ++this.clock
    return index
  }

  /** A list nobody reads any more: a finished one stays cached, a listing in progress is stopped. */
  private releaseIndex(index: FileIndex): void {
    if (index.readers.size > 0 || !index.scanning) return
    index.scanning = false
    this.stopIndex(index)
    if (this.indexes.get(index.root) === index) this.indexes.delete(index.root)
  }

  private stopIndex(index: FileIndex): void {
    for (const child of index.children) {
      void child.kill().catch(() => {})
      child.detach()
    }
    index.children.clear()
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

  private endIndex(index: FileIndex, error?: FsxSearchError): void {
    if (!index.scanning) return
    index.scanning = false
    if (error) index.error = error
    this.stopIndex(index)
    this.notifyIndex(index)
  }

  private notifyIndex(index: FileIndex): void {
    for (const reader of [...index.readers]) reader()
  }

  /** Adds listed `lines` under `prefix` while the list holds fewer than `limit`; false once it is full. */
  private take(index: FileIndex, lines: readonly string[], prefix: string, limit: number): boolean {
    const windows = isWindowsPath(index.root)
    let added = false
    let full = false
    for (const line of lines) {
      if (line === '') continue
      if (index.paths.length >= limit) {
        index.truncated = true
        full = true
        break
      }
      index.paths.push(prefix + normalizeFoundPath(line, windows))
      added = true
    }
    if (added) this.notifyIndex(index)
    return !full
  }

  /**
   * Lists the folder, then every repository below it that the folder's ignore files left out (F-9), each
   * with its own ignore files and an equal share of what the cap has left, deepest first.
   */
  private scan(index: FileIndex): void {
    const spawner = this.deps.spawner()
    if (!spawner) {
      this.endIndex(index, 'unavailable')
      return
    }
    void this.listAll(index, spawner)
  }

  private async listAll(index: FileIndex, spawner: FsxStreamSpawner): Promise<void> {
    const max = this.deps.indexMaxFiles ?? FSX_FIND_INDEX_MAX_FILES
    const windows = isWindowsPath(index.root)
    const probed: string[] = []
    const probe = this.runListing(index, spawner, nestedRepoProbeArgs(), index.root, lines => {
      for (const line of lines) if (line !== '') probed.push(normalizeFoundPath(line, windows))
      return true
    })
    const main = await this.runListing(index, spawner, findFilesArgs(), index.root, lines => this.take(index, lines, '', max))
    if (!index.scanning) return
    if ('error' in main) {
      this.endIndex(index, spawnError(main.error))
      return
    }
    // 1 is "nothing listed"; 2 is an error, which only counts when nothing was listed.
    if (main.exitCode === 2 && index.paths.length === 0 && !main.killed) {
      this.endIndex(index, 'failed')
      return
    }
    if (index.truncated) {
      this.endIndex(index)
      return
    }
    const probeEnd = await probe
    if (!index.scanning) return
    const repos = 'error' in probeEnd ? [] : unlistedRepoRoots(probed, index.paths)
    const listed: string[] = []
    for (const [at, repo] of repos.entries()) {
      const share = Math.floor((max - index.paths.length) / (repos.length - at))
      if (share <= 0) {
        index.truncated = true
        break
      }
      const inner = listed.filter(done => done.startsWith(`${repo}/`)).map(done => done.slice(repo.length + 1))
      const limit = index.paths.length + share
      await this.runListing(index, spawner, findFilesArgs(inner), joinUnderRoot(index.root, repo), lines =>
        this.take(index, lines, `${repo}/`, limit),
      )
      if (!index.scanning) return
      listed.push(repo)
    }
    this.endIndex(index)
  }

  /**
   * Runs one child of `index`'s listing, handing its stdout lines to `onLines` until that answers
   * false (the child is then killed). Resolves when the child ends, is stopped, or fails to start.
   */
  private runListing(
    index: FileIndex,
    spawner: FsxStreamSpawner,
    args: string[],
    cwd: string,
    onLines: (lines: string[]) => boolean,
  ): Promise<{ exitCode: number | null; killed: boolean } | { error: unknown }> {
    return new Promise(resolve => {
      const splitter = new LineSplitter()
      let child: NativeStreamChild | null = null
      let done = false
      const settle = (result: { exitCode: number | null; killed: boolean } | { error: unknown }) => {
        if (done) return
        done = true
        if (child) {
          index.children.delete(child)
          child.detach()
        }
        resolve(result)
      }
      const feed = (lines: string[]) => {
        if (done || !index.scanning) return
        if (onLines(lines)) return
        void child?.kill().catch(() => {})
        settle({ exitCode: null, killed: true })
      }
      spawner(
        { file: FSX_SEARCH_BINARY, args, cwd },
        {
          onOutput: (stream, bytes) => {
            if (stream === 'stdout') feed(splitter.push(bytes))
          },
          onExit: exit => {
            feed(splitter.end())
            settle({ exitCode: exit.exitCode, killed: exit.killed })
          },
        },
      ).then(
        started => {
          if (done || !index.scanning) {
            void started.kill().catch(() => {})
            started.detach()
            settle({ exitCode: null, killed: true })
            return
          }
          child = started
          index.children.add(started)
        },
        (error: unknown) => settle({ error }),
      )
    })
  }
}

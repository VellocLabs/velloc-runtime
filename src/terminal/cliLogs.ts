/**
 * What a CLI session reads from its CLI's own conversation logs (F-34): the
 * Codex conversation a start created, so it can be continued, and the title
 * a conversation's log gives, for a CLI that sets no terminal title.
 *
 * Security: read-only, never written. Paths come from the host's home, the
 * session's folder and a conversation UUID; nothing a client sends names a file.
 */
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { createBridgeRoute } from '../browser/bridge/browserBridgeProtocol'
import type { BridgeFsTreeEntry } from '../browser/bridge/protocol/fs'
import { sourceRoot } from '../browser/bridge/adapter/sessionImportBridgeAdapter'
import type { ImportSessionLiteRow, ImportSource } from '../sessionImport/protocol'
import { getImportSource, TERMINAL_AGENT_SOURCE_ID } from '../sessionImport/sources'
import { projectFolderKey } from '../utils/conversationStoragePaths'
import { joinRuntimePath } from '../utils/runtimePaths'
import { isConversationId, readCliProbeEnv, type CliAgentId } from './cliAgents'
import type { CliTitleTimers } from './cliTitles'
import type { TerminalHost } from './TerminalService'

/** Bytes read from the start of a log: enough for its opening records and first prompt. */
export const CLI_LOG_HEAD_BYTES = 256 * 1024

/** A log may be stamped this much before the start the runtime recorded. */
const START_SLACK_MS = 5_000

const DAY_MS = 24 * 60 * 60 * 1000

/** When a running CLI's log is looked for, after its start; each idle turn and the exit also look. */
export const CLI_LOG_RETRY_MS: readonly number[] = [2_000, 5_000, 10_000, 20_000, 40_000, 60_000, 120_000]

export type FoundConversation = { id: string; log: string }

export type CliLogReader = {
  /** The conversation a CLI started in `cwd` at `startedAt`, not one of `taken`, and its log; null until the log exists. */
  findConversation(
    cli: CliAgentId,
    where: { cwd: string; startedAt: number; taken: ReadonlySet<string> },
  ): Promise<FoundConversation | null>
  /** The title conversation `id`'s log gives (its own title, else its first prompt), or null. `log` is where a find saw it. */
  title(cli: CliAgentId, where: { cwd: string; id: string; log: string | null }): Promise<string | null>
}

/** The import source whose parser reads `cli`'s logs. */
export function cliLogSource(cli: CliAgentId): ImportSource {
  return cli === 'codex' ? 'codex' : TERMINAL_AGENT_SOURCE_ID
}

/** A folder path in one comparable spelling: `/` separators, no trailing one, case-folded on Windows. */
export function comparablePath(path: string): string {
  const plain = path.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:/.test(plain) ? plain.toLowerCase() : plain
}

/** The `YYYY/MM/DD` day folders (local time) a log written between `from` and `to` may sit in, oldest first. */
export function cliLogDayFolders(from: number, to: number): string[] {
  const folders: string[] = []
  const pad = (n: number) => String(n).padStart(2, '0')
  for (let at = from - DAY_MS; at <= to + DAY_MS; at += DAY_MS) {
    const day = new Date(at)
    const folder = `${day.getFullYear()}/${pad(day.getMonth() + 1)}/${pad(day.getDate())}`
    if (!folders.includes(folder)) folders.push(folder)
  }
  return folders
}

/**
 * The conversation a start created among parsed log rows: one recorded in
 * `cwd`, created no earlier than the start, not taken; the earliest wins.
 */
export function pickStartedConversation(
  rows: readonly ImportSessionLiteRow[],
  where: { cwd: string; startedAt: number; taken: ReadonlySet<string> },
): FoundConversation | null {
  const folder = comparablePath(where.cwd)
  let best: { id: string; log: string; at: number } | null = null
  for (const row of rows) {
    if (!isConversationId(row.sessionId) || where.taken.has(row.sessionId)) continue
    if (!row.projectPath || comparablePath(row.projectPath) !== folder) continue
    const at = row.createdAt ? Date.parse(row.createdAt) : Number.NaN
    if (!Number.isFinite(at) || at < where.startedAt - START_SLACK_MS) continue
    if (!best || at < best.at) best = { id: row.sessionId, log: row.path, at }
  }
  return best ? { id: best.id, log: best.log } : null
}

/** Reads the logs over the host's `fs` bridge; the home folder is read once per host port. */
export function createBridgeCliLogReader(
  host: () => TerminalHost,
  createRequestId: () => string,
  now: () => number = Date.now,
): CliLogReader {
  let homeOf: { transport: BrowserBridgeTransport; home: Promise<string | null> } | null = null
  const home = (transport: BrowserBridgeTransport): Promise<string | null> => {
    if (homeOf?.transport !== transport) {
      homeOf = {
        transport,
        home: readCliProbeEnv(host(), createRequestId).then(env => env?.home ?? null, () => null),
      }
    }
    return homeOf.home
  }
  const request = async <T>(
    transport: BrowserBridgeTransport,
    action: 'readdirTree' | 'readRange',
    payload: Record<string, unknown>,
  ): Promise<T | null> => {
    const response = await transport.request({
      id: createRequestId(),
      route: createBridgeRoute('fs', action),
      payload: payload as never,
    })
    return response.ok ? (response.result as T) : null
  }
  const readHead = async (
    transport: BrowserBridgeTransport,
    path: string,
  ): Promise<string | null> => {
    const read = await request<{ data?: Uint8Array; bytesRead?: number }>(transport, 'readRange', {
      path,
      offset: 0,
      length: CLI_LOG_HEAD_BYTES,
    })
    const data = read?.data
    if (!data || data.byteLength === 0) return null
    const bytes = data.subarray(0, Math.min(read.bytesRead ?? data.byteLength, data.byteLength))
    return new TextDecoder('utf-8').decode(bytes)
  }
  const parse = (cli: CliAgentId, path: string, head: string, size: number, mtimeMs: number) =>
    getImportSource(cliLogSource(cli)).parseLite([{ path, head, tail: '', size, mtimeMs }])[0]

  return {
    async findConversation(cli, where) {
      if (cli !== 'codex') return null
      const transport = host().transport
      const homeDir = transport ? await home(transport) : null
      if (!transport || !homeDir) return null
      const root = sourceRoot(homeDir, cliLogSource(cli))
      const rows: ImportSessionLiteRow[] = []
      for (const folder of cliLogDayFolders(where.startedAt, now())) {
        const dir = joinRuntimePath(root, ...folder.split('/'))
        const listed = await request<{ entries?: BridgeFsTreeEntry[] }>(transport, 'readdirTree', {
          path: dir,
          maxDepth: 1,
        }).catch(() => null)
        for (const entry of listed?.entries ?? []) {
          if (entry.isDirectory || entry.size <= 0 || !entry.path.endsWith('.jsonl')) continue
          if ((entry.mtimeMs ?? 0) < where.startedAt - START_SLACK_MS) continue
          const path = joinRuntimePath(dir, entry.path)
          const head = await readHead(transport, path).catch(() => null)
          const row = head === null ? undefined : parse(cli, path, head, entry.size, entry.mtimeMs ?? 0)
          if (row) rows.push(row)
        }
      }
      return pickStartedConversation(rows, where)
    },

    async title(cli, where) {
      if (!isConversationId(where.id)) return null
      const transport = host().transport
      const homeDir = transport ? await home(transport) : null
      if (!transport || !homeDir) return null
      const path =
        cli === 'codex'
          ? where.log
          : joinRuntimePath(
              sourceRoot(homeDir, cliLogSource(cli)),
              projectFolderKey(where.cwd.replace(/[\\/]+$/, '')),
              `${where.id}.jsonl`,
            )
      if (!path) return null
      const head = await readHead(transport, path).catch(() => null)
      if (head === null) return null
      return parse(cli, path, head, head.length, 0)?.title ?? null
    },
  }
}

type FollowedLog = {
  cli: CliAgentId
  cwd: string
  startedAt: number
  id: string | null
  log: string | null
  wantsTitle: boolean
  attempt: number
  timer: unknown
  looking: boolean
  again: boolean
}

export type CliLogFollowerDeps = {
  reader: CliLogReader
  /** Records the conversation found for `sessionId`, so it can be continued. */
  found(sessionId: string, id: string): Promise<void>
  /** Sets the session's automatic title from its log; without it no title is read. */
  retitle?(sessionId: string, title: string): Promise<void>
  /** True once the session follows a title of its CLI's terminal, which then wins. */
  hasTerminalTitle(sessionId: string): boolean
  retryMs?: readonly number[]
  timers?: CliTitleTimers
}

const DEFAULT_TIMERS: CliTitleTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * Looks for each running CLI's log until it has what it needs: the
 * conversation id (Codex) and, for a new conversation of a CLI that sets no
 * terminal title, the title. One lookup per session at a time.
 */
export class CliLogFollower {
  private readonly logs = new Map<string, FollowedLog>()
  /** Conversations already found, so two starts in one folder never take the same one. */
  private readonly claimed = new Set<string>()
  private readonly timers: CliTitleTimers
  private readonly retryMs: readonly number[]

  constructor(private readonly deps: CliLogFollowerDeps) {
    this.timers = deps.timers ?? DEFAULT_TIMERS
    this.retryMs = deps.retryMs ?? CLI_LOG_RETRY_MS
  }

  /** A CLI started for `sessionId`: `id` is its conversation when known, `fresh` when it is a new one. */
  start(
    sessionId: string,
    run: { cli: CliAgentId; cwd: string; startedAt: number; id: string | null; fresh: boolean },
  ): void {
    this.forget(sessionId)
    const wantsTitle = run.fresh && this.deps.retitle !== undefined
    if (run.id !== null && !wantsTitle) return
    this.logs.set(sessionId, {
      cli: run.cli,
      cwd: run.cwd,
      startedAt: run.startedAt,
      id: run.id,
      log: null,
      wantsTitle,
      attempt: 0,
      timer: undefined,
      looking: false,
      again: false,
    })
    this.schedule(sessionId)
  }

  /** Something may have been written (the CLI went idle or exited): look now. */
  poke(sessionId: string): void {
    if (this.logs.has(sessionId)) void this.look(sessionId)
  }

  forget(sessionId: string): void {
    const log = this.logs.get(sessionId)
    if (!log) return
    if (log.timer !== undefined) this.timers.clearTimeout(log.timer)
    this.logs.delete(sessionId)
  }

  dispose(): void {
    for (const sessionId of Array.from(this.logs.keys())) this.forget(sessionId)
  }

  private schedule(sessionId: string): void {
    const log = this.logs.get(sessionId)
    if (!log || log.attempt >= this.retryMs.length) return
    const delay = this.retryMs[log.attempt]!
    log.attempt += 1
    log.timer = this.timers.setTimeout(() => {
      log.timer = undefined
      void this.look(sessionId)
    }, delay)
  }

  private async look(sessionId: string): Promise<void> {
    const log = this.logs.get(sessionId)
    if (!log) return
    if (log.looking) {
      log.again = true
      return
    }
    log.looking = true
    try {
      if (log.id === null) {
        const found = await this.deps.reader.findConversation(log.cli, {
          cwd: log.cwd,
          startedAt: log.startedAt,
          taken: this.claimed,
        })
        if (found !== null && this.logs.get(sessionId) === log && !this.claimed.has(found.id)) {
          this.claimed.add(found.id)
          log.id = found.id
          log.log = found.log
          await this.deps.found(sessionId, found.id)
        }
      }
      if (log.wantsTitle && this.deps.hasTerminalTitle(sessionId)) log.wantsTitle = false
      if (log.id !== null && log.wantsTitle) {
        const title = await this.deps.reader.title(log.cli, { cwd: log.cwd, id: log.id, log: log.log })
        if (title && this.logs.get(sessionId) === log && !this.deps.hasTerminalTitle(sessionId)) {
          await this.deps.retitle?.(sessionId, title)
          log.wantsTitle = false
        }
      }
    } catch {
      // A failed read is retried on the next look.
    } finally {
      log.looking = false
    }
    if (this.logs.get(sessionId) !== log) return
    if (log.id !== null && !log.wantsTitle) {
      this.forget(sessionId)
      return
    }
    if (log.again) {
      log.again = false
      void this.look(sessionId)
      return
    }
    if (log.timer === undefined) this.schedule(sessionId)
  }
}

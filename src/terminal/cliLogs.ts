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
import { CliTypedLines, lineMatchesPromptTitle } from './cliTypedLines'
import type { TerminalHost } from './TerminalService'

/** Bytes read from the start of a log: enough for its opening records and first prompt. */
export const CLI_LOG_HEAD_BYTES = 256 * 1024

/** How far a log is read for the end of an opening record longer than the head. */
export const CLI_LOG_OPENING_MAX_BYTES = 4 * 1024 * 1024

/** Logs a reader remembers between looks; the oldest is dropped past this. */
const KNOWN_LOGS_LIMIT = 2_048

const CONVERSATION_ID_IN_NAME = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

/** A log may be stamped this much before the start the runtime recorded. */
const START_SLACK_MS = 5_000

const DAY_MS = 24 * 60 * 60 * 1000

/** When a running CLI's log is looked for, after its start; each idle turn and the exit also look. */
export const CLI_LOG_RETRY_MS: readonly number[] = [2_000, 5_000, 10_000, 20_000, 40_000, 60_000, 120_000]

/** A conversation's log: where it is, when it was created, and the title its first prompt gives. */
export type FoundConversation = { id: string; log: string; at: number; prompt: string | null }

export type CliLogReader = {
  /** The conversations a CLI may have started in `cwd` since `startedAt`, not one of `taken`, earliest first. */
  findConversations(
    cli: CliAgentId,
    where: { cwd: string; startedAt: number; taken: ReadonlySet<string> },
  ): Promise<FoundConversation[]>
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
 * The conversations a start may have created among parsed log rows: those
 * recorded in `cwd`, created no earlier than the start, not taken; earliest first.
 */
export function startedConversations(
  rows: readonly ImportSessionLiteRow[],
  where: { cwd: string; startedAt: number; taken: ReadonlySet<string> },
): FoundConversation[] {
  const folder = comparablePath(where.cwd)
  const found: FoundConversation[] = []
  for (const row of rows) {
    if (!isConversationId(row.sessionId) || where.taken.has(row.sessionId)) continue
    if (!row.projectPath || comparablePath(row.projectPath) !== folder) continue
    const at = row.createdAt ? Date.parse(row.createdAt) : Number.NaN
    if (!Number.isFinite(at) || at < where.startedAt - START_SLACK_MS) continue
    found.push({ id: row.sessionId, log: row.path, at, prompt: row.title })
  }
  return found.sort((a, b) => a.at - b.at)
}

/**
 * A Codex log's opening `session_meta` record cut to its id, time and folder,
 * read from a prefix of it (the record runs past what was read); null when
 * the prefix is not one or lacks the time or folder.
 */
export function openingRecordFields(prefix: string): string | null {
  const payloadAt = prefix.indexOf('"payload"')
  if (payloadAt < 0 || !/"type"\s*:\s*"session_meta"/.test(prefix.slice(0, payloadAt))) return null
  const payload = prefix.slice(payloadAt)
  const field = (text: string, name: string): string | null => {
    const match = new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text)
    if (!match) return null
    try {
      return JSON.parse(`"${match[1]}"`) as string
    } catch {
      return null
    }
  }
  const id = field(payload, 'id')
  const timestamp = field(payload, 'timestamp')
  const cwd = field(payload, 'cwd')
  if (!timestamp || !cwd) return null
  return JSON.stringify({
    timestamp: field(prefix.slice(0, payloadAt), 'timestamp') ?? timestamp,
    type: 'session_meta',
    payload: { ...(id ? { id } : {}), timestamp, cwd },
  })
}

/** Whether what a parsed log gives for a find can no longer change: its folder is another, or its first prompt is in. */
function settledFor(row: ImportSessionLiteRow | undefined, folder: string): boolean {
  if (!row?.projectPath || !row.createdAt) return false
  return comparablePath(row.projectPath) !== folder || row.title !== null
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
  const readBytes = async (
    transport: BrowserBridgeTransport,
    path: string,
    offset: number,
  ): Promise<Uint8Array | null> => {
    const read = await request<{ data?: Uint8Array; bytesRead?: number }>(transport, 'readRange', {
      path,
      offset,
      length: CLI_LOG_HEAD_BYTES,
    })
    const data = read?.data
    if (!data || data.byteLength === 0) return null
    return data.subarray(0, Math.min(read.bytesRead ?? data.byteLength, data.byteLength))
  }
  const decode = (bytes: Uint8Array) => new TextDecoder('utf-8').decode(bytes)
  const readHead = async (transport: BrowserBridgeTransport, path: string): Promise<string | null> => {
    const bytes = await readBytes(transport, path, 0)
    return bytes ? decode(bytes) : null
  }
  /** A Codex log's head; an opening record longer than the head is cut to the fields a find reads, the records after it kept. */
  const readLogHead = async (transport: BrowserBridgeTransport, path: string): Promise<string | null> => {
    const first = await readBytes(transport, path, 0)
    if (!first) return null
    if (first.byteLength < CLI_LOG_HEAD_BYTES || first.includes(0x0a)) return decode(first)
    const opening = openingRecordFields(decode(first))
    if (opening === null) return decode(first)
    for (let offset = first.byteLength; offset < CLI_LOG_OPENING_MAX_BYTES; ) {
      const chunk = await readBytes(transport, path, offset)
      if (!chunk) break
      const newline = chunk.indexOf(0x0a)
      if (newline >= 0) {
        const rest = await readBytes(transport, path, offset + newline + 1)
        return rest ? `${opening}\n${decode(rest)}` : opening
      }
      if (chunk.byteLength < CLI_LOG_HEAD_BYTES) break
      offset += chunk.byteLength
    }
    return opening
  }
  const parse = (cli: CliAgentId, path: string, head: string, size: number, mtimeMs: number) =>
    getImportSource(cliLogSource(cli)).parseLite([{ path, head, tail: '', size, mtimeMs }])[0]
  // What each log gave, so a later look reads again only a log of the folder still without its first prompt that changed.
  const known = new Map<string, { size: number; mtimeMs: number; row: ImportSessionLiteRow | undefined }>()

  return {
    async findConversations(cli, where) {
      if (cli !== 'codex') return []
      const transport = host().transport
      const homeDir = transport ? await home(transport) : null
      if (!transport || !homeDir) return []
      const root = sourceRoot(homeDir, cliLogSource(cli))
      const folder = comparablePath(where.cwd)
      const rows: ImportSessionLiteRow[] = []
      for (const day of cliLogDayFolders(where.startedAt, now())) {
        const dir = joinRuntimePath(root, ...day.split('/'))
        const listed = await request<{ entries?: BridgeFsTreeEntry[] }>(transport, 'readdirTree', {
          path: dir,
          maxDepth: 1,
        }).catch(() => null)
        for (const entry of listed?.entries ?? []) {
          if (entry.isDirectory || entry.size <= 0 || !entry.path.endsWith('.jsonl')) continue
          const mtimeMs = entry.mtimeMs ?? 0
          if (mtimeMs < where.startedAt - START_SLACK_MS) continue
          const named = CONVERSATION_ID_IN_NAME.exec(entry.path)?.[1]?.toLowerCase()
          if (named && where.taken.has(named)) continue
          const path = joinRuntimePath(dir, entry.path)
          let seen = known.get(path)
          const unchanged = seen?.size === entry.size && seen.mtimeMs === mtimeMs
          if (!seen || (!unchanged && !settledFor(seen.row, folder))) {
            const head = await readLogHead(transport, path).catch(() => null)
            if (head === null) continue
            seen = { size: entry.size, mtimeMs, row: parse(cli, path, head, entry.size, mtimeMs) }
            known.delete(path)
            known.set(path, seen)
            if (known.size > KNOWN_LOGS_LIMIT) known.delete(known.keys().next().value!)
          }
          if (seen.row) rows.push(seen.row)
        }
      }
      return startedConversations(rows, where)
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
  typed: CliTypedLines
  attempt: number
  timer: unknown
  looking: boolean
  again: boolean
  /** Told when the look in progress ends. */
  lookEnded: Array<() => void>
}

/** Who a found log belongs to; `confirmed` when its first prompt is a line submitted to that session. */
type LogOwner = { sessionId: string; confirmed: boolean }

export type CliLogFollowerDeps = {
  reader: CliLogReader
  /**
   * Records the conversation found for `sessionId`, so it can be continued.
   * `confirmed`: the log's first prompt is a line submitted to that session;
   * otherwise the log was taken because nothing else could claim it.
   */
  found(sessionId: string, id: string, confirmed: boolean): Promise<void>
  /** The conversation ids sessions have already recorded; read once, and none of them is taken again. */
  recorded?(): Promise<Iterable<string>>
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
  private seeded: Promise<void> | null = null
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
      typed: new CliTypedLines(),
      attempt: 0,
      timer: undefined,
      looking: false,
      again: false,
      lookEnded: [],
    })
    this.schedule(sessionId)
  }

  /**
   * Looks once more for a session whose conversation is not known yet, after
   * any look in progress, and resolves when that look ends: what a restart
   * waits on before choosing between resuming and starting anew.
   */
  async settle(sessionId: string): Promise<void> {
    const log = this.logs.get(sessionId)
    while (log && this.logs.get(sessionId) === log && log.id === null) {
      if (!log.looking) {
        await this.look(sessionId)
        return
      }
      await new Promise<void>(resolve => log.lookEnded.push(resolve))
    }
  }

  /** Keystrokes sent to the session's CLI at `at`; what was submitted tells its log from another's. */
  typed(sessionId: string, data: string, at: number): void {
    const log = this.logs.get(sessionId)
    if (log?.id === null) log.typed.feed(data, at)
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
    this.endLook(log)
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
        await this.seed()
        const candidates = await this.deps.reader.findConversations(log.cli, {
          cwd: log.cwd,
          startedAt: log.startedAt,
          taken: this.claimed,
        })
        for (const found of candidates) {
          if (this.logs.get(sessionId) !== log) break
          if (this.claimed.has(found.id)) continue
          const owner = this.ownerOf(found, sessionId, log)
          if (owner === null) continue
          if (owner.sessionId !== sessionId) {
            // Another session in the folder submitted this prompt: leave the log to it.
            void this.look(owner.sessionId)
            continue
          }
          this.claimed.add(found.id)
          log.id = found.id
          log.log = found.log
          await this.deps.found(sessionId, found.id, owner.confirmed)
          break
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
      this.endLook(log)
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

  /** Adds the ids sessions already recorded to the claimed ones, once; a failed read is tried again on the next look. */
  private seed(): Promise<void> {
    const recorded = this.deps.recorded
    if (!recorded) return Promise.resolve()
    this.seeded ??= recorded().then(
      ids => {
        for (const id of ids) this.claimed.add(id)
      },
      () => {
        this.seeded = null
      },
    )
    return this.seeded
  }

  private endLook(log: FollowedLog): void {
    for (const resolve of log.lookEnded.splice(0)) resolve()
  }

  /**
   * Which session still looking in the folder a log belongs to, or null when
   * none may take it. A session that submitted lines takes a log with a first
   * prompt only when one of its lines is that prompt (confirmed). Otherwise:
   * the one whose last submit came nearest before the log was created, else
   * `sessionId`, the one looking, when it may take it.
   */
  private ownerOf(found: FoundConversation, sessionId: string, log: FollowedLog): LogOwner | null {
    const folder = comparablePath(log.cwd)
    let waiting = Array.from(this.logs).filter(
      ([, other]) =>
        other.id === null &&
        other.cli === log.cli &&
        comparablePath(other.cwd) === folder &&
        found.at >= other.startedAt - START_SLACK_MS,
    )
    let confirmed = false
    const prompt = found.prompt
    if (prompt) {
      const typedIt = waiting.filter(([, other]) => other.typed.lines.some(line => lineMatchesPromptTitle(line.text, prompt)))
      if (typedIt.length > 0) {
        waiting = typedIt
        confirmed = true
      } else {
        waiting = waiting.filter(([, other]) => other.typed.lines.length === 0)
      }
    }
    if (waiting.length === 1) return { sessionId: waiting[0]![0], confirmed }
    let owner: string | null = null
    let ownerAt = Number.NEGATIVE_INFINITY
    let tied = false
    for (const [id, other] of waiting) {
      const at = Math.max(
        Number.NEGATIVE_INFINITY,
        ...other.typed.lines.filter(line => line.at <= found.at + START_SLACK_MS).map(line => line.at),
      )
      if (at > ownerAt) {
        owner = id
        ownerAt = at
        tied = false
      } else if (at === ownerAt) {
        tied = true
      }
    }
    if (owner !== null && ownerAt > Number.NEGATIVE_INFINITY && !tied) return { sessionId: owner, confirmed }
    return waiting.some(([id]) => id === sessionId) ? { sessionId, confirmed } : null
  }
}

/**
 * Contract: the runtime's terminals (F-31) — one pseudoconsole child per
 * terminal on the runtime's host port, owned here and never by a client or a
 * session engine. Per terminal: its id (`term_<uuid>`), the session it
 * belongs to, the shell and cwd it started with, its title, size and state,
 * and a mirror of its screen with up to TERMINAL_HISTORY_LINES lines of
 * history above it. Output bytes are decoded once with a streaming UTF-8
 * decoder; the text reaches the mirror and the listeners in coalesced pieces,
 * so a snapshot and the deltas after it never overlap. Listeners hear every change
 * as a `TerminalServiceEvent`; the `terminal` capability turns them into topic
 * deltas. An unknown id throws `not_found`; a host without `shell.spawn.pty`,
 * or none at all, throws `host_unavailable`.
 *
 * Security: `create` takes a shell id from the resolved list, never a path or
 * command line, and the cwd is the session's own folder as the runtime knows
 * it — a client never sends one. Output stays in memory: nothing here writes
 * to disk or reaches the model.
 */
import {
  createNativePrimitives,
  NativePrimitiveError,
  type NativePtyChild,
  type NativeStreamExit,
  type NativeStreamHandlers,
} from '../browser/bridge/nativePrimitives'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { createBridgeRoute } from '../browser/bridge/browserBridgeProtocol'
import type { BrowserHostManifest } from '../browser/bridge/protocol/manifest'
import { wireError } from '../browser/runtimeProtocol'
import { OutputCoalescer } from './outputCoalescer'
import {
  isTerminalSize,
  TERMINAL_PTY_PRIMITIVE,
  TERMINAL_HISTORY_LINES,
  type TerminalCreatePayload,
  type TerminalRow,
  type TerminalShellInfo,
  type TerminalSnapshot,
  type TerminalState,
  type TerminalsState,
} from './protocol'
import { ScreenMirror } from './screenMirror'
import {
  defaultTerminalShell,
  isTerminalShellId,
  sameShells,
  shellsFromHostReport,
  TERMINAL_SHELL_ARGV,
  type HostShellReport,
  type TerminalShellId,
} from './shells'
import { TitleSequenceScanner } from './titleScanner'
import { CliActivityClock, CliBusyTracker, CliTitleFollower } from './cliTitles'
import { createBridgeCliLogEraser, type CliLogEraser } from './cliLogErase'
import { CliLogFollower, createBridgeCliLogReader, type CliLogReader } from './cliLogs'
import {
  CLI_ASSIGNS_CONVERSATION_ID,
  cliAgentArgv,
  isCliAgentId,
  isConversationId,
  probeCliAgents,
  type CliAgentId,
  type CliConversation,
} from './cliAgents'

/** The runtime's host port and manifest, read per call so a replaced port is used. */
export type TerminalHost = {
  transport: BrowserBridgeTransport | null
  manifest: Pick<BrowserHostManifest, 'capabilities' | 'primitives'> | null
}

export type TerminalServiceDeps = {
  host(): TerminalHost
  createRequestId(): string
  /** Where a session's terminal starts — its worktree when it runs in one; undefined for a session the runtime does not hold. */
  sessionCwd(sessionId: string): string | undefined
  /** Which shells the host has. Default: `exec.listShells` and `fs.systemInfo`. */
  probeShells?(host: TerminalHost, createRequestId: () => string): Promise<TerminalShellInfo[]>
  /** Which coding-agent CLIs the host has (F-34). Default: `probeCliAgents`. */
  probeClis?(host: TerminalHost, createRequestId: () => string): Promise<CliAgentId[]>
  /** Where a CLI session's conversation id is kept; without it a CLI cannot be started. */
  cliConversations?: CliConversationStore
  /** How long a CLI's terminal title must hold before it becomes the session title; default `CLI_TITLE_SETTLE_MS`. */
  cliTitleSettleMs?: number
  /** How long a CLI counts as working after its title glyph last changed; default `CLI_BUSY_HOLD_MS`. */
  cliBusyHoldMs?: number
  /** How often a working CLI's session records activity; default `CLI_ACTIVITY_INTERVAL_MS`. */
  cliActivityIntervalMs?: number
  /** Reads the CLIs' own conversation logs; default over the host's `fs` bridge. */
  cliLogs?: CliLogReader
  /** Removes a deleted CLI session's conversation from its CLI's logs; default over the host's `fs` bridge. */
  cliLogEraser?: CliLogEraser
  /** When a running CLI's log is looked for; default `CLI_LOG_RETRY_MS`. */
  cliLogRetryMs?: readonly number[]
  now?(): number
  /** Output coalescing window and size; defaults ~16 ms / 64 Ki units. */
  coalesceWindowMs?: number
  coalesceMaxUnits?: number
  historyLines?: number
  newId?(): string
}

/**
 * A CLI session's recorded conversation (F-34): `id` is null until it is
 * known. `confirmed` marks a found id whose log's first prompt was submitted
 * to this session; an id the runtime assigned needs no mark.
 */
export type CliConversationRecord = { cli: CliAgentId; id: string | null; confirmed?: boolean }

/** Reads and writes the conversation a CLI session started, in that session's metadata. */
export type CliConversationStore = {
  read(sessionId: string): Promise<CliConversationRecord | undefined>
  record(sessionId: string, record: CliConversationRecord): Promise<void>
  /** Sets the session's automatic title from its CLI's terminal title; without it titles are not followed. */
  retitle?(sessionId: string, title: string): Promise<void>
  /** Moves the session's activity time forward to `at`; without it a working CLI does not move it. */
  touch?(sessionId: string, at: number): Promise<void>
  /** Every conversation id the sessions have recorded, so a log one of them holds is never found for another. */
  recordedIds?(): Promise<Iterable<string>>
}

export type TerminalServiceEvent =
  | { kind: 'list' }
  | { kind: 'output'; id: string; data: string }
  | { kind: 'resize'; id: string; cols: number; rows: number }
  | { kind: 'title'; id: string; title: string }
  | { kind: 'state'; id: string; state: TerminalState }
  | { kind: 'closed'; id: string }
  /** A CLI session started or stopped working (F-34); read `cliBusy`. */
  | { kind: 'cliBusy'; sessionId: string; busy: boolean }

const DEFAULT_COALESCE_WINDOW_MS = 16
const DEFAULT_COALESCE_MAX_UNITS = 64 * 1024

const FOCUS_REPORTS = /\u001b\[[IO]/g

/** `data` without the focus-in / focus-out reports an emulator sends. */
function withoutFocusReports(data: string): string {
  return data.replace(FOCUS_REPORTS, '')
}

/** `pwsh` missing on the host: the same two codes the PowerShell tool falls back on. */
const POWERSHELL_FALLBACK_CODES = new Set(['BINARY_NOT_FOUND', 'COMMAND_NOT_ALLOWED'])

type TerminalRecord = {
  id: string
  sessionId: string
  shell: TerminalShellId | CliAgentId
  /** Set for a CLI terminal: what it runs and the conversation its next start names. */
  cli: { id: CliAgentId; conversation: CliConversation | null } | null
  cwd: string
  title: string
  cols: number
  rows: number
  state: TerminalState
  screen: ScreenMirror
  coalescer: OutputCoalescer
  titles: TitleSequenceScanner
  decoder: TextDecoder
  child: NativePtyChild | null
  /** Identifies the spawn whose events are current; an older spawn's are dropped. */
  spawn: object | null
}

function randomId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return uuid.replace(/-/g, '')
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The host's shells, asked on the runtime's port: `exec.listShells` (when `exec` is served) and the platform. */
export async function probeHostShells(
  host: TerminalHost,
  createRequestId: () => string,
): Promise<TerminalShellInfo[]> {
  const transport = host.transport
  if (!transport) return []
  const report: HostShellReport = { bash: false, powershell: false, platform: '' }
  if (host.manifest?.capabilities.includes('exec') ?? true) {
    const shells = await transport.request({
      id: createRequestId(),
      route: createBridgeRoute('exec', 'listShells'),
      payload: {},
    })
    if (shells.ok) {
      report.bash = shells.result.bash === true
      report.powershell = shells.result.powershell === true
    }
  }
  const info = await transport.request({
    id: createRequestId(),
    route: createBridgeRoute('fs', 'systemInfo'),
    payload: {},
  })
  if (info.ok && typeof info.result.platform === 'string') report.platform = info.result.platform
  return shellsFromHostReport(report)
}

export class TerminalService {
  private readonly records = new Map<string, TerminalRecord>()
  private readonly listeners = new Set<(event: TerminalServiceEvent) => void>()
  private readonly encoder = new TextEncoder()
  private shellList: TerminalShellInfo[] = []
  private cliList: CliAgentId[] = []
  private cliScan: Promise<void> | null = null
  private lastAvailable = false
  private probeToken = 0
  private disposed = false
  private readonly cliTitles: CliTitleFollower | null
  private readonly cliWork: CliBusyTracker
  private readonly cliActivity: CliActivityClock | null
  private readonly cliLogs: CliLogFollower | null

  constructor(private readonly deps: TerminalServiceDeps) {
    const store = deps.cliConversations
    const retitle = store?.retitle
    this.cliTitles = retitle
      ? new CliTitleFollower((sessionId, title) => retitle(sessionId, title), deps.cliTitleSettleMs)
      : null
    const touch = store?.touch
    this.cliActivity = touch
      ? new CliActivityClock(sessionId => {
          void touch(sessionId, (deps.now ?? Date.now)()).catch(() => undefined)
        }, deps.cliActivityIntervalMs)
      : null
    this.cliWork = new CliBusyTracker((sessionId, busy) => {
      this.cliActivity?.busy(sessionId, busy)
      this.emit({ kind: 'cliBusy', sessionId, busy })
      if (!busy) this.cliLogs?.poke(sessionId)
    }, deps.cliBusyHoldMs)
    this.cliLogs = store
      ? new CliLogFollower({
          reader: deps.cliLogs ?? createBridgeCliLogReader(deps.host, deps.createRequestId),
          found: (sessionId, id, confirmed) => this.cliConversationFound(sessionId, id, confirmed),
          ...(store.recordedIds ? { recorded: () => store.recordedIds!() } : {}),
          ...(retitle ? { retitle } : {}),
          hasTerminalTitle: sessionId => this.cliTitles?.hasTitle(sessionId) ?? false,
          ...(deps.cliLogRetryMs ? { retryMs: deps.cliLogRetryMs } : {}),
        })
      : null
  }

  /** Whether `sessionId`'s CLI is working, read from its title's spinner (F-34). */
  cliBusy(sessionId: string): boolean {
    return this.cliWork.isBusy(sessionId)
  }

  /** False without a host port or without the host's `shell.spawn.pty` primitive. */
  get available(): boolean {
    if (this.disposed) return false
    const host = this.deps.host()
    return host.transport !== null && (host.manifest?.primitives?.includes(TERMINAL_PTY_PRIMITIVE) ?? false)
  }

  subscribe(listener: (event: TerminalServiceEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * The host port or its manifest changed: re-read availability and ask the
   * host for its shells again; listeners hear a `list` when either differs.
   */
  refreshHost(): void {
    if (this.disposed) return
    const available = this.available
    if (available !== this.lastAvailable) {
      this.lastAvailable = available
      this.emit({ kind: 'list' })
    }
    if (!available) {
      if (this.shellList.length > 0 || this.cliList.length > 0) {
        this.shellList = []
        this.cliList = []
        this.emit({ kind: 'list' })
      }
      return
    }
    const token = ++this.probeToken
    void this.probe(token)
    this.cliScan = null
    void this.rescanClis()
  }

  /**
   * Look for the coding-agent CLIs again (F-34): file lookups only, one scan
   * at a time — a call while one runs shares it. Listeners hear a `list` when
   * the answer differs.
   */
  rescanClis(): Promise<void> {
    if (this.disposed || !this.available) return Promise.resolve()
    if (this.cliScan) return this.cliScan
    const token = this.probeToken
    const scan = this.scanClis(token).finally(() => {
      if (this.cliScan === scan) this.cliScan = null
    })
    this.cliScan = scan
    return scan
  }

  /**
   * The host port went away: its streams died with it, so every running
   * terminal is now exited without a code. The rows stay, so a person can
   * restart them once a host is back.
   */
  hostGone(): void {
    this.probeToken += 1
    for (const record of this.records.values()) {
      if (!record.child && record.state.kind !== 'starting') continue
      record.spawn = null
      record.child?.detach()
      record.child = null
      record.coalescer.flush()
      this.setState(record, { kind: 'exited', exitCode: null })
    }
    this.refreshHost()
  }

  list(): TerminalsState {
    const available = this.available
    return {
      available,
      shells: available ? [...this.shellList] : [],
      clis: available ? [...this.cliList] : [],
      terminals: Array.from(this.records.values(), rowOf),
    }
  }

  has(id: string): boolean {
    return this.records.has(id)
  }

  /** The terminal as it is now; its `scrollback` redraws the screen and history on a reset emulator of that size. */
  async snapshot(id: string): Promise<TerminalSnapshot | undefined> {
    const record = this.records.get(id)
    if (!record) return undefined
    const { cols, rows, title, state } = record
    const scrollback = await record.screen.serialize()
    return { cols, rows, title, state, scrollback }
  }

  /** Start a shell for `sessionId` in its folder; resolves with the id once the start settled (running or failed). */
  async create(input: TerminalCreatePayload): Promise<string> {
    this.requireAvailable()
    const cwd = this.deps.sessionCwd(input.sessionId)
    if (cwd === undefined) {
      throw wireError('not_found', `terminal: the runtime holds no session '${input.sessionId}'`)
    }
    if (!isTerminalSize(input.cols, input.rows)) {
      throw wireError('bad_payload', 'terminal: cols and rows must be integers in 1..1000')
    }
    let shell: TerminalShellId | CliAgentId
    let cli: TerminalRecord['cli'] = null
    if (input.cli !== undefined) {
      if (input.shell !== undefined) {
        throw wireError('bad_payload', 'terminal: give a shell or a cli, not both')
      }
      cli = await this.cliStart(input.sessionId, input.cli)
      shell = cli.id
    } else {
      const picked = input.shell ?? defaultTerminalShell(this.shellList)
      if (!isTerminalShellId(picked) || !this.shellList.some(known => known.id === picked)) {
        throw wireError('bad_payload', `terminal: shell '${String(picked)}' is not one this host has`)
      }
      shell = picked
    }
    const id = `term_${(this.deps.newId ?? randomId)()}`
    const record: TerminalRecord = {
      id,
      sessionId: input.sessionId,
      shell,
      cli,
      cwd,
      title: shell,
      cols: input.cols,
      rows: input.rows,
      state: { kind: 'starting' },
      screen: this.newScreen(input.cols, input.rows),
      coalescer: new OutputCoalescer(
        data => this.deliverOutput(id, data),
        this.deps.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS,
        this.deps.coalesceMaxUnits ?? DEFAULT_COALESCE_MAX_UNITS,
      ),
      titles: new TitleSequenceScanner(),
      decoder: new TextDecoder('utf-8'),
      child: null,
      spawn: null,
    }
    this.records.set(id, record)
    this.emit({ kind: 'list' })
    await this.spawn(record)
    return id
  }

  /**
   * Keystrokes to the shell; nothing while it is not running. A CLI is never
   * told its terminal lost or regained focus: a CLI out of focus stops
   * updating its title, which its working state is read from (F-34).
   */
  async write(id: string, data: string): Promise<void> {
    const record = this.require(id)
    const child = record.child
    if (record.cli) data = withoutFocusReports(data)
    if (!child || data.length === 0) return
    if (record.cli) this.cliLogs?.typed(record.sessionId, data, (this.deps.now ?? Date.now)())
    try {
      await child.write(this.encoder.encode(data))
    } catch (error) {
      throw wireError('host_unavailable', `terminal: write failed: ${messageOf(error)}`)
    }
  }

  async resize(id: string, cols: number, rows: number): Promise<void> {
    const record = this.require(id)
    if (!isTerminalSize(cols, rows)) {
      throw wireError('bad_payload', 'terminal: cols and rows must be integers in 1..1000')
    }
    record.cols = cols
    record.rows = rows
    record.screen.resize(cols, rows)
    this.emit({ kind: 'resize', id, cols, rows })
    const child = record.child
    if (!child) return
    try {
      await child.resize(cols, rows)
    } catch {
      // The size is recorded; a child the host no longer knows is about to report its exit.
    }
  }

  /** Start the same shell again in the same place, under the same id. Only for an exited or failed terminal. */
  async restart(id: string): Promise<void> {
    const record = this.require(id)
    if (record.state.kind === 'starting' || record.state.kind === 'running') {
      throw wireError('conflict', `terminal '${id}' is still running`)
    }
    this.requireAvailable()
    record.decoder = new TextDecoder('utf-8')
    record.titles = new TitleSequenceScanner()
    // A restarted terminal starts afresh: the old shell's output does not carry over.
    record.screen.dispose()
    record.screen = this.newScreen(record.cols, record.rows)
    this.setTitle(record, record.shell)
    this.setState(record, { kind: 'starting' })
    // A CLI whose conversation is not known yet looks for its log once more first.
    if (record.cli && !record.cli.conversation) {
      await this.cliLogs?.settle(record.sessionId)
      if (record.spawn !== null || !this.records.has(id)) return
    }
    // A CLI restarted after its first run continues the conversation it started.
    if (record.cli?.conversation) record.cli.conversation = { ...record.cli.conversation, resume: true }
    await this.spawn(record)
  }

  /** Kill the shell and forget the terminal. */
  close(id: string): void {
    const record = this.require(id)
    this.forget(record)
  }

  /**
   * A deleted CLI session's conversation leaves its CLI's own logs; call
   * after `closeForSession`. Never throws. Only an id known to be the
   * session's is erased: one the runtime assigned, or a found one `confirmed`.
   */
  async eraseCliConversation(record: CliConversationRecord, cwd: string): Promise<string[]> {
    if (!isConversationId(record.id)) return []
    if (!CLI_ASSIGNS_CONVERSATION_ID[record.cli] && record.confirmed !== true) return []
    const eraser = this.deps.cliLogEraser ?? createBridgeCliLogEraser(this.deps.host, this.deps.createRequestId)
    return eraser.erase(record.cli, { cwd, id: record.id }).catch(() => [])
  }

  /** The session ended: its terminals die with it. */
  closeForSession(sessionId: string): void {
    this.cliTitles?.forget(sessionId)
    this.cliLogs?.forget(sessionId)
    for (const record of Array.from(this.records.values())) {
      if (record.sessionId === sessionId) this.forget(record)
    }
  }

  dispose(): void {
    this.disposed = true
    this.probeToken += 1
    this.cliTitles?.dispose()
    this.cliWork.dispose()
    this.cliActivity?.dispose()
    this.cliLogs?.dispose()
    for (const record of Array.from(this.records.values())) this.forget(record)
    this.listeners.clear()
  }

  // ---- internals -----------------------------------------------------------

  private requireAvailable(): void {
    if (!this.available) {
      throw wireError('host_unavailable', 'terminal: this host cannot run a pseudoconsole')
    }
  }

  private require(id: string): TerminalRecord {
    const record = this.records.get(id)
    if (!record) throw wireError('not_found', `terminal: no terminal '${id}'`)
    return record
  }

  private emit(event: TerminalServiceEvent): void {
    for (const listener of Array.from(this.listeners)) listener(event)
  }

  /** The CLI's log names the conversation it started: record it, so a restart and Continue resume it. */
  private async cliConversationFound(sessionId: string, id: string, confirmed: boolean): Promise<void> {
    let cli: CliAgentId | null = null
    for (const record of this.records.values()) {
      if (record.sessionId !== sessionId || !record.cli || record.cli.conversation) continue
      record.cli.conversation = { id, resume: false }
      cli = record.cli.id
    }
    if (cli) await this.deps.cliConversations?.record(sessionId, { cli, id, ...(confirmed ? { confirmed } : {}) })
  }

  /** Validates a CLI start and settles the conversation it names, recording a new one first. */
  private async cliStart(
    sessionId: string,
    request: NonNullable<TerminalCreatePayload['cli']>,
  ): Promise<NonNullable<TerminalRecord['cli']>> {
    const cliId = request.id
    if (!isCliAgentId(cliId)) {
      throw wireError('bad_payload', `terminal: cli '${String(cliId)}' is not one Velloc runs`)
    }
    const store = this.deps.cliConversations
    if (!store) throw wireError('host_unavailable', 'terminal: this runtime cannot start a cli')
    if (request.start === 'continue') {
      const recorded = await store.read(sessionId)
      if (!recorded || recorded.cli !== cliId || !isConversationId(recorded.id)) {
        throw wireError('bad_payload', `terminal: session '${sessionId}' has no ${cliId} conversation to continue`)
      }
      return { id: cliId, conversation: { id: recorded.id, resume: true } }
    }
    if (request.start !== 'new') {
      throw wireError('bad_payload', "terminal: cli start must be 'new' or 'continue'")
    }
    // A new conversation takes its own title, whatever the last one's terminal showed.
    this.cliTitles?.forget(sessionId)
    const conversationId = CLI_ASSIGNS_CONVERSATION_ID[cliId] ? newConversationId() : null
    await store.record(sessionId, { cli: cliId, id: conversationId })
    return {
      id: cliId,
      conversation: conversationId ? { id: conversationId, resume: false } : null,
    }
  }

  private async scanClis(token: number): Promise<void> {
    const probeClis = this.deps.probeClis ?? probeCliAgents
    let clis: CliAgentId[]
    try {
      clis = await probeClis(this.deps.host(), this.deps.createRequestId)
    } catch {
      clis = []
    }
    if (token !== this.probeToken || this.disposed) return
    if (clis.length === this.cliList.length && clis.every((cli, i) => cli === this.cliList[i])) return
    this.cliList = clis
    this.emit({ kind: 'list' })
  }

  private async probe(token: number): Promise<void> {
    const probeShells = this.deps.probeShells ?? probeHostShells
    let shells: TerminalShellInfo[]
    try {
      shells = await probeShells(this.deps.host(), this.deps.createRequestId)
    } catch {
      shells = []
    }
    if (token !== this.probeToken || this.disposed) return
    if (sameShells(shells, this.shellList)) return
    this.shellList = shells
    this.emit({ kind: 'list' })
  }

  private async spawn(record: TerminalRecord): Promise<void> {
    const host = this.deps.host()
    if (!host.transport || !this.available) {
      this.setState(record, { kind: 'failed', message: 'the host cannot run a pseudoconsole' })
      return
    }
    const primitives = createNativePrimitives({
      transport: host.transport,
      createRequestId: this.deps.createRequestId,
      manifest: host.manifest ?? undefined,
    })
    const spawn = {}
    record.spawn = spawn
    const startedAt = (this.deps.now ?? Date.now)()
    const handlers: NativeStreamHandlers = {
      onOutput: (_stream, bytes) => {
        if (record.spawn === spawn) this.onOutput(record, bytes)
      },
      onExit: exit => {
        if (record.spawn === spawn) this.onExit(record, exit)
      },
    }
    let spawnedSize = { cols: record.cols, rows: record.rows }
    const start = (shell: TerminalShellId | CliAgentId) => {
      spawnedSize = { cols: record.cols, rows: record.rows }
      return primitives.shell.spawnPty(
        {
          ...(record.cli
            ? cliAgentArgv(record.cli.id, record.cli.conversation)
            : TERMINAL_SHELL_ARGV[shell as TerminalShellId]),
          cwd: record.cwd,
        },
        spawnedSize,
        handlers,
      )
    }
    let child: NativePtyChild
    try {
      try {
        child = await start(record.shell)
      } catch (error) {
        if (record.shell !== 'pwsh' || !isPowerShellFallback(error)) throw error
        record.shell = 'powershell'
        this.setTitle(record, record.shell)
        child = await start(record.shell)
      }
    } catch (error) {
      if (record.spawn !== spawn || !this.records.has(record.id)) return
      this.setState(record, { kind: 'failed', message: messageOf(error) })
      return
    }
    if (record.spawn !== spawn || !this.records.has(record.id)) {
      // Closed while the host was starting it.
      child.detach()
      void child.kill().catch(() => {})
      return
    }
    // A child that already exited (its exit was replayed by the spawn) keeps that state.
    if (record.state.kind === 'exited') return
    record.child = child
    // A resize that arrived while the host was starting the console was only recorded.
    if (record.cols !== spawnedSize.cols || record.rows !== spawnedSize.rows) {
      void child.resize(record.cols, record.rows).catch(() => {})
    }
    this.setState(record, { kind: 'running' })
    if (record.cli) {
      this.cliLogs?.start(record.sessionId, {
        cli: record.cli.id,
        cwd: record.cwd,
        startedAt,
        id: record.cli.conversation?.id ?? null,
        fresh: !record.cli.conversation?.resume,
      })
    }
  }

  private onOutput(record: TerminalRecord, bytes: Uint8Array): void {
    const text = record.decoder.decode(bytes, { stream: true })
    if (text.length === 0) return
    const titles = record.titles.feed(text)
    const title = titles[titles.length - 1]
    if (title !== undefined) this.setTitle(record, title)
    record.coalescer.push(text)
  }

  private onExit(record: TerminalRecord, exit: NativeStreamExit): void {
    record.coalescer.push(record.decoder.decode())
    record.coalescer.flush()
    record.child = null
    record.spawn = null
    this.setState(record, { kind: 'exited', exitCode: exit.exitCode >= 0 ? exit.exitCode : null })
  }

  private newScreen(cols: number, rows: number): ScreenMirror {
    return new ScreenMirror(cols, rows, this.deps.historyLines ?? TERMINAL_HISTORY_LINES)
  }

  private deliverOutput(id: string, data: string): void {
    const record = this.records.get(id)
    if (!record) return
    record.screen.write(data)
    this.emit({ kind: 'output', id, data })
  }

  private setTitle(record: TerminalRecord, title: string): void {
    if (record.title === title) return
    record.title = title
    if (record.cli) {
      this.cliTitles?.observe(record.sessionId, record.cli.id, title)
      this.cliWork.observe(record.sessionId, title)
    }
    this.emit({ kind: 'title', id: record.id, title })
    this.emit({ kind: 'list' })
  }

  private setState(record: TerminalRecord, state: TerminalState): void {
    record.state = state
    // A CLI that stopped is not working, whatever its last title showed.
    if (record.cli && (state.kind === 'exited' || state.kind === 'failed')) {
      this.cliWork.end(record.sessionId)
      this.cliLogs?.poke(record.sessionId)
    }
    this.emit({ kind: 'state', id: record.id, state })
    this.emit({ kind: 'list' })
  }

  private forget(record: TerminalRecord): void {
    if (!this.records.delete(record.id)) return
    // A closed terminal is not activity: its session may be going, and a write now would race its removal.
    if (record.cli) {
      this.cliActivity?.stop(record.sessionId)
      this.cliWork.end(record.sessionId)
    }
    record.spawn = null
    record.coalescer.dispose()
    record.screen.dispose()
    const child = record.child
    record.child = null
    if (child) {
      child.detach()
      void child.kill().catch(() => {})
    }
    this.emit({ kind: 'closed', id: record.id })
    this.emit({ kind: 'list' })
  }
}

function rowOf(record: TerminalRecord): TerminalRow {
  return {
    id: record.id,
    sessionId: record.sessionId,
    shell: record.shell,
    ...(record.cli ? { cli: record.cli.id } : {}),
    title: record.title,
    state: record.state,
  }
}

function newConversationId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (!uuid) throw wireError('host_unavailable', 'terminal: no random source for a conversation id')
  return uuid
}

function isPowerShellFallback(error: unknown): boolean {
  return error instanceof NativePrimitiveError && POWERSHELL_FALLBACK_CODES.has(error.code)
}

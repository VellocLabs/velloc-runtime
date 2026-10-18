/**
 * Contract: the runtime's terminals (F-31) — one pseudoconsole child per
 * terminal on the runtime's host port, owned here and never by a client or a
 * session engine. Per terminal: its id (`term_<uuid>`), the session it
 * belongs to, the shell and cwd it started with, its title, size and state,
 * and a scrollback of decoded text capped at TERMINAL_SCROLLBACK_BYTES UTF-16
 * code units. Output bytes are decoded once with a streaming UTF-8 decoder;
 * the text reaches the scrollback and the listeners in coalesced pieces, so a
 * snapshot and the deltas after it never overlap. Listeners hear every change
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
  TERMINAL_SCROLLBACK_BYTES,
  type TerminalCreatePayload,
  type TerminalRow,
  type TerminalShellInfo,
  type TerminalSnapshot,
  type TerminalState,
  type TerminalsState,
} from './protocol'
import { ScrollbackRing } from './scrollback'
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
  /** Output coalescing window and size; defaults ~16 ms / 64 Ki units. */
  coalesceWindowMs?: number
  coalesceMaxUnits?: number
  scrollbackLimit?: number
  newId?(): string
}

export type TerminalServiceEvent =
  | { kind: 'list' }
  | { kind: 'output'; id: string; data: string }
  | { kind: 'resize'; id: string; cols: number; rows: number }
  | { kind: 'title'; id: string; title: string }
  | { kind: 'state'; id: string; state: TerminalState }
  | { kind: 'closed'; id: string }

const DEFAULT_COALESCE_WINDOW_MS = 16
const DEFAULT_COALESCE_MAX_UNITS = 64 * 1024

/** `pwsh` missing on the host: the same two codes the PowerShell tool falls back on. */
const POWERSHELL_FALLBACK_CODES = new Set(['BINARY_NOT_FOUND', 'COMMAND_NOT_ALLOWED'])

type TerminalRecord = {
  id: string
  sessionId: string
  shell: TerminalShellId
  cwd: string
  title: string
  cols: number
  rows: number
  state: TerminalState
  scrollback: ScrollbackRing
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
  private lastAvailable = false
  private probeToken = 0
  private disposed = false

  constructor(private readonly deps: TerminalServiceDeps) {}

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
      if (this.shellList.length > 0) {
        this.shellList = []
        this.emit({ kind: 'list' })
      }
      return
    }
    const token = ++this.probeToken
    void this.probe(token)
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
      terminals: Array.from(this.records.values(), rowOf),
    }
  }

  has(id: string): boolean {
    return this.records.has(id)
  }

  snapshot(id: string): TerminalSnapshot | undefined {
    const record = this.records.get(id)
    if (!record) return undefined
    return {
      cols: record.cols,
      rows: record.rows,
      title: record.title,
      state: record.state,
      scrollback: record.scrollback.text(),
    }
  }

  /** Start a shell for `sessionId` in its folder; resolves with the id once the start settled (running or failed). */
  async create(input: TerminalCreatePayload): Promise<string> {
    this.requireAvailable()
    const cwd = this.deps.sessionCwd(input.sessionId)
    if (cwd === undefined) {
      throw wireError('not_found', `terminal: the runtime holds no session '${input.sessionId}'`)
    }
    const shell = input.shell ?? defaultTerminalShell(this.shellList)
    if (!isTerminalShellId(shell) || !this.shellList.some(known => known.id === shell)) {
      throw wireError('bad_payload', `terminal: shell '${String(shell)}' is not one this host has`)
    }
    if (!isTerminalSize(input.cols, input.rows)) {
      throw wireError('bad_payload', 'terminal: cols and rows must be integers in 1..1000')
    }
    const id = `term_${(this.deps.newId ?? randomId)()}`
    const record: TerminalRecord = {
      id,
      sessionId: input.sessionId,
      shell,
      cwd,
      title: shell,
      cols: input.cols,
      rows: input.rows,
      state: { kind: 'starting' },
      scrollback: new ScrollbackRing(this.deps.scrollbackLimit ?? TERMINAL_SCROLLBACK_BYTES),
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

  /** Keystrokes to the shell; nothing while it is not running. */
  async write(id: string, data: string): Promise<void> {
    const record = this.require(id)
    const child = record.child
    if (!child || data.length === 0) return
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
    record.scrollback = new ScrollbackRing(this.deps.scrollbackLimit ?? TERMINAL_SCROLLBACK_BYTES)
    this.setTitle(record, record.shell)
    this.setState(record, { kind: 'starting' })
    await this.spawn(record)
  }

  /** Kill the shell and forget the terminal. */
  close(id: string): void {
    const record = this.require(id)
    this.forget(record)
  }

  /** The session ended: its terminals die with it. */
  closeForSession(sessionId: string): void {
    for (const record of Array.from(this.records.values())) {
      if (record.sessionId === sessionId) this.forget(record)
    }
  }

  dispose(): void {
    this.disposed = true
    this.probeToken += 1
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
    const handlers: NativeStreamHandlers = {
      onOutput: (_stream, bytes) => {
        if (record.spawn === spawn) this.onOutput(record, bytes)
      },
      onExit: exit => {
        if (record.spawn === spawn) this.onExit(record, exit)
      },
    }
    const start = (shell: TerminalShellId) =>
      primitives.shell.spawnPty(
        { ...TERMINAL_SHELL_ARGV[shell], cwd: record.cwd },
        { cols: record.cols, rows: record.rows },
        handlers,
      )
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
    this.setState(record, { kind: 'running' })
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

  private deliverOutput(id: string, data: string): void {
    const record = this.records.get(id)
    if (!record) return
    record.scrollback.append(data)
    this.emit({ kind: 'output', id, data })
  }

  private setTitle(record: TerminalRecord, title: string): void {
    if (record.title === title) return
    record.title = title
    this.emit({ kind: 'title', id: record.id, title })
    this.emit({ kind: 'list' })
  }

  private setState(record: TerminalRecord, state: TerminalState): void {
    record.state = state
    this.emit({ kind: 'state', id: record.id, state })
    this.emit({ kind: 'list' })
  }

  private forget(record: TerminalRecord): void {
    if (!this.records.delete(record.id)) return
    record.spawn = null
    record.coalescer.dispose()
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
    title: record.title,
    state: record.state,
  }
}

function isPowerShellFallback(error: unknown): boolean {
  return error instanceof NativePrimitiveError && POWERSHELL_FALLBACK_CODES.has(error.code)
}

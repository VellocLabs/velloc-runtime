/**
 * Contract: the worker's background-shell registry. Every `local_bash` task is a persistent host child
 * started with `shell.spawn({persist: {logPath}})`; the host appends stdout + stderr to `logPath`
 * (the task's output file). This owns start, the adaptive poll loop (`shell.persistentList` + the log
 * tail), the deadline kill, stop/kill, re-adoption after a restart, and acknowledged results. Invariants:
 * - killed outranks exitCode (user Stop ≠ failure)
 * - a poll and the stop flow never double-finalize
 * - acknowledged results skip delivery
 * - the worker never writes the output file
 */
import type { BridgeShellPersistentRecord } from '../bridge/browserBridgeProtocol'
import { NativePrimitiveError } from '../bridge/nativePrimitives'
import { taskKindFromId } from '../../backgroundTasks/taskId'
import {
  joinShellOutput,
  formatShellSummary,
  classifyShellExit,
  type ShellRunObservation,
} from './shellFormatting'
import type { TaskRegistry } from './TaskRegistry'
import type { BackgroundShellSpawnRequest } from '../../toolkit/run/backgroundShellSink'

// --- Types ---

export type NexusShellInvokeParams = {
  timeout?: number
  background?: boolean
  cwd?: string
  description?: string
}

export type BackgroundShellLaunch = {
  /** The persistent child's id (`shell.spawn` → `persistentId`) — the
   *  registry key and the `shell.persistentKill` handle. */
  shellId: string
  command: string
  spawnerSessionId?: string
  outputFilePath?: string | null
  taskId?: string
  params?: NexusShellInvokeParams
  /** Register already acknowledged — the launching caller reads the result
   *  itself (toolkit/run/backgroundShellSink.ts HOST_RESULT_ACKNOWLEDGED). */
  resultAcknowledged?: boolean
  /** The SuperShell invocation whose script started this shell
   *  (toolkit/run/backgroundShellSink.ts HOST_SUPER_SHELL_TASK_ID). */
  superShellTaskId?: string
  /** Kill the child this long after it started and report it timed out — the
   *  finite timeout a forced-background leading `sleep` keeps. Absent = runs
   *  to completion. */
  killAfterMs?: number
  /** When the child started (re-adoption: the host's `startedMs`). */
  startedAt?: number
}

export type BackgroundShellRunState = {
  type: 'local_bash'
  taskId: string
  /** The persistent child's id. */
  shellId: string
  spawnerSessionId: string
  command: string
  params?: NexusShellInvokeParams
  /** Public task id of the SuperShell invocation that started this shell as
   *  one of its steps — the drawer lists it under that invocation, not Shell.
   *  Absent for every shell the model (or anything else) launched directly. */
  superShellTaskId?: string
  /** The host's log of the child — also the file the model may Read. */
  outputFilePath: string | null
  startedAt: number
  lastActivityAt: number
  output: string
  polls: number
  pollFailures: number
  lastPollError: string
  pollHandle: ReturnType<typeof setTimeout> | null
  /** True while a poll is awaiting the bridge — gates kickPoll/poll so only
   *  one poll chain exists per shell. Optional so test seeds
   *  need not carry it. */
  pollInFlight?: boolean
  /** Callers blocked in waitForCompletion: while any exists the poll keeps
   *  the normal cadence past the fast window, so a quiet command's exit is
   *  not left to the safety poll. Optional so test seeds need not carry it. */
  inlineWaiters?: number
  /** The finite-timeout kill timer (see BackgroundShellLaunch.killAfterMs). */
  deadlineHandle?: ReturnType<typeof setTimeout> | null
  /** The registry killed the child at its deadline: a timeout, not a Stop. */
  timedOut?: boolean
  /** Log size at the last read, so an unchanged log is not read again. */
  logSize?: number
  /** The raw log tail last read (ANSI intact) and whether it was cut. */
  logTail?: string
  logTailTruncated?: boolean
  finalized: boolean
}

export type FinishedBackgroundShellRecord = {
  type: 'local_bash'
  taskId: string
  shellId: string
  spawnerSessionId: string
  command: string
  params?: NexusShellInvokeParams
  /** See BackgroundShellRunState.superShellTaskId. */
  superShellTaskId?: string
  outputFilePath: string | null
  status: 'success' | 'error' | 'stopped'
  summary: string
  exitCode?: number | null
  startedAt: number
  finishedAt: number
}

export type BackgroundShellDeliveryResult = {
  type: 'local_bash'
  taskId: string
  shellId: string
  command: string
  outputFilePath: string | null
  status: 'success' | 'error'
  summary: string
}

export type BackgroundShellStopStatus =
  | 'stopped'
  | 'already_finished'
  | 'not_found'
  | 'stop_pending'
  | 'stop_failed'

export type SubAgentSnapshot = {
  sessionId: string
  status: 'running' | 'success' | 'error' | 'stopped'
  description: string
  taskType?: 'local_agent' | 'local_bash' | 'local_supershell'
  output: string
  exitCode?: number | null
  startedAt: number
  updates?: number
  lastActivityAt?: number
  agentType?: string
}

export type BackgroundShellPollResult =
  | { ok: true; result: ShellRunObservation }
  | { ok: false; terminal: boolean; message: string }

/** What `shell.spawn` is asked to run, in the shell form. */
export type PersistentShellSpawnSpec = {
  shell: 'bash' | 'sh' | 'pwsh' | 'powershell'
  command: string
  cwd?: string
  logPath: string
}

export type PersistentShellListResult =
  | { ok: true; shells: BridgeShellPersistentRecord[] }
  | { ok: false; terminal: boolean; message: string }

/** A log read. `text` absent = the log has not changed since `sinceSize`. */
export type ShellLogTail =
  | { ok: true; size: number; text?: string; truncated?: boolean }
  | { ok: false; message: string }

export type { BackgroundShellSpawnRequest }

// --- Dependency interfaces ---

export interface BackgroundShellBridge {
  hasTransport(): boolean
  /** The host lists shell.spawn.persist + persistentList + persistentKill. */
  supportsPersistentShells(): boolean
  /** Both the host port and its manifest are known, so
   *  `supportsPersistentShells` is an answer, not a not-yet. Absent = known. */
  knowsHost?(): boolean
  spawnPersistent(spec: PersistentShellSpawnSpec): Promise<{ persistentId: string }>
  listPersistent(): Promise<PersistentShellListResult>
  killPersistent(id: string): Promise<{ found: boolean; wasRunning: boolean } | null>
  readLogTail(path: string, maxBytes: number, sinceSize?: number): Promise<ShellLogTail>
}

export interface BackgroundShellHost {
  scheduleSummary(): void
  deliverResult(spawnerSessionId: string, result: BackgroundShellDeliveryResult): void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dropPendingResult(predicate: (r: any) => boolean): boolean
  getOutputPath(spawnerSessionId: string, taskId: string, providedPath?: string | null): string | null
  evictFinishedOverCap(
    kind: string,
    cap: number,
    onEvict?: (id: string) => void,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    filter?: (record: any) => boolean,
  ): void
}

// --- Constants ---

const SHELL_POLL_INTERVAL_MS = 1500
const SHELL_FOREGROUND_POLL_INTERVAL_MS = 150
const SHELL_FOREGROUND_POLL_WINDOW_MS = 12000
const SHELL_STOP_CONFIRM_INTERVAL_MS = 100
const SHELL_STOP_CONFIRM_TIMEOUT_MS = 5000
const SHELL_MAX_CONSECUTIVE_POLL_FAILURES = 3
const SHELL_SAFETY_POLL_INTERVAL_MS = 30000
const SHELL_ACTIVE_VIEW_WINDOW_MS = 5000
const MAX_FINISHED_BACKGROUND_SHELLS = 40
/** How much of a log's tail a snapshot / completion summary carries — the
 *  per-stream cap the C++ registry applied (process_tool.cc kMaxOutputBytes).
 *  The whole output stays in the file. */
export const SHELL_OUTPUT_TAIL_BYTES = 30_000
/** The host appends a child's last output on a separate sequence from the
 *  exit it records, so an exit seen this soon after `endedMs` waits this long
 *  before the final log read. */
export const SHELL_LOG_SETTLE_MS = 200
/** A deadline kill the host could not carry out is tried again this often,
 *  this many times. */
const SHELL_DEADLINE_KILL_RETRY_MS = 1000
const SHELL_DEADLINE_KILL_ATTEMPTS = 3

/** pwsh missing → Windows PowerShell (process_tool.cc OnPowerShellSpawnDone):
 *  only pre-launch resolution failures fall back. */
const POWERSHELL_FALLBACK_CODES = new Set(['BINARY_NOT_FOUND', 'COMMAND_NOT_ALLOWED'])

// --- Helpers ---

function monitorFailureSummary(message: string): string {
  return `Background shell monitor failed: ${message}`
}

/** The host's path-shape signal for a Windows host (utils/hostPathForm.ts). */
function isWindowsHostPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/**
 * The owner of a background-shell log, read back from its path
 * (`<…>/<sessionId>/tasks/<taskId>.output`, conversationStoragePaths.ts
 * taskLogFile). Null for any other persistent child of the profile.
 */
export function parseBackgroundShellLogPath(
  logPath: string,
): { spawnerSessionId: string; taskId: string } | null {
  const match = /[\\/]([^\\/]+)[\\/]tasks[\\/]([^\\/]+)\.output$/.exec(logPath)
  if (!match) return null
  const [, spawnerSessionId, taskId] = match
  if (!spawnerSessionId || !taskId || taskKindFromId(taskId) !== 'local_bash') return null
  return { spawnerSessionId, taskId }
}

/** The host's display command (`bash -c <cmd>`) back to what the model ran. */
function displayCommandOf(record: BridgeShellPersistentRecord): string {
  return record.command.replace(/^(?:bash|sh|pwsh|powershell) -c /, '')
}

export function runningShellToSnapshot(run: BackgroundShellRunState): SubAgentSnapshot {
  return {
    sessionId: run.taskId,
    status: 'running',
    description: run.command,
    taskType: 'local_bash',
    output: run.output,
    startedAt: run.startedAt,
    updates: run.polls,
    lastActivityAt: run.lastActivityAt,
  }
}

export function finishedShellToSnapshot(
  rec: FinishedBackgroundShellRecord,
): SubAgentSnapshot {
  return {
    sessionId: rec.taskId,
    status: rec.status,
    description: rec.command,
    taskType: 'local_bash',
    output: rec.summary,
    exitCode: rec.exitCode,
    startedAt: rec.startedAt,
  }
}

// --- Coordinator ---

export class BackgroundShellCoordinator {
  private readonly acknowledged = new Set<string>()
  /** Children this worker let go of (parent closed): never re-adopted. */
  private readonly released = new Set<string>()

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly registry: TaskRegistry<any, any>,
    private readonly bridge: BackgroundShellBridge,
    private readonly host: BackgroundShellHost,
  ) {}

  // --- Start ---

  /** The host serves the persistent-shell primitives this registry needs. */
  canSpawn(): boolean {
    return this.bridge.supportsPersistentShells()
  }

  /** `canSpawn` is settled (the port and manifest are known). */
  isSpawnKnown(): boolean {
    return this.bridge.knowsHost?.() ?? true
  }

  /**
   * Start a background command as a persistent child. Bash runs under git-bash
   * on a Windows host and `sh` elsewhere (process_tool.cc
   * BuildShellInvocation); PowerShell prefers pwsh and falls back to Windows
   * PowerShell when pwsh cannot be resolved. A refusal throws
   * `<CODE>: <message>`, the shape a hosted-tool rejection has.
   */
  async spawn(request: BackgroundShellSpawnRequest): Promise<{ shellId: string }> {
    const shells: PersistentShellSpawnSpec['shell'][] =
      request.tool === 'PowerShell'
        ? ['pwsh', 'powershell']
        : [isWindowsHostPath(request.cwd) ? 'bash' : 'sh']
    for (let i = 0; i < shells.length; i += 1) {
      try {
        const { persistentId } = await this.bridge.spawnPersistent({
          shell: shells[i]!,
          command: request.command,
          cwd: request.cwd,
          logPath: request.logPath,
        })
        // A list taken before this child existed must not answer for it.
        this.listCache = null
        return { shellId: persistentId }
      } catch (err) {
        const retry =
          i < shells.length - 1 &&
          err instanceof NativePrimitiveError &&
          POWERSHELL_FALLBACK_CODES.has(err.code)
        if (!retry) throw err instanceof Error ? err : new Error(String(err))
      }
    }
    // Unreachable: the last attempt either returned or threw.
    throw new Error('background shell spawn failed')
  }

  // --- Registration ---

  /** Children `adoptRunning` registered, not yet claimed by their launcher. */
  private readonly adoptedUnclaimed = new Set<string>()
  /** The `shell.persistentList` in flight, which every observation asking
   *  meanwhile shares: one host list, not one per shell. */
  private listCache: Promise<PersistentShellListResult> | null = null
  /** The ended record of a live child, from whichever list saw it first —
   *  the host keeps a bounded number of records and may evict an ended one
   *  before this child's own poll comes round. */
  private readonly exitsSeen = new Map<string, BridgeShellPersistentRecord>()

  register(launch: BackgroundShellLaunch): void {
    const { shellId, command, spawnerSessionId, outputFilePath, params } = launch
    if (!shellId) return
    const existing = this.registry.getLiveByType(shellId, 'local_bash') as
      | BackgroundShellRunState | undefined
    if (existing) {
      // Adoption can run between a launcher's spawn and its register (a port
      // swap or a manifest arriving mid-call): the launcher's terms win.
      if (this.adoptedUnclaimed.delete(shellId)) this.claimAdopted(existing, launch)
      return
    }

    const taskId = launch.taskId ?? shellId
    // Defense-in-depth: drop a stale terminal record under the same id.
    const stale = this.registry.getFinishedByType(shellId, 'local_bash') as
      | { taskId: string } | undefined
    if (stale) {
      this.registry.removeTaskIdIndex(stale.taskId)
      this.registry.deleteFinished(shellId)
      this.acknowledged.delete(shellId)
      this.host.dropPendingResult(
        (r) => r.type === 'local_bash' && r.shellId === shellId,
      )
    }

    // Every launcher names its session (`context.options.sessionId`); there is no
    // "current session" to adopt an orphan.
    const ownerSessionId = spawnerSessionId ?? ''
    const now = Date.now()
    const startedAt = launch.startedAt ?? now
    const outputPath = this.host.getOutputPath(ownerSessionId, taskId, outputFilePath)
    const run: BackgroundShellRunState = {
      type: 'local_bash',
      taskId,
      shellId,
      spawnerSessionId: ownerSessionId,
      command,
      params,
      ...(launch.superShellTaskId ? { superShellTaskId: launch.superShellTaskId } : {}),
      outputFilePath: outputPath,
      startedAt,
      lastActivityAt: now,
      output: '',
      polls: 0,
      pollFailures: 0,
      lastPollError: '',
      pollHandle: null,
      finalized: false,
    }
    this.registry.registerLive(shellId, run)
    this.registry.indexTaskId(taskId, shellId)
    // A nested caller that awaits the result itself (SuperShell): acknowledged
    // from the first moment the task exists, so no completion can slip out as
    // a <task-notification> before the caller acknowledges it.
    if (launch.resultAcknowledged) this.acknowledged.add(shellId)
    this.armDeadline(run, launch.killAfterMs)
    this.host.scheduleSummary()
    this.schedulePoll(run, 0)
  }

  private armDeadline(run: BackgroundShellRunState, killAfterMs: number | undefined): void {
    if (typeof killAfterMs !== 'number' || !Number.isFinite(killAfterMs)) return
    const delay = Math.max(0, run.startedAt + killAfterMs - Date.now())
    run.deadlineHandle = setTimeout(() => {
      run.deadlineHandle = null
      void this.killAtDeadline(run.shellId)
    }, delay)
  }

  /** An adopted row taken over by the launcher that started it: its
   *  delivery, deadline and SuperShell link are the launcher's. */
  private claimAdopted(run: BackgroundShellRunState, launch: BackgroundShellLaunch): void {
    run.command = launch.command
    if (launch.params) run.params = launch.params
    if (launch.superShellTaskId) run.superShellTaskId = launch.superShellTaskId
    if (!launch.resultAcknowledged) this.acknowledged.delete(run.shellId)
    if (!run.deadlineHandle) this.armDeadline(run, launch.killAfterMs)
    this.host.scheduleSummary()
  }

  /** `shell.persistentList`, shared by the observations that ask while it is
   *  in flight (never reused once answered: a child may end the next moment);
   *  every answer records the ends of live children. */
  private listShells(): Promise<PersistentShellListResult> {
    if (this.listCache) return this.listCache
    const result = this.bridge.listPersistent().then(list => {
      if (list.ok) {
        for (const record of list.shells) {
          if (!record.running && this.registry.getLiveByType(record.id, 'local_bash')) {
            this.exitsSeen.set(record.id, record)
          }
        }
      }
      return list
    })
    this.listCache = result
    const clear = () => {
      if (this.listCache === result) this.listCache = null
    }
    result.then(clear, clear)
    return result
  }

  /**
   * Re-adopt running children of this profile, under a session's task-output dir, that this registry
   * does not track; each returns as a live, acknowledged row. Ended children are left to transcript
   * recovery. Returns how many were adopted.
   */
  async adoptRunning(): Promise<number> {
    if (!this.bridge.hasTransport()) return 0
    const list = await this.listShells()
    if (!list.ok) return 0
    let adopted = 0
    for (const record of list.shells) {
      if (!record.running || this.released.has(record.id)) continue
      if (
        this.registry.getLiveByType(record.id, 'local_bash') ||
        this.registry.getFinishedByType(record.id, 'local_bash')
      ) {
        continue
      }
      const owner = parseBackgroundShellLogPath(record.logPath)
      if (!owner || this.registry.hasTaskIdIndex(owner.taskId)) continue
      this.register({
        shellId: record.id,
        taskId: owner.taskId,
        spawnerSessionId: owner.spawnerSessionId,
        command: displayCommandOf(record),
        outputFilePath: record.logPath,
        resultAcknowledged: true,
        startedAt: record.startedMs,
      })
      this.adoptedUnclaimed.add(record.id)
      adopted += 1
    }
    return adopted
  }

  // --- Observation ---

  /** Re-read the log when it grew. Best-effort: a failed read keeps the last. */
  private async refreshLog(run: BackgroundShellRunState): Promise<void> {
    if (!run.outputFilePath) return
    const tail = await this.bridge.readLogTail(
      run.outputFilePath,
      SHELL_OUTPUT_TAIL_BYTES,
      run.logSize,
    )
    if (!tail.ok) return
    run.logSize = tail.size
    if (tail.text !== undefined) {
      run.logTail = tail.text
      run.logTailTruncated = tail.truncated ?? false
    }
  }

  /** One observation: the child's record + its log tail. */
  private async observe(run: BackgroundShellRunState): Promise<BackgroundShellPollResult> {
    const list = await this.listShells()
    if (!list.ok) return list
    const record = list.shells.find(r => r.id === run.shellId) ?? this.exitsSeen.get(run.shellId)
    if (record && !record.running && typeof record.endedMs === 'number') {
      const sinceEnd = Date.now() - record.endedMs
      if (sinceEnd >= 0 && sinceEnd < SHELL_LOG_SETTLE_MS) {
        await new Promise(resolve => setTimeout(resolve, SHELL_LOG_SETTLE_MS - sinceEnd))
      }
    }
    await this.refreshLog(run)
    const base = {
      stdout: run.logTail ?? '',
      stderr: '',
      stdoutTruncated: run.logTailTruncated ?? false,
      stderrTruncated: false,
    }
    if (!record) {
      return { ok: true, result: { found: false, running: false, ...base } }
    }
    if (record.running) {
      return { ok: true, result: { found: true, running: true, ...base } }
    }
    // A killed child reports no exit code, as the C++ registry did: the code
    // the host records for a terminated job (1 on Windows) is the kill's
    // mechanics, and the foreground result reads "no code" as -1. The
    // deadline counts only when the host's record says the kill landed: a
    // child that exited on its own just before is reported as it exited.
    const killed = Boolean(record.killed)
    const deadlineKilled = killed && Boolean(run.timedOut)
    return {
      ok: true,
      result: {
        found: true,
        running: false,
        ...base,
        ...(!killed && typeof record.exitCode === 'number' ? { exitCode: record.exitCode } : {}),
        ...(typeof record.signal === 'number' ? { signal: record.signal } : {}),
        timedOut: Boolean(record.timedOut) || deadlineKilled,
        killed: Boolean(record.killed),
        ...(typeof record.durationMs === 'number' ? { durationMs: record.durationMs } : {}),
      },
    }
  }

  // --- Polling ---

  private schedulePoll(run: BackgroundShellRunState, delayMs: number): void {
    if (run.finalized) return
    run.pollHandle = setTimeout(() => {
      run.pollHandle = null
      void this.poll(run.shellId)
    }, delayMs)
  }

  private nextPollDelay(run: BackgroundShellRunState): number {
    if (Date.now() - run.startedAt < SHELL_FOREGROUND_POLL_WINDOW_MS) {
      return SHELL_FOREGROUND_POLL_INTERVAL_MS
    }
    if (
      (run.inlineWaiters ?? 0) > 0 ||
      Date.now() - run.lastActivityAt < SHELL_ACTIVE_VIEW_WINDOW_MS
    ) {
      return SHELL_POLL_INTERVAL_MS
    }
    return SHELL_SAFETY_POLL_INTERVAL_MS
  }

  private async poll(shellId: string): Promise<void> {
    const run = this.registry.getLiveByType(shellId, 'local_bash') as
      | BackgroundShellRunState | undefined
    if (!run || run.finalized) return
    // One poll chain per shell. A kickPoll that lands while a
    // poll is awaiting the bridge must not start a second interleaved loop
    // (each would keep rescheduling its own successor forever).
    if (run.pollInFlight) return
    run.pollInFlight = true
    try {
      await this.pollLocked(run, shellId)
    } finally {
      run.pollInFlight = false
    }
  }

  private async pollLocked(
    run: BackgroundShellRunState,
    shellId: string,
  ): Promise<void> {
    if (!this.bridge.hasTransport()) {
      this.schedulePoll(run, SHELL_POLL_INTERVAL_MS)
      return
    }

    const status = await this.observe(run)
    const live = this.registry.getLiveByType(shellId, 'local_bash') as
      | BackgroundShellRunState | undefined
    if (!live || live.finalized) return

    if (!status.ok) {
      live.pollFailures += 1
      live.lastPollError = status.message
      live.lastActivityAt = Date.now()
      if (status.terminal || live.pollFailures >= SHELL_MAX_CONSECUTIVE_POLL_FAILURES) {
        this.finalize(shellId, 'error', monitorFailureSummary(status.message))
        return
      }
      this.host.scheduleSummary()
      this.schedulePoll(live, this.nextPollDelay(live))
      return
    }

    const result = status.result
    live.pollFailures = 0
    live.lastPollError = ''
    live.polls += 1
    const combined = joinShellOutput(result)
    // Bump liveness only on FRESH OUTPUT (or a drawer view via
    // kickPoll) — bumping on every poll made `nextPollDelay`'s 30s safety
    // cadence unreachable: each 1.5s poll re-armed the 5s active window, so
    // every running shell polled at 1.5s forever no matter how quiet.
    if (combined && combined !== live.output) {
      live.output = combined
      live.lastActivityAt = Date.now()
    }

    if (!result.found) {
      // No record and no end seen: the host dropped it (idle-recycled, or
      // evicted once ended) before any list saw how it ended.
      this.finalize(shellId, 'error',
        live.output || 'Background shell record is gone; how it ended is unknown (evicted or idle-recycled).')
      return
    }
    if (!result.running) {
      this.finalize(shellId, classifyShellExit(result), formatShellSummary(result), result.exitCode)
      return
    }
    this.host.scheduleSummary()
    this.schedulePoll(live, this.nextPollDelay(live))
  }

  /** The finite timeout ran out: kill, and let the poll report a timeout.
   *  A child that had already exited is not a timeout; a kill the host
   *  could not carry out is tried again. */
  private async killAtDeadline(shellId: string, attempt = 1): Promise<void> {
    const run = this.registry.getLiveByType(shellId, 'local_bash') as
      | BackgroundShellRunState | undefined
    if (!run || run.finalized) return
    // Set before the kill: a poll answering meanwhile still reads the kill's
    // record as a timeout (observe counts it only when the record is killed).
    run.timedOut = true
    const result = await this.bridge.killPersistent(shellId)
    this.listCache = null
    if (run.finalized) return
    if (!result?.wasRunning) run.timedOut = false
    if (result === null && attempt < SHELL_DEADLINE_KILL_ATTEMPTS) {
      run.deadlineHandle = setTimeout(() => {
        run.deadlineHandle = null
        void this.killAtDeadline(shellId, attempt + 1)
      }, SHELL_DEADLINE_KILL_RETRY_MS)
    }
    this.kickPoll(shellId)
  }

  // --- Finalize ---

  private clearTimers(run: BackgroundShellRunState): void {
    if (run.pollHandle !== null) {
      clearTimeout(run.pollHandle)
      run.pollHandle = null
    }
    if (run.deadlineHandle) {
      clearTimeout(run.deadlineHandle)
      run.deadlineHandle = null
    }
  }

  private finalize(
    shellId: string,
    status: 'success' | 'error' | 'stopped',
    summary: string,
    exitCode?: number | null,
  ): void {
    const run = this.registry.getLiveByType(shellId, 'local_bash') as
      | BackgroundShellRunState | undefined
    if (!run) return
    run.finalized = true
    this.clearTimers(run)
    this.registry.deleteLive(shellId)
    this.exitsSeen.delete(shellId)
    this.adoptedUnclaimed.delete(shellId)

    const record: FinishedBackgroundShellRecord = {
      type: 'local_bash',
      taskId: run.taskId,
      shellId,
      spawnerSessionId: run.spawnerSessionId,
      command: run.command,
      params: run.params,
      ...(run.superShellTaskId ? { superShellTaskId: run.superShellTaskId } : {}),
      outputFilePath: run.outputFilePath,
      status,
      summary,
      exitCode,
      startedAt: run.startedAt,
      finishedAt: Date.now(),
    }
    this.registry.recordFinished(shellId, record)
    // SuperShell steps and the shells the model ran itself are capped apart: a
    // script's many steps must not evict the model's own shells.
    const isStep = (r: { superShellTaskId?: string }): boolean => Boolean(r.superShellTaskId)
    this.host.evictFinishedOverCap(
      'local_bash',
      MAX_FINISHED_BACKGROUND_SHELLS,
      id => this.acknowledged.delete(id),
      record.superShellTaskId ? isStep : r => !isStep(r),
    )
    this.host.scheduleSummary()

    if (status !== 'stopped' && !this.acknowledged.has(shellId)) {
      this.host.deliverResult(run.spawnerSessionId, {
        type: 'local_bash',
        taskId: run.taskId,
        shellId,
        command: run.command,
        outputFilePath: run.outputFilePath,
        status: status as 'success' | 'error',
        summary,
      })
    }
    this.acknowledged.delete(shellId)
  }

  // --- Stop ---

  async stop(shellId: string): Promise<BackgroundShellStopStatus> {
    const run = this.registry.getLiveByType(shellId, 'local_bash') as
      | BackgroundShellRunState | undefined
    if (!run) {
      return this.registry.getFinishedByType(shellId, 'local_bash')
        ? 'already_finished'
        : 'not_found'
    }

    if (!this.bridge.hasTransport()) return 'stop_failed'

    const killResult = await this.bridge.killPersistent(shellId)
    this.listCache = null
    if (!killResult) return 'stop_failed'
    if (!killResult.found) return 'not_found'

    // Racing poll may have finalized while we awaited the kill.
    if (!this.registry.getLiveByType(shellId, 'local_bash')) {
      const fin = this.registry.getFinishedByType(shellId, 'local_bash') as
        | { status: string } | undefined
      return fin ? (fin.status === 'stopped' ? 'stopped' : 'already_finished') : 'not_found'
    }

    if (!killResult.wasRunning) {
      const status = await this.observe(run)
      if (!status.ok) return 'stop_failed'
      if (!status.result.found) return 'not_found'
      if (!status.result.running) {
        this.finalize(shellId, classifyShellExit(status.result),
          formatShellSummary(status.result), status.result.exitCode)
        const fin = this.registry.getFinishedByType(shellId, 'local_bash') as
          | { status: string } | undefined
        return fin?.status === 'stopped' ? 'stopped' : 'already_finished'
      }
      return 'stop_failed'
    }

    const terminal = await this.waitForTerminal(run, SHELL_STOP_CONFIRM_TIMEOUT_MS)
    if (!this.registry.getLiveByType(shellId, 'local_bash')) {
      const fin = this.registry.getFinishedByType(shellId, 'local_bash') as
        | { status: string } | undefined
      return fin ? (fin.status === 'stopped' ? 'stopped' : 'already_finished') : 'not_found'
    }
    if (!terminal || terminal.running) return 'stop_pending'
    if (!terminal.found) return 'not_found'

    if (terminal.killed && !terminal.timedOut) {
      this.finalize(shellId, 'stopped',
        joinShellOutput(terminal) || run.output || 'Stopped by request.', terminal.exitCode)
      return 'stopped'
    }

    this.finalize(shellId, classifyShellExit(terminal),
      formatShellSummary(terminal), terminal.exitCode)
    const fin = this.registry.getFinishedByType(shellId, 'local_bash') as
      | { status: string } | undefined
    return fin?.status === 'stopped' ? 'stopped' : 'already_finished'
  }

  private async waitForTerminal(
    run: BackgroundShellRunState,
    timeoutMs: number,
  ): Promise<ShellRunObservation | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() <= deadline) {
      const status = await this.observe(run)
      if (!status.ok) return null
      if (!status.result.found || !status.result.running) return status.result
      await new Promise(resolve => setTimeout(resolve, SHELL_STOP_CONFIRM_INTERVAL_MS))
    }
    const status = await this.observe(run)
    return status.ok ? status.result : null
  }

  /** Fire-and-forget kill — used by parent-close cascade. */
  killBestEffort(shellId: string): void {
    void this.bridge.killPersistent(shellId).catch(() => {})
  }

  /** Expose finalize for tests that need to clean up dangling poll timers. */
  finalizeForTest(
    shellId: string,
    status: 'success' | 'error' | 'stopped',
    summary: string,
    exitCode?: number | null,
  ): void {
    this.finalize(shellId, status, summary, exitCode)
  }

  // --- Acknowledge ---

  acknowledgeResult(shellId: string): void {
    const removedPending = this.host.dropPendingResult(
      (r) => r.type === 'local_bash' && r.shellId === shellId,
    )
    if (!removedPending && this.registry.getLiveByType(shellId, 'local_bash')) {
      this.acknowledged.add(shellId)
    }
  }

  // --- Queries ---

  getSnapshot(shellId: string): SubAgentSnapshot | null {
    const run = this.registry.getLiveByType(shellId, 'local_bash') as
      | BackgroundShellRunState | undefined
    if (run) return runningShellToSnapshot(run)
    const rec = this.registry.getFinishedByType(shellId, 'local_bash') as
      | FinishedBackgroundShellRecord | undefined
    if (rec) return finishedShellToSnapshot(rec)
    return null
  }

  // --- Wait ---

  waitForCompletion(
    shellId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<SubAgentSnapshot | null> {
    const initial = this.getSnapshot(shellId)
    if (!initial) return Promise.resolve(null)
    if (initial.status !== 'running') return Promise.resolve(initial)
    if (signal?.aborted) {
      void this.stop(shellId)
      return Promise.resolve(this.getSnapshot(shellId))
    }
    const run = this.registry.getLiveByType(shellId, 'local_bash') as
      | BackgroundShellRunState | undefined
    if (run) {
      run.inlineWaiters = (run.inlineWaiters ?? 0) + 1
      // A poll already parked on the safety cadence would otherwise report
      // this exit up to 30s late.
      if (run.pollHandle !== null && !run.pollInFlight) {
        clearTimeout(run.pollHandle)
        this.schedulePoll(run, SHELL_POLL_INTERVAL_MS)
      }
    }
    return new Promise((resolve) => {
      let settled = false
      const finish = (snap: SubAgentSnapshot | null): void => {
        if (settled) return
        settled = true
        if (run) run.inlineWaiters = Math.max(0, (run.inlineWaiters ?? 0) - 1)
        clearInterval(poll)
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(snap)
      }
      const onAbort = (): void => {
        void this.stop(shellId)
        finish(this.getSnapshot(shellId))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const poll = setInterval(() => {
        const snap = this.getSnapshot(shellId)
        if (!snap) finish(null)
        else if (snap.status !== 'running') finish(snap)
      }, 200)
      const timer = setTimeout(() => finish(this.getSnapshot(shellId)), timeoutMs)
    })
  }

  // --- Cascade ---

  /**
   * Kick an immediate poll for an actively-viewed shell (bumps liveness +
   * resets the poll timer to fetch fresh output now).
   */
  kickPoll(shellId: string): void {
    const run = this.registry.getLiveByType(shellId, 'local_bash') as
      | BackgroundShellRunState | undefined
    if (!run || run.finalized) return
    run.lastActivityAt = Date.now()
    // Mid-flight poll: fresh output is already being fetched,
    // and the bumped activity above makes ITS reschedule pick the fast
    // cadence — starting a second chain here would leave two interleaved
    // poll loops running forever.
    if (run.pollInFlight) return
    if (run.pollHandle !== null) {
      clearTimeout(run.pollHandle)
      run.pollHandle = null
    }
    this.schedulePoll(run, 0)
  }

  stopChildren(spawnerSessionId: string): void {
    for (const run of this.registry.liveByType('local_bash') as IterableIterator<BackgroundShellRunState>) {
      if (run.spawnerSessionId === spawnerSessionId) {
        this.killBestEffort(run.shellId)
        this.released.add(run.shellId)
        this.clearTimers(run)
        run.finalized = true
        this.registry.deleteLive(run.shellId)
        this.registry.removeTaskIdIndex(run.taskId)
        this.acknowledged.delete(run.shellId)
      }
    }
    // Drop retained terminal records for the closed parent (dead weight that
    // would otherwise ride the summary tail until FIFO eviction).
    for (const rec of this.registry.finishedByType('local_bash') as IterableIterator<FinishedBackgroundShellRecord>) {
      if (rec.spawnerSessionId === spawnerSessionId) {
        this.registry.deleteFinished(rec.shellId)
        this.registry.removeTaskIdIndex(rec.taskId)
        this.acknowledged.delete(rec.shellId)
      }
    }
  }

  // --- Lifecycle ---

  dispose(): void {
    for (const run of this.registry.liveByType('local_bash') as IterableIterator<BackgroundShellRunState>) {
      this.clearTimers(run)
    }
  }
}

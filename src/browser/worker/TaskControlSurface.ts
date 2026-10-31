import { processFs, type RuntimeFs } from '../../utils/fs/runtimeFs'
import type { BrowserConversationStorageBackend } from '../../sessions/sessionStore'
import type {
  NexusTaskInfo,
  NexusTaskTranscriptEntry,
} from '../bridge/protocol/ui'
import type {
  SubAgentListEntry,
  SubAgentResumeResult,
  SubAgentSnapshot,
  SubAgentStopResult,
} from '../../team/subAgentController'
import type { SharedWorkerInboundMessage } from './sharedWorkerProtocol'
import type {
  BackgroundShellCoordinator,
  BackgroundShellRunState,
  FinishedBackgroundShellRecord,
} from './BackgroundShellCoordinator'
import {
  finishedShellToSnapshot,
  runningShellToSnapshot,
} from './BackgroundShellCoordinator'
import type { RoutineCoordinator } from './RoutineCoordinator'
import type { SideTaskCoordinator } from './SideTaskCoordinator'
import type { SubAgentCoordinator } from './SubAgentCoordinator'
import type { SuperShellTaskCoordinator } from './SuperShellTaskCoordinator'
import type { TaskDeliveryQueue } from './TaskDeliveryQueue'
import type { TaskRegistry } from './TaskRegistry'
import { SESSION_TITLE_QUERY_SOURCE } from './recoverTitleRows'
import {
  extractFinalAssistantText,
  fastCallDisplayLabel,
  finishedRecordToSnapshot,
  projectSubAgentTranscript,
} from './taskProjection'
import type {
  FinishedFastCallRecord,
  FinishedForkRecord,
  FinishedRoutineRecord,
  FinishedRunJsRecord,
  FinishedSubAgentRecord,
  FastCallRunState,
  ForkRunState,
  NexusFinishedTaskRecord,
  NexusTaskDeliveryResult,
  NexusTaskState,
  RunJsRunState,
  SubAgentRunState,
} from './taskTypes'
type TaskStopStatus =
  | 'stopped'
  | 'not_found'
  | 'already_finished'
  | 'stop_failed'
  | 'stop_pending'

/** `SubAgentStopResult` widened with the outcomes only an AWAITED background
 *  shell kill can report (`stop_failed`, `stop_pending`). */
export type TaskStopResult = {
  status: TaskStopStatus
  /** The task label, when the id resolved. */
  description?: string
}

/** The run_js source + result recovered from the persisted tool-detail sidecar,
 *  for the drawer detail of a run_js whose live task-registry record is gone
 *  (session reloaded). Field shape mirrors `FinishedRunJsRecord` so
 *  `loadInfoWithOutput` builds the same `local_js` NexusTaskInfo either way. */
export interface RunJsSidecarDetail {
  code: string
  description?: string
  path?: string
  /** The run's `inputs` data values, recovered from the sidecar's full args
   *  so the payload stays reviewable across restarts. */
  inputs?: Record<string, unknown>
  timeoutSec?: number
  inlineCode: boolean
  resultText?: string
}

/** A SuperShell call's script + inputs + result recovered from its persisted
 *  tool-detail sidecar — the `RunJsSidecarDetail` sibling, for the drawer detail
 *  of an invocation whose registry record is gone (session reloaded). */
export interface SuperShellSidecarDetail {
  code: string
  description?: string
  inputs?: Record<string, unknown>
  /** The tool result the call returned. For a run that continued in the
   *  background that is the hand-off with its progress at that point, unless
   *  restart recovery found the run's own result, which is given instead. */
  resultText?: string
}

export interface TaskControlSurfaceHost {
  /**
   * The fs a background shell's output file is written through, so the drawer reads through the same
   * one (not the shared process slot). Optional; absent → the process slot.
   */
  getFs?(): RuntimeFs
  getStorage():
    | Pick<BrowserConversationStorageBackend, 'load'>
    | null
  dropSessionRouting(sessionId: string): void
  scheduleSummary(): void
  /** Load the CURRENT session's persisted run_js tool-detail sidecar by tool
   *  call id (the run_js public task id IS its tool call id). Null when the
   *  sidecar is absent or is not a run_js call. Used only as the drawer's
   *  reload fallback — a live/finished run_js is served from the registry. */
  loadRunJsSidecar?(toolCallId: string): Promise<RunJsSidecarDetail | null>
  /** Load a SuperShell call's persisted tool-detail sidecar by tool call id —
   *  the id its conversation card jumps with. Null when the sidecar is absent or
   *  is not a SuperShell call. Only the drawer's reload fallback: a live/finished
   *  invocation is served from the registry. */
  loadSuperShellSidecar?(toolCallId: string): Promise<SuperShellSidecarDetail | null>
  /** The drawer's detail fallback for a background shell whose live/finished
   *  registry record is gone (session reloaded after an app restart). Resolves
   *  the transcript-recovered row by public task id → its command + output-file
   *  path, so `loadInfoWithOutput` can read the persisted log lazily. Null when
   *  no recovered row matches. */
  loadRecoveredShell?(
    taskId: string,
  ): { command?: string; outputFilePath?: string; detailId?: string } | null
  /** The output of a recovered shell whose transcript kept only the
   *  `{ shell_id, status }` handle (the real foreground-shell shape — no inline
   *  `output_file`). Resolves the shell's tool-detail sidecar by tool-call id
   *  (`RecoveredBashRow.detailId`) to a streamed `output_file` path or a quick
   *  shell's inline `output` text. Null when the sidecar is absent/not a shell. */
  loadRecoveredShellDetail?(
    toolCallId: string,
  ): Promise<{ outputFilePath?: string; outputText?: string } | null>
  /** The drawer's detail fallback for a session-title namer row recovered
   *  from the transcript after an app restart: the title the call stored.
   *  Null when no recovered row matches. */
  loadRecoveredTitle?(taskId: string): { title: string } | null
}

/**
 * Owns public-id resolution and the per-operation task-kind dispatch policy.
 *
 * TaskOutput/TaskStop model tools intentionally support only agent + shell
 * tasks. Drawer operations are broader: fork and routine
 * rows can be stopped, and every retained terminal kind answers
 * `already_finished`.
 */
export class TaskControlSurface {
  constructor(
    private readonly taskRegistry: TaskRegistry<
      NexusTaskState,
      NexusFinishedTaskRecord
    >,
    private readonly subAgents: SubAgentCoordinator,
    private readonly shells: BackgroundShellCoordinator,
    private readonly sideTasks: SideTaskCoordinator,
    private readonly routines: RoutineCoordinator,
    private readonly taskDelivery: TaskDeliveryQueue<NexusTaskDeliveryResult>,
    private readonly host: TaskControlSurfaceHost,
    /** SuperShell invocations (`local_supershell`). Optional so hosts that
     *  never run SuperShell (tests, older wiring) need not supply it. */
    private readonly superShells?: SuperShellTaskCoordinator,
  ) {}

  async loadTranscript(
    publicId: string,
  ): Promise<NexusTaskTranscriptEntry[] | null> {
    const id = this.resolveNative(publicId)
    const agent = this.liveAgent(id)
    if (agent) {
      return projectSubAgentTranscript(agent.messages)
    }
    const finishedAgent = this.finishedAgent(id)
    if (finishedAgent?.transcript) {
      return finishedAgent.transcript
    }
    const fork = this.liveFork(id)
    if (fork) {
      return projectSubAgentTranscript(fork.messages)
    }
    const finishedFork = this.finishedFork(id)
    if (finishedFork?.transcript) {
      return finishedFork.transcript
    }
    if (this.liveFastCall(id) || this.finishedFastCall(id)) {
      return []
    }
    if (this.liveRunJs(id) || this.finishedRunJs(id)) {
      // run_js has no conversation transcript — its detail is the params + JS
      // source + result carried on NexusTaskInfo (see loadInfo).
      return []
    }
    if (this.superShells?.owns(id)) {
      // Nor does a SuperShell invocation: script, inputs and progress/result.
      return []
    }
    const routine = this.routines.get(id)
    if (routine) {
      return projectSubAgentTranscript(routine.messages)
    }
    const finishedRoutine = this.finishedRoutine(id)
    if (finishedRoutine?.transcript) {
      return finishedRoutine.transcript
    }

    const storage = this.host.getStorage()
    if (!storage) {
      return null
    }
    try {
      const payload = await storage.load(id)
      if (!payload) {
        return null
      }
      const messages = Array.isArray(payload) ? payload : payload.messages
      return Array.isArray(messages)
        ? projectSubAgentTranscript(messages)
        : null
    } catch {
      return null
    }
  }

  loadInfo(publicId: string): NexusTaskInfo | null {
    const id = this.resolveNative(publicId)
    const agent = this.liveAgent(id)
    if (agent) {
      return {
        type: 'local_agent',
        model: agent.effectiveModel,
        effort: agent.effort,
        task: agent.prompt || undefined,
        systemPrompt: agent.systemPrompt || undefined,
        summary: extractFinalAssistantText(agent.messages) || undefined,
      }
    }
    const finishedAgent = this.finishedAgent(id)
    if (finishedAgent) {
      return {
        type: 'local_agent',
        model: finishedAgent.effectiveModel,
        effort: finishedAgent.effort,
        task: finishedAgent.prompt || undefined,
        systemPrompt: finishedAgent.systemPrompt || undefined,
        summary: finishedAgent.summary || undefined,
      }
    }
    const shell = this.liveShell(id)
    if (shell) {
      return {
        type: 'local_bash',
        task: shell.command,
        summary: shell.output || undefined,
        outputFilePath: shell.outputFilePath ?? undefined,
        shellParams: shell.params,
      }
    }
    const finishedShell = this.finishedShell(id)
    if (finishedShell) {
      return {
        type: 'local_bash',
        task: finishedShell.command,
        summary: finishedShell.summary || undefined,
        outputFilePath: finishedShell.outputFilePath ?? undefined,
        shellParams: finishedShell.params,
      }
    }
    const fork = this.liveFork(id)
    if (fork) {
      return {
        type: 'local_fork',
        model: fork.model,
        task: fork.prompt || fork.description,
        systemPrompt: fork.systemPrompt || undefined,
        summary: extractFinalAssistantText(fork.messages) || undefined,
      }
    }
    const finishedFork = this.finishedFork(id)
    if (finishedFork) {
      return {
        type: 'local_fork',
        model: finishedFork.model,
        task: finishedFork.prompt || finishedFork.description,
        systemPrompt: finishedFork.systemPrompt || undefined,
        summary: finishedFork.summary || undefined,
      }
    }
    const fast = this.liveFastCall(id)
    if (fast) {
      return {
        type: 'local_fast',
        model: fast.model,
        task: fast.prompt || fast.description,
        systemPrompt: fast.systemPrompt || undefined,
      }
    }
    const finishedFast = this.finishedFastCall(id)
    if (finishedFast) {
      return {
        type: 'local_fast',
        model: finishedFast.model,
        task: finishedFast.prompt || finishedFast.description,
        systemPrompt: finishedFast.systemPrompt || undefined,
        summary: finishedFast.summary || undefined,
        outputText: finishedFast.responseText,
      }
    }
    const recoveredTitle = this.host.loadRecoveredTitle?.(id)
    if (recoveredTitle) {
      return {
        type: 'local_fast',
        task: fastCallDisplayLabel(SESSION_TITLE_QUERY_SOURCE),
        outputText: recoveredTitle.title,
      }
    }
    const superShellInfo = this.superShells?.loadInfo(id)
    if (superShellInfo) {
      return superShellInfo
    }
    const runJs = this.liveRunJs(id)
    if (runJs) {
      return {
        type: 'local_js',
        jsSource: runJs.code,
        jsParams: {
          description: runJs.description,
          path: runJs.path,
          timeoutSec: runJs.timeoutSec,
          inlineCode: runJs.inlineCode,
          inputs: runJs.inputs,
        },
      }
    }
    const finishedRunJs = this.finishedRunJs(id)
    if (finishedRunJs) {
      return {
        type: 'local_js',
        jsSource: finishedRunJs.code,
        jsParams: {
          description: finishedRunJs.description,
          path: finishedRunJs.path,
          timeoutSec: finishedRunJs.timeoutSec,
          inlineCode: finishedRunJs.inlineCode,
          inputs: finishedRunJs.inputs,
        },
        outputText: finishedRunJs.resultText || undefined,
      }
    }
    const routine = this.routines.get(id)
    if (routine) {
      return {
        type: 'local_routine',
        model: routine.model,
        task: routine.prompt || routine.description,
        summary: extractFinalAssistantText(routine.messages) || undefined,
      }
    }
    const finishedRoutine = this.finishedRoutine(id)
    if (finishedRoutine) {
      return {
        type: 'local_routine',
        model: finishedRoutine.model,
        task: finishedRoutine.prompt || finishedRoutine.description,
        summary: finishedRoutine.summary || undefined,
      }
    }
    return null
  }

  private outputFs(): RuntimeFs {
    return this.host.getFs?.() ?? processFs()
  }

  async loadInfoWithOutput(publicId: string): Promise<NexusTaskInfo | null> {
    const info = this.loadInfo(publicId)
    if (info?.outputFilePath) {
      try {
        const text = await this.outputFs().readFile(info.outputFilePath, {
          encoding: 'utf-8',
        })
        return text ? { ...info, outputText: text } : info
      } catch {
        return info
      }
    }
    if (info) {
      return info
    }
    // No live/finished registry record — a background shell from a reloaded
    // session (the in-memory shell registry only holds this worker lifetime's
    // runs). Its command + output-file path were recovered from the transcript;
    // build the local_bash detail and read the persisted log file lazily, so
    // the drawer shows the shell's output after an app restart. The process is
    // long dead — this is read-only history.
    const shell = this.host.loadRecoveredShell?.(publicId)
    if (shell) {
      let outputFilePath = shell.outputFilePath
      let inlineOutput: string | undefined
      // The real foreground-shell shape kept only `{ shell_id, status }` — no
      // inline output_file. Resolve the streamed log path (or a quick shell's
      // inline output) from the tool-detail sidecar by detailId, lazily.
      if (!outputFilePath && shell.detailId) {
        const sidecar = await this.host.loadRecoveredShellDetail?.(
          shell.detailId,
        )
        if (sidecar) {
          outputFilePath = sidecar.outputFilePath
          inlineOutput = sidecar.outputText
        }
      }
      const shellInfo: NexusTaskInfo = {
        type: 'local_bash',
        task: shell.command,
        outputFilePath,
      }
      if (outputFilePath) {
        try {
          const text = await this.outputFs().readFile(outputFilePath, {
            encoding: 'utf-8',
          })
          if (text) return { ...shellInfo, outputText: text }
        } catch {
          // best-effort — a missing/rotated output file just yields no log
        }
      }
      if (inlineOutput) return { ...shellInfo, outputText: inlineOutput }
      return shellInfo
    }
    // No live/finished registry record — a run_js from a reloaded session (the
    // in-memory registry only holds runs from the current worker lifetime). Its
    // source + result live in the persisted tool-detail sidecar, keyed by the
    // tool call id, which IS the run_js public task id. Recover the drawer
    // detail from there so the jump works across restarts.
    const sidecar = await this.host.loadRunJsSidecar?.(publicId)
    if (sidecar) {
      return {
        type: 'local_js',
        jsSource: sidecar.code,
        jsParams: {
          description: sidecar.description,
          path: sidecar.path,
          timeoutSec: sidecar.timeoutSec,
          inlineCode: sidecar.inlineCode,
          inputs: sidecar.inputs,
        },
        outputText: sidecar.resultText || undefined,
      }
    }
    // The SuperShell sibling: a reloaded session's SuperShell card jumps with
    // its tool call id, and the call's script, inputs and result sit in that
    // call's sidecar. Same detail shape as a live invocation (SuperShellTask
    // Coordinator.loadInfo).
    const superShell = await this.host.loadSuperShellSidecar?.(publicId)
    if (superShell) {
      return {
        type: 'local_supershell',
        jsSource: superShell.code,
        jsParams: {
          description: superShell.description,
          inlineCode: true,
          inputs: superShell.inputs,
        },
        outputText: superShell.resultText || undefined,
      }
    }
    return null
  }

  handleDrawerStop(
    port: MessagePort,
    message: Extract<SharedWorkerInboundMessage, { type: 'task.stop' }>,
  ): void {
    const id = this.resolveNative(message.sessionId)
    const reply = (status: TaskStopStatus): void => {
      port.postMessage({
        type: 'task.stopped',
        payload: {
          sessionId: message.sessionId,
          status,
          requestId: message.requestId,
        },
      })
    }

    if (this.liveShell(id) || this.finishedShell(id)) {
      void this.stopAndWait(message.sessionId).then(result => reply(result.status))
      return
    }
    if (this.superShells?.owns(id)) {
      reply(this.superShells.stop(id).status)
      return
    }
    if (this.liveFork(id)) {
      reply(this.sideTasks.stopFork(id))
      return
    }
    if (this.finishedFork(id)) {
      reply('already_finished')
      return
    }
    if (this.routines.has(id)) {
      reply(this.routines.stopHeadlessRun(id))
      return
    }
    if (
      this.finishedRoutine(id) ||
      this.finishedFastCall(id) ||
      this.liveRunJs(id) ||
      this.finishedRunJs(id)
    ) {
      // run_js is a synchronous tool call — it runs to completion (or is aborted
      // with its turn), so there is nothing the drawer can Stop. The drawer
      // suppresses the Stop action for local_js; this is the defensive reply.
      reply('already_finished')
      return
    }
    reply(this.stop(message.sessionId).status)
  }

  handleDrawerResume(
    port: MessagePort,
    message: Extract<SharedWorkerInboundMessage, { type: 'task.resume' }>,
  ): void {
    const result = this.resume(message.sessionId, message.prompt)
    port.postMessage({
      type: 'task.resumed',
      payload: {
        sessionId: message.sessionId,
        ok: result.ok,
        reason: result.ok ? undefined : result.reason,
        requestId: message.requestId,
      },
    })
    if (result.ok) {
      this.host.scheduleSummary()
    }
  }

  handleDrawerTranscript(
    port: MessagePort,
    message: Extract<SharedWorkerInboundMessage, { type: 'task.transcript' }>,
  ): void {
    const { sessionId, requestId } = message
    const id = this.resolveNative(sessionId)
    const viewedShell = this.liveShell(id)
    if (viewedShell && !viewedShell.finalized) {
      this.shells.kickPoll(id)
    }
    void Promise.all([
      this.loadInfoWithOutput(sessionId),
      this.loadTranscript(sessionId),
    ]).then(([info, entries]) => {
      port.postMessage({
        type: 'task.transcript',
        payload: { sessionId, requestId, entries, info },
      })
    })
  }

  getSnapshot(publicId: string): SubAgentSnapshot | null {
    const id = this.resolveNative(publicId)
    const agent = this.liveAgent(id)
    if (agent) {
      return {
        sessionId: agent.taskId ?? publicId,
        status: 'running',
        description: agent.description,
        agentType: agent.agentType,
        output: extractFinalAssistantText(agent.messages),
        startedAt: agent.startedAt,
        updates: agent.messages.length,
        lastActivityAt: agent.lastActivityAt,
      }
    }
    const finishedAgent = this.finishedAgent(id)
    if (finishedAgent) {
      return finishedRecordToSnapshot(finishedAgent)
    }
    const shell = this.liveShell(id)
    if (shell) {
      return runningShellToSnapshot(shell)
    }
    const finishedShell = this.finishedShell(id)
    if (finishedShell) {
      return finishedShellToSnapshot(finishedShell)
    }
    return this.superShells?.getSnapshot(id) ?? null
  }

  list(spawnerSessionId: string): SubAgentListEntry[] {
    const running: SubAgentListEntry[] = []
    for (const agent of this.taskRegistry.liveByType('local_agent')) {
      if (agent.spawnerSessionId !== spawnerSessionId) {
        continue
      }
      running.push({
        sessionId: agent.taskId ?? agent.sessionId,
        status: 'running',
        description: agent.description,
        agentType: agent.agentType,
        startedAt: agent.startedAt,
        updates: agent.messages.length,
      })
    }
    for (const shell of this.taskRegistry.liveByType('local_bash')) {
      if (shell.spawnerSessionId !== spawnerSessionId) {
        continue
      }
      running.push({
        sessionId: shell.taskId,
        status: 'running',
        description: shell.command,
        startedAt: shell.startedAt,
        updates: shell.polls,
      })
    }
    for (const script of this.taskRegistry.liveByType('local_supershell')) {
      if (script.spawnerSessionId !== spawnerSessionId) {
        continue
      }
      running.push({
        sessionId: script.taskId,
        status: 'running',
        description: script.description,
        startedAt: script.startedAt,
      })
    }
    running.sort((a, b) => a.startedAt - b.startedAt)

    const finished: SubAgentListEntry[] = []
    for (const agent of this.taskRegistry.finishedByType('local_agent')) {
      if (agent.spawnerSessionId !== spawnerSessionId) {
        continue
      }
      finished.push({
        sessionId: agent.taskId ?? agent.sessionId,
        status: agent.status,
        description: agent.description,
        agentType: agent.agentType,
        startedAt: agent.startedAt,
        finishedAt: agent.finishedAt,
      })
    }
    for (const shell of this.taskRegistry.finishedByType('local_bash')) {
      if (shell.spawnerSessionId !== spawnerSessionId) {
        continue
      }
      finished.push({
        sessionId: shell.taskId,
        status: shell.status,
        description: shell.command,
        startedAt: shell.startedAt,
        finishedAt: shell.finishedAt,
      })
    }
    for (const script of this.taskRegistry.finishedByType('local_supershell')) {
      if (script.spawnerSessionId !== spawnerSessionId) {
        continue
      }
      finished.push({
        sessionId: script.taskId,
        status: script.status,
        description: script.description,
        startedAt: script.startedAt,
        finishedAt: script.finishedAt,
      })
    }
    finished.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    return [...running, ...finished]
  }

  waitForCompletion(
    publicId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<SubAgentSnapshot | null> {
    const id = this.resolveNative(publicId)
    if (
      !this.liveAgent(id) &&
      !this.finishedAgent(id) &&
      (this.liveShell(id) || this.finishedShell(id))
    ) {
      return this.shells.waitForCompletion(id, timeoutMs, signal)
    }
    if (this.superShells?.owns(id)) {
      return this.superShells.waitForCompletion(id, timeoutMs, signal)
    }
    const finished = this.finishedAgent(id)
    if (finished) {
      return Promise.resolve(finishedRecordToSnapshot(finished))
    }
    if (!this.liveAgent(id)) {
      return Promise.resolve(null)
    }
    if (signal?.aborted) {
      this.stop(publicId)
      return Promise.resolve(this.getSnapshot(publicId))
    }
    return new Promise(resolve => {
      let settled = false
      let poll: ReturnType<typeof setInterval> | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (snapshot: SubAgentSnapshot | null): void => {
        if (settled) {
          return
        }
        settled = true
        if (timer !== undefined) {
          clearTimeout(timer)
        }
        if (poll !== undefined) {
          clearInterval(poll)
        }
        signal?.removeEventListener('abort', onAbort)
        resolve(snapshot)
      }
      const unregister = (): void => {
        this.subAgents.removeWaiter(id, finish)
      }
      const onAbort = (): void => {
        this.stop(publicId)
        finish(this.getSnapshot(publicId))
      }
      this.subAgents.addWaiter(id, finish)
      signal?.addEventListener('abort', onAbort, { once: true })
      poll = setInterval(() => {
        const terminal = this.finishedAgent(id)
        if (terminal) {
          unregister()
          finish(finishedRecordToSnapshot(terminal))
        } else if (!this.liveAgent(id)) {
          unregister()
          finish(this.getSnapshot(publicId))
        }
      }, 250)
      timer = setTimeout(() => {
        unregister()
        finish(this.getSnapshot(publicId))
      }, timeoutMs)
    })
  }

  /**
   * Stop a task and report the OUTCOME. A background shell's kill is
   * asynchronous and can fail (`stop_failed`), outlive its confirm window
   * (`stop_pending`) or find the process already gone (`not_found` /
   * `already_finished`) — see BackgroundShellCoordinator.stop — so the shell
   * branch awaits it. Every other kind stops synchronously and answers exactly
   * as `stop` does. Prefer this over `stop` wherever the caller can await.
   */
  async stopAndWait(publicId: string): Promise<TaskStopResult> {
    const id = this.resolveNative(publicId)
    const shell = this.liveShell(id)
    if (shell) {
      const status = await this.shells.stop(id)
      return { status, description: shell.command }
    }
    return this.stop(publicId)
  }

  /**
   * Synchronous stop, for the `SubAgentController.stop` seam (the TaskStop
   * tool via the manager's `stopSubAgent`). A live background shell is only
   * REQUESTED to stop here — the kill is fired, not awaited — so its
   * `stopped` is the request, not the outcome; `stopAndWait` reports the
   * outcome for callers that can await.
   */
  stop(publicId: string): SubAgentStopResult {
    const id = this.resolveNative(publicId)
    const agent = this.liveAgent(id)
    if (agent) {
      return this.subAgents.stopRun(id)
    }
    const shell = this.liveShell(id)
    if (shell) {
      void this.shells.stop(id)
      return { status: 'stopped', description: shell.command }
    }
    const finishedShell = this.finishedShell(id)
    if (finishedShell) {
      return {
        status: 'already_finished',
        description: finishedShell.command,
      }
    }
    if (this.superShells?.owns(id)) {
      return this.superShells.stop(id)
    }
    const finishedAgent = this.finishedAgent(id)
    return finishedAgent
      ? {
          status: 'already_finished',
          description: finishedAgent.description,
        }
      : { status: 'not_found' }
  }

  resume(publicId: string, prompt: string): SubAgentResumeResult {
    const result = this.subAgents.resume(publicId, prompt)
    if (result.ok) {
      this.taskDelivery.acknowledge(
        pending => pending.taskId === result.sessionId,
      )
    }
    return result
  }

  /** Hold a live sub-agent's result for a waiter (`SubAgentController.holdResult`). */
  holdResult(publicId: string): ((consumed: boolean) => void) | undefined {
    const id = this.resolveNative(publicId)
    if (!this.subAgents.holdResult(id)) return undefined
    let released = false
    return consumed => {
      if (released) return
      released = true
      this.subAgents.releaseResult(id, consumed)
    }
  }

  acknowledgeResult(publicId: string): void {
    const id = this.resolveNative(publicId)
    if (this.finishedAgent(id)) {
      this.taskDelivery.acknowledge(
        pending => pending.taskId === publicId,
      )
      return
    }
    if (this.superShells?.owns(id)) {
      this.superShells.acknowledgeResult(id)
      return
    }
    this.shells.acknowledgeResult(id)
  }

  stopRunningForParent(spawnerSessionId: string): void {
    for (const agent of [
      ...this.taskRegistry.liveByType('local_agent'),
    ]) {
      if (agent.spawnerSessionId === spawnerSessionId) {
        this.stop(agent.sessionId)
      }
    }
    for (const shell of [
      ...this.taskRegistry.liveByType('local_bash'),
    ]) {
      if (shell.spawnerSessionId === spawnerSessionId) {
        void this.shells.stop(shell.shellId)
      }
    }
    for (const fork of [
      ...this.taskRegistry.liveByType('local_fork'),
    ]) {
      if (fork.spawnerSessionId === spawnerSessionId) {
        this.sideTasks.stopFork(fork.agentId)
      }
    }
    this.superShells?.stopChildren(spawnerSessionId)
  }

  cascadeOnParentClose(spawnerSessionId: string): Promise<void> {
    const teardowns: Array<Promise<void>> = []
    for (const [id, task] of [...this.taskRegistry.allLiveEntries()]) {
      if (
        task.type !== 'local_agent' ||
        task.spawnerSessionId !== spawnerSessionId
      ) {
        continue
      }
      teardowns.push(
        this.subAgents
          .teardown(id)
          .catch(() => {})
          .then(() => Promise.resolve(task.onCleanup?.()).catch(() => {})),
      )
      this.taskRegistry.removeTaskIdIndex(task.taskId)
      this.host.dropSessionRouting(id)
      this.subAgents.resolveWaiters(id)
    }
    for (const [id, task] of [...this.taskRegistry.allFinishedEntries()]) {
      if (
        task.type !== 'local_agent' ||
        task.spawnerSessionId !== spawnerSessionId
      ) {
        continue
      }
      this.taskRegistry.deleteFinished(id)
      this.taskRegistry.removeTaskIdIndex(task.taskId)
      this.subAgents.resolveWaiters(id)
    }
    this.taskDelivery.dropParent(spawnerSessionId)
    this.superShells?.stopChildren(spawnerSessionId)
    this.shells.stopChildren(spawnerSessionId)
    return Promise.allSettled(teardowns).then(() => {})
  }

  private resolveNative(publicId: string): string {
    return this.taskRegistry.resolveNative(publicId)
  }

  private liveAgent(id: string): SubAgentRunState | undefined {
    return this.taskRegistry.getLiveByType(id, 'local_agent')
  }

  private finishedAgent(id: string): FinishedSubAgentRecord | undefined {
    return this.taskRegistry.getFinishedByType(id, 'local_agent')
  }

  private liveShell(id: string): BackgroundShellRunState | undefined {
    return this.taskRegistry.getLiveByType(id, 'local_bash')
  }

  private finishedShell(
    id: string,
  ): FinishedBackgroundShellRecord | undefined {
    return this.taskRegistry.getFinishedByType(id, 'local_bash')
  }

  private liveFork(id: string): ForkRunState | undefined {
    return this.taskRegistry.getLiveByType(id, 'local_fork')
  }

  private finishedFork(id: string): FinishedForkRecord | undefined {
    return this.taskRegistry.getFinishedByType(id, 'local_fork')
  }

  private liveFastCall(id: string): FastCallRunState | undefined {
    return this.taskRegistry.getLiveByType(id, 'local_fast')
  }

  private finishedFastCall(id: string): FinishedFastCallRecord | undefined {
    return this.taskRegistry.getFinishedByType(id, 'local_fast')
  }

  private liveRunJs(id: string): RunJsRunState | undefined {
    return this.taskRegistry.getLiveByType(id, 'local_js')
  }

  private finishedRunJs(id: string): FinishedRunJsRecord | undefined {
    return this.taskRegistry.getFinishedByType(id, 'local_js')
  }

  private finishedRoutine(id: string): FinishedRoutineRecord | undefined {
    return this.taskRegistry.getFinishedByType(id, 'local_routine')
  }
}

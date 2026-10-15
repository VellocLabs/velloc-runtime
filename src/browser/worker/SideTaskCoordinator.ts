/**
 * Contract: SideTaskCoordinator — local_fork, local_fast and local_js (run_js) lifecycle. Invariants:
 * - local_fork and local_fast skip parent task-notification delivery (in-process side-tasks)
 * - fork abort is idempotent
 * - a reused agentId supersedes the stale finished record and its index entry
 */
import type { TaskRegistry } from './TaskRegistry'

// --- Host interface (Manager provides these) ---

export interface SideTaskHost {
  scheduleSummary(): void
  mintTaskHandle(prefix: string): string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  forkDisplayLabel(start: any): string
  fastCallDisplayLabel(querySource: string): string
  runJsDisplayLabel(): string
  extractFinalAssistantText(messages: unknown[]): string
  projectSubAgentTranscript(messages: unknown[]): unknown[]
  evictFinishedOverCap(kind: string, cap: number, onEvict?: (id: string) => void): void
}

// --- Constants ---

const MAX_FINISHED_FORKS = 40
const MAX_FINISHED_FAST_CALLS = 40
const MAX_FINISHED_RUN_JS = 40

// --- Coordinator ---

export class SideTaskCoordinator {
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly registry: TaskRegistry<any, any>,
    private readonly host: SideTaskHost,
  ) {}

  // --- Fork lifecycle ---

  registerFork(start: {
    agentId: string
    spawnerSessionId?: string
    querySource: unknown
    forkLabel: string
    description?: string
    agentType?: string
    model?: string
    prompt?: string
    systemPrompt?: string
    startedAt: number
    abort: () => void
  }): void {
    if (!start.agentId) return
    if (this.registry.getLiveByType(start.agentId, 'local_fork')) return

    // Stale finished record cleanup (reused agentId).
    const stale = this.registry.getFinishedByType(start.agentId, 'local_fork')
    if (stale) {
      this.registry.removeTaskIdIndex(stale.taskId)
      this.registry.deleteFinished(start.agentId)
    }

    const taskId = this.host.mintTaskHandle('local_fork')
    const run = {
      type: 'local_fork' as const,
      taskId,
      agentId: start.agentId,
      spawnerSessionId: start.spawnerSessionId ?? '',
      querySource: String(start.querySource),
      forkLabel: start.forkLabel,
      description: this.host.forkDisplayLabel(start),
      agentType: start.agentType,
      model: start.model,
      prompt: start.prompt,
      systemPrompt: start.systemPrompt,
      messages: [] as unknown[],
      startedAt: start.startedAt,
      lastActivityAt: start.startedAt,
      abort: start.abort,
      stopRequested: false,
    }
    this.registry.registerLive(start.agentId, run)
    this.registry.indexTaskId(taskId, start.agentId)
    this.host.scheduleSummary()
  }

  progressFork(agentId: string, message: unknown): void {
    const run = this.registry.getLiveByType(agentId, 'local_fork') as
      | { messages: unknown[]; lastActivityAt: number }
      | undefined
    if (!run) return
    run.messages.push(message)
    run.lastActivityAt = Date.now()
    this.host.scheduleSummary()
  }

  finishFork(finish: {
    agentId: string
    status: 'success' | 'error' | 'stopped'
    errorMessage?: string
    model?: string
    finishedAt: number
  }): void {
    const run = this.registry.getLiveByType(finish.agentId, 'local_fork') as
      | {
          taskId: string; agentId: string; spawnerSessionId: string
          querySource: string; description: string; agentType?: string
          model?: string; prompt?: string; systemPrompt?: string
          messages: unknown[]; startedAt: number; stopRequested: boolean
        }
      | undefined
    if (!run) return
    this.registry.deleteLive(finish.agentId)
    const status = run.stopRequested ? 'stopped' : finish.status
    const record = {
      type: 'local_fork' as const,
      taskId: run.taskId,
      agentId: run.agentId,
      spawnerSessionId: run.spawnerSessionId,
      querySource: run.querySource,
      description: run.description,
      agentType: run.agentType,
      model: finish.model ?? run.model,
      prompt: run.prompt,
      systemPrompt: run.systemPrompt,
      status,
      summary:
        status === 'error'
          ? finish.errorMessage || 'Fork failed.'
          : this.host.extractFinalAssistantText(run.messages) ||
            (status === 'stopped' ? 'Stopped.' : ''),
      transcript: this.host.projectSubAgentTranscript(run.messages),
      startedAt: run.startedAt,
      finishedAt: finish.finishedAt,
    }
    this.registry.recordFinished(run.agentId, record)
    this.host.evictFinishedOverCap('local_fork', MAX_FINISHED_FORKS)
    this.host.scheduleSummary()
  }

  stopFork(agentId: string): 'stopped' | 'not_found' {
    const run = this.registry.getLiveByType(agentId, 'local_fork') as
      | { stopRequested: boolean; abort: () => void }
      | undefined
    if (!run) return 'not_found'
    run.stopRequested = true
    try {
      run.abort()
    } catch {
      // The abort callback lives in the fork's realm; a throw here must not
      // take down the port handler. The finish notification still finalizes.
    }
    this.host.scheduleSummary()
    return 'stopped'
  }

  // --- Fast-call lifecycle ---

  registerFastCall(start: {
    callId: string
    spawnerSessionId?: string
    querySource: unknown
    description?: string
    model?: string
    prompt?: string
    systemPrompt?: string
    startedAt: number
  }): void {
    if (!start.callId) return
    if (this.registry.getLiveByType(start.callId, 'local_fast')) return

    // Stale finished record cleanup (reused callId): same
    // rule as registerFork above. Page-side call ids can restart across
    // reloads while the SharedWorker's finished records persist; without
    // this, the OLD public taskId still resolved to the reused native id
    // and could read/control the NEW call for its whole live window.
    const stale = this.registry.getFinishedByType(start.callId, 'local_fast')
    if (stale) {
      this.registry.removeTaskIdIndex(stale.taskId)
      this.registry.deleteFinished(start.callId)
    }

    const taskId = this.host.mintTaskHandle('local_fast')
    const run = {
      type: 'local_fast' as const,
      taskId,
      callId: start.callId,
      spawnerSessionId: start.spawnerSessionId ?? '',
      querySource: String(start.querySource),
      description: this.host.fastCallDisplayLabel(String(start.querySource)),
      model: start.model,
      prompt: start.prompt,
      systemPrompt: start.systemPrompt,
      startedAt: start.startedAt,
    }
    this.registry.registerLive(start.callId, run)
    this.registry.indexTaskId(taskId, start.callId)
    this.host.scheduleSummary()
  }

  finishFastCall(finish: {
    callId: string
    status: 'success' | 'error' | 'stopped'
    errorMessage?: string
    responseText?: string
    model?: string
    finishedAt: number
  }): void {
    const run = this.registry.getLiveByType(finish.callId, 'local_fast') as
      | {
          taskId: string; callId: string; spawnerSessionId: string
          querySource: string; description: string; model?: string
          prompt?: string; systemPrompt?: string; startedAt: number
        }
      | undefined
    if (!run) return
    this.registry.deleteLive(finish.callId)
    const record = {
      type: 'local_fast' as const,
      taskId: run.taskId,
      callId: run.callId,
      spawnerSessionId: run.spawnerSessionId,
      querySource: run.querySource,
      description: run.description,
      model: finish.model ?? run.model,
      prompt: run.prompt,
      systemPrompt: run.systemPrompt,
      status: finish.status,
      summary:
        finish.status === 'error'
          ? finish.errorMessage || 'Failed.'
          : finish.status === 'stopped'
            ? 'Stopped.'
            : finish.responseText || '',
      responseText: finish.responseText,
      startedAt: run.startedAt,
      finishedAt: finish.finishedAt,
    }
    this.registry.recordFinished(run.callId, record)
    this.host.evictFinishedOverCap('local_fast', MAX_FINISHED_FAST_CALLS)
    this.host.scheduleSummary()
  }

  // --- run_js lifecycle ---

  registerRunJs(start: {
    callId: string
    spawnerSessionId?: string
    description?: string
    code: string
    path?: string
    inputs?: Record<string, unknown>
    timeoutSec?: number
    inlineCode: boolean
    startedAt: number
  }): void {
    if (!start.callId) return
    if (this.registry.getLiveByType(start.callId, 'local_js')) return

    // Stale finished record cleanup (reused callId) — same rule as
    // registerFastCall above.
    const stale = this.registry.getFinishedByType(start.callId, 'local_js')
    if (stale) {
      this.registry.removeTaskIdIndex(stale.taskId)
      this.registry.deleteFinished(start.callId)
    }

    // The public task id IS the tool call id — the conversation card focuses the
    // drawer with the id it already holds, so no minted id needs correlating.
    const taskId = start.callId
    const run = {
      type: 'local_js' as const,
      taskId,
      callId: start.callId,
      spawnerSessionId:
        start.spawnerSessionId ?? '',
      description: start.description?.trim() || this.host.runJsDisplayLabel(),
      code: start.code,
      path: start.path,
      inputs: start.inputs,
      timeoutSec: start.timeoutSec,
      inlineCode: start.inlineCode,
      startedAt: start.startedAt,
    }
    this.registry.registerLive(start.callId, run)
    this.registry.indexTaskId(taskId, start.callId)
    this.host.scheduleSummary()
  }

  finishRunJs(finish: {
    callId: string
    status: 'success' | 'error' | 'stopped'
    resultText?: string
    finishedAt: number
  }): void {
    const run = this.registry.getLiveByType(finish.callId, 'local_js') as
      | {
          taskId: string; callId: string; spawnerSessionId: string
          description: string; code: string; path?: string
          inputs?: Record<string, unknown>
          timeoutSec?: number; inlineCode: boolean; startedAt: number
        }
      | undefined
    if (!run) return
    this.registry.deleteLive(finish.callId)
    const record = {
      type: 'local_js' as const,
      taskId: run.taskId,
      callId: run.callId,
      spawnerSessionId: run.spawnerSessionId,
      description: run.description,
      code: run.code,
      path: run.path,
      inputs: run.inputs,
      timeoutSec: run.timeoutSec,
      inlineCode: run.inlineCode,
      status: finish.status,
      resultText:
        finish.resultText ?? (finish.status === 'stopped' ? 'Stopped.' : ''),
      startedAt: run.startedAt,
      finishedAt: finish.finishedAt,
    }
    this.registry.recordFinished(run.callId, record)
    this.host.evictFinishedOverCap('local_js', MAX_FINISHED_RUN_JS)
    this.host.scheduleSummary()
  }
}

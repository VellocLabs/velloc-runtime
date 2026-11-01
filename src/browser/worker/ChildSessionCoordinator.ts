/**
 * Contract: ChildSessionCoordinator — starts a child session (F-36) from a
 * parent's request: a fresh session briefed by its parent, or a fork of the
 * parent's transcript, each a full session of its own. Invariants:
 * - the session is on record (its origin written) before its worker exists,
 *   and stays on record when the start fails, with the reason
 * - a worktree failure never falls back to the shared directory
 * - a fork whose cut ends in an unanswered tool call creates nothing
 * - the parent is told once when a child it started did not start
 */
import type { AgentRuntimeWorkerHandle } from './AgentRuntimeWorkerHandle'
import type { AgentRuntimeWorkerInitPayload } from './workerProtocol'
import type { SessionWorkerInboundMessage } from './sharedWorkerProtocol'
import type {
  BrowserConversationStorageBackend,
  BrowserSessionMetadata,
  SessionMetaFile,
} from '../../sessions/sessionStore'
import { SESSION_META_FILE_SCHEMA_VERSION } from '../../sessions/sessionStore'
import {
  allocateFamilyName,
  familyNameBase,
  type ChildReport,
  type ChildStartState,
  type SessionOrigin,
} from '../../sessions/sessionLineage'
import {
  buildChildFirstMessage,
  childNotStartedText,
} from '../../sessions/childSessionSpec'
import type {
  ChildSessionSpawnOutcome,
  ChildSessionSpawnParams,
} from '../../sessions/childSessionSpawner'
import { deriveChildInitPayload, type ParentSessionBinding } from './childInitPayload'
import type { installSessionTracer } from '../../utils/sessionTrace'

type SessionTracer = ReturnType<typeof installSessionTracer>

export interface ChildSessionHost {
  /** The reusable UI init payload; null before any UI session booted. */
  getInitTemplate(): AgentRuntimeWorkerInitPayload | null
  /** Route and stamp the child's storage backend; a child is routed by its
   *  own project like any session, never nested under its parent. */
  prepareWorkerStorage(
    sessionId: string,
    payload: AgentRuntimeWorkerInitPayload,
  ): BrowserConversationStorageBackend | null
  createWorker(
    sessionId: string,
    backend: BrowserConversationStorageBackend | null,
  ): { worker: AgentRuntimeWorkerHandle; instanceId: string }
  /** Register the child's session entry (no ports, background). */
  registerSessionEntry(
    sessionId: string,
    worker: AgentRuntimeWorkerHandle,
    instanceId: string,
    binding: { templateType?: string; projectRoot?: string },
  ): void
  getSessionWorker(sessionId: string): AgentRuntimeWorkerHandle | undefined
  disposeManagedSession(sessionId: string, opts: { fireStop: boolean }): Promise<void>
  notifySessionUpserted(sessionId: string): void
  /** The parent's own binding: the seed for the child's project and type. */
  getParentSessionBinding(parentSessionId: string): ParentSessionBinding | null
  /** Every short name taken in the parent's family, archived members included. */
  familyNamesOf(parentSessionId: string): ReadonlySet<string>
  /** Whether `path` is a project folder this runtime already trusts. */
  isTrustedProjectFolder(path: string): Promise<boolean>
  /** Write a fresh child's record (routed, published) before its worker exists. */
  writeChildMeta(sessionId: string, meta: SessionMetaFile): Promise<void>
  /** Merge `patch` into a not-live session's record and republish it. */
  patchSessionMeta(sessionId: string, patch: Partial<BrowserSessionMetadata>): Promise<void>
  /** Hold / clear the live start state the list projection shows. */
  setStartState(sessionId: string, state: ChildStartState | null): void
  /** Queue the child's first turn at user priority; false without a live worker. */
  submitFirstTurn(sessionId: string, prompt: string): boolean
  /** Hand the parent one report about a child, replacing an earlier one from
   *  the same child. */
  recordChildReport(parentSessionId: string, report: ChildReport): Promise<void>
  /** Where the parent's transcript would be cut for a model fork; a refusal
   *  creates nothing. */
  planModelFork(
    parentSessionId: string,
  ): Promise<{ ok: true; cutUuid: string } | { ok: false; reason: string }>
  /** Copy the parent's transcript up to `cutUuid` into a new session whose
   *  record also carries `patch`; the new session id. */
  forkForChild(
    parentSessionId: string,
    cutUuid: string,
    patch: Partial<BrowserSessionMetadata>,
    title: string,
  ): Promise<{ ok: true; sessionId: string } | { ok: false; reason: string }>
  tracer: SessionTracer
}

function newSessionId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `child-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`
  )
}

function newTaskId(): string {
  return `task_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

export class ChildSessionCoordinator {
  constructor(private readonly host: ChildSessionHost) {}

  /**
   * Start a child session. Resolves once the session is on record and its
   * start is under way (or has failed); the first turn runs in the
   * background. Null when no UI session has booted yet.
   */
  async spawn(params: ChildSessionSpawnParams): Promise<ChildSessionSpawnOutcome | null> {
    const template = this.host.getInitTemplate()
    if (!template) return null
    const { parentSessionId, request } = params
    const parent = this.host.getParentSessionBinding(parentSessionId)
    if (!parent) {
      return { ok: false, reason: 'this session is not a live session the runtime can start a child from.' }
    }
    // Security: the child binds to a folder the runtime already trusts: its
    // parent's, or one the request names that the workspace or a session
    // already knows. A new path is never bound here.
    let projectRoot = parent.projectRoot
    if (request.cwd) {
      if (!(await this.host.isTrustedProjectFolder(request.cwd))) {
        return {
          ok: false,
          reason: `cwd "${request.cwd}" is not a project folder this runtime trusts; use this session's folder or one the user has opened.`,
        }
      }
      projectRoot = request.cwd
    }
    if (request.from === 'fresh' && !projectRoot) {
      return { ok: false, reason: 'this session has no project folder to start a child in; pass cwd.' }
    }
    const sharedCheckout = request.isolation === 'shared'
    const now = Date.now()
    const name = allocateFamilyName(
      familyNameBase(request.name, request.title),
      this.host.familyNamesOf(parentSessionId),
    )
    const origin: SessionOrigin = {
      sessionId: parentSessionId,
      taskId: newTaskId(),
      kind: 'side_session',
      initiator: 'model',
      sharedCheckout,
      name,
    }
    const patch: Partial<BrowserSessionMetadata> = {
      spawnedFrom: origin,
      permissionMode: request.permissionMode,
    }

    let sessionId: string
    if (request.from === 'fork') {
      const plan = await this.host.planModelFork(parentSessionId)
      if (!plan.ok) return { ok: false, reason: `the fork was refused: ${plan.reason}` }
      const forked = await this.host.forkForChild(parentSessionId, plan.cutUuid, patch, request.title)
      if (!forked.ok) return { ok: false, reason: `the fork failed: ${forked.reason}` }
      sessionId = forked.sessionId
    } else {
      sessionId = newSessionId()
      const meta: SessionMetaFile = {
        schemaVersion: SESSION_META_FILE_SCHEMA_VERSION,
        sessionId,
        updatedAt: now,
        customTitle: request.title,
        customTitleAt: now,
        metadata: {
          ...patch,
          customTitle: request.title,
          createdAt: now,
          ...(parent.templateType ? { templateType: parent.templateType } : {}),
          ...(projectRoot ? { projectRoot } : {}),
        },
      }
      try {
        await this.host.writeChildMeta(sessionId, meta)
      } catch (err) {
        return { ok: false, reason: `the session record could not be written: ${messageOf(err)}` }
      }
    }
    this.host.setStartState(sessionId, { state: 'starting', since: now })
    this.host.notifySessionUpserted(sessionId)

    // The worktree: made now, after the record exists, so a failure is a
    // session that did not start, never one that quietly shares the tree.
    let cwd = sharedCheckout ? (request.cwd ?? parent.cwd ?? projectRoot) : undefined
    let worktreeRepoRoot: string | undefined
    if (params.prepareWorktree) {
      const made = await params.prepareWorktree(name)
      if (!made.ok) {
        await this.failStart(sessionId, parentSessionId, name, `the worktree could not be created: ${made.reason}`)
        return { ok: true, sessionId, name, sharedCheckout, startFailed: made.reason }
      }
      cwd = made.cwd
      worktreeRepoRoot = made.repoRoot
    }

    const payload = deriveChildInitPayload(template, {
      sessionId,
      parent,
      // A worktree child keeps its storage on the repository root, like a
      // worktree-isolated sub-agent; only its working directory moves.
      projectRoot: worktreeRepoRoot ?? projectRoot,
      templateType: parent.templateType,
      providerId: params.providerId,
      model: request.model,
      thinkingTier: params.thinkingTier,
      cwd,
      routineOriginId: params.routineOriginId,
    })
    const prompt = buildChildFirstMessage({
      briefing: request.from === 'fresh' ? request.briefing : request.briefing ?? '',
      task: request.task,
    })
    void this.startWorker(sessionId, parentSessionId, name, payload, prompt)
    return { ok: true, sessionId, name, sharedCheckout, ...(cwd ? { cwd } : {}) }
  }

  /** Build the worker, run its init, queue the first turn; a failure anywhere
   *  marks the start failed and releases the worker. */
  private async startWorker(
    sessionId: string,
    parentSessionId: string,
    name: string,
    payload: AgentRuntimeWorkerInitPayload,
    prompt: string,
  ): Promise<void> {
    let registered = false
    try {
      const backend = this.host.prepareWorkerStorage(sessionId, payload)
      const { worker, instanceId } = this.host.createWorker(sessionId, backend)
      this.host.registerSessionEntry(sessionId, worker, instanceId, {
        ...(payload.templateType ? { templateType: payload.templateType } : {}),
        ...(payload.projectRoot ? { projectRoot: payload.projectRoot } : {}),
      })
      registered = true
      await worker.receiveFrame({
        type: 'worker.init',
        sessionId,
        payload,
      } as SessionWorkerInboundMessage)
      if (!this.host.submitFirstTurn(sessionId, prompt)) {
        throw new Error('the session has no live runtime to take its first message')
      }
      this.host.setStartState(sessionId, null)
      this.host.notifySessionUpserted(sessionId)
    } catch (err) {
      this.host.tracer.event('nexus_child_session_start_failed', {
        attrs: { sessionId, error: messageOf(err) },
      })
      if (registered) {
        try {
          await this.host.disposeManagedSession(sessionId, { fireStop: false })
        } catch {
          // the entry is gone either way; the record below says why
        }
      }
      await this.failStart(sessionId, parentSessionId, name, `the session runtime did not start: ${messageOf(err)}`)
    }
  }

  private async failStart(
    sessionId: string,
    parentSessionId: string,
    name: string,
    reason: string,
  ): Promise<void> {
    const at = Date.now()
    this.host.setStartState(sessionId, { state: 'failed', reason, at })
    try {
      await this.host.patchSessionMeta(sessionId, { startFailed: { reason, at } })
    } catch {
      // the live state still shows it; the record is best-effort
    }
    this.host.notifySessionUpserted(sessionId)
    try {
      await this.host.recordChildReport(parentSessionId, {
        sessionId,
        ending: 'failed',
        text: childNotStartedText({ name, sessionId, reason }),
        at,
        notStarted: true,
      })
    } catch {
      // the child's own record carries the reason
    }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

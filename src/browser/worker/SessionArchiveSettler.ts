import { isTeammateSessionId } from './taskProjection'
import { archivedWorktreeLogLine, insideFolder, settleWorktreeOnArchive, settleWorktreeOnUnarchive, worktreeRecordOf, type ArchivedWorktreeDeps } from './archivedWorktree'
import { managerHostCommand } from './managerHostCommand'
import type { SharedWorkerSessionManager } from './SharedWorkerSessionManager'

type Manager = SharedWorkerSessionManager

/** The manager state and callbacks archiving reads; owned by the manager. */
export type SessionArchiveSettlerDeps = {
  sessions: Manager['sessions']
  worktreeSettles: Manager['worktreeSettles']
  bridgeRouter: Manager['bridgeRouter']
  taskRegistry: Manager['taskRegistry']
  getTeams: () => Manager['teams']
  getCloseTerminalsForSession: () => Manager['closeTerminalsForSession']
  getStorage: () => Manager['storage']
  getFsSummaries: () => Manager['fsSummaries']
  interruptSessionTurn: Manager['interruptSessionTurn']
  stopRunningSubAgentsForParent: Manager['stopRunningSubAgentsForParent']
  patchSessionRecord: Manager['patchSessionRecord']
  sessionTerminalCwd: Manager['sessionTerminalCwd']
  generateBridgeRequestId: Manager['generateBridgeRequestId']
}

/**
 * Contract: what archiving a session stops (its turn, sub-agents, teammates,
 * terminals), the per-session serialized settle of its own worktree, and
 * whether it still has live work. Owns no state; the settle chain map
 * belongs to the manager.
 */
export class SessionArchiveSettler {
  constructor(private readonly deps: SessionArchiveSettlerDeps) {}

  /** Stop a session's turn (only when one runs: an interrupt builds an idle
   *  runtime), its sub-agents, shells, teammates and terminals. (F-36) */
  async stopSessionForArchive(sessionId: string): Promise<void> {
    const session = this.deps.sessions.get(sessionId)
    if (session?.worker.isBusy()) this.deps.interruptSessionTurn(sessionId)
    else this.deps.stopRunningSubAgentsForParent(sessionId)
    try {
      await this.deps.getTeams().abortTeammatesOf(sessionId)
    } catch (err) {
      console.warn(`[SharedWorkerSessionManager] teammates of ${sessionId} did not stop`, err)
    }
    try {
      this.deps.getCloseTerminalsForSession()(sessionId)
    } catch (err) {
      console.warn(`[SharedWorkerSessionManager] terminals of ${sessionId} did not close`, err)
    }
  }

  /** The archive / unarchive of a session, for its own worktree (F-36):
   *  best-effort, logged, one at a time per session so an unarchive sent
   *  during an archive's removal sees the removal. */
  settleArchivedWorktree(sessionId: string, archived: boolean): Promise<void> {
    const previous = this.deps.worktreeSettles.get(sessionId) ?? Promise.resolve()
    const run = previous.then(() => this.settleArchivedWorktreeNow(sessionId, archived))
    this.deps.worktreeSettles.set(sessionId, run)
    void run.then(() => {
      if (this.deps.worktreeSettles.get(sessionId) === run) this.deps.worktreeSettles.delete(sessionId)
    })
    return run
  }

  async settleArchivedWorktreeNow(sessionId: string, archived: boolean): Promise<void> {
    const deps: ArchivedWorktreeDeps = {
      readWorktree: async id => worktreeRecordOf((await this.deps.getStorage()?.readSessionMeta(id))?.metadata?.worktree),
      writeWorktree: (id, record) => this.deps.patchSessionRecord(id, { worktree: record }),
      inUseElsewhere: async (id, dir) => {
        for (const other of this.deps.sessions.keys()) {
          if (other === id || this.deps.getFsSummaries().peek(other)?.archived) continue
          const cwd = this.deps.sessionTerminalCwd(other)
          if (cwd && insideFolder(cwd, dir)) return true
        }
        // A teammate was shut down by this archive; a child with its own
        // worktree works there, not here.
        for (const other of [...this.deps.getFsSummaries().keys()]) {
          const summary = this.deps.getFsSummaries().peek(other)
          if (other === id || summary?.parentSessionId !== id || summary.archived || isTeammateSessionId(other)) continue
          const meta = await this.deps.getStorage()?.readSessionMeta(other)
          if (!worktreeRecordOf(meta?.metadata?.worktree)) return true
        }
        return false
      },
      run: (id, cwd) =>
        managerHostCommand(
          {
            getTransport: () => this.deps.bridgeRouter.getDirectTransport(),
            createRequestId: () => this.deps.generateBridgeRequestId(),
          },
          id,
          cwd,
        ),
      now: () => Date.now(),
    }
    try {
      const outcome = archived
        ? await settleWorktreeOnArchive(deps, sessionId)
        : await settleWorktreeOnUnarchive(deps, sessionId)
      const line = archivedWorktreeLogLine(sessionId, outcome)
      if (line) console.info(`[SharedWorkerSessionManager] ${line}`)
    } catch (err) {
      console.warn(`[SharedWorkerSessionManager] worktree of ${sessionId} not settled`, err)
    }
  }

  /** A sub-agent, shell or other task the session started is still running. */
  hasLiveWorkFor(sessionId: string): boolean {
    for (const task of this.deps.taskRegistry.allLive()) {
      if ((task as { spawnerSessionId?: string }).spawnerSessionId === sessionId) return true
    }
    for (const teammate of this.deps.getTeams().listTeammatesOf(sessionId)) {
      if (teammate.status === 'active' || teammate.status === 'idle') return true
    }
    return false
  }
}

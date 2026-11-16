import type { SharedWorkerSessionManager } from './SharedWorkerSessionManager'

type Manager = SharedWorkerSessionManager

/** The manager state and callbacks background-row recovery reads; owned by the manager. */
export type BackgroundRowRecoveryDeps = {
  backgroundRecovered: Manager['backgroundRecovered']
  backgroundRecoveries: Manager['backgroundRecoveries']
  toolDetailLoader: Manager['toolDetailLoader']
  readPersistedEntries: Manager['readPersistedEntries']
}

/**
 * Contract: rebuilds a session's restart-recovered background drawer rows
 * from its persisted transcript, at most once per session per worker
 * lifetime. Best-effort; the claim sets belong to the manager.
 */
export class BackgroundRowRecovery {
  constructor(private readonly deps: BackgroundRowRecoveryDeps) {}

  /**
   * `task.recoverBackground`: rebuild the session's restart-recovered shell, run_js and SuperShell
   * drawer rows from its persisted transcript, at most once per session per lifetime. Best-effort.
   */
  async handleRecoverBackground(sessionId: string): Promise<void> {
    if (this.deps.backgroundRecovered.has(sessionId)) return
    // Claim eagerly so a rapid re-open can't run two concurrent recoveries…
    this.deps.backgroundRecovered.add(sessionId)
    const recovery = this.recoverBackgroundRows(sessionId)
    this.deps.backgroundRecoveries.set(sessionId, recovery)
    try {
      await recovery
    } finally {
      if (this.deps.backgroundRecoveries.get(sessionId) === recovery) {
        this.deps.backgroundRecoveries.delete(sessionId)
      }
    }
  }

  async recoverBackgroundRows(sessionId: string): Promise<void> {
    let messages: unknown[] = []
    try {
      // The request can precede the first `worker.init` (a pane restored open
      // on the session the window boots into); the read brings storage up.
      messages = await this.deps.readPersistedEntries(sessionId)
    } catch {
      // No storage backend: release the claim so the next request reads again.
      this.deps.backgroundRecovered.delete(sessionId)
      return
    }
    if (messages.length === 0) {
      // Nothing written yet; a later request reads what the session has by then.
      this.deps.backgroundRecovered.delete(sessionId)
      return
    }
    this.deps.toolDetailLoader.recoverRunJsRowsFromTranscript(sessionId, messages)
    this.deps.toolDetailLoader.recoverTitleRowsFromTranscript(sessionId, messages)
    // The shell rows need no sidecar: publish them now, synchronously, rather
    // than behind the SuperShell sidecar reads below (one per run, from
    // storage). Those reads name the `background: true` steps whose completion
    // notifications the shell rebuild leaves out — so the rows are rebuilt a
    // second time, minus those steps, once the reads have settled.
    this.deps.toolDetailLoader.recoverBashRowsFromTranscript(sessionId, messages)
    const superShellSteps = await this.deps.toolDetailLoader.recoverSuperShellRowsFromTranscript(
      sessionId,
      messages,
    )
    if (superShellSteps.size > 0) {
      this.deps.toolDetailLoader.recoverBashRowsFromTranscript(sessionId, messages, superShellSteps)
    }
    // The persisted transcript parts don't carry pass/fail — upgrade a
    // recovered row to 'error' from its tool-detail sidecar's isError.
    await this.deps.toolDetailLoader.markRecoveredTaskErrors(sessionId)
  }
}

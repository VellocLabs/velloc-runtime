/**
 * Names a session in the background once it has a real exchange and no
 * title. One attempt runs at a time, a failure is swallowed, and a manual
 * rename cancels the attempt: the latch is read again right before the
 * write, because a rename cancels before its own title is stored.
 */
import type { ConversationStore } from '../runtime/interfaces/ConversationStore'
import type { Message } from '../runtime/RuntimeTypes'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { getSessionMetadata, storeAutoTitle } from '../sessions/sessionStore'
import { proposeSessionTitle } from '../sessions/sessionTitles'
import { getActiveSessionManager } from '../browser/worker/SharedWorkerSessionManager'

/** The services the title writer reaches; replaceable for tests. */
export type TitleServices = {
  generateName: (rows: readonly Message[], context: ToolCallContext, signal: AbortSignal) => Promise<string | null>
  readMetadata: (store: ConversationStore) => Promise<{ customTitle?: string } | null | undefined>
  saveTitle: (title: string, store: ConversationStore) => Promise<void>
  refreshSidebar: (sessionId: string) => Promise<void>
}

const defaultTitleServices: TitleServices = {
  generateName: (rows, context, signal) => proposeSessionTitle(rows as Message[], context, signal),
  readMetadata: store => getSessionMetadata(store),
  saveTitle: (title, store) => storeAutoTitle(title, store),
  refreshSidebar: async sessionId => {
    await getActiveSessionManager()?.refreshSessionSummary(sessionId)
  },
}

export type TitleSubject = {
  readonly store: ConversationStore
  readonly rows: () => readonly Message[]
  readonly sessionId: () => string
}

export class SessionTitler {
  private readonly services: TitleServices
  private running = false
  private cancelLatch: AbortController | null = null

  constructor(private readonly subject: TitleSubject, overrides: Partial<TitleServices> = {}) {
    this.services = { ...defaultTitleServices, ...overrides }
  }

  /** Starts an attempt unless one is running. Never awaited by the turn. */
  start(context: ToolCallContext): void {
    if (this.running) return
    this.running = true
    const latch = new AbortController()
    this.cancelLatch = latch
    void this.attempt(context, latch)
  }

  /** Cancels the running attempt; a no-op when none runs. */
  cancel(): void {
    this.cancelLatch?.abort()
    this.cancelLatch = null
  }

  private async attempt(context: ToolCallContext, latch: AbortController): Promise<void> {
    const { store } = this.subject
    try {
      const before = await this.services.readMetadata(store)
      if (before?.customTitle) return
      if (!this.subject.rows().some(message => message.type === 'assistant')) return
      const name = await this.services.generateName(this.subject.rows(), context, latch.signal)
      if (!name) return
      // A rename that landed during the call wins.
      const after = await this.services.readMetadata(store)
      if (after?.customTitle) return
      if (latch.signal.aborted) return
      await this.services.saveTitle(name, store)
      await this.services.refreshSidebar(this.subject.sessionId())
    } catch {
      // The title is a nicety; its failure never reaches the turn.
    } finally {
      if (this.cancelLatch === latch) this.cancelLatch = null
      this.running = false
    }
  }
}

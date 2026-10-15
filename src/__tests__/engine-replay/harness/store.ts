import type { ConversationStore } from '../../../runtime/interfaces/ConversationStore'
import type { Message } from '../../../runtime/RuntimeTypes'
import { TraceRecorder, summarizeMessage } from './trace'

/**
 * A conversation store that keeps the session in memory and records every
 * write: the rows each `saveTranscriptRows` added or changed (a row whose kept
 * form differs from what was stored under its uuid is a rewrite), terminal
 * states, flushes, conversation resets and titles. Every turn hydrates from
 * it, as the production store does.
 */
export class RecordingStore implements ConversationStore {
  private rows: Message[] = []
  private readonly stored = new Map<string, string>()
  private title: { customTitle?: string; aiTitle?: string } = {}

  constructor(
    private readonly sessionId: string,
    private readonly recorder: TraceRecorder,
  ) {}

  private write(entry: Record<string, unknown>): void {
    this.recorder.trace.sessionWrites.push(entry)
  }

  async saveTranscriptRows(messages: readonly Message[]): Promise<void> {
    const added: unknown[] = []
    const rewritten: unknown[] = []
    for (const message of messages) {
      const summary = summarizeMessage(message)
      const json = JSON.stringify(summary)
      const uuid = typeof message.uuid === 'string' ? message.uuid : undefined
      if (uuid === undefined) {
        added.push(summary)
        continue
      }
      const before = this.stored.get(uuid)
      if (before === undefined) added.push(summary)
      else if (before !== json) rewritten.push(summary)
      this.stored.set(uuid, json)
    }
    this.rows = [...messages]
    if (added.length > 0 || rewritten.length > 0) {
      this.write({ op: 'record', ...(added.length ? { added } : {}), ...(rewritten.length ? { rewritten } : {}), total: messages.length })
    }
  }

  async hydrateMessagesForModel(): Promise<readonly Message[]> {
    return [...this.rows]
  }

  getRecordedMessages(): readonly Message[] {
    return this.rows
  }

  async drainWrites(): Promise<void> {
    this.write({ op: 'flush' })
  }

  getSessionId(): string {
    return this.sessionId
  }

  isEphemeral(): boolean {
    return false
  }

  async saveTerminalState(reason: string): Promise<void> {
    this.write({ op: 'terminal', reason })
  }

  async startNewConversation(): Promise<void> {
    this.rows = []
    this.stored.clear()
    this.write({ op: 'startNewConversation' })
  }

  async getSessionMetadata(): Promise<Record<string, unknown>> {
    return { ...this.title }
  }

  async storeUserTitle(customTitle: string, source: string): Promise<void> {
    this.title.customTitle = customTitle
    this.write({ op: 'customTitle', customTitle, source })
  }

  async storeAutoTitle(aiTitle: string): Promise<void> {
    this.title.aiTitle = aiTitle
    this.write({ op: 'aiTitle', aiTitle })
  }
}

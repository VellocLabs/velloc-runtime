import type { Message } from '../RuntimeTypes'

export interface ConversationStore {
  saveTranscriptRows(messages: readonly Message[]): Promise<void>
  drainWrites(): Promise<void>
  getSessionId(): string
  isEphemeral(): boolean
  saveTerminalState(reason: string, timestamp: number): Promise<void>
  /**
   * `/clear`: forget the conversation recorded so far, so the next
   * `saveTranscriptRows` starts a new one. Optional — a store that keeps no
   * copy of its own (it records whatever list it is handed) has nothing to
   * forget.
   */
  startNewConversation?(): Promise<void>
}

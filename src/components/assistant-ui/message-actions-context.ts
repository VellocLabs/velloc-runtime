import { createContext, useContext } from 'react'

/**
 * Per-message custom actions that aren't built-in assistant-ui primitives.
 * Provided by `AssistantUiThread` (bound to its session) and consumed by the
 * message action bars in `thread.tsx`. Kept in its own module so the thread
 * component and the host don't import each other (no cycle).
 */
export type MessageActionsContextValue = {
  /** Fork the conversation at the given message uuid into a new session. */
  onForkFromMessage?: (cutUuid: string) => void
  /**
   * Rewind the conversation to the given message uuid — restore to that point
   * and discard everything after (destructive). Implemented as fork-to-cut +
   * switch + delete-original.
   */
  onRewindToMessage?: (cutUuid: string) => void
  /**
   * Open a side chat cut at the given message uuid, with the selected text
   * quoted in its composer (F-36). Absent in a side chat itself.
   */
  onStartSideChat?: (cutUuid: string, selection: string) => void
  /** Retry a final provider API-error turn from its previous visible prompt. */
  onRetryProviderApiError?: (prompt: string) => void | Promise<void>
  /** Open the folder chooser that continues this chat in a Code session. */
  onRequestContinueInCode?: (toolCallId: string) => void
  /** Tool calls whose offer the user already took in this window. */
  continuedInCode?: ReadonlySet<string>
}

export const MessageActionsContext = createContext<MessageActionsContextValue>(
  {},
)

export function useMessageActionsContext(): MessageActionsContextValue {
  return useContext(MessageActionsContext)
}

import { createContext, useContext } from 'react'

import type { TurnTopicState } from '../../sessions/turnProtocol'

/**
 * One session's turn board as the page reads it (F-41): the plan and closing
 * published on `turn/<sessionId>`. `canReply` is false on a read-only thread;
 * the closing box then draws its question without buttons.
 */
export type TurnBoardValue = {
  /** Null until the session's state has landed (or with no connection). */
  state: TurnTopicState | null
  canReply: boolean
}

export const NO_TURN_BOARD: TurnBoardValue = { state: null, canReply: false }

export const TurnBoardContext = createContext<TurnBoardValue>(NO_TURN_BOARD)

export function useTurnBoardContext(): TurnBoardValue {
  return useContext(TurnBoardContext)
}

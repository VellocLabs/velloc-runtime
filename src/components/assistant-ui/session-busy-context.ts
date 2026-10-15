import { createContext, useContext } from 'react'

/**
 * "This session has a turn in flight", from the runtime client's own snapshot on the
 * session port, the transport the composer's Send/Stop gate rides. Not the
 * `session.currentStateChanged` phase, which can freeze mid-turn. True from turn dispatch
 * and across a provider retry.
 */
export const SessionBusyContext = createContext<boolean>(false)

export const SessionBusyProvider = SessionBusyContext.Provider

export function useSessionBusy(): boolean {
  return useContext(SessionBusyContext)
}

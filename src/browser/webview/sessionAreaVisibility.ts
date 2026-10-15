import { createContext, useContext } from 'react'

/**
 * Is the shell's session area on screen? Settings hides it without unmounting, so every window/document
 * keyboard handler in the tree must read this one flag and do nothing while hidden. Defaults to `true`
 * for a thread rendered outside the shell.
 */
export const SessionAreaVisibleContext = createContext<boolean>(true)

export function useSessionAreaVisible(): boolean {
  return useContext(SessionAreaVisibleContext)
}

import { createContext, useContext } from 'react'

/** True when the thread is drawn by a small-screen shell: the mod panes and
 *  the band above the prompt are left out so the conversation keeps the room. */
export const CompactThreadChromeContext = createContext(false)

export function useCompactThreadChrome(): boolean {
  return useContext(CompactThreadChromeContext)
}

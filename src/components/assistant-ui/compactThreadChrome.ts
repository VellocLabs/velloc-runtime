import { createContext, useContext } from 'react'

/** True when the thread is drawn by a small-screen shell: the mods' band
 *  above the prompt is left out so the conversation keeps the room. */
export const CompactThreadChromeContext = createContext(false)

export function useCompactThreadChrome(): boolean {
  return useContext(CompactThreadChromeContext)
}

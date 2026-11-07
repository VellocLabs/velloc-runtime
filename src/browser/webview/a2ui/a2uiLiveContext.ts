// The session's streaming-block reader, provided by the A2UI host (F-1).
// Dependency-free: the chat imports it before the host has loaded.

import { createContext, useContext } from 'react'
import type { A2uiLiveBlocks } from './a2uiLiveBlock'

export const A2uiLiveContext = createContext<A2uiLiveBlocks | null>(null)

export function useA2uiLiveBlocks(): A2uiLiveBlocks | null {
  return useContext(A2uiLiveContext)
}

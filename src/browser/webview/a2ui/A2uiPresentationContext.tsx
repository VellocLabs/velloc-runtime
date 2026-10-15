// Presentation state shared by the inline A2UI surfaces (rendered by the
// `a2ui_*` tool UIs) and the maximize overlay (in A2uiProviderHost).
//
// A surface is identified by surfaceId but can be mentioned by several
// tool-calls over a conversation (create, then updates). We render the LIVE
// surface only at the LATEST mention; older mentions render a "jump to latest"
// breadcrumb. This module derives that map from the transcript + holds the
// maximize + busy UI state.

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { Message } from '../../../runtime/RuntimeTypes'
import { deriveA2uiPresentation } from './surfaceStore'

export type A2uiPresentation = {
  /**
   * For each surfaceId, the toolCallId of its LATEST non-delete mention — only
   * that tool-call position renders the live surface.
   */
  latestToolCallIdBySurface: ReadonlyMap<string, string>
  /** surfaceIds whose net state is deleted — render nothing at every position. */
  deletedSurfaceIds: ReadonlySet<string>
  /**
   * The conversation is processing a turn — dim/disable surfaces so the user
   * sees that input is gated (one action per turn).
   */
  busy: boolean
  /** The surfaceId currently shown full-pane in the maximize overlay, or null. */
  maximizedSurfaceId: string | null
  setMaximizedSurfaceId: (surfaceId: string | null) => void
}

const A2uiPresentationContext = createContext<A2uiPresentation | null>(null)

export function useA2uiPresentation(): A2uiPresentation {
  const value = useContext(A2uiPresentationContext)
  if (!value) {
    throw new Error(
      'useA2uiPresentation must be used within an A2uiPresentationProvider',
    )
  }
  return value
}

/**
 * Like {@link useA2uiPresentation} but returns null instead of throwing when no
 * provider is present. Inline surfaces use this because they can briefly render
 * in a Suspense fallback tree (before the lazy A2uiProviderHost mounts the
 * provider) — there they must degrade to rendering nothing, never crash. They
 * re-render with the live surface once the provider is up.
 */
export function useA2uiPresentationOptional(): A2uiPresentation | null {
  return useContext(A2uiPresentationContext)
}

export function A2uiPresentationProvider({
  messages,
  busy,
  children,
}: {
  messages: readonly Message[]
  busy: boolean
  children: ReactNode
}) {
  const [maximizedSurfaceId, setMaximizedSurfaceId] = useState<string | null>(
    null,
  )

  const derived = useMemo(() => deriveA2uiPresentation(messages), [messages])

  // A maximized surface that gets deleted should close the overlay.
  const effectiveMaximized =
    maximizedSurfaceId && !derived.deletedSurfaceIds.has(maximizedSurfaceId)
      ? maximizedSurfaceId
      : null

  const value = useMemo<A2uiPresentation>(
    () => ({
      latestToolCallIdBySurface: derived.latestToolCallIdBySurface,
      deletedSurfaceIds: derived.deletedSurfaceIds,
      busy,
      maximizedSurfaceId: effectiveMaximized,
      setMaximizedSurfaceId,
    }),
    [derived, busy, effectiveMaximized],
  )

  return (
    <A2uiPresentationContext.Provider value={value}>
      {children}
    </A2uiPresentationContext.Provider>
  )
}

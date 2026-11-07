// Presentation state shared by the inline A2UI cards and the side pane content
// (in A2uiProviderHost) (F-1), including the block the model is still writing.
//
// Surfaces render in the side pane; each tool-call position in the
// conversation renders a card that opens its surface there. The pane's tabs,
// selection and open/close requests come from `stepA2uiPane`.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type { Message } from '../../../runtime/RuntimeTypes'
import { deriveA2uiPresentation, latestA2uiMentionTime } from './surfaceStore'
import {
  EMPTY_A2UI_PANE_STATE,
  dismissA2uiPane,
  paneSurfaceOrder,
  selectA2uiSurface,
  stepA2uiPane,
  type A2uiPaneState,
} from './a2uiPaneModel'
import { getOwner, getShownSession, onPaneClosed, requestPane, subscribeSlot } from './a2uiPaneBus'
import { withLiveMention, type A2uiLiveBlocks } from './a2uiLiveBlock'
/**
 * The presentation with an app's surfaces (F-40) as the first tabs, in their
 * build's order, the first shown when nothing is selected; `boardKey` (the
 * build's hash) is their mention, so a new build counts as an update.
 */
export function withAppBoard<T extends { latestMentionBySurface: ReadonlyMap<string, string>; deletedSurfaceIds: ReadonlySet<string> }>(
  derived: T,
  boardKey: string | undefined,
  boardIds: readonly string[],
): T & { preferred?: string } {
  if (boardKey === undefined || boardIds.length === 0) return derived
  const latestMentionBySurface = new Map<string, string>(boardIds.map(id => [id, `app:${boardKey}`]))
  for (const [id, key] of derived.latestMentionBySurface) if (!boardIds.includes(id)) latestMentionBySurface.set(id, key)
  const deletedSurfaceIds = new Set(derived.deletedSurfaceIds)
  for (const id of boardIds) deletedSurfaceIds.delete(id)
  return { ...derived, latestMentionBySurface, deletedSurfaceIds, preferred: boardIds[0] }
}

export type A2uiPresentation = {
  /** For each live surfaceId, the key of its latest mention. */
  latestMentionBySurface: ReadonlyMap<string, string>
  /** surfaceIds whose net state is deleted — render nothing at every position. */
  deletedSurfaceIds: ReadonlySet<string>
  /** A turn is running: surfaces are dimmed and take no input (one action per turn). */
  busy: boolean
  /** The pane's tabs, in first-creation order. */
  paneSurfaceIds: readonly string[]
  /** The surface the pane shows, or null when there is none. */
  selectedSurfaceId: string | null
  /** The side pane is drawn and shows this session's surface. */
  paneShown: boolean
  /** This session is the one the shell shows, so its pane can be opened. */
  paneAvailable: boolean
  /** Select `surfaceId` and open the pane on it. */
  openSurface: (surfaceId: string) => void
}

const LIVE_MENTION_WINDOW_MS = 2 * 60 * 1000

/** Whether an A2UI mention at `mentionedAt` (epoch ms) is recent enough to count as live. */
export function isRecentMention(mentionedAt: number | null, now = Date.now()): boolean {
  return mentionedAt !== null && now - mentionedAt < LIVE_MENTION_WINDOW_MS
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
 * Like {@link useA2uiPresentation} but returns null when no provider is
 * present: a card can render in a Suspense fallback before the lazy host mounts.
 */
export function useA2uiPresentationOptional(): A2uiPresentation | null {
  return useContext(A2uiPresentationContext)
}

const NO_BOARD_IDS: readonly string[] = []

export function A2uiPresentationProvider({
  sessionId,
  messages,
  busy,
  live,
  boardKey,
  boardIds = NO_BOARD_IDS,
  children,
}: {
  sessionId: string
  messages: readonly Message[]
  busy: boolean
  /** The block the model is writing: its surface shows before it is finished. */
  live?: A2uiLiveBlocks
  /** An app's build (F-40): its hash, and the surfaces it draws. */
  boardKey?: string
  boardIds?: readonly string[]
  children: ReactNode
}) {
  const fromTranscript = useMemo(() => deriveA2uiPresentation(messages), [messages])
  const readLive = useCallback(() => live?.snapshot() ?? null, [live])
  const subscribeLive = useCallback(
    (listener: () => void) => live?.subscribe(listener) ?? (() => {}),
    [live],
  )
  const liveBlock = useSyncExternalStore(subscribeLive, readLive, readLive)
  // What the transcript said of the live surface when its block started.
  const baseRef = useRef<{ blockKey: string; mention: string | undefined } | null>(null)
  if (liveBlock?.surfaceId && baseRef.current?.blockKey !== liveBlock.blockKey) {
    baseRef.current = {
      blockKey: liveBlock.blockKey,
      mention: fromTranscript.latestMentionBySurface.get(liveBlock.surfaceId),
    }
  }
  const withLive = useMemo(
    () => withLiveMention(fromTranscript, liveBlock, baseRef.current?.mention),
    [fromTranscript, liveBlock],
  )
  const derived = useMemo(() => withAppBoard(withLive, boardKey, boardIds), [withLive, boardKey, boardIds])
  const [pane, setPane] = useState<A2uiPaneState>(EMPTY_A2UI_PANE_STATE)
  const paneRef = useRef(pane)
  const commit = useCallback((next: A2uiPaneState) => {
    if (next === paneRef.current) return
    paneRef.current = next
    setPane(next)
  }, [])
  // The host mounts lazily, often after a fast turn has ended, so the first
  // derivation counts as live when a turn is running or the newest A2UI
  // mention is recent; a session loaded from disk replays without opening.
  const steppedRef = useRef(false)
  const busyRef = useRef(busy)
  busyRef.current = busy
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const liveRef = useRef(false)
  liveRef.current = withLive !== fromTranscript

  useEffect(() => {
    const isLive =
      liveRef.current ||
      steppedRef.current ||
      busyRef.current ||
      isRecentMention(latestA2uiMentionTime(messagesRef.current))
    steppedRef.current = true
    const step = stepA2uiPane(paneRef.current, derived, isLive)
    commit(step.state)
    if (step.open !== null) requestPane({ sessionId, open: step.open })
  }, [derived, sessionId, commit])

  useEffect(
    () =>
      onPaneClosed(closedId => {
        if (closedId === sessionId) commit(dismissA2uiPane(paneRef.current))
      }),
    [sessionId, commit],
  )

  const openSurface = useCallback(
    (surfaceId: string) => {
      commit(selectA2uiSurface(paneRef.current, surfaceId))
      requestPane({ sessionId, open: true, byPerson: true })
    },
    [sessionId, commit],
  )

  const paneOwner = useSyncExternalStore(subscribeSlot, getOwner, getOwner)
  const paneShown = paneOwner === sessionId
  const shownSession = useSyncExternalStore(subscribeSlot, getShownSession, getShownSession)
  const paneAvailable = shownSession === sessionId

  const value = useMemo<A2uiPresentation>(
    () => ({
      latestMentionBySurface: derived.latestMentionBySurface,
      deletedSurfaceIds: derived.deletedSurfaceIds,
      busy,
      paneSurfaceIds: paneSurfaceOrder(derived),
      selectedSurfaceId: pane.selected,
      paneShown,
      paneAvailable,
      openSurface,
    }),
    [derived, busy, pane.selected, paneShown, paneAvailable, openSurface],
  )

  return (
    <A2uiPresentationContext.Provider value={value}>
      {children}
    </A2uiPresentationContext.Provider>
  )
}

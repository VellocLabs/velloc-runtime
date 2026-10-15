import { useSyncExternalStore } from 'react'

import type { TranscriptSearchMatch } from '../bridge/protocol/search'

/**
 * State of the topbar transcript search, module-level so it outlives the popup; clearing the input
 * discards results, nothing persists to disk. Groups are kept in arrival order (the requested search order)
 * and never re-sorted.
 */

/** One session's hits, as one popup row + its flyout contents. */
export type TranscriptSearchGroup = {
  sessionId: string
  title: string
  /** Session kind (agent / chat / code), for the row's type icon. */
  templateType?: string
  /** The session's TITLE matched; `matches` may then be empty. */
  titleMatch?: boolean
  /** Session activity time (epoch ms) — rendered as a day. */
  updatedAt: number
  matches: TranscriptSearchMatch[]
}

export type TranscriptSearchUiState = {
  query: string
  regex: boolean
  caseSensitive: boolean
  /** The topbar control is an input box rather than a bare icon. */
  boxExpanded: boolean
  /** The results panel is showing. */
  popupOpen: boolean
  /** null = nothing searched yet (idle hint); [] = searched, no hits. */
  groups: TranscriptSearchGroup[] | null
  /** Sessions searched so far / in total, for the progress line. */
  scanned: number
  total: number
  running: boolean
  truncated: boolean
  /** Translated error text (never a raw protocol code). */
  error: string | null
  /** Monotonic across clears — see `nextTranscriptSearchGeneration`. */
  generation: number
  /** Session whose hit flyout is open. */
  expandedSessionId: string | null
  /**
   * The hit the user last opened, as `<sessionId>#<lineOrdinal>`.
   *
   * A jump moves the conversation behind the popup, and with a dozen
   * near-identical snippets in the list there is otherwise nothing that
   * says which one you are looking at — so clicking through hits one by
   * one means losing your place after the first click.
   */
  selectedHitKey: string | null
  /** Keyboard cursor over the session rows. */
  selectedSessionId: string | null
}

const IDLE_STATE: TranscriptSearchUiState = {
  query: '',
  regex: false,
  caseSensitive: false,
  boxExpanded: false,
  popupOpen: false,
  groups: null,
  scanned: 0,
  total: 0,
  running: false,
  truncated: false,
  error: null,
  generation: 0,
  expandedSessionId: null,
  selectedHitKey: null,
  selectedSessionId: null,
}

let state: TranscriptSearchUiState = IDLE_STATE
const listeners = new Set<() => void>()

// Never reset, not even by a clear: a response from before the clear must never be adopted by a search
// issued after it.
let generationCounter = 0

function emit(): void {
  for (const listener of listeners) listener()
}

function setState(partial: Partial<TranscriptSearchUiState>): void {
  state = { ...state, ...partial }
  emit()
}

export function getTranscriptSearchState(): TranscriptSearchUiState {
  return state
}

export function subscribeTranscriptSearch(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useTranscriptSearchState(): TranscriptSearchUiState {
  return useSyncExternalStore(
    subscribeTranscriptSearch,
    getTranscriptSearchState,
    getTranscriptSearchState,
  )
}

/** Allocates the next generation. Strictly increasing for the page's life. */
export function nextTranscriptSearchGeneration(): number {
  generationCounter += 1
  return generationCounter
}

// ---- input + toggles -------------------------------------------------------

export function setTranscriptSearchQuery(query: string): void {
  if (query === '') {
    clearTranscriptSearchResults()
    return
  }
  setState({ query, popupOpen: true, boxExpanded: true })
}

export function setTranscriptSearchOption(
  option: 'regex' | 'caseSensitive',
  value: boolean,
): void {
  setState({ [option]: value } as Partial<TranscriptSearchUiState>)
}

/**
 * The user emptied the input: results are discarded, but the box stays
 * open (they are still typing in it). Bumps the generation so an in-flight
 * chunk can never repopulate what was just cleared.
 */
export function clearTranscriptSearchResults(): void {
  generationCounter += 1
  setState({
    query: '',
    groups: null,
    scanned: 0,
    total: 0,
    running: false,
    truncated: false,
    error: null,
    generation: generationCounter,
    expandedSessionId: null,
  selectedHitKey: null,
    selectedSessionId: null,
  })
}

// ---- popup / box lifecycle -------------------------------------------------

export function openTranscriptSearchBox(): void {
  setState({
    boxExpanded: true,
    // Always open the panel. With a previous query it restores those
    // results (they were never discarded); with an empty box it is what
    // surfaces recent searches, so gating it on a non-empty query made
    // the history unreachable.
    popupOpen: true,
  })
}

/**
 * Focus moved away, or Escape. The popup goes; the box survives as long as
 * it still holds a query, which is what lets the user click back into it
 * and get the previous results again. With an empty query there is nothing
 * to come back to, so the control collapses to its icon.
 */
export function closeTranscriptSearchPopup(): void {
  setState({
    popupOpen: false,
    expandedSessionId: null,
  selectedHitKey: null,
    boxExpanded: state.query !== '',
  })
}

/** Explicit dismissal (the X): always back to the bare icon. */
export function dismissTranscriptSearch(): void {
  generationCounter += 1
  state = { ...IDLE_STATE, generation: generationCounter }
  emit()
}

/** Key identifying one hit within the result list. */
export function searchHitKey(sessionId: string, lineOrdinal: number): string {
  return `${sessionId}#${lineOrdinal}`
}

/** Marks the hit the user just opened, so the list shows where they are. */
export function setSelectedSearchHit(key: string | null): void {
  setState({ selectedHitKey: key })
}

export function setExpandedSearchSession(sessionId: string | null): void {
  setState({
    expandedSessionId: sessionId,
    selectedSessionId: sessionId,
    // A different session's hits are a different list; the old selection
    // would point at a row that is no longer on screen.
    selectedHitKey: null,
  })
}

export function setSelectedSearchSession(sessionId: string | null): void {
  setState({ selectedSessionId: sessionId })
}

// ---- streaming search lifecycle -------------------------------------------

/** Arms a new search. Results arrive chunk by chunk via `appendChunk`. */
export function beginTranscriptSearch(
  generation: number,
  total: number,
): void {
  setState({
    generation,
    groups: [],
    scanned: 0,
    total,
    running: true,
    truncated: false,
    error: null,
    expandedSessionId: null,
  selectedHitKey: null,
    selectedSessionId: null,
  })
}

/**
 * Appends one chunk's groups. Chunks are issued front-to-back over the
 * priority-ordered target list and awaited in sequence, so appending
 * preserves that order — the popup can render immediately and grow
 * downward without ever reordering what the user is already reading.
 * Ignored outright when a newer search has started.
 */
export function appendTranscriptSearchChunk(
  generation: number,
  chunk: {
    groups: TranscriptSearchGroup[]
    scanned: number
    truncated?: boolean
  },
): void {
  if (generation !== state.generation) return
  setState({
    groups: [...(state.groups ?? []), ...chunk.groups],
    scanned: state.scanned + chunk.scanned,
    truncated: state.truncated || Boolean(chunk.truncated),
  })
}

export function finishTranscriptSearch(generation: number): void {
  if (generation !== state.generation) return
  setState({ running: false })
}

export function failTranscriptSearch(
  generation: number,
  message: string,
): void {
  if (generation !== state.generation) return
  setState({ running: false, error: message, groups: state.groups ?? [] })
}

/** Test seam: restore the pristine state without touching the counter. */
export function resetTranscriptSearchStateForTests(): void {
  state = { ...IDLE_STATE, generation: generationCounter }
  emit()
}

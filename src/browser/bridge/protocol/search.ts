/**
 * The `search` capability — native span-index search over session transcripts.
 * The caller supplies the ordered transcripts, one slice per request; matching
 * covers classified text ranges only. Discard a response whose `generation` is not the latest.
 */

export type TranscriptSearchSpanKind =
  | 'userText'
  | 'assistantText'
  /** A host notice the transcript records as its own line — "User has
   *  approved exiting plan mode…", interrupts, and similar. */
  | 'systemText'
  | 'toolCall'
  | 'toolResult'

export type TranscriptSearchMatch = {
  /** Session directory name under the project dir. */
  sessionId: string
  /** Sanitized project directory name under the projects root. */
  projectDir: string
  /** Absolute path of the matched transcript.jsonl. */
  transcriptPath: string
  /** 0-based physical line number in the transcript file. */
  lineOrdinal: number
  /** Top-level `uuid` of the matched message line — the jump anchor.
   *  Empty when the line carried none. */
  messageUuid: string
  spanKind: TranscriptSearchSpanKind
  /** Context around the hit, JSON-unescaped, single-line. */
  snippet: string
  /** Byte offsets of the hit within `snippet`. */
  matchStart: number
  matchLen: number
}

export type TranscriptSearchResponse = {
  /** The client keystroke counter echoed back verbatim. */
  generation: number
  /** True when a newer query preempted this one server-side; matches
   *  may be partial and the response should be dropped. */
  superseded: boolean
  truncated: boolean
  skippedFiles: number
  matches: TranscriptSearchMatch[]
}

export type SearchBridgeActionMap = {
  queryTranscripts: {
    payload: {
      /** Absolute transcript.jsonl paths to search, IN PRIORITY ORDER.
       *  The host walks them exactly as given — it never enumerates or
       *  re-sorts — so the caller owns relevance. Callers stream by
       *  sending one slice of the ordered list per request. */
      targets: string[]
      query: string
      regex?: boolean
      caseSensitive?: boolean
      /** Total cap; host default 500, ceiling 2000. Per-file cap of 10
       *  is fixed host-side. */
      maxResults?: number
      /** Client keystroke counter, echoed in the response. */
      generation: number
    }
    result: TranscriptSearchResponse
  }
}

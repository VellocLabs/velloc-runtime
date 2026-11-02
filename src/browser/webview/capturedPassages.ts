/**
 * Captured passages: transcript text held as quote cards above the composer
 * and sent ahead of the person's words (F-22). A passage is a text copy, never
 * a link back to its message; the card shows an excerpt, the prompt the body.
 * One serializer writes the sent prompt and the saved draft and one parser
 * reads both, so a reload, a fork prefill and a sent row restore the same
 * cards.
 */

import { randomUuid } from '../../utils/randomUuid'
import { utf8ByteLength } from '../../utils/utf8ByteLength'

/** Where a passage was taken from; local only, never sent. */
export type PassageAnchor = {
  threadKey: string
  entryKey: string
}

export type CapturedPassage = {
  passageKey: string
  /** `note`: the person's reply to this passage, one line, never blank when present. */
  payload: { media: 'text/plain'; body: string; note?: string }
  capture: {
    method: 'range' | 'entry-content'
    at: number
    anchors: PassageAnchor[]
  }
}

export type CaptureRequest = {
  body: string
  note?: string
  method: CapturedPassage['capture']['method']
  anchors: PassageAnchor[]
}

/** A passage as the wire form carries it: the body alone, or the body with a reply note. */
export type QuotedPassage = string | { body: string; note: string }

export function quotedBody(passage: QuotedPassage): string {
  return typeof passage === 'string' ? passage : passage.body
}

export function quotedNote(passage: QuotedPassage): string | null {
  return typeof passage === 'string' ? null : passage.note
}

/** Longest reply note, in UTF-16 code units. */
export const PASSAGE_NOTE_MAX_UTF16 = 4000

/** A reply note as stored: line breaks folded to spaces, trimmed; null when blank. */
export function normalizePassageNote(note: string | null | undefined): string | null {
  const folded = (note ?? '').replace(/[\r\n]+/g, ' ').trim()
  return folded ? folded.slice(0, PASSAGE_NOTE_MAX_UTF16) : null
}

/** A draft passage in its wire shape. */
export function passageAsQuoted(passage: CapturedPassage): QuotedPassage {
  const { body, note } = passage.payload
  return note ? { body, note } : body
}

/** Longest passage, in UTF-16 code units. */
export const PASSAGE_MAX_UTF16 = 100_000
/** Longest passage, in UTF-8 bytes. */
export const PASSAGE_MAX_UTF8_BYTES = 256 * 1024
/** Most passages one draft holds. */
export const DRAFT_MAX_PASSAGES = 20
/** Most UTF-8 bytes all of one draft's passages hold together. */
export const DRAFT_MAX_PASSAGE_BYTES = 1024 * 1024
/** Grapheme clusters a card's excerpt shows. */
export const PASSAGE_EXCERPT_GRAPHEMES = 240
/** Shortest attachable selection, trimmed, in UTF-16 code units. */
export const ATTACH_MIN_UTF16 = 2

export type PassageRefusal = 'too-short' | 'too-long' | 'too-many' | 'draft-too-large'

/** Whether a selection is long enough to attach: two UTF-16 units once trimmed. */
export function isAttachableSelection(text: string): boolean {
  return text.trim().length >= ATTACH_MIN_UTF16
}

/** Whether a selection is worth copying: anything but whitespace. */
export function isCopyableSelection(text: string): boolean {
  return text.trim().length > 0
}

/**
 * Whether `body` may join a draft already holding `existing`. Never trims or
 * shortens: an oversized passage is refused whole.
 */
export function admitPassage(
  existing: readonly CapturedPassage[],
  body: string,
): { ok: true } | { ok: false; reason: PassageRefusal } {
  if (body.trim().length === 0) return { ok: false, reason: 'too-short' }
  if (body.length > PASSAGE_MAX_UTF16) return { ok: false, reason: 'too-long' }
  const bytes = utf8ByteLength(body)
  if (bytes > PASSAGE_MAX_UTF8_BYTES) return { ok: false, reason: 'too-long' }
  if (existing.length >= DRAFT_MAX_PASSAGES) return { ok: false, reason: 'too-many' }
  const held = existing.reduce((sum, passage) => sum + utf8ByteLength(passage.payload.body), 0)
  if (held + bytes > DRAFT_MAX_PASSAGE_BYTES) return { ok: false, reason: 'draft-too-large' }
  return { ok: true }
}

let passageCounter = 0

function newPassageKey(): string {
  passageCounter += 1
  return `passage-${randomUuid()}-${passageCounter}`
}

export function createPassage(request: CaptureRequest, at: number = Date.now()): CapturedPassage {
  const note = normalizePassageNote(request.note)
  return {
    passageKey: newPassageKey(),
    payload: { media: 'text/plain', body: request.body, ...(note ? { note } : {}) },
    capture: { method: request.method, at, anchors: [...request.anchors] },
  }
}

// C0/C1 controls other than tab and line breaks, plus bidi overrides and
// isolates that could reorder the card's text. Zero-width joiners stay: they
// hold emoji sequences together.
const LAYOUT_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F‪-‮⁦-⁩]/g

function splitGraphemes(text: string): string[] {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter
  if (typeof Segmenter === 'function') {
    return Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(text), s => s.segment)
  }
  // Code points, with combining marks, variation selectors and ZWJ sequences
  // kept on their base.
  const out: string[] = []
  for (const char of Array.from(text)) {
    const previous = out[out.length - 1]
    const joinsPrevious =
      previous !== undefined &&
      (/^[̀-ͯ᪰-᫿⃐-⃿︀-️\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]$/u.test(char) ||
        previous.endsWith('‍') ||
        char === '‍')
    if (joinsPrevious) out[out.length - 1] = previous + char
    else out.push(char)
  }
  return out
}

/**
 * A card's excerpt: layout controls dropped, whitespace runs folded to one
 * space, at most {@link PASSAGE_EXCERPT_GRAPHEMES} grapheme clusters plus an
 * ellipsis. Display only — the body is never changed.
 */
export function passageExcerpt(body: string, maxGraphemes: number = PASSAGE_EXCERPT_GRAPHEMES): string {
  // Only a bounded prefix is read: a 100k-unit body is never walked whole for
  // a 240-cluster card.
  const limit = maxGraphemes * 32
  const cut = body.length > limit
  const folded = body.slice(0, limit).replace(LAYOUT_CONTROL_RE, '').replace(/\s+/g, ' ').trim()
  const graphemes = splitGraphemes(folded)
  if (!cut && graphemes.length <= maxGraphemes) return folded
  // A cut prefix may end inside a cluster (or a surrogate pair): its last one is never shown.
  const whole = cut ? graphemes.slice(0, -1) : graphemes
  return `${whole.slice(0, maxGraphemes).join('')}…`
}

// ---------------------------------------------------------------------------
// Wire form
// ---------------------------------------------------------------------------

const PASSAGE_HEADER_RE = /^\[Quoted context (\d+)\]$/
const WORDS_HEADER = '[User message]'
const NOTE_PREFIX = '[Reply] '

function passageHeader(index: number): string {
  return `[Quoted context ${index}]`
}

function quoteLines(body: string): string {
  return body
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => (line === '' ? '>' : `> ${line}`))
    .join('\n')
}

/**
 * The text a prompt (or a saved draft) carries for `passages` and `words`:
 * each passage under a numbered header as `> ` lines, its reply note (if any)
 * on one `[Reply] ` line after them, then the words under their own header.
 * No passages: the words alone, unchanged. Line breaks are normalised to LF;
 * nothing else in a body is rewritten.
 */
export function serializePassagePrompt(passages: readonly QuotedPassage[], words: string): string {
  const kept = passages.filter(passage => quotedBody(passage).trim().length > 0)
  if (kept.length === 0) return words
  const blocks = kept.map((passage, index) => {
    const note = normalizePassageNote(quotedNote(passage))
    const quoted = `${passageHeader(index + 1)}\n${quoteLines(quotedBody(passage))}`
    return note ? `${quoted}\n${NOTE_PREFIX}${note}` : quoted
  })
  if (words.length > 0) blocks.push(`${WORDS_HEADER}\n${words}`)
  return blocks.join('\n\n')
}

/**
 * Reads {@link serializePassagePrompt}'s form back. Anything that does not
 * follow it exactly, from the first line on, is all words and no passages.
 */
export function splitPassagePrompt(text: string): { passages: QuotedPassage[]; words: string } {
  const none = { passages: [], words: text }
  const normalized = text.replace(/\r\n?/g, '\n')
  if (!normalized.startsWith(passageHeader(1))) return none
  const lines = normalized.split('\n')
  const passages: QuotedPassage[] = []
  let index = 0
  while (index < lines.length) {
    const header = PASSAGE_HEADER_RE.exec(lines[index] ?? '')
    if (!header || Number(header[1]) !== passages.length + 1) break
    index++
    const body: string[] = []
    while (index < lines.length) {
      const line = lines[index] ?? ''
      if (line === '>') body.push('')
      else if (line.startsWith('> ')) body.push(line.slice(2))
      else break
      index++
    }
    if (body.length === 0) return none
    const noteLine = lines[index] ?? ''
    const note = noteLine.startsWith(NOTE_PREFIX) ? normalizePassageNote(noteLine.slice(NOTE_PREFIX.length)) : null
    if (note !== null) index++
    passages.push(note === null ? body.join('\n') : { body: body.join('\n'), note })
    if (index >= lines.length) return { passages, words: '' }
    if (lines[index] !== '') return none
    index++
  }
  if (passages.length === 0) return none
  if (index >= lines.length) return { passages, words: '' }
  if (lines[index] !== WORDS_HEADER) return none
  return { passages, words: lines.slice(index + 1).join('\n') }
}

/**
 * Several prompts sent as one turn: every passage, in order, ahead of every
 * prompt's words joined by newlines. Prompts with no passages join unchanged.
 */
export function joinPassagePrompts(prompts: readonly string[]): string {
  const split = prompts.map(splitPassagePrompt)
  if (split.every(part => part.passages.length === 0)) return prompts.join('\n')
  return serializePassagePrompt(
    split.flatMap(part => part.passages),
    split.map(part => part.words).filter(words => words.length > 0).join('\n'),
  )
}

/**
 * Gives a sent prompt back to a composer: its passages go to `store` as
 * cards, ahead of any already there; returns the words for the text box.
 * With no store the prompt comes back whole.
 */
export function handBackPrompt(store: PassageDraftStore | null | undefined, prompt: string): string {
  if (!store) return prompt
  const { passages, words } = splitPassagePrompt(prompt)
  store.prepend(passages)
  return words
}

/** The text a send carries, as `markComposerSend` / `takeForSend` compare it: its text parts, newline-joined. */
export function composerSendText(content: readonly { type: string; text?: string }[]): string {
  return content.flatMap(part => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : [])).join('\n')
}

// ---------------------------------------------------------------------------
// Draft store
// ---------------------------------------------------------------------------

export type PassageDraftStore = {
  getPassages: () => readonly CapturedPassage[]
  subscribe: (listener: () => void) => () => void
  /** Adds a passage; refused (and nothing changes) past a limit. */
  add: (request: CaptureRequest) => { ok: true; passage: CapturedPassage } | { ok: false; reason: PassageRefusal }
  remove: (passageKey: string) => void
  /** Replaces every passage (a draft restore). */
  replace: (bodies: readonly QuotedPassage[]) => void
  /** Marks the composer's own send of `text` (its text parts, newline-joined). */
  markComposerSend: (text: string) => void
  /**
   * Empties the draft's passages and returns them when the composer marked a
   * send of exactly `text`; any other send (a slash command, an answer, an
   * append after a send that never arrived) takes nothing. Clears the mark.
   */
  takeForSend: (text: string) => CapturedPassage[]
  /** Empties the draft's passages and returns them. */
  take: () => CapturedPassage[]
  /**
   * Puts back passages a send took, ahead of any added since; a passage
   * already present (same key) is not doubled.
   */
  restore: (taken: readonly CapturedPassage[]) => void
  /** Adds passages read back from a prompt ahead of any present. */
  prepend: (bodies: readonly QuotedPassage[]) => void
}

function passageFromQuoted(passage: QuotedPassage): CapturedPassage {
  const note = quotedNote(passage)
  return createPassage({ body: quotedBody(passage), ...(note ? { note } : {}), method: 'range', anchors: [] })
}

export function createPassageDraftStore(): PassageDraftStore {
  let passages: readonly CapturedPassage[] = []
  let composerSend: string | null = null
  const listeners = new Set<() => void>()
  const set = (next: readonly CapturedPassage[]) => {
    passages = next
    for (const listener of listeners) listener()
  }
  return {
    getPassages: () => passages,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    add(request) {
      const verdict = admitPassage(passages, request.body)
      if (!verdict.ok) return verdict
      const passage = createPassage(request)
      set([...passages, passage])
      return { ok: true, passage }
    },
    remove(passageKey) {
      if (!passages.some(passage => passage.passageKey === passageKey)) return
      set(passages.filter(passage => passage.passageKey !== passageKey))
    },
    replace(bodies) {
      if (bodies.length === 0 && passages.length === 0) return
      set(bodies.map(passageFromQuoted))
    },
    markComposerSend(text) {
      composerSend = text
    },
    takeForSend(text) {
      const marked = composerSend
      composerSend = null
      return marked === text ? this.take() : []
    },
    take() {
      const taken = [...passages]
      if (taken.length > 0) set([])
      return taken
    },
    restore(taken) {
      if (taken.length === 0) return
      const present = new Set(passages.map(passage => passage.passageKey))
      const back = taken.filter(passage => !present.has(passage.passageKey))
      if (back.length === 0) return
      set([...back, ...passages])
    },
    prepend(bodies) {
      if (bodies.length === 0) return
      set([...bodies.map(passageFromQuoted), ...passages])
    },
  }
}

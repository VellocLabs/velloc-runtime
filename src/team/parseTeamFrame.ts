/**
 * Parse a rendered mailbox frame back into its parts (inverse of
 * `renderTeamFrame`) for the transcript card. Parsing only: the reported `trust`
 * is what the renderer decided, never re-derived.
 */
import type { TeamMessageKind, TeamMessageTrust } from './teamTypes'

export type ParsedTeamMessage = {
  /** The sender's member KEY, as `renderTeamFrame` wrote it. */
  from: string
  /** The sender's display name (any language); equals `from` when the frame
   *  carried none — the lead, or a frame from before display names. */
  fromDisplay: string
  trust: TeamMessageTrust
  kind: TeamMessageKind
  /** The peer's own text, with the envelope stripped. */
  body: string
}

const KINDS: readonly string[] = ['message', 'turn_end', 'shutdown', 'system']

/** `renderTeamFrame`'s untrusted envelope: an opening tag, four instruction
 *  lines addressed to the model, `---`, the body, `---`, the closing tag. */
const UNTRUSTED = /^<team-message from="([^"]*)"(?: display="([^"]*)")? trust="untrusted" kind="([a-z_]+)">\n([\s\S]*?)\n---\n([\s\S]*)\n---\n<\/team-message>$/

/**
 * The trusted form: `[message from <key>]: body`, or
 * `[message from <display> (<key>)]: body` when the sender has a display
 * name. The display part is any text without `]` or a newline (the renderer
 * strips those, and `( )`, from names); it is matched lazily so the trailing
 * ` (<key>)` — whose alphabet is the key's own — is taken as the key when
 * present, and a header with no parenthesised key reads as key-only.
 */
const TRUSTED = /^\[message from ([^\]\n]{1,64}?)(?: \(([A-Za-z0-9_\- ]{1,64})\))?\]: ([\s\S]*)$/

/**
 * The frame behind a turn's text, or null when the text is not one.
 *
 * Null is the common case — this runs over every user turn — so the cheap
 * prefix checks come first.
 */
export function parseTeamMessageEnvelope(text: string): ParsedTeamMessage | null {
  const trimmed = text.trim()
  if (trimmed.startsWith('<team-message ')) {
    const match = UNTRUSTED.exec(trimmed)
    if (!match) return null
    const kind = match[3]
    const from = match[1] || 'unknown'
    return {
      from,
      fromDisplay: match[2] || from,
      trust: 'untrusted',
      kind: (KINDS.includes(kind) ? kind : 'message') as TeamMessageKind,
      body: match[5],
    }
  }
  if (trimmed.startsWith('[message from ')) {
    const match = TRUSTED.exec(trimmed)
    if (!match) return null
    // The trusted form carries no kind — it is the plain "a peer said this"
    // shape, which is what `message` means.
    const key = match[2]
    return {
      from: key ?? match[1],
      fromDisplay: match[1],
      trust: 'trusted',
      kind: 'message',
      body: match[3],
    }
  }
  return null
}

/**
 * Parse a Codex rollout `.jsonl` into the session header and ordered
 * `response_item`s: WRAPPED lines `{ timestamp, type, payload }` (`event_msg`
 * ignored) or legacy FLAT lines (bare SessionMeta first, `record_type: "state"`
 * skipped). Pure.
 */

import { asRecord, asString } from '../../core/json'
import { promptToTitle } from '../../core/sessionTitle'

export type CodexResponseItem = { type: string; [key: string]: unknown }

export type CodexSessionMeta = {
  id: string | null
  cwd: string | null
  timestamp: string | null
  /** Model of the (first) turn, from `turn_context`. */
  model: string | null
}

export type ParsedRollout = {
  items: Array<{ item: CodexResponseItem; timestamp: string | null }>
  meta: CodexSessionMeta
  lines: number
  skippedLines: number
}

export function parseRollout(text: string): ParsedRollout {
  const meta: CodexSessionMeta = {
    id: null,
    cwd: null,
    timestamp: null,
    model: null,
  }
  const items: ParsedRollout['items'] = []
  let lines = 0
  let skippedLines = 0

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    lines++
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      // A truncated final line (or a corrupt record) is skipped, never fatal.
      skippedLines++
      continue
    }

    const type = asString(parsed.type)
    const payload = asRecord(parsed.payload)

    // WRAPPED line: { timestamp, type, payload }
    if (type && payload) {
      const timestamp = asString(parsed.timestamp)
      switch (type) {
        case 'session_meta':
          meta.id = asString(payload.id) ?? meta.id
          meta.cwd = asString(payload.cwd) ?? meta.cwd
          meta.timestamp = asString(payload.timestamp) ?? meta.timestamp
          break
        case 'turn_context':
          if (!meta.model) meta.model = asString(payload.model)
          break
        case 'response_item':
          if (asString(payload.type)) {
            items.push({ item: payload as CodexResponseItem, timestamp })
          }
          break
        // event_msg / compacted / world_state → not part of the model transcript.
        default:
          break
      }
      continue
    }

    // FLAT line: a top-level ResponseItem (has `type`, no `payload`).
    if (type) {
      items.push({
        item: parsed as CodexResponseItem,
        timestamp: asString(parsed.timestamp),
      })
      continue
    }

    // FLAT line: a bare SessionMeta (`{ id, timestamp, cwd?, ... }`, no `type`).
    // `{ record_type: "state" }` markers and anything else fall through as noise.
    if (parsed.record_type === undefined && asString(parsed.id)) {
      meta.id = asString(parsed.id) ?? meta.id
      meta.cwd = asString(parsed.cwd) ?? meta.cwd
      meta.timestamp = asString(parsed.timestamp) ?? meta.timestamp
    }
  }

  return { items, meta, lines, skippedLines }
}

/** A user text block the model never sees as a real prompt: an IDE/context
 *  preamble opening with a lowercase XML-like tag, or an IDE header line. The
 *  converter marks these `isMeta` and the title pass skips them — one predicate
 *  so a hidden preamble can never become the session title. */
export function isSyntheticUserText(text: string): boolean {
  return /^\s*<[a-z]/.test(text) || text.startsWith('# Context from')
}

/** The first real user prompt across a rollout's items — for the session
 *  title. Shared by the converter and the lite pass so a post-import title
 *  never drifts from the dialog row, and skips the same synthetic preambles
 *  the converter hides. */
export function firstUserPrompt(
  items: ReadonlyArray<{ item: CodexResponseItem }>,
): string | null {
  for (const { item } of items) {
    if (item.type !== 'message' || asString(item.role) !== 'user') continue
    const content = Array.isArray(item.content) ? item.content : []
    for (const block of content) {
      const rec = asRecord(block)
      if (rec?.type === 'input_text' && typeof rec.text === 'string') {
        if (isSyntheticUserText(rec.text)) continue
        const candidate = promptToTitle(rec.text)
        if (candidate && 'title' in candidate) return candidate.title
      }
    }
  }
  return null
}

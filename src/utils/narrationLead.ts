/**
 * Whether a run's narration is short enough to be the run's own line, with
 * the chevron after it. Anything with more than one block — a second
 * paragraph, a list, a heading, a table, a fenced block — stays ordinary
 * prose above the run's summary line.
 */
export const NARRATION_LEAD_MAX_CHARS = 280

export function isCompactNarration(text: string | undefined): boolean {
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  if (trimmed.length === 0 || trimmed.length > NARRATION_LEAD_MAX_CHARS) {
    return false
  }
  if (trimmed.includes('```')) return false
  const lines = trimmed.split(/\r?\n/)
  if (lines.some((line) => line.trim().length === 0)) return false
  return !lines.some(
    (line) =>
      /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\|)/.test(line) ||
      // A setext underline, a thematic break, or a table's delimiter row.
      /^\s*(=+|[-*_](\s*[-*_]){2,})\s*$/.test(line) ||
      /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line),
  )
}

/**
 * One-line headline for a proposed plan: its first non-empty line with any
 * markdown heading marks, list marker or emphasis stripped. Empty when the
 * plan has no text. Capped at {@link PLAN_HEADLINE_MAX} characters.
 */
export const PLAN_HEADLINE_MAX = 200

export function planHeadline(planText: string | undefined | null): string {
  if (!planText) return ''
  for (const raw of planText.split(/\r?\n/)) {
    const line = raw
      .trim()
      .replace(/^#{1,6}\s+/, '')
      .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/\*\*|__|`/g, '')
      .trim()
    if (line) {
      return line.length > PLAN_HEADLINE_MAX
        ? `${line.slice(0, PLAN_HEADLINE_MAX - 1)}…`
        : line
    }
  }
  return ''
}

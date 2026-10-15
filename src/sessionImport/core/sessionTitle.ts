/**
 * Title derivation shared by every import source: turns one user prompt into
 * a row title, and picks the session title from the candidates a source has.
 */

/** Longest prompt text kept in a title before it is cut with an ellipsis. */
export const PROMPT_TITLE_LIMIT = 200

export type PromptTitle = { title: string } | { command: string }

// Transcript-format shapes (external format, recognised only here).
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/
const SHELL_INPUT = /<bash-input>([\s\S]*?)<\/bash-input>/
const MARKUP_START = /^\s*<[a-z][\w-]*[\s>]/
const INTERRUPT_MARKER = /^\s*\[Request interrupted by user[^\]]*\]/

/**
 * One prompt → a title, a slash-command name to fall back on, or `null` when
 * the text is empty or a synthetic (non-human) line.
 */
export function promptToTitle(raw: string): PromptTitle | null {
  const text = raw.replace(/\n/g, ' ').trim()
  if (!text) return null

  const cmd = COMMAND_NAME.exec(text)
  if (cmd) return { command: cmd[1] }

  const shell = SHELL_INPUT.exec(text)
  if (shell) return { title: `! ${shell[1].trim()}` }

  if (MARKUP_START.test(text) || INTERRUPT_MARKER.test(text)) return null

  if (text.length > PROMPT_TITLE_LIMIT) {
    return { title: `${text.slice(0, PROMPT_TITLE_LIMIT).trim()}…` }
  }
  return { title: text }
}

export interface SessionTitleCandidates {
  customTitle?: string | null
  aiTitle?: string | null
  lastPrompt?: string | null
  summary?: string | null
  firstPrompt?: string | null
}

/**
 * The session title: first non-empty of custom, AI, last prompt, summary,
 * first prompt. Used by both the list pass and the full conversion so the
 * imported title equals its list row.
 */
export function pickSessionTitle(c: SessionTitleCandidates): string | null {
  for (const v of [c.customTitle, c.aiTitle, c.lastPrompt, c.summary, c.firstPrompt]) {
    if (v) return v
  }
  return null
}

/**
 * The `instructions` an MCP server returns at initialize, as the model may
 * see them (F-10).
 * Security: the text is the server's, not ours. It is cut to a fixed size
 * and stripped of control characters here, once, so every consumer (the
 * system prompt, the server's Skill description) renders the same bounded
 * text; the prompt renderer further fences it as data.
 */

/** Longest instructions text a server may contribute, in characters. */
export const MCP_INSTRUCTIONS_MAX_CHARS = 4096

// Control characters other than tab and newline.
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

/** The usable text of a server's instructions, or undefined when there is none. */
export function cleanMcpInstructions(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const text = raw.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '').trim()
  if (text.length === 0) return undefined
  return text.length > MCP_INSTRUCTIONS_MAX_CHARS ? text.slice(0, MCP_INSTRUCTIONS_MAX_CHARS) : text
}

/** How many characters of a Skill description the summary may take. */
const SUMMARY_MAX_CHARS = 200

/**
 * A one-line summary of a server's instructions for its Skill description:
 * the first paragraph with heading marks and line breaks collapsed, cut at a
 * word boundary.
 */
export function summarizeMcpInstructions(instructions: string): string | undefined {
  const paragraph = instructions
    .split(/\n\s*\n/)
    .map(block => block.replace(/^\s*#+\s*/gm, '').replace(/\s+/g, ' ').trim())
    .find(block => block.length > 0)
  if (!paragraph) return undefined
  if (paragraph.length <= SUMMARY_MAX_CHARS) return paragraph
  const cut = paragraph.slice(0, SUMMARY_MAX_CHARS)
  const atWord = cut.lastIndexOf(' ')
  return `${(atWord > SUMMARY_MAX_CHARS / 2 ? cut.slice(0, atWord) : cut).trimEnd()}…`
}

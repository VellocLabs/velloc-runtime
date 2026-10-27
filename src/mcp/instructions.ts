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

/** Most characters of server notes the `$mcp_servers` section carries in all. */
export const MCP_INSTRUCTIONS_TOTAL_MAX_CHARS = 16_384

/**
 * The names whose notes the prompt carries: in name order while the running
 * total fits `MCP_INSTRUCTIONS_TOTAL_MAX_CHARS`. The first server that does
 * not fit and every server after it are left out, so a subset of `entries`
 * never leaves out a server the whole set keeps.
 */
export function mcpInstructionsInPrompt(
  entries: ReadonlyArray<{ name: string; instructions: string }>,
): Set<string> {
  const kept = new Set<string>()
  let total = 0
  const sorted = entries
    .filter(entry => entry.instructions.length > 0)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of sorted) {
    total += entry.instructions.length
    if (total > MCP_INSTRUCTIONS_TOTAL_MAX_CHARS) break
    kept.add(entry.name)
  }
  return kept
}

/** `text` with every opener or closer of `tag` escaped, so it cannot end a fence early. */
export function escapeMcpFence(text: string, tag: string): string {
  return text.replace(new RegExp(`<(/?)${tag}\\b`, 'gi'), '&lt;$1' + tag)
}

/** The tag that marks a server's notes as the server's own words. */
export const MCP_NOTES_FENCE_TAG = 'server_notes'

/** A server's notes inside their fence. */
export function fenceMcpServerNotes(name: string, instructions: string): string {
  const body = escapeMcpFence(instructions, MCP_NOTES_FENCE_TAG)
  return `<${MCP_NOTES_FENCE_TAG} server="${name}">\n${body}\n</${MCP_NOTES_FENCE_TAG}>`
}

/** How many characters of a Skill description the summary may take. */
const SUMMARY_MAX_CHARS = 200

/** Markup that could read as prompt structure in a catalog line: tags, then
 *  stray angle brackets, backticks and emphasis marks. */
function flattenMarkup(text: string): string {
  return text.replace(/<\/?[A-Za-z!?][^>]*>/g, ' ').replace(/[<>`*]/g, '')
}

/**
 * A one-line summary of a server's instructions for its Skill description:
 * the first paragraph with heading marks, markup and line breaks collapsed,
 * cut at a word boundary.
 */
export function summarizeMcpInstructions(instructions: string): string | undefined {
  const paragraph = instructions
    .split(/\n\s*\n/)
    .map(block => flattenMarkup(block.replace(/^\s*#+\s*/gm, '')).replace(/\s+/g, ' ').trim())
    .find(block => block.length > 0)
  if (!paragraph) return undefined
  if (paragraph.length <= SUMMARY_MAX_CHARS) return paragraph
  const cut = paragraph.slice(0, SUMMARY_MAX_CHARS)
  const atWord = cut.lastIndexOf(' ')
  return `${(atWord > SUMMARY_MAX_CHARS / 2 ? cut.slice(0, atWord) : cut).trimEnd()}…`
}

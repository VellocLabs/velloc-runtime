/**
 * Contract: rule text is `Tool` or `Tool(content)`; `\(` `\)` `\\` are
 * literal; the first unescaped `(` opens content, which must end with an
 * unescaped `)`, else the whole is a tool name. `Tool()` and `Tool(*)` are
 * tool-wide. Stored in settings; pinned by `permission-rule-syntax.test.ts`.
 */

import { SPAWN_TOOL_ID } from '../toolkit/builtin/subagentLaunch'

/** A rule in structured form: a tool, optionally narrowed by content. */
export type ToolRuleSpec = {
  toolName: string
  ruleContent?: string
}

const BACKSLASH = '\\'

/**
 * Resolve old tool names still found in saved rules. `Task` is the former
 * name of the agent tool.
 *
 * The agent tool's name is looked up per call on purpose: this module and the
 * agent tool import each other indirectly, and touching the binding while the
 * modules are still initializing throws.
 */
export function canonicalToolName(name: string): string {
  if (name === 'Task') return SPAWN_TOOL_ID
  return name
}

/** Escape content for placement between the rule's parentheses. */
export function encodeRuleBody(body: string): string {
  let out = ''
  for (const ch of body) {
    out += ch === BACKSLASH || ch === '(' || ch === ')' ? BACKSLASH + ch : ch
  }
  return out
}

/**
 * Undo {@link encodeRuleBody}. A backslash followed by another backslash or a
 * paren yields that character; any other backslash is kept as-is.
 */
export function decodeRuleBody(text: string): string {
  const parts: string[] = []
  let at = 0
  while (at < text.length) {
    const ch = text[at]
    const next = text[at + 1]
    if (ch === BACKSLASH && (next === BACKSLASH || next === '(' || next === ')')) {
      parts.push(next)
      at += 2
    } else {
      parts.push(ch)
      at += 1
    }
  }
  return parts.join('')
}

/**
 * Locate the delimiters of `Tool(content)`: the first unescaped `(` and the
 * last unescaped `)`. A character is escaped when an odd number of
 * backslashes sits directly before it.
 */
function delimiterPositions(text: string): { open: number; close: number } {
  let open = -1
  let close = -1
  let escaped = false
  for (let at = 0; at < text.length; at++) {
    const ch = text[at]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === BACKSLASH) {
      escaped = true
    } else if (ch === '(' && open < 0) {
      open = at
    } else if (ch === ')') {
      close = at
    }
  }
  return { open, close }
}

/** Read a rule written in settings. Never throws. */
export function parseRuleText(text: string): ToolRuleSpec {
  const { open, close } = delimiterPositions(text)
  const wellFormed = open > 0 && close === text.length - 1 && close > open
  if (!wellFormed) return { toolName: canonicalToolName(text) }

  const toolName = canonicalToolName(text.slice(0, open))
  const inner = text.slice(open + 1, close)
  if (inner.length === 0 || inner === '*') return { toolName }
  return { toolName, ruleContent: decodeRuleBody(inner) }
}

/** Write a rule back in settings form. Tool names are written unchanged. */
export function formatRuleText(spec: ToolRuleSpec): string {
  const { toolName, ruleContent } = spec
  return ruleContent ? `${toolName}(${encodeRuleBody(ruleContent)})` : toolName
}

import { toolAnswersTo } from '../toolkit/toolContract'
import { getAllAgentDisallowedTools } from '../toolkit/builtin/toolGroups'

/**
 * Security: filter a tool set down to what a SUBAGENT may use, at both fork
 * sites. First strip `getAllAgentDisallowedTools()` (main-thread-only tools,
 * resolved per call) regardless of the agent's own lists, then apply its
 * `tools` allowlist, then its `disallowedTools`. Matching includes aliases.
 */
export function filterSubAgentTools<
  T extends { name: string; aliases?: string[] },
>(
  tools: readonly T[],
  allow: readonly string[] | undefined,
  disallow: readonly string[] | undefined,
): T[] {
  const disallowed = getAllAgentDisallowedTools()
  let out = tools.filter(
    tool => !disallowed.some(name => toolAnswersTo(tool, name)),
  )
  if (allow && allow.length > 0) {
    out = out.filter(tool => allow.some(name => toolAnswersTo(tool, name)))
  }
  if (disallow && disallow.length > 0) {
    out = out.filter(tool => !disallow.some(name => toolAnswersTo(tool, name)))
  }
  return out
}

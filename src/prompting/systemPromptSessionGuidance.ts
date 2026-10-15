// The tool-gated session-guidance section, spliced in after
// `{{TOOL_CATALOG}}`. Always the specialized-agents phrasing (forks run
// synchronously); Explore bullets gate on a search tool, naming `Glob` /
// `Grep` when hosted, else `find` / `grep` via `Bash`.

import { SPAWN_TOOL_ID } from '../toolkit/builtin/subagentLaunch'
import {
  SHELL_TOOL_ID,
  FIND_FILES_TOOL_ID,
  SEARCH_TEXT_TOOL_ID,
} from './processToolNames'
import { SKILL_TOOL_NAME } from './skillToolName'

/**
 * The guidance section (`# Subagents and skills`, or one of the two), or null
 * when neither the Agent nor the Skill tool is on. Holds the `/<skill-name>`
 * bullet, gated on the Skill tool.
 */
export function sessionGuidanceChunk(
  activeToolIds: ReadonlySet<string>,
): string | null {
  const items: string[] = []

  if (activeToolIds.has(SPAWN_TOOL_ID)) {
    items.push(
      `Use the ${SPAWN_TOOL_ID} tool with a specialized agent when the task matches that agent's description. Subagents are useful for running independent queries in parallel and for keeping bulky results out of the main context, but you should not use them excessively when they are not needed. Importantly, avoid duplicating a subagent's work: if you hand research to one, do not run the same searches yourself.`,
    )

    const hasGlob = activeToolIds.has(FIND_FILES_TOOL_ID)
    const hasGrep = activeToolIds.has(SEARCH_TEXT_TOOL_ID)
    const hasBash = activeToolIds.has(SHELL_TOOL_ID)
    if (hasGlob || hasGrep || hasBash) {
      // Dedicated Glob/Grep tools when present,
      // else `find`/`grep` via Bash (the live nexus path).
      const searchTools =
        hasGlob && hasGrep
          ? `${FIND_FILES_TOOL_ID} or ${SEARCH_TEXT_TOOL_ID}`
          : hasGlob
            ? FIND_FILES_TOOL_ID
            : hasGrep
              ? SEARCH_TEXT_TOOL_ID
              : `\`find\` or \`grep\` via the ${SHELL_TOOL_ID} tool`
      items.push(
        `For a simple, targeted search of the codebase (a particular file, class or function), use ${searchTools} directly.`,
        `For broader exploration or research that will take several rounds of searching, use the ${SPAWN_TOOL_ID} tool with subagent_type=Explore. It is slower than searching directly, so use it only when a simple, targeted search has not been enough.`,
      )
    }
  }

  if (activeToolIds.has(SKILL_TOOL_NAME)) {
    items.push(
      `When the user types \`/<skill-name>\`, run that skill with the ${SKILL_TOOL_NAME} tool. Use only skills listed in the user-invocable skills section; do not guess names.`,
    )
  }

  if (items.length === 0) {
    return null
  }

  const hasSpawn = activeToolIds.has(SPAWN_TOOL_ID)
  const hasSkill = activeToolIds.has(SKILL_TOOL_NAME)
  const heading =
    hasSpawn && hasSkill ? 'Subagents and skills' : hasSpawn ? 'Subagents' : 'Skills'
  return [`# ${heading}`, ...items.map(item => `- ${item}`)].join('\n')
}

/**
 * `skill.prompt` through the session's mods (F-25), for both skill-expansion
 * sites. Never rejects: a missing method or a failed chain leaves the text as
 * computed.
 */

import {
  skillPromptSourceOf,
  type SkillPromptInput,
  type SkillPromptMods,
} from '../mods/toolCallEvent'
import type { ChromiumPromptCommand } from '../runtime/CommandTypes'

export async function skillPromptThroughMods(
  mods: Partial<SkillPromptMods> | undefined,
  input: SkillPromptInput,
  signal?: AbortSignal,
): Promise<string> {
  if (!mods?.skillPrompt || mods.hasSkillPromptHooks?.() === false) return input.text
  try {
    return await mods.skillPrompt(input, signal)
  } catch {
    return input.text
  }
}

/** `skill.prompt`'s `e` for `skill` expanded to `text`: its header, whose
 *  words it is, and its file (none for a built-in). */
export function skillPromptInputOf(
  skill: Pick<ChromiumPromptCommand, 'name' | 'source' | 'path' | 'pluginName' | 'frontmatter' | 'frontmatterProblem'>,
  text: string,
): SkillPromptInput {
  const source = skillPromptSourceOf(skill.source)
  return {
    skill: skill.name,
    text,
    frontmatter: skill.frontmatter ?? {},
    ...(skill.frontmatterProblem !== undefined ? { frontmatterProblem: skill.frontmatterProblem } : {}),
    source,
    ...(skill.pluginName !== undefined ? { pluginName: skill.pluginName } : {}),
    ...(source !== 'built-in' && skill.path ? { path: skill.path } : {}),
  }
}

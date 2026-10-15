/**
 * `skill.prompt` through the session's mods (F-25), for both skill-expansion
 * sites. Never rejects: a missing method or a failed chain leaves the text as
 * computed.
 */

import type { SkillPromptMods } from '../mods/toolCallEvent'

export async function skillPromptThroughMods(
  mods: Partial<SkillPromptMods> | undefined,
  input: { skill: string; text: string },
  signal?: AbortSignal,
): Promise<string> {
  if (!mods?.skillPrompt || mods.hasSkillPromptHooks?.() === false) return input.text
  try {
    return await mods.skillPrompt(input, signal)
  } catch {
    return input.text
  }
}

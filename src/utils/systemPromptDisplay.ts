import type { InstructionText } from '../runtime/RuntimeTypes'

/**
 * Display cap for a serialized system prompt shown in the Background Tasks
 * detail view. A fast call's system prompt is small (a few hundred chars), but
 * an in-process fork inherits the FULL agent system prompt (tens of KB); the
 * cap bounds both the retained-record memory (up to `MAX_FINISHED_*` records
 * each holding one string) and the on-open detail payload. Generous enough to
 * show a whole fast-call prompt verbatim.
 */
export const SYSTEM_PROMPT_DISPLAY_MAX = 20_000

/**
 * Flatten an `InstructionText` into one readable string: blank sections dropped,
 * sections joined by a blank line, capped at `maxLen` (trailing `…`). `''` for
 * an undefined or empty prompt.
 */
export function serializeSystemPromptForDisplay(
  systemPrompt: InstructionText | undefined,
  maxLen: number = SYSTEM_PROMPT_DISPLAY_MAX,
): string {
  if (systemPrompt === undefined) return ''
  const joined =
    typeof systemPrompt === 'string'
      ? systemPrompt
      : collectParts(systemPrompt).join('\n\n')
  const trimmed = joined.trim()
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}…` : trimmed
}

function collectParts(parts: ReadonlyArray<string>): string[] {
  return parts.filter(part => part.trim().length > 0)
}

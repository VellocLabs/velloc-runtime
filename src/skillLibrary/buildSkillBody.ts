import type { ChromiumCommandMetadata } from '../runtime/CommandTypes'
import { fillPromptArgs } from '../utils/promptArgs'

/**
 * Loading-metadata tags for a skill body (`<command-message>`, `<command-name>`,
 * then `<command-args>` for the slash form `/${name}`, or
 * `<skill-format>true</skill-format>` with a bare name when model-only). They
 * travel in the same isMeta message as the body, so the model can see a skill
 * is already loaded.
 */
export function skillLoadingTags(
  command: ChromiumCommandMetadata,
  args: string | undefined,
): string[] {
  const name = command.name
  const tags: string[] = []
  if (command.userCallable !== false) {
    tags.push(`<command-message>${name}</command-message>`)
    tags.push(`<command-name>/${name}</command-name>`)
    if (args && args.length > 0) {
      tags.push(`<command-args>${args}</command-args>`)
    }
  } else {
    tags.push(`<command-message>${name}</command-message>`)
    tags.push(`<command-name>${name}</command-name>`)
    tags.push(`<skill-format>true</skill-format>`)
  }
  return tags
}

export function formatSkillInvocationMessage(
  command: ChromiumCommandMetadata,
  args: string | undefined,
  body: string,
): string {
  return [...skillLoadingTags(command, args), '', body].join('\n')
}

/**
 * Normalize Windows backslashes inside the substituted base directory.
 * The model uses the substituted value to build shell commands; bash
 * treats `\` as an escape character, so a Windows-style path embedded
 * mid-command corrupts tokenization.
 */
export function normalizeSkillDirForBody(value: string): string {
  return value.replace(/\\/g, '/')
}

/**
 * Expand a skill body for injection; shared by the model-invoked and slash
 * paths so both produce identical text. Prefixes the base directory, then
 * substitutes `$ARGUMENTS` / `$<n>` / `$<name>`, `${CLAUDE_SKILL_DIR}` and
 * `${CLAUDE_SESSION_ID}`.
 */
export function buildSkillBody(
  command: ChromiumCommandMetadata,
  args: string | undefined,
  sessionId: string,
  argsAlreadyApplied = false,
): string {
  const normalizedBaseDir = command.baseDir
    ? normalizeSkillDirForBody(command.baseDir)
    : undefined

  let content = normalizedBaseDir
    ? `Base directory for this skill: ${normalizedBaseDir}\n\n${command.content}`
    : command.content

  // Static bodies append the arguments so they remain visible when no
  // placeholder is present. Dynamic callbacks already received the arguments
  // and return their final prompt, so bypass substitution entirely; this also
  // preserves literal `$ARGUMENTS` documentation examples.
  if (!argsAlreadyApplied) {
    content = fillPromptArgs(content, args, {
      appendWhenUnused: true,
      labels: command.argNames ?? [],
    })
  }

  if (normalizedBaseDir) {
    content = content.replace(/\$\{CLAUDE_SKILL_DIR\}/g, normalizedBaseDir)
  }
  content = content.replace(/\$\{CLAUDE_SESSION_ID\}/g, sessionId)

  return content
}

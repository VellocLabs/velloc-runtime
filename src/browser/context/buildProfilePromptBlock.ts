import type { NexusProfileSettings } from '../../settings/settingsTypes'

/**
 * The General-settings profile (display identity) as one system-prompt block,
 * appended via `appendSystemPrompt`, never as `customSystemPrompt` (which would
 * replace the base prompt). Identity only: standing instructions live in AGENTS.md.
 * Fields are trimmed and blanks dropped; returns `undefined` for an empty profile.
 */
export function buildProfilePromptBlock(
  profile: NexusProfileSettings | undefined,
): string | undefined {
  if (!profile) return undefined

  const fullName = profile.fullName?.trim()
  const callName = profile.callName?.trim()
  const workRole = profile.workRole?.trim()

  const identity: string[] = []
  if (fullName) identity.push(`The user's name is ${fullName}.`)
  if (callName) identity.push(`The user prefers to be called "${callName}".`)
  if (workRole) {
    identity.push(`The user's work is best described as: ${workRole}.`)
  }

  const sections: string[] = []
  if (identity.length > 0) sections.push(identity.join('\n'))

  if (sections.length === 0) return undefined
  return `<user_profile>\n${sections.join('\n\n')}\n</user_profile>`
}

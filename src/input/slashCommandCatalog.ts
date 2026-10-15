/**
 * The built-in slash command catalog (names, description keys, parsing
 * helpers); dependency-free. Command NAMES are protocol and never translated;
 * only descriptions are catalog prose.
 */
import type { MessageKey } from '../browser/webview/i18n/messages/en'

export const BROWSER_SLASH_COMMANDS = [
  'help',
  'tabs',
  'context',
  'clear',
  'model',
  'compact',
  'autocompact',
  'status',
  'plan',
  'exit-plan',
  'plugins',
  'plugin',
  'marketplace',
  'mcp',
  'rename',
  'cost',
  'agents',
  'skills',
  'hooks',
  'permissions',
] as const

export const NEXUS_SLASH_COMMANDS = [
  'help',
  'context',
  'clear',
  'model',
  'compact',
  'autocompact',
  'status',
  'plan',
  'exit-plan',
  'plugins',
  'plugin',
  'marketplace',
  'mcp',
  'rename',
  'cost',
  'agents',
  'skills',
  'hooks',
  'permissions',
] as const

/**
 * Catalog keys for built-in command descriptions, resolved by the picker with
 * `t()` (the worker never picks a display language). English values under
 * `slash.builtin.*` (F-21).
 */
export const BUILTIN_SLASH_COMMAND_DESCRIPTION_KEYS: Record<
  (typeof BROWSER_SLASH_COMMANDS)[number],
  MessageKey
> = {
  help: 'slash.builtin.help',
  tabs: 'slash.builtin.tabs',
  context: 'slash.builtin.context',
  clear: 'slash.builtin.clear',
  model: 'slash.builtin.model',
  compact: 'slash.builtin.compact',
  autocompact: 'slash.builtin.autocompact',
  status: 'slash.builtin.status',
  plan: 'slash.builtin.plan',
  'exit-plan': 'slash.builtin.exit-plan',
  plugins: 'slash.builtin.plugins',
  plugin: 'slash.builtin.plugin',
  marketplace: 'slash.builtin.marketplace',
  mcp: 'slash.builtin.mcp',
  rename: 'slash.builtin.rename',
  cost: 'slash.builtin.cost',
  agents: 'slash.builtin.agents',
  skills: 'slash.builtin.skills',
  hooks: 'slash.builtin.hooks',
  permissions: 'slash.builtin.permissions',
}

export type BrowserSlashCommand = (typeof BROWSER_SLASH_COMMANDS)[number]
export const BROWSER_SLASH_COMMAND_SET = new Set<string>(BROWSER_SLASH_COMMANDS)

/**
 * Hidden built-in slash commands: dispatch when typed in full, never shown in
 * the picker. `/help` does list them, in their own section (F-21).
 */
export const HIDDEN_BROWSER_SLASH_COMMANDS = ['debug'] as const

export type HiddenBrowserSlashCommand =
  (typeof HIDDEN_BROWSER_SLASH_COMMANDS)[number]
export const HIDDEN_BROWSER_SLASH_COMMAND_SET = new Set<string>(
  HIDDEN_BROWSER_SLASH_COMMANDS,
)

/**
 * Description keys for hidden commands, shown in the picker only on an exact
 * full-name match and as the hint in `/help`. `/debug`'s output stays English
 * (G-1).
 */
export const HIDDEN_SLASH_COMMAND_DESCRIPTION_KEYS: Record<
  HiddenBrowserSlashCommand,
  MessageKey
> = {
  debug: 'slash.builtin.debug',
}

export function resolveSupportedSlashCommands(
  commands?: readonly string[],
): readonly string[] {
  if (!commands) {
    return BROWSER_SLASH_COMMANDS
  }

  const resolved: string[] = []
  for (const command of commands) {
    if (!BROWSER_SLASH_COMMAND_SET.has(command) || resolved.includes(command)) {
      continue
    }
    resolved.push(command)
  }

  return resolved
}

/** Leading word that is dropped from a command: `/claude <name> …` runs as
 *  `/<name> …`. A bare `/claude` stays the command `claude`. (F-21) */
export const COMMAND_PREFIX_ALIAS = 'claude'

/** Splits `/name args` into its command word and arguments, resolving the
 *  `COMMAND_PREFIX_ALIAS` word first. Every slash route reads commands
 *  through here, so they all agree on the name. */
export function splitCommandWord(raw: string): {
  command: string
  args: string
} {
  const trimmed = raw.trim()
  const spaceIndex = trimmed.indexOf(' ')
  if (spaceIndex === -1) {
    return { command: trimmed.slice(1), args: '' }
  }
  const command = trimmed.slice(1, spaceIndex)
  const args = trimmed.slice(spaceIndex + 1).trim()
  if (command === COMMAND_PREFIX_ALIAS && args !== '') {
    return splitCommandWord(`/${args}`)
  }
  return { command, args }
}

/**
 * Pure builder for the slash-command picker list: built-ins, then user-invocable skills
 * (alphabetical), then hidden built-ins (`hidden: true`; `hiddenFromPicker` skills too). Skills named
 * like a hidden built-in are skipped; one row per name (hidden built-in > built-in > first skill).
 */

import type { ChromiumCommandMetadata } from '../../runtime/CommandTypes'
import {
  BROWSER_SLASH_COMMANDS,
  BUILTIN_SLASH_COMMAND_DESCRIPTION_KEYS,
  HIDDEN_BROWSER_SLASH_COMMANDS,
  HIDDEN_SLASH_COMMAND_DESCRIPTION_KEYS,
  NEXUS_SLASH_COMMANDS,
} from '../../input/slashCommandCatalog'
import type { LoadedSkillSummary, SlashCommandSummary } from './workerProtocol'

/** A slash command a mod registered (`$.command.register`). */
export type ModCommandSummaryInput = {
  name: string
  description: string
  argumentHint?: string
  plugin: string
}

export function buildSlashCommandSummaries(options: {
  /** `'nexus'` drops `/tabs` (no multi-tab concept in the nexus host). */
  isNexusHost: boolean
  commands: readonly ChromiumCommandMetadata[]
  /** The slot's mods' registered commands (F-25). A built-in's name is
   *  refused at registration; a mod command outranks a skill of its name,
   *  as the dispatcher routes the typed line to the mod first. */
  modCommands?: readonly ModCommandSummaryInput[]
}): SlashCommandSummary[] {
  const builtinNames = options.isNexusHost
    ? NEXUS_SLASH_COMMANDS
    : BROWSER_SLASH_COMMANDS

  // Built-ins send a catalog KEY, not text: the picker renders it with the
  // user's locale. Skills (below) still send author-written text, which the
  // app has no catalog entry for and cannot translate.
  const builtins: SlashCommandSummary[] = builtinNames.map(name => ({
    name,
    blurbKey: BUILTIN_SLASH_COMMAND_DESCRIPTION_KEYS[name],
    kind: 'builtin' as const,
  }))

  // Hidden built-ins (e.g. `/debug`) ride along in the summary list
  // tagged `hidden: true` so the picker can keep them out of the normal
  // suggestion list yet still reveal one on an exact full-name query
  // (`isHidden`). They carry no host-mode split — available
  // everywhere the dispatcher accepts them.
  const hiddenBuiltins: SlashCommandSummary[] = HIDDEN_BROWSER_SLASH_COMMANDS.map(
    name => ({
      name,
      blurbKey: HIDDEN_SLASH_COMMAND_DESCRIPTION_KEYS[name],
      kind: 'builtin' as const,
      hidden: true,
    }),
  )

  // Global name dedup, mirroring the dispatcher's actual
  // precedence in `dispatchCommandInput`: hidden built-in > visible
  // built-in > skill (first registry entry). The picker must never show
  // two entries the dispatcher can only route to one of — a skill named
  // like a VISIBLE built-in, two same-name skills, or a double-loaded
  // skill all previously produced duplicate rows.
  const takenNames = new Set<string>([
    ...builtinNames,
    ...HIDDEN_BROWSER_SLASH_COMMANDS,
  ])

  // Mod commands before skills: the dispatcher raises a registered command
  // through the mods before the skill registry sees the typed line.
  const mods: SlashCommandSummary[] = []
  for (const command of options.modCommands ?? []) {
    if (takenNames.has(command.name)) continue
    takenNames.add(command.name)
    mods.push({
      name: command.name,
      description: command.description,
      kind: 'mod' as const,
      source: 'plugin' as const,
      ...(command.argumentHint !== undefined ? { argumentHint: command.argumentHint } : {}),
    })
  }

  const skills: SlashCommandSummary[] = []
  for (const command of options.commands) {
    if (command.type !== 'prompt') continue
    // `userCallable !== false` matches `dispatchSkillSlashCommand`'s
    // gate; skills opted out of slash invocation stay model-only.
    if (command.userCallable === false) continue
    // Name collision with a built-in (hidden or visible) or an earlier
    // skill → the dispatcher routes the typed input to that one; skip
    // this entry so the picker shows exactly one authoritative row.
    if (takenNames.has(command.name)) continue
    takenNames.add(command.name)
    skills.push({
      name: command.name,
      description: command.description,
      kind: 'skill' as const,
      source: command.source,
      argumentHint: command.argumentHint,
      ...(command.hiddenFromPicker ? { hidden: true } : {}),
    })
  }

  // Built-ins first, skills sorted alphabetically afterwards. Built-in
  // ordering is fixed (matches the help text and the slash-command doc).
  skills.sort((left, right) => left.name.localeCompare(right.name))
  mods.sort((left, right) => left.name.localeCompare(right.name))
  return [...builtins, ...mods, ...skills, ...hiddenBuiltins]
}

/**
 * All loaded skills for the Skills tab, model-only ones included, with `path` and `size` (UTF-8 bytes
 * of `content`; empty → undefined). No `path` → dropped. Name-deduped first-wins, sorted.
 */
export function buildLoadedSkillSummaries(
  commands: readonly ChromiumCommandMetadata[],
): LoadedSkillSummary[] {
  const seen = new Set<string>()
  const skills: LoadedSkillSummary[] = []
  for (const command of commands) {
    if (command.type !== 'prompt') continue
    if (!command.path) continue
    if (seen.has(command.name)) continue
    seen.add(command.name)
    skills.push({
      name: command.name,
      description: command.description,
      path: command.path,
      source: command.source,
      size:
        typeof command.content === 'string' && command.content.length > 0
          ? byteLength(command.content)
          : undefined,
    })
  }
  skills.sort((left, right) => left.name.localeCompare(right.name))
  return skills
}

/** UTF-8 byte length — matches the on-disk size of the skill's `SKILL.md`
 *  body, not its UTF-16 JS-string length. */
function byteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

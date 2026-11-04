/**
 * After a compaction, the skills found relevant earlier in the session but
 * never invoked come back as one `skill_discovery` row after the summary
 * (F-21). The boundary cuts off the rows that announced them, while the
 * session still remembers them as found and so never offers them again.
 */
import type { Message } from '../runtime/RuntimeTypes'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { getModelInvocableCommands } from '../skillLibrary/skillDiscovery'
import { skillsUsedBy } from '../skillLibrary/invokedSkillsStore'
import { getActiveSkills } from '../toolkit/run/deferredTools'
import { SKILL_TOOL_NAME } from '../prompting/skillToolName'
import { makeContextRow } from './messageFactories'

/** The found-but-unused skills as one discovery row, or none. Skills already
 *  invoked or active are left out: their bodies are restored separately. */
export function collectPostCompactSkillDiscoveryRows(
  context: ToolCallContext | undefined,
  runtimeConfig: RuntimeConfig | undefined,
): Message[] {
  if (!context || !runtimeConfig) return []
  const tools = Array.isArray(context.options?.tools) ? context.options.tools : []
  if (!tools.some(tool => tool?.name === SKILL_TOOL_NAME)) return []
  const appState = context.readAppState()
  const found = new Set(appState.attachmentState?.discoveredSkillNames ?? [])
  if (found.size === 0) return []
  const used = getActiveSkills(appState)
  const sessionId = context.options.sessionId
  if (sessionId) {
    for (const record of skillsUsedBy(sessionId, context.agentId ?? null).values()) {
      used.add(record.skillName)
    }
  }
  const skills = getModelInvocableCommands(context.options.commands ?? [])
    .filter(command => found.has(command.name) && !used.has(command.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(command => ({
      name: command.name,
      description: command.description,
      path: command.path,
      shortId: command.name,
    }))
  if (skills.length === 0) return []
  return [
    makeContextRow(runtimeConfig, {
      type: 'skill_discovery',
      skills,
      signal: 'user_input',
      source: 'native',
    }),
  ]
}

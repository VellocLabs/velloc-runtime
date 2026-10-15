import type { ChromiumCommandMetadata } from '../runtime/CommandTypes'
import type { UserRow } from '../runtime/RuntimeTypes'
import { SKILL_TOOL_NAME } from '../prompting/skillToolName'
import {
  createGeneratedUserMessage,
  createGeneratedUuid,
} from '../messages/messageFactories'
import { formatSkillInvocationMessage } from './buildSkillBody'
import { skillBodyDetailId } from './skillInvocationTags'

/**
 * Build the isMeta skill-invocation message with its lazy-body sidecar. The
 * caller's `uuid` doubles as the invocation event id (`skill:<uuid>` sidecar);
 * defaults to a fresh uuid.
 */
export function createSkillInvocationMessage(
  command: ChromiumCommandMetadata,
  args: string | undefined,
  body: string,
  uuid: string = createGeneratedUuid(),
): UserRow {
  const content = formatSkillInvocationMessage(command, args, body)
  const message = { ...createGeneratedUserMessage(content, { isMeta: true }), uuid }
  const toolCallId = skillBodyDetailId(uuid)
  return {
    ...message,
    toolCallDetailRef: { toolCallId, toolName: SKILL_TOOL_NAME },
    toolCallDetail: {
      toolCallId,
      toolName: SKILL_TOOL_NAME,
      args: { skill: command.name, ...(args ? { args } : {}) },
      result: content,
    },
  } as UserRow
}

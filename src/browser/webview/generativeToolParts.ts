import type { ThreadMessageLike } from '@assistant-ui/react'
import { CONTINUE_IN_CODE_TOOL_ID } from '../../toolkit/builtin/continueInCode'
import { ASK_TOOL_ID } from '@/toolkit/builtin/askUser'
import { SKILL_TOOL_NAME } from '@/prompting/skillToolName'
import {
  A2UI_CREATE_SURFACE,
  A2UI_DELETE_SURFACE,
  A2UI_UPDATE_COMPONENTS,
  A2UI_UPDATE_DATA_MODEL,
} from '@/toolkit/builtin/a2ui/a2uiToolNames'

const GENERATIVE_TOOL_NAMES = new Set([
  'collect_contact',
  'select_date',
  'show_location',
  ASK_TOOL_ID,
  // The a2ui_* tool-calls render a card (or an update note) at their position
  // in the conversation; the surface itself is in the side pane.
  A2UI_CREATE_SURFACE,
  A2UI_UPDATE_COMPONENTS,
  A2UI_UPDATE_DATA_MODEL,
  A2UI_DELETE_SURFACE,
  CONTINUE_IN_CODE_TOOL_ID,
  // The Skill card names the skill and anchors a model-invoked review's report card.
  SKILL_TOOL_NAME,
])

/** Whether the thread holds a tool call whose card lives in the lazily loaded generative tool UIs. */
export function hasGenerativeToolParts(messages: readonly ThreadMessageLike[]): boolean {
  return messages.some(message => {
    if (typeof message.content === 'string') {
      return false
    }

    return message.content.some(
      part =>
        part.type === 'tool-call' &&
        GENERATIVE_TOOL_NAMES.has(part.toolName),
    )
  })
}

/**
 * `HandOffSession` (F-36): move the task the model is in the middle of into a
 * child session of its own, a fork of this conversation whose first message
 * is the remaining plan. Nothing here stops this session: the result asks its
 * model to stop the moved task and answer the user.
 */

import type { ToolContract, InputCheck, ToolArgsJsonShape } from '../toolContract'
import type { ToolCallContext } from '../toolCallContext'
import { declareTool } from '../toolContract'
import { HAND_OFF_SESSION_TOOL_NAME, handOffRegisteredText } from '../../sessions/childProposals'
import { launchChildSession } from './spawnSession'

export { HAND_OFF_SESSION_TOOL_NAME }

export type HandOffSessionInput = { title: string; remainingPlan: string }

const SCHEMA: ToolArgsJsonShape = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'The new session\'s title: under 60 characters, naming the task being moved.',
    },
    remainingPlan: {
      type: 'string',
      description: 'What is left of the task: the steps, the files, and what done looks like. It is the new session\'s first message, after its copy of this conversation.',
    },
  },
  required: ['title', 'remainingPlan'],
  additionalProperties: false,
}

export async function handOffChildSession(
  input: HandOffSessionInput,
  context: ToolCallContext,
): Promise<{ data: string }> {
  const remainingPlan = typeof input?.remainingPlan === 'string' ? input.remainingPlan.trim() : ''
  if (!remainingPlan) return { data: 'Refused: remainingPlan is required: what is left of the task.' }
  const title = typeof input.title === 'string' ? input.title : ''
  const launch = await launchChildSession(
    {
      initiation: 'asked',
      title,
      task: remainingPlan,
      briefing: '',
      from: 'fork',
      name: '',
      isolation: '',
      model: '',
      effort: '',
      permissionMode: '',
      cwd: '',
      baseBranch: '',
      branchName: '',
      proposalId: '',
    },
    context,
    {
      kind: 'hand_off',
      registeredText: (outcome, request) =>
        handOffRegisteredText({ sessionId: outcome.sessionId, name: outcome.name, title: request.title }),
    },
  )
  return { data: launch.text }
}

export const HandOffSessionTool: ToolContract<HandOffSessionInput, string> = declareTool({
  name: HAND_OFF_SESSION_TOOL_NAME,
  discoveryHint: 'move the task in progress into a child session forked from this conversation',
  argsSchema: SCHEMA,
  strict: false,
  description: async () =>
    'Move the task you are in the middle of into a CHILD SESSION of its own: a fork of this ' +
    'conversation whose first message is remainingPlan. Use it when the user, partway through, ' +
    'asks about something else and the task should carry on apart from this conversation. It does ' +
    'not stop this session: after the call, stop working on the moved task here and answer the user.',
  parallelSafe: () => false,
  readsOnly: () => false,
  async checkInput(input: HandOffSessionInput): Promise<InputCheck> {
    for (const [index, field] of (['title', 'remainingPlan'] as const).entries()) {
      if (typeof input?.[field] !== 'string') {
        return { result: false, message: `${field} is required.`, errorCode: index + 1 }
      }
    }
    return { result: true }
  },
  async call(input: HandOffSessionInput, context: ToolCallContext) {
    return handOffChildSession(input, context)
  },
})

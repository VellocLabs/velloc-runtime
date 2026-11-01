/**
 * `ProposeSession` and `WithdrawProposal` (F-36): a child session the model
 * proposes instead of starting. A proposal runs nothing; it is a card in the
 * transcript the user answers. `suggest` waits up to a week for Start or
 * Dismiss; `offer` asks "New session" or "Do it here" and the call waits for
 * the answer. The record is the runtime's (`ProposalBoard`).
 */

import type { ToolContract, InputCheck, ToolArgsJsonShape } from '../toolContract'
import type { ToolCallContext } from '../toolCallContext'
import type { Message } from '../../runtime/RuntimeTypes'
import { declareTool } from '../toolContract'
import { checkChildSessionRequest } from '../../sessions/childSessionSpec'
import {
  PROPOSE_SESSION_TOOL_NAME,
  WITHDRAW_PROPOSAL_TOOL_NAME,
  isProposalTaskId,
  offerAcceptedText,
  offerKeptHereText,
  offerStoppedText,
  offerSupersededText,
  proposalStateWords,
  suggestionRecordedText,
  type ProposalMode,
  type ProposedRequest,
} from '../../sessions/childProposals'
import { getProposalBoard } from '../../sessions/proposalBoard'
import { checkChildModelChoice, childCallerContext, proposalLauncherFor } from './spawnSession'

export { PROPOSE_SESSION_TOOL_NAME, WITHDRAW_PROPOSAL_TOOL_NAME }

export type ProposeSessionInput = ProposedRequest & { mode: string }

const PROPOSE_DESCRIPTION =
  'PROPOSE a child session instead of starting one: nothing runs until the user ' +
  'answers a card in this conversation. mode="suggest" is for work you noticed ' +
  'yourself that the user has not asked for: the card offers Start and Dismiss, ' +
  'it expires after 7 days, and the result is its task id; a full task and ' +
  'briefing are required, as for SpawnSession. mode="offer" is for a task the ' +
  'user just gave you that might run in its own session: the card asks "New ' +
  'session" or "Do it here", and this call waits for the answer. Only title is ' +
  'required for an offer; when the user picks a new session, call SpawnSession ' +
  'with its proposalId, a task and a briefing. Every field is required; "" ' +
  'means none.'

const PROPOSE_SCHEMA: ToolArgsJsonShape = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      description: '"suggest": a card the user may start or dismiss, for work you noticed. "offer": ask the user, before anything starts, whether a task they gave you runs in a new session or here.',
    },
    title: {
      type: 'string',
      description: 'The card\'s title and the session\'s title if it starts: under 60 characters, naming the task.',
    },
    task: {
      type: 'string',
      description: 'What the child would do and what done looks like. Required for "suggest"; "" allowed for "offer", whose task comes once the user accepts.',
    },
    briefing: {
      type: 'string',
      description: 'Everything a reader who has not seen this conversation needs. Required for a fresh "suggest" (at least 80 characters); "" allowed for "offer".',
    },
    from: {
      type: 'string',
      description: '"fresh" or "fork", as for SpawnSession; "" for an offer means "fresh". It cannot change when the proposal starts.',
    },
    name: {
      type: 'string',
      description: 'A short name for the child, as for SpawnSession; "" derives one from the title.',
    },
    isolation: {
      type: 'string',
      description: '"shared", "worktree" or "" for the default, as for SpawnSession. Must be "" for from="fork".',
    },
    model: {
      type: 'string',
      description: 'A model enabled on this session\'s provider, or "" to inherit.',
    },
    effort: {
      type: 'string',
      description: 'An effort tier of that model, or "". Needs model.',
    },
    permissionMode: {
      type: 'string',
      description: 'This session\'s mode or a less permissive one, or "" to inherit.',
    },
    cwd: {
      type: 'string',
      description: 'A project folder the user has opened, or "" for this session\'s.',
    },
    baseBranch: {
      type: 'string',
      description: 'For isolation "worktree": what the worktree is cut from, or "".',
    },
    branchName: {
      type: 'string',
      description: 'For isolation "worktree": a new branch name, or "".',
    },
  },
  required: [
    'mode',
    'title',
    'task',
    'briefing',
    'from',
    'name',
    'isolation',
    'model',
    'effort',
    'permissionMode',
    'cwd',
    'baseBranch',
    'branchName',
  ],
  additionalProperties: false,
}

const PROPOSE_FIELDS = PROPOSE_SCHEMA.required as readonly (keyof ProposeSessionInput)[]

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The id of the tool call that carries this proposal, read off the assistant
 * row that invoked it: the one call of this tool, else the one whose mode and
 * title match. The transcript card finds its record by it.
 */
export function proposalToolCallIdOf(
  invokingRow: Message | undefined,
  toolName: string,
  input: { mode?: unknown; title?: unknown },
): string | undefined {
  const content = (invokingRow as { message?: { content?: unknown } } | undefined)?.message?.content
  if (!Array.isArray(content)) return undefined
  const calls = content.filter(
    (block): block is Record<string, unknown> =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'tool-call' &&
      (block as { toolName?: unknown }).toolName === toolName &&
      typeof (block as { toolCallId?: unknown }).toolCallId === 'string',
  )
  if (calls.length === 1) return calls[0]!.toolCallId as string
  const match = calls.find(block => {
    const args = (block.args ?? block.input) as { mode?: unknown; title?: unknown } | undefined
    return args?.mode === input.mode && args?.title === input.title
  })
  return match?.toolCallId as string | undefined
}

export async function proposeChildSession(
  input: ProposeSessionInput,
  context: ToolCallContext,
  invokingRow?: Message,
): Promise<{ data: string }> {
  const mode = trimmed(input?.mode)
  if (mode !== 'suggest' && mode !== 'offer') {
    return { data: `Refused: mode must be "suggest" or "offer" (got ${JSON.stringify(mode)}).` }
  }
  const from = trimmed(input.from) || (mode === 'offer' ? 'fresh' : '')
  const checked = checkChildSessionRequest(
    { ...input, from, initiation: 'asked', proposalId: '' },
    childCallerContext(context),
    { briefLater: mode === 'offer' },
  )
  if (!checked.ok) return { data: `Refused: ${checked.reason}` }
  const model = await checkChildModelChoice(checked.request, context)
  if (!model.ok) return { data: `Refused: ${model.reason}` }

  const board = getProposalBoard()
  const sessionId = context.options.sessionId
  if (!board || !sessionId) {
    return { data: 'Refused: proposals are unavailable here (no session manager in this runtime).' }
  }
  const request: ProposedRequest = {
    title: trimmed(input.title),
    task: trimmed(input.task),
    briefing: trimmed(input.briefing),
    from,
    name: trimmed(input.name),
    isolation: trimmed(input.isolation),
    model: trimmed(input.model),
    effort: trimmed(input.effort),
    permissionMode: trimmed(input.permissionMode),
    cwd: trimmed(input.cwd),
    baseBranch: trimmed(input.baseBranch),
    branchName: trimmed(input.branchName),
  }
  board.setLauncher(sessionId, proposalLauncherFor(context))
  const toolCallId = proposalToolCallIdOf(invokingRow, PROPOSE_SESSION_TOOL_NAME, input)
  const record = (chosen: ProposedRequest) =>
    board.propose(sessionId, {
      mode: mode as ProposalMode,
      request: chosen,
      ...(toolCallId ? { toolCallId } : {}),
    })
  let proposal: Awaited<ReturnType<typeof record>> | undefined
  const mods = context.options.mods
  if (!mods?.sessionPropose || mods.hasSessionProposeHooks?.() === false) {
    proposal = await record(request)
  } else {
    // A rewrite is checked again as the model's own proposal would be; a
    // deny records nothing.
    let settled: Awaited<ReturnType<NonNullable<typeof mods.sessionPropose>>> | undefined
    let entered = false
    try {
      settled = await mods.sessionPropose(
        { initiation: mode, title: request.title, task: request.task, briefing: request.briefing, parentSessionId: sessionId },
        async rewrite => {
          const chosen: ProposedRequest = {
            ...request,
            title: rewrite.title.trim(),
            task: rewrite.task.trim(),
            briefing: rewrite.briefing.trim(),
          }
          const recheck = checkChildSessionRequest(
            { ...chosen, initiation: 'asked', proposalId: '' },
            childCallerContext(context),
            { briefLater: mode === 'offer' },
          )
          if (!recheck.ok) throw new Error(recheck.reason)
          // Security: one call records one proposal, however often core is
          // asked; a rewrite the checks refused recorded nothing.
          if (entered) throw new Error('this proposal has already been recorded')
          entered = true
          proposal = await record(chosen)
          return { taskId: proposal.taskId }
        },
        context.cancelSource?.signal,
      )
    } catch (error) {
      if (!proposal) return { data: `Refused: the proposal was cancelled: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (!proposal) {
      const reason = settled && 'deny' in settled ? settled.deny : 'a plugin answered without recording it'
      return { data: `Refused: a plugin refused this proposal: ${reason}` }
    }
  }
  if (mode === 'suggest') return { data: suggestionRecordedText(proposal) }

  const outcome = await board.awaitOffer(sessionId, proposal.taskId, context.cancelSource?.signal)
  switch (outcome) {
    case 'new':
      return { data: offerAcceptedText(proposal) }
    case 'here':
      return { data: offerKeptHereText(proposal) }
    case 'superseded':
      return { data: offerSupersededText(proposal) }
    case 'stopped':
      return { data: offerStoppedText(proposal) }
  }
}

export const ProposeSessionTool: ToolContract<ProposeSessionInput, string> = declareTool({
  name: PROPOSE_SESSION_TOOL_NAME,
  discoveryHint: 'propose a child session as a card the user starts, dismisses, or answers new session / do it here',
  argsSchema: PROPOSE_SCHEMA,
  inputJSONSchemaStrict: PROPOSE_SCHEMA,
  strict: true,
  description: async () => PROPOSE_DESCRIPTION,
  parallelSafe: () => false,
  readsOnly: () => false,
  async checkInput(input: ProposeSessionInput): Promise<InputCheck> {
    for (const [index, field] of PROPOSE_FIELDS.entries()) {
      if (typeof (input as Record<string, unknown>)[field] !== 'string') {
        return { result: false, message: `${field} is required: a string, or "" for none.`, errorCode: index + 1 }
      }
    }
    return { result: true }
  },
  async call(input: ProposeSessionInput, context: ToolCallContext, _canUseTool, invokingRow) {
    return proposeChildSession(input, context, invokingRow)
  },
})

export type WithdrawProposalInput = { taskId: string }

const WITHDRAW_SCHEMA: ToolArgsJsonShape = {
  type: 'object',
  properties: {
    taskId: {
      type: 'string',
      description: 'The task id ProposeSession returned: "task_" and eight letters or digits.',
    },
  },
  required: ['taskId'],
  additionalProperties: false,
}

export async function withdrawProposal(
  input: WithdrawProposalInput,
  context: ToolCallContext,
): Promise<{ data: string }> {
  const taskId = trimmed(input?.taskId)
  if (!isProposalTaskId(taskId)) {
    return { data: 'Refused: taskId must be a task id: "task_" and eight lowercase letters or digits.' }
  }
  const board = getProposalBoard()
  const sessionId = context.options.sessionId
  if (!board || !sessionId) {
    return { data: 'Refused: proposals are unavailable here (no session manager in this runtime).' }
  }
  const result = await board.dismiss(sessionId, taskId)
  if (!result) return { data: `Refused: this session has no proposal ${taskId}.` }
  if (!result.ok) {
    const now = await board.get(sessionId, taskId)
    const words = now ? proposalStateWords(now) : result.state
    return { data: `Refused: proposal ${taskId} is ${words}; only a proposal still waiting can be withdrawn.` }
  }
  return { data: `Withdrew proposal ${taskId} ("${result.proposal.request.title}"); its card now shows it dismissed. Nothing was started.` }
}

export const WithdrawProposalTool: ToolContract<WithdrawProposalInput, string> = declareTool({
  name: WITHDRAW_PROPOSAL_TOOL_NAME,
  discoveryHint: 'withdraw a child-session proposal that has not started',
  argsSchema: WITHDRAW_SCHEMA,
  inputJSONSchemaStrict: WITHDRAW_SCHEMA,
  strict: true,
  description: async () =>
    'Withdraw a proposal of yours (ProposeSession) that is still waiting: before you do that work here ' +
    'yourself, or when it no longer applies. One that is starting or has started cannot be withdrawn; the ' +
    'result says which state it is in.',
  parallelSafe: () => false,
  readsOnly: () => false,
  async checkInput(input: WithdrawProposalInput): Promise<InputCheck> {
    if (typeof input?.taskId !== 'string') {
      return { result: false, message: 'taskId is required.', errorCode: 1 }
    }
    return { result: true }
  },
  async call(input: WithdrawProposalInput, context: ToolCallContext) {
    return withdrawProposal(input, context)
  },
})

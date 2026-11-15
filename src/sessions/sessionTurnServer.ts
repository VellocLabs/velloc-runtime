/**
 * Contract: the built-in `session_turn` server (F-41). `set_plan` keeps the
 * step list the conversation shows while the model works; `close` leaves the
 * turn's summary and, when the next move is the person's, one question with
 * reply buttons. Both tools write the caller's own session's turn board and
 * nothing else. Only the main conversation has a board on screen, so a call
 * from a loop under the session (a sub-agent or a teammate) is refused with a
 * note to carry on. A refusal writes nothing and says what to send instead;
 * a fixable flaw (too long, too many) is applied as far as it goes and noted
 * in the result.
 */
import type { BuiltinMcpServer, BuiltinMcpToolResult } from '../mcp/builtinServers'
import { mcpToolName } from '../mcp/toolAdapter'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { ToolArgsJsonShape } from '../toolkit/toolContract'
import {
  MAX_TURN_STEPS,
  TURN_STEP_STATUSES,
  turnBoard,
  type TurnBoard,
  type TurnStep,
  type TurnStepStatus,
} from './turnBoard'

export const SESSION_TURN_SERVER_NAME = 'session_turn'
export const SET_PLAN_TOOL = 'set_plan'
export const CLOSE_TURN_TOOL = 'close'
export const SET_PLAN_TOOL_NAME = mcpToolName(SESSION_TURN_SERVER_NAME, SET_PLAN_TOOL)
export const CLOSE_TURN_TOOL_NAME = mcpToolName(SESSION_TURN_SERVER_NAME, CLOSE_TURN_TOOL)

/** Session types without a turn board: a chat has no multi-step work to list. */
const TYPES_WITHOUT_TURN_BOARD: ReadonlySet<string> = new Set(['chat'])

export const MAX_SUMMARY_CHARS = 300
export const MAX_QUESTION_CHARS = 100
export const MAX_REPLY_CHARS = 24
export const MAX_REPLIES = 2

const SET_PLAN_DESCRIPTION = [
  'Show and update the step list the person sees under your latest message while you work. Use it for any request that edits files or takes more than one command; skip it for a one-command answer or plain conversation.',
  '',
  'Send it together with another tool call in the same message, never alone, so it adds no round trip.',
  '- Start: with the first tool call of the turn, pass {"steps": [...]} holding every step in order. Each step is a short imperative phrase of a few words, without numbering. Mark the step you are beginning "in_progress" and the others "pending". If you have to look around before you can plan, make that the first step and send the full list once you know it.',
  '- Moving on: pass {"next": true} beside the call that begins the following step. It completes the step in progress and starts the first pending one.',
  '- Out of order: pass {"done": [2], "start": 4}, counting steps from 1.',
  '- New plan: when the plan changes, or the person redirects you mid-task, pass {"steps": [...]} again with the whole new list.',
  'Keep exactly one step in progress while you work. The list on screen is the plan: do not repeat it as a numbered list in your message.',
].join('\n')

const CLOSE_DESCRIPTION = [
  'End the turn\'s work with a summary and, when the next move is the person\'s, one question with reply buttons. Call it once in every turn where you kept a step list, changed files, ran commands or finished multi-step work, after the work is done and before your closing message. It also completes the step in progress, so no final set_plan call is needed. Skip it for short answers and plain conversation.',
  '',
  'Your closing message comes after this call as ordinary text and is your full answer; the summary does not replace it. The result tells you whether the question is on screen: ask in your message only a question it does not show.',
  '',
  'Arguments, each plain prose addressed to the person:',
  '- summary (required): what is now true or changed and where things stand, naming anything not done or not verified. Two or three short sentences, at most 300 characters. It must make sense read on its own. No recommendation.',
  '- question: only when a decision or go-ahead is the person\'s to give. One decision in one short sentence, at most 100 characters, without reasons and without listing the answers the buttons give.',
  '- replies: one or two answers to the question, your recommended one first. Each is the person\'s words back to you, one to three words, at most 24 characters.',
  '- waiting: true when you cannot continue until the person answers.',
].join('\n')

const SET_PLAN_SCHEMA: ToolArgsJsonShape = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      description: `The whole plan in order (1-${MAX_TURN_STEPS} steps); replaces the list on screen.`,
      minItems: 1,
      maxItems: MAX_TURN_STEPS,
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'A short imperative phrase.' },
          status: { type: 'string', enum: [...TURN_STEP_STATUSES] },
        },
        required: ['text', 'status'],
      },
    },
    next: { type: 'boolean', description: 'Complete the step in progress and start the first pending one.' },
    done: { type: 'array', items: { type: 'number' }, description: 'Steps to complete, counted from 1.' },
    start: { type: 'number', description: 'The step to start, counted from 1.' },
  },
}

const CLOSE_SCHEMA: ToolArgsJsonShape = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: `What is now true and where things stand, at most ${MAX_SUMMARY_CHARS} characters.`,
    },
    question: {
      type: 'string',
      description: `The one decision left to the person, at most ${MAX_QUESTION_CHARS} characters. Omit when nothing waits on them.`,
    },
    replies: {
      type: 'array',
      description: `One or two answers to the question, the recommended one first; each at most ${MAX_REPLY_CHARS} characters.`,
      maxItems: MAX_REPLIES,
      items: { type: 'string' },
    },
    waiting: { type: 'boolean', description: 'true when the work stops until the person answers.' },
  },
  required: ['summary'],
}

export const NESTED_CALLER_NOTE =
  'Not shown: only the main conversation has a step list and a closing box, and you are working under it. Do not call set_plan or close again; continue your task and report your result the usual way.'

const refused = (text: string): BuiltinMcpToolResult => ({ text, isError: true })

/** Whether the call comes from a loop under the session rather than its main conversation. */
export function isNestedCaller(context: ToolCallContext): boolean {
  const sessionId = context.options.sessionId ?? ''
  return (
    context.agentId !== undefined ||
    context.options.mods?.agentId !== undefined ||
    sessionId.startsWith('subagent-') ||
    sessionId.startsWith('teammate-') ||
    context.options.teammateName !== undefined
  )
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Where the list stands, with the next move when it is not one step in progress. */
function describeSteps(steps: readonly TurnStep[]): string {
  const total = steps.length
  const current = steps.flatMap((step, index) => (step.status === 'in_progress' ? [index + 1] : []))
  if (current.length === 1) return `step ${current[0]} of ${total} is in progress`
  if (current.length > 1) {
    return `steps ${current.join(', ')} of ${total} are in progress; keep one and send {"done": [n]} for each one you finished`
  }
  const done = steps.filter(step => step.status === 'completed').length
  if (done === total) return 'every step is done'
  return `no step is in progress (${done} of ${total} done); {"start": n} starts one`
}

/** The entries of `raw` that are steps: text and a known status. The rest are left out. */
function readSteps(raw: unknown): TurnStep[] {
  if (!Array.isArray(raw)) return []
  const steps: TurnStep[] = []
  for (const item of raw) {
    if (!isRecord(item) || typeof item.text !== 'string') continue
    const text = item.text.trim()
    if (!text || !(TURN_STEP_STATUSES as readonly unknown[]).includes(item.status)) continue
    steps.push({ text, status: item.status as TurnStepStatus })
  }
  return steps
}

export function runSetPlan(board: TurnBoard, sessionId: string, args: Record<string, unknown>): BuiltinMcpToolResult {
  const next = args.next === true
  const done = Array.isArray(args.done) && args.done.length > 0 ? (args.done as unknown[]) : undefined
  const start = args.start === undefined || args.start === null ? undefined : args.start
  const hasUpdate = next || done !== undefined || start !== undefined

  if (args.steps !== undefined) {
    const steps = readSteps(args.steps)
    if (steps.length === 0) {
      return refused('"steps" needs at least one step with a "text" and a "status". Nothing changed.')
    }
    // The board bounds the list and each text; the latest whole list is the state.
    const shown = board.setPlan(sessionId, steps)
    const notes: string[] = []
    if (hasUpdate) {
      notes.push('"steps" sets every step\'s status, so the "next" / "done" / "start" sent with it changed nothing; send them in a later call.')
    }
    if (shown.filter(step => step.status === 'in_progress').length > 1) {
      notes.push('Keep only one step in progress.')
    }
    const count = `${shown.length} ${shown.length === 1 ? 'step' : 'steps'}`
    return { text: [`Plan shown (${count}): ${describeSteps(shown)}.`, ...notes].join(' ') }
  }

  if (!hasUpdate) {
    return refused('Pass {"steps": [...]} for the whole plan, {"next": true}, or {"done": [n], "start": m}.')
  }
  const change = board.update(sessionId, {
    ...(done ? { done: done as number[] } : {}),
    ...(start !== undefined ? { start: start as number } : {}),
    next,
  })
  if (!change.ok) {
    return refused(
      `Nothing changed: "done" and "start" take whole step numbers counted from 1, and the list has ${change.count} ${change.count === 1 ? 'step' : 'steps'}. ` +
        (change.count === 0 ? 'Send {"steps": [...]} with the whole plan first.' : 'Send the call again with numbers from the list.'),
    )
  }
  if (change.steps.length === 0) {
    return { text: 'Plan updated: no list is shown yet. Send {"steps": [...]} with the whole plan.' }
  }
  return { text: `Plan updated: ${describeSteps(change.steps)}.` }
}

/** A character that draws nothing: a control, a zero-width or a direction mark. */
const INVISIBLE_CHAR = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060-\u2064\ufeff]/

/** Text of another argument or call caught inside a field's value. */
const SWALLOWED_MARKUP = /<\/?[A-Za-z_:.-]*(?:invoke|parameter|function_calls|tool_use|tool_call)\b/i

export function runCloseTurn(board: TurnBoard, sessionId: string, args: Record<string, unknown>): BuiltinMcpToolResult {
  const summary = typeof args.summary === 'string' ? args.summary.trim() : ''
  if (!summary) {
    return refused('"summary" is required: say what is now true or changed and where things stand. Nothing is shown.')
  }
  const rawQuestion = typeof args.question === 'string' ? args.question.trim() : ''
  const rawReplies = Array.isArray(args.replies) ? (args.replies as unknown[]) : []
  const fields = [summary, rawQuestion, ...rawReplies.filter((reply): reply is string => typeof reply === 'string')]
  if (fields.some(field => SWALLOWED_MARKUP.test(field))) {
    return refused(
      'Nothing is shown: a value holds what looks like another argument or call. Send close again with each argument on its own as plain prose, "summary" last.',
    )
  }

  const notes: string[] = []
  let question = rawQuestion
  if (question.length > MAX_QUESTION_CHARS) {
    question = question.slice(0, MAX_QUESTION_CHARS)
    notes.push(`"question" was cut to ${MAX_QUESTION_CHARS} characters; keep it shorter next time.`)
  }

  const replies: string[] = []
  let dropped = 0
  let shortened = 0
  for (const raw of rawReplies) {
    const reply = typeof raw === 'string' ? raw.trim() : ''
    if (!reply) continue
    if (reply.startsWith('/') || reply.startsWith('!') || INVISIBLE_CHAR.test(reply)) {
      dropped += 1
      continue
    }
    if (reply.length > MAX_REPLY_CHARS) shortened += 1
    replies.push(reply.slice(0, MAX_REPLY_CHARS).trim())
  }
  if (dropped > 0) {
    notes.push('A reply that starts with "/" or "!" or holds an invisible character was left out.')
  }
  if (shortened > 0) {
    notes.push(`A reply longer than ${MAX_REPLY_CHARS} characters was cut; a reply is one to three words.`)
  }
  if (replies.length > MAX_REPLIES) {
    replies.length = MAX_REPLIES
    notes.push(`Only the first ${MAX_REPLIES} replies are shown.`)
  }
  if (!question && replies.length > 0) {
    replies.length = 0
    notes.push('The replies were left out: they answer a "question", and none was sent.')
  }

  const { repeated } = board.close(sessionId, {
    summary: summary.slice(0, MAX_SUMMARY_CHARS),
    ...(question ? { question } : {}),
    replies,
    waiting: args.waiting === true,
  })
  if (repeated) {
    notes.push('Do not call close again this turn; the notes here are for your next call.')
  }
  const outcome = question
    ? 'Shown: the question and its reply buttons are on screen; do not ask it again in your closing message.'
    : 'Nothing waits on the person, so no box is drawn. Write your closing message now.'
  return { text: [outcome, ...notes].join(' ') }
}

/** The server over `board`; the bundled one uses the realm's board. */
export function createSessionTurnServer(board: TurnBoard = turnBoard): BuiltinMcpServer {
  const onMainConversation = (
    context: ToolCallContext,
    run: (sessionId: string) => BuiltinMcpToolResult,
  ): BuiltinMcpToolResult => {
    if (isNestedCaller(context)) return refused(NESTED_CALLER_NOTE)
    const sessionId = context.options.sessionId
    if (!sessionId) return refused('Unavailable here: this conversation has no session to show a plan in.')
    return run(sessionId)
  }
  return {
    name: SESSION_TURN_SERVER_NAME,
    alwaysLoad: true,
    isEnabled: session =>
      !session.nested && !session.headless && !TYPES_WITHOUT_TURN_BOARD.has(session.templateType),
    tools: [
      {
        name: SET_PLAN_TOOL,
        description: SET_PLAN_DESCRIPTION,
        inputSchema: SET_PLAN_SCHEMA,
        readOnly: true,
        call: (args, context) => onMainConversation(context, sessionId => runSetPlan(board, sessionId, args)),
      },
      {
        name: CLOSE_TURN_TOOL,
        description: CLOSE_DESCRIPTION,
        inputSchema: CLOSE_SCHEMA,
        readOnly: true,
        call: (args, context) => onMainConversation(context, sessionId => runCloseTurn(board, sessionId, args)),
      },
    ],
  }
}

/**
 * `$.ui.ask` (F-25) shapes: one question raised as a `tool.call` of AskUserQuestion,
 * the answer read from `result.answers[question]` (lists joined with ", "); no answer
 * is a rejection.
 */
import { MOD_ASK_HEADER_MAX_CHARS, MOD_ASK_MAX_OPTIONS, sanitizeModUiText, type ModUiAskArgs } from './modUi'
import { toolCallEventOf, type ToolCallCoreResult, type ToolCallEvent } from './toolCallEvent'

export const MOD_ASK_TOOL = 'AskUserQuestion'
/** The chip a call that names none gets. */
export const MOD_ASK_DEFAULT_HEADER = 'Plugin'

/** One question of AskUserQuestion's input. */
export type ModAskQuestion = {
  question: string
  header: string
  options: Array<{ label: string; description: string }>
  multiSelect: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function questionOf(args: ModUiAskArgs): ModAskQuestion {
  return {
    question: args.question,
    header: args.header ?? MOD_ASK_DEFAULT_HEADER,
    options: args.options.map(option => ({ label: option.label, description: '' })),
    multiSelect: args.multiSelect,
  }
}

/** The `tool.call` event of a `$.ui.ask`: AskUserQuestion's input. */
export function askToolEventOf(args: ModUiAskArgs, toolUseId: string): ToolCallEvent {
  return toolCallEventOf(MOD_ASK_TOOL, toolUseId, { questions: [questionOf(args)] })
}

/**
 * The question as it ARRIVED at core. A hook above may rewrite the question,
 * its chip, its labels or `multiSelect`, as it may any tool's arguments; what
 * the dialog cannot draw (no question, fewer than two or more than four
 * labels, a repeated one) is the call as it was made. A label the engine
 * padded keeps its mark while it is still offered, so the page draws it in
 * the person's language.
 */
export function askArgsOfArrived(arrived: unknown, original: ModUiAskArgs): ModUiAskArgs {
  const questions = isRecord(arrived) ? arrived.questions : undefined
  const first = Array.isArray(questions) ? (questions[0] as unknown) : undefined
  if (!isRecord(first)) return original
  const question = first.question
  if (typeof question !== 'string' || question.trim() === '') return original
  const options = Array.isArray(first.options) ? first.options : []
  const labels = options.map(option => (isRecord(option) ? option.label : undefined))
  if (
    labels.length < 2 ||
    labels.length > MOD_ASK_MAX_OPTIONS ||
    !labels.every((label): label is string => typeof label === 'string' && label.trim() !== '') ||
    new Set(labels).size !== labels.length
  ) {
    return original
  }
  const header =
    typeof first.header === 'string' && first.header !== '' && !(first.header === MOD_ASK_DEFAULT_HEADER && original.header === undefined)
      ? sanitizeModUiText(first.header.slice(0, MOD_ASK_HEADER_MAX_CHARS))
      : original.header
  return {
    question: sanitizeModUiText(question),
    ...(header !== undefined ? { header } : {}),
    options: labels.map(label => {
      const padded = original.options.find(option => option.label === label && option.engine !== undefined)
      return padded ? { ...padded } : { label: sanitizeModUiText(label) }
    }),
    multiSelect: first.multiSelect === true,
  }
}

/** Core's answer when the person answered: AskUserQuestion's result, the
 *  answers keyed by the question, and the summary the model would read. */
export function askCoreAnswered(args: ModUiAskArgs, answer: string): ToolCallCoreResult {
  return {
    ref: 0,
    result: { questions: [questionOf(args)], answers: { [args.question]: answer } },
    text: `The user answered: "${args.question}"="${answer}". Continue, taking these answers into account.`,
  }
}

/** Core's answer when the person dismissed the question: no answers. */
export function askCoreDismissed(args: ModUiAskArgs): ToolCallCoreResult {
  return {
    ref: 0,
    result: { questions: [questionOf(args)] },
    text: 'the dialog was dismissed',
    isError: true,
  }
}

/** What the call resolves to, read off the chain's answer: the answer to
 *  `question`, or why there is none. */
export type ModAskOutcome = { answer: string } | { noAnswer: string }

export function askOutcomeOf(settled: unknown, question: string): ModAskOutcome {
  if (isRecord(settled) && typeof settled.deny === 'string') return { noAnswer: settled.deny }
  const result = isRecord(settled) ? settled.result : undefined
  const answers = isRecord(result) ? result.answers : undefined
  // Keyed by the question as asked; a hook that reworded it gets its one
  // answer back all the same.
  const keys = isRecord(answers) ? Object.keys(answers) : []
  const answer = isRecord(answers) ? (question in answers ? answers[question] : keys.length === 1 ? answers[keys[0]!] : undefined) : undefined
  if (typeof answer === 'string') return { answer }
  if (Array.isArray(answer)) return { answer: answer.map(String).join(', ') }
  const text = isRecord(settled) && typeof settled.text === 'string' ? settled.text : ''
  return { noAnswer: text !== '' ? text : 'the dialog was dismissed' }
}

import type { ToolContract, InputCheck } from '../toolContract'
import type { ToolCallContext } from '../toolCallContext'
import { declareTool } from '../toolContract'

export const ASK_TOOL_ID = 'AskUserQuestion'

export const ASK_CHIP_COLUMNS = 12
const MIN_QUESTIONS = 1
const MAX_QUESTIONS = 4
const MIN_OPTIONS = 2
const MAX_OPTIONS = 4

export type AskUserQuestionOption = {
  label: string
  description: string
  preview?: string
}

export type AskUserQuestion = {
  question: string
  header: string
  options: AskUserQuestionOption[]
  multiSelect?: boolean
}

export type AskUserQuestionAnnotation = {
  preview?: string
  notes?: string
}

export type AskUserQuestionInput = {
  questions?: AskUserQuestion[]
  // Populated by the host UI when it submits answers back to the runtime.
  // Keys are the question text; values are the answer string (multi-select
  // answers are comma-separated).
  answers?: Record<string, string>
  annotations?: Record<string, AskUserQuestionAnnotation>
  metadata?: { source?: string }
}

// The model-facing result is a prose summary of the
// user's answers ("The user answered: …"). The
// structured fields live on the input itself; consumers that need
// them read `input.answers` / `input.annotations`.
export type AskUserQuestionOutput = string

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function validateOption(
  option: unknown,
  questionIndex: number,
  optionIndex: number,
): string | null {
  if (!isPlainObject(option)) {
    return `questions[${questionIndex}].options[${optionIndex}] must be an object.`
  }
  if (!isString(option.label) || option.label.trim().length === 0) {
    return `questions[${questionIndex}].options[${optionIndex}].label must be a non-empty string.`
  }
  if (!isString(option.description)) {
    return `questions[${questionIndex}].options[${optionIndex}].description must be a string.`
  }
  if (option.preview !== undefined && !isString(option.preview)) {
    return `questions[${questionIndex}].options[${optionIndex}].preview must be a string when provided.`
  }
  return null
}

function validateQuestion(
  question: unknown,
  index: number,
): { error: string | null; multiSelect: boolean } {
  if (!isPlainObject(question)) {
    return { error: `questions[${index}] must be an object.`, multiSelect: false }
  }
  if (!isString(question.question) || question.question.trim().length === 0) {
    return {
      error: `questions[${index}].question must be a non-empty string.`,
      multiSelect: false,
    }
  }
  if (!isString(question.header) || question.header.length === 0) {
    return {
      error: `questions[${index}].header must be a non-empty string.`,
      multiSelect: false,
    }
  }
  // NOTE: header length is a SOFT hint, not a hard rule. The schema
  // description documents "max 12 chars" and the UI truncates an over-long
  // header to fit the chip. Hard-rejecting here
  // (as nexus_web previously did) made the model RE-ISSUE the whole question
  // with a shortened header, which rendered as a duplicate "(no answer)" card.
  // The chip width is enforced cosmetically in the UI, not by validation.
  if (!Array.isArray(question.options)) {
    return {
      error: `questions[${index}].options must be an array.`,
      multiSelect: false,
    }
  }
  if (
    question.options.length < MIN_OPTIONS ||
    question.options.length > MAX_OPTIONS
  ) {
    return {
      error: `questions[${index}].options must contain ${MIN_OPTIONS}-${MAX_OPTIONS} options.`,
      multiSelect: false,
    }
  }
  for (let optionIndex = 0; optionIndex < question.options.length; optionIndex += 1) {
    const error = validateOption(question.options[optionIndex], index, optionIndex)
    if (error) {
      return { error, multiSelect: false }
    }
  }
  const labels = question.options.map(opt => (opt as AskUserQuestionOption).label)
  if (new Set(labels).size !== labels.length) {
    return {
      error: `questions[${index}].options labels must be unique within the question.`,
      multiSelect: false,
    }
  }
  const multiSelect =
    typeof question.multiSelect === 'boolean' ? question.multiSelect : false
  return { error: null, multiSelect }
}

export const AskPersonTool: ToolContract<
  AskUserQuestionInput,
  AskUserQuestionOutput
> = declareTool({
  name: ASK_TOOL_ID,
  discoveryHint: 'prompt the user with a multiple-choice question',
  argsSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: MIN_QUESTIONS,
        maxItems: MAX_QUESTIONS,
        description: `${MIN_QUESTIONS}-${MAX_QUESTIONS} questions to ask the user.`,
        items: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description:
                'The complete question text. Should end with a question mark and be phrased as a single decision.',
            },
            header: {
              type: 'string',
              description: `A very short tag/chip label (max ${ASK_CHIP_COLUMNS} chars), e.g. "Library" or "Approach".`,
            },
            options: {
              type: 'array',
              minItems: MIN_OPTIONS,
              maxItems: MAX_OPTIONS,
              description:
                'Mutually exclusive choices the user can pick from. The host UI also offers an "Other" free-text fallback automatically.',
              items: {
                type: 'object',
                properties: {
                  label: {
                    type: 'string',
                    description:
                      'Short display text for the option (1-5 words). For recommendations append "(Recommended)".',
                  },
                  description: {
                    type: 'string',
                    description:
                      'Brief explanation of what choosing this option means.',
                  },
                  preview: {
                    type: 'string',
                    description:
                      'Optional preview content (markdown / HTML fragment depending on host) used for side-by-side comparisons. Only honored for single-select questions.',
                  },
                },
                required: ['label', 'description'],
              },
            },
            multiSelect: {
              type: 'boolean',
              description:
                'When true, the user can pick multiple options. Disables previews for that question.',
            },
          },
          required: ['question', 'header', 'options'],
        },
      },
      answers: {
        type: 'object',
        description:
          'Populated by the host UI on the answer submission. Keys are the question text; values are the chosen labels (comma-separated for multi-select).',
        additionalProperties: { type: 'string' },
      },
      annotations: {
        type: 'object',
        description:
          'Optional per-question annotations (e.g. selected preview, free-text notes) returned by the host UI. Keyed by question text.',
        additionalProperties: {
          type: 'object',
          properties: {
            preview: { type: 'string' },
            notes: { type: 'string' },
          },
        },
      },
      metadata: {
        type: 'object',
        description: 'Optional analytics metadata not shown to the user.',
        properties: {
          source: { type: 'string' },
        },
      },
    },
    required: ['questions'],
  },
  description: async () =>
    'Puts one to four multiple-choice questions to the user and waits for the answers. Use it to resolve an ambiguity, learn a preference, or let the user pick between options.',
  readsOnly: () => true,
  parallelSafe: () => true,
  haltsForUser: () => true,
  async checkInput(
    input: AskUserQuestionInput,
    _context: ToolCallContext,
  ): Promise<InputCheck> {
    const questions = input.questions
    if (!Array.isArray(questions)) {
      return {
        result: false,
        message: 'questions must be an array.',
        errorCode: 1,
      }
    }
    if (questions.length < MIN_QUESTIONS || questions.length > MAX_QUESTIONS) {
      return {
        result: false,
        message: `questions must contain ${MIN_QUESTIONS}-${MAX_QUESTIONS} entries.`,
        errorCode: 2,
      }
    }
    const seenQuestionTexts = new Set<string>()
    for (let index = 0; index < questions.length; index += 1) {
      const { error } = validateQuestion(questions[index], index)
      if (error) {
        return { result: false, message: error, errorCode: 3 }
      }
      const questionText = (questions[index] as AskUserQuestion).question
      if (seenQuestionTexts.has(questionText)) {
        return {
          result: false,
          message: `Question texts must be unique. Duplicate: "${questionText}".`,
          errorCode: 4,
        }
      }
      seenQuestionTexts.add(questionText)
    }
    return { result: true }
  },
  async call(input: AskUserQuestionInput, _context: ToolCallContext) {
    // The host UI is responsible for collecting answers and submitting the
    // tool result via submitToolResult. When the runtime invokes call()
    // directly without prior interaction, requiresUserInteraction() will
    // already have caused the orchestration to yield a pendingToolUse and
    // halt — call() should only run in the off-path where the input was
    // pre-populated with answers (e.g. SDK consumers replaying a transcript
    // or tests).
    if (!input.answers) {
      throw new Error(
        `${ASK_TOOL_ID} requires user interaction. The host UI must collect answers and submit them via submitToolResult.`,
      )
    }
    // The result is a prose summary of the user's selections plus a closing
    // line, so the model reads it as a conversational reply.
    // Build "Question text" → "chosen label" pairs joined by '; '.
    const answersText = (input.questions ?? [])
      .map(q => {
        const selected = input.answers?.[q.question] ?? '(no answer)'
        const annot = input.annotations?.[q.question]
        const annotSuffix =
          annot?.notes && annot.notes.length > 0
            ? ` (notes: ${annot.notes})`
            : ''
        return `"${q.question}"="${selected}"${annotSuffix}`
      })
      .join(', ')
    return {
      data: `The user answered: ${answersText}. Continue, taking these answers into account.`,
    }
  },
})

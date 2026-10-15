import { describe, expect, it } from 'vitest'
import { INTERRUPTED_TOOL_RESULT } from '../browser/webview/assistantUiAdapterParts'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import { AskPersonTool } from '../toolkit/builtin/askUser'
import {
  digestFromResult,
  isSupersededAskResult,
  resolveEffectiveAskResult,
  answeredResultCache,
} from '../browser/webview/AskUserQuestionToolUI'

const PARENT_MESSAGE = {
  type: 'assistant',
  uuid: 'assistant-1',
  message: {
    role: 'assistant',
    content: [],
  },
} as never

const ALLOW = async () => ({ behavior: 'allow' as const })

function makeContext() {
  return createNoopToolUseContext({
    tools: [AskPersonTool],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
    cwd: '/workspace',
    sessionId: 'aaq-test-session',
  })
}

const SAMPLE_QUESTIONS = [
  {
    question: 'Which library should we use for date formatting?',
    header: 'Library',
    options: [
      {
        label: 'date-fns (Recommended)',
        description: 'Tree-shakeable, immutable, ESM-first.',
      },
      { label: 'dayjs', description: 'Smaller bundle, similar API to moment.' },
      {
        label: 'luxon',
        description: 'Built-in IANA tz support, immutable.',
      },
    ],
  },
] as const

describe('AskPersonTool', () => {
  it('declares the canonical tool surface (read-only, requires user interaction)', () => {
    expect(AskPersonTool.name).toBe('AskUserQuestion')
    expect(AskPersonTool.readsOnly?.({} as never)).toBe(true)
    expect(AskPersonTool.parallelSafe?.({} as never)).toBe(true)
    expect(AskPersonTool.haltsForUser?.()).toBe(true)
  })

  describe('validateInput', () => {
    it('accepts a well-formed question', async () => {
      const result = await AskPersonTool.checkInput?.(
        { questions: SAMPLE_QUESTIONS as never },
        makeContext(),
      )
      expect(result).toEqual({ result: true })
    })

    it('rejects a missing questions array', async () => {
      const result = await AskPersonTool.checkInput?.(
        {} as never,
        makeContext(),
      )
      expect(result).toEqual({
        result: false,
        message: 'questions must be an array.',
        errorCode: 1,
      })
    })

    it('rejects an empty questions array', async () => {
      const result = await AskPersonTool.checkInput?.(
        { questions: [] },
        makeContext(),
      )
      expect(result).toEqual({
        result: false,
        message: 'questions must contain 1-4 entries.',
        errorCode: 2,
      })
    })

    it('rejects more than 4 questions', async () => {
      const tooMany = Array.from({ length: 5 }, (_, i) => ({
        question: `Q${i}?`,
        header: `H${i}`,
        options: [
          { label: `${i}-A`, description: 'a' },
          { label: `${i}-B`, description: 'b' },
        ],
      }))
      const result = await AskPersonTool.checkInput?.(
        { questions: tooMany },
        makeContext(),
      )
      expect(result).toEqual({
        result: false,
        message: 'questions must contain 1-4 entries.',
        errorCode: 2,
      })
    })

    // An over-long header is a SOFT hint (schema description), NOT a hard
    // rule: validation accepts it and the UI truncates the chip. A hard
    // rejection forced the model to RE-ISSUE the question with a shortened
    // header, which rendered as a duplicate "(no answer)" card.
    it('ACCEPTS a header longer than the chip-width hint (no hard rejection)', async () => {
      const result = await AskPersonTool.checkInput?.(
        {
          questions: [
            {
              question: 'Pick one?',
              header: 'this-header-is-way-too-long',
              options: [
                { label: 'A', description: 'a' },
                { label: 'B', description: 'b' },
              ],
            },
          ],
        },
        makeContext(),
      )
      expect(result?.result).toBe(true)
    })

    it('rejects a question with fewer than 2 options', async () => {
      const result = await AskPersonTool.checkInput?.(
        {
          questions: [
            {
              question: 'Single choice?',
              header: 'Choice',
              options: [{ label: 'Only', description: 'only one' }],
            },
          ],
        },
        makeContext(),
      )
      expect(result?.result).toBe(false)
      expect((result && 'message' in result ? result.message : undefined)).toContain('2-4 options')
    })

    it('rejects a question with more than 4 options', async () => {
      const result = await AskPersonTool.checkInput?.(
        {
          questions: [
            {
              question: 'Many choices?',
              header: 'Choice',
              options: Array.from({ length: 5 }, (_, i) => ({
                label: `Opt-${i}`,
                description: 'd',
              })),
            },
          ],
        },
        makeContext(),
      )
      expect(result?.result).toBe(false)
      expect((result && 'message' in result ? result.message : undefined)).toContain('2-4 options')
    })

    it('rejects duplicate option labels within a question', async () => {
      const result = await AskPersonTool.checkInput?.(
        {
          questions: [
            {
              question: 'Dup options?',
              header: 'Choice',
              options: [
                { label: 'Same', description: 'a' },
                { label: 'Same', description: 'b' },
              ],
            },
          ],
        },
        makeContext(),
      )
      expect(result?.result).toBe(false)
      expect((result && 'message' in result ? result.message : undefined)).toContain('options labels must be unique')
    })

    it('rejects duplicate question texts across the batch', async () => {
      const result = await AskPersonTool.checkInput?.(
        {
          questions: [
            {
              question: 'Same question?',
              header: 'A',
              options: [
                { label: 'A', description: 'a' },
                { label: 'B', description: 'b' },
              ],
            },
            {
              question: 'Same question?',
              header: 'B',
              options: [
                { label: 'C', description: 'c' },
                { label: 'D', description: 'd' },
              ],
            },
          ],
        },
        makeContext(),
      )
      expect(result?.result).toBe(false)
      expect((result && 'message' in result ? result.message : undefined)).toContain('Question texts must be unique')
    })
  })

  describe('call', () => {
    it('returns the answers when the host UI has populated them', async () => {
      const result = await AskPersonTool.call(
        {
          questions: SAMPLE_QUESTIONS as never,
          answers: {
            'Which library should we use for date formatting?':
              'date-fns (Recommended)',
          },
          annotations: {
            'Which library should we use for date formatting?': {
              notes: 'Tree-shaking is required.',
            },
          },
        },
        makeContext(),
        ALLOW,
        PARENT_MESSAGE,
      )

      // AskPersonTool emits a prose summary
       // string instead of the {questions, answers, annotations} dict.
       // The structured input data is still available on `input` for
       // the UI; the test now asserts on the prose shape the model
       // actually sees.
      expect(typeof result.data).toBe('string')
      expect(result.data).toContain('The user answered')
      expect(result.data).toContain('date-fns (Recommended)')
      expect(result.data).toContain('Which library should we use for date formatting?')
      expect(result.data).toContain('Tree-shaking is required.')
    })

    it('throws when answers have not been provided yet', async () => {
      await expect(
        AskPersonTool.call(
          { questions: SAMPLE_QUESTIONS as never },
          makeContext(),
          ALLOW,
          PARENT_MESSAGE,
        ),
      ).rejects.toThrow(/requires user interaction/i)
    })
  })

  // Orchestration behavior (requiresUserInteraction → pendingToolUse →
  // terminal.reason='awaiting_user_interaction') is already covered by
  // src/__tests__/generative-ui-tools.test.ts for the existing interactive
  // generative-UI tools (`select_date`, `collect_contact`). AskUserQuestion
  // sets the same tool flags so it rides the same path.
})

// Regression: a validation-rejected / superseded AskUserQuestion call must NOT
// render as a phantom "(no answer)" question card (the duplicate-card defect).
// The UI branches on isSupersededAskResult to render a compact chip instead.
describe('isSupersededAskResult (error-aware card detection)', () => {
  it('treats a validation-error result as superseded', () => {
    expect(
      isSupersededAskResult(
        'Invalid input: questions[0].header must be at most 12 characters.',
      ),
    ).toBe(true)
  })

  it('does NOT treat a real answer result as superseded', () => {
    expect(
      isSupersededAskResult(
        'The user answered: "Q1"="A1". Continue, taking these answers into account.',
      ),
    ).toBe(false)
  })

  it('is false for an unanswered (undefined) or empty result', () => {
    expect(isSupersededAskResult(undefined)).toBe(false)
    expect(isSupersededAskResult('')).toBe(false)
  })
})

// Regression: when the model continues after an answer (new tool calls arrive),
// the live → persisted message-id swap REMOUNTS the AskUserQuestion card, wiping
// its `pendingResult` useState back to null. If the remount lands before the
// worker round-trip populates the `result` prop, the card must NOT revert to its
// unanswered form — it recovers the answer from the module-level
// `answeredResultCache`. `resolveEffectiveAskResult` encodes that fallback chain.
describe('resolveEffectiveAskResult (answered state survives remount)', () => {
  const ANSWER =
    'The user answered: "Q1"="A1". Continue, taking these answers into account.'

  it('prefers the persisted result prop when present', () => {
    expect(resolveEffectiveAskResult(ANSWER, null, undefined)).toBe(ANSWER)
    // The prop wins even when a stale cache entry exists.
    expect(resolveEffectiveAskResult(ANSWER, 'pending', 'cached')).toBe(ANSWER)
  })

  it('falls back to the locally-cached pending result in the same mount', () => {
    expect(resolveEffectiveAskResult(undefined, ANSWER, undefined)).toBe(ANSWER)
  })

  it('falls back to the module-level cache after a remount wipes pendingResult', () => {
    // This is the defect scenario: result prop still undefined (worker round-
    // trip in flight) AND pendingResult reset to null by the remount — only the
    // cache keeps the card answered.
    expect(resolveEffectiveAskResult(undefined, null, ANSWER)).toBe(ANSWER)
  })

  it('returns null (genuinely unanswered) when no source has an answer', () => {
    expect(resolveEffectiveAskResult(undefined, null, undefined)).toBeNull()
  })

  // Regression: the answer travels as the NEXT turn's user prompt, and the
  // transcript is not refetched until that turn ends — but the snapshot that
  // clears `pendingUserInteraction` lands immediately, so the adapter stamps the
  // still-unresolved call with INTERRUPTED_TOOL_RESULT for the whole turn. That
  // sentinel used to win over the pending/cached answer (and evict the cache),
  // rendering "(no answer)" until the turn ended.
  it('a restart sentinel never outranks the pending / cached answer', () => {
    expect(
      resolveEffectiveAskResult(INTERRUPTED_TOOL_RESULT, ANSWER, undefined),
    ).toBe(ANSWER)
    expect(
      resolveEffectiveAskResult(INTERRUPTED_TOOL_RESULT, null, ANSWER),
    ).toBe(ANSWER)
  })

  it('a restart sentinel still settles a genuinely dead call (no answer anywhere)', () => {
    expect(
      resolveEffectiveAskResult(INTERRUPTED_TOOL_RESULT, null, undefined),
    ).toBe(INTERRUPTED_TOOL_RESULT)
  })
})

describe('answeredResultCache (remount survival store)', () => {
  it('a cached answer keeps the card answered across a simulated remount', () => {
    const toolCallId = 'remount-survival-test'
    const answer =
      'The user answered: "Pick?"="Yes". Continue, taking these answers into account.'

    // handleSubmit writes the cache.
    answeredResultCache.set(toolCallId, answer)

    // Simulate the remount: fresh mount has result=undefined, pendingResult=null.
    const effective = resolveEffectiveAskResult(
      undefined,
      null,
      answeredResultCache.get(toolCallId),
    )
    expect(effective).toBe(answer)

    // Once the persisted result arrives, the cleanup effect drops the entry.
    answeredResultCache.delete(toolCallId)
    expect(answeredResultCache.get(toolCallId)).toBeUndefined()
  })
})


// The answered card does NOT keep the structured selections around: it
// re-derives them by parsing the prose result string it shipped to the model.
// The prose has no escaping, so a `"` inside a question text (or an option
// label) used to re-pair a plain left-to-right scan onto the wrong quotes —
// the affected question's real key went missing from the map and its row
// rendered "(no answer)" while every LATER pair re-synced and rendered fine.
// That is the user-visible "two questions, the first one comes back blank"
// defect. `digestFromResult` now anchors on the question texts it already has.
describe('digestFromResult (answered-card round-trip)', () => {
  const prose = (pairs: string) =>
    `The user answered: ${pairs}. Continue, taking these answers into account.`

  const asQuestions = (...texts: string[]) =>
    texts.map(text => ({
      question: text,
      header: 'H',
      options: [
        { label: 'a', description: '' },
        { label: 'b', description: '' },
      ],
    }))

  it('reads both answers back for a plain two-question card', () => {
    const q1 = 'Which library should we use?'
    const q2 = 'Should we add tests?'
    const digest = digestFromResult(
      prose(`"${q1}"="date-fns", "${q2}"="Yes"`),
      asQuestions(q1, q2),
    )
    expect(digest?.answers[q1]).toBe('date-fns')
    expect(digest?.answers[q2]).toBe('Yes')
  })

  // THE DEFECT. Without the questions to anchor on, the scan pairs the quote
  // that CLOSES the inner `"mode"` with the one that opens the answer: the
  // first question is keyed by a fragment, so its real key is absent and the
  // card shows "(no answer)" for row 1 while row 2 is correct.
  it('scanning without the questions mis-pairs a quoted question text', () => {
    const q1 = 'Which "mode" should we use?'
    const q2 = 'Should we add tests?'
    const scanned = digestFromResult(prose(`"${q1}"="Strict", "${q2}"="Yes"`))
    expect(scanned?.answers[q1]).toBeUndefined()
    expect(scanned?.answers[' should we use?']).toBe('Strict')
    expect(scanned?.answers[q2]).toBe('Yes')
  })

  it('anchoring on the question texts recovers the quoted first question', () => {
    const q1 = 'Which "mode" should we use?'
    const q2 = 'Should we add tests?'
    const digest = digestFromResult(
      prose(`"${q1}"="Strict", "${q2}"="Yes"`),
      asQuestions(q1, q2),
    )
    expect(digest?.answers[q1]).toBe('Strict')
    expect(digest?.answers[q2]).toBe('Yes')
  })

  it('keeps an answer whose LABEL carries quotes, commas and parens intact', () => {
    const q1 = 'Pick one?'
    const q2 = 'And then?'
    const answer = 'Use "strict" mode, always (Recommended)'
    const digest = digestFromResult(
      prose(`"${q1}"="${answer}", "${q2}"="Later"`),
      asQuestions(q1, q2),
    )
    expect(digest?.answers[q1]).toBe(answer)
    expect(digest?.answers[q2]).toBe('Later')
  })

  it('keeps a multi-select comma-joined answer whole', () => {
    const q1 = 'Which features?'
    const digest = digestFromResult(
      prose(`"${q1}"="Alpha, Beta"`),
      asQuestions(q1),
    )
    expect(digest?.answers[q1]).toBe('Alpha, Beta')
  })

  it('splits the Other notes off the answer, mid-list and at the end', () => {
    const q1 = 'First?'
    const q2 = 'Second?'
    const digest = digestFromResult(
      prose(`"${q1}"="Other" (notes: my first note), "${q2}"="Other" (notes: my second note)`),
      asQuestions(q1, q2),
    )
    expect(digest?.answers[q1]).toBe('Other')
    expect(digest?.notes[q1]).toBe('my first note')
    expect(digest?.answers[q2]).toBe('Other')
    expect(digest?.notes[q2]).toBe('my second note')
  })

  // A question the prose does not mention (a shape from an older build) simply
  // has no entry — the card renders "(no answer)" for it, which is honest.
  it('leaves an unmatched question out of the map', () => {
    const q1 = 'First?'
    const digest = digestFromResult(prose(`"${q1}"="Yes"`), asQuestions(q1, 'Never asked?'))
    expect(digest?.answers[q1]).toBe('Yes')
    expect(digest?.answers['Never asked?']).toBeUndefined()
  })

  it('returns null for anything that is not the answer prose', () => {
    expect(digestFromResult(undefined)).toBeNull()
    expect(digestFromResult('')).toBeNull()
    expect(digestFromResult(INTERRUPTED_TOOL_RESULT)).toBeNull()
    expect(
      digestFromResult('InputValidationError: questions[0].header is too long'),
    ).toBeNull()
  })
})

import { useEffect, useMemo, useState } from 'react'
import { makeAssistantToolUI } from '@assistant-ui/react'
import { CircleSlashIcon, HelpCircleIcon } from 'lucide-react'
import {
  ASK_TOOL_ID,
  type AskUserQuestion,
  type AskUserQuestionAnnotation,
  type AskUserQuestionInput,
  type AskUserQuestionOutput,
} from '@/toolkit/builtin/askUser'
import {
  ToolFallbackContent,
  ToolFallbackRoot,
  ToolFallbackTrigger,
} from '@/components/assistant-ui/tool-fallback'
import { useT } from './i18n'
import { rememberBounded } from '@/components/assistant-ui/boundedUiMemory'
import { isInterruptedToolResult } from './assistantUiAdapterParts'
import { usePendingQuestionRegistration } from './pendingQuestionsStore'

const OTHER_LABEL = 'Other'

// The exact prefix handleSubmit emits for a real answer (see digestFromResult).
// A DEFINED result WITHOUT this prefix is an error / superseded call (e.g. the
// tool rejected the input and the model retried), NOT an answer — used to render
// a compact superseded chip instead of a phantom "(no answer)" question card.
const ANSWER_PROSE_PREFIX = 'The user answered:'

/**
 * True when an AskUserQuestion tool result is an ERROR / superseded call rather
 * than a real user answer: a defined, non-empty result string that does NOT
 * carry the answer prose. The model retries after a validation rejection, so
 * without this the rejected call would render a phantom "(no answer)" card next
 * to the real answered one (the duplicate-card defect). Exported for testing.
 */
export function isSupersededAskResult(result: unknown): boolean {
  return (
    typeof result === 'string' &&
    result.length > 0 &&
    !result.includes(ANSWER_PROSE_PREFIX)
  )
}

/**
 * The card's effective result: `result`, unless it is the restart sentinel
 * (`INTERRUPTED_TOOL_RESULT`), which counts only when nothing better exists; then
 * `pendingResult` (same mount); then `cachedResult` (survives a remount). `null` when none.
 */
export function resolveEffectiveAskResult(
  result: unknown,
  pendingResult: string | null,
  cachedResult: string | undefined,
): unknown {
  if (result !== undefined && !isInterruptedToolResult(result)) return result
  return pendingResult ?? cachedResult ?? result ?? null
}

type AskFormState = {
  selected: Set<string>
  otherChecked: boolean
  otherText: string
}

function emptyQuestionState(): AskFormState {
  return { selected: new Set<string>(), otherChecked: false, otherText: '' }
}

function isQuestionAnswered(state: AskFormState): boolean {
  if (state.selected.size > 0) return true
  return state.otherChecked && state.otherText.trim().length > 0
}

function buildAnswers(
  questions: AskUserQuestion[],
  states: Record<string, AskFormState>,
): { answers: Record<string, string>; annotations: Record<string, AskUserQuestionAnnotation> } {
  const answers: Record<string, string> = {}
  const annotations: Record<string, AskUserQuestionAnnotation> = {}

  for (const question of questions) {
    const state = states[question.question] ?? emptyQuestionState()
    const orderedLabels = question.options
      .map(opt => opt.label)
      .filter(label => state.selected.has(label))
    const labels = [...orderedLabels]
    if (state.otherChecked) labels.push(OTHER_LABEL)
    answers[question.question] = labels.join(', ')

    const annotation: AskUserQuestionAnnotation = {}
    if (state.otherChecked && state.otherText.trim().length > 0) {
      annotation.notes = state.otherText.trim()
    }
    if (!question.multiSelect && orderedLabels.length === 1) {
      const selectedOption = question.options.find(opt => opt.label === orderedLabels[0])
      if (selectedOption?.preview) {
        annotation.preview = selectedOption.preview
      }
    }
    if (annotation.notes !== undefined || annotation.preview !== undefined) {
      annotations[question.question] = annotation
    }
  }

  return { answers, annotations }
}

type ResultDigest = {
  answers: Record<string, string>
  notes: Record<string, string>
}

// In-memory open-state map for the answered card. assistant-ui remounts the
// tool UI when `result` transitions from undefined → defined (the live →
// persisted message-id swap), so a `useState(initialOpen)` inside AnsweredCard
// would reset to collapsed the instant the worker round-trip lands — hiding
// the answer the user just submitted. Keyed by toolCallId, the map survives
// that remount. Mirrors ToolFallback's `toolFallbackOpenState` pattern.
const answeredCardOpenState = new Map<string, boolean>()

// Answered-result cache by toolCallId: a remounted instance (live → persisted message-id
// swap) keeps its answered state until the persisted `result` arrives. Exported for testing.
export const answeredResultCache = new Map<string, string>()

// Parse the prose `result` back into a {question → answer / notes} map. Format (built in
// `handleSubmit`, mirrored by `AskPersonTool.call`):
//   The user answered: "Q1"="A1", "Q2"="A2, A3" (notes: ...). Continue, taking these answers into account.
// On parse failure the card falls back to a raw <pre>.
const ANSWER_PROSE_SUFFIX = '. Continue, taking'

// The exact separator `handleSubmit` puts between an answer and its notes.
// Kept as one literal because the anchored parse below splits on it.
const NOTES_OPEN = '" (notes: '

/**
 * The pair list between the prose prefix and its closing sentence, or null
 * when `result` is not the answer prose at all (an object sentinel, an error
 * string, an empty result). The closing sentence is located with
 * `lastIndexOf` — it is a TRAILER, and an answer or a note that happens to
 * contain the same words must not truncate the body.
 */
function answerProseBody(result: unknown): string | null {
  if (typeof result !== 'string' || result.length === 0) return null
  const startIndex = result.indexOf(ANSWER_PROSE_PREFIX)
  if (startIndex < 0) return null
  const bodyStart = startIndex + ANSWER_PROSE_PREFIX.length
  const endIndex = result.lastIndexOf(ANSWER_PROSE_SUFFIX)
  return result.slice(bodyStart, endIndex > bodyStart ? endIndex : undefined)
}

/**
 * Exact parse anchored on each literal `"<question>"="` marker, in `questions` order: the
 * prose carries no escaping, so a `"` in a question or label would mis-pair a generic scan.
 */
function anchoredDigest(
  body: string,
  questions: readonly AskUserQuestion[],
): ResultDigest {
  const answers: Record<string, string> = {}
  const notes: Record<string, string> = {}
  const markers: { question: string; start: number; valueAt: number }[] = []
  let cursor = 0
  for (const question of questions) {
    const marker = `"${question.question}"="`
    const start = body.indexOf(marker, cursor)
    if (start < 0) continue
    const valueAt = start + marker.length
    markers.push({ question: question.question, start, valueAt })
    cursor = valueAt
  }
  for (let index = 0; index < markers.length; index += 1) {
    const { question, valueAt } = markers[index]!
    // The value runs to the next marker (or to the end for the last pair),
    // so an answer containing `"`, `,` or `(` stays intact.
    const end = index + 1 < markers.length ? markers[index + 1]!.start : body.length
    let segment = body.slice(valueAt, end).replace(/,\s*$/, '')
    let note: string | undefined
    if (segment.endsWith(')')) {
      const notesAt = segment.lastIndexOf(NOTES_OPEN)
      if (notesAt >= 0) {
        note = segment.slice(notesAt + NOTES_OPEN.length, segment.length - 1).trim()
        segment = segment.slice(0, notesAt)
      }
    }
    if (segment.endsWith('"')) segment = segment.slice(0, -1)
    answers[question] = segment
    if (note) notes[question] = note
  }
  return { answers, notes }
}

/**
 * Generic left-to-right scan, kept as the fallback for a body whose questions
 * we do not have (a legacy transcript whose tool ARGS no longer round-trip, or
 * a prose shape from an older build). It is the pre-anchor behaviour and has
 * the mis-pairing weakness described above, so anchored entries always win.
 */
function scannedDigest(body: string): ResultDigest {
  const answers: Record<string, string> = {}
  const notes: Record<string, string> = {}
  const pairPattern =
    /"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"(?:\s*\(notes:\s*([^)]*)\))?/g
  let match: RegExpExecArray | null
  while ((match = pairPattern.exec(body)) !== null) {
    const question = match[1]!
    answers[question] = match[2]!
    if (match[3]) notes[question] = match[3].trim()
  }
  return { answers, notes }
}

/**
 * `questions` is the tool's own args — pass it whenever it is available so
 * the exact anchored parse runs. Exported for testing.
 */
export function digestFromResult(
  result: unknown,
  questions: readonly AskUserQuestion[] = [],
): ResultDigest | null {
  const body = answerProseBody(result)
  if (body === null) return null
  const scanned = scannedDigest(body)
  const anchored = anchoredDigest(body, questions)
  const answers = { ...scanned.answers, ...anchored.answers }
  const notes = { ...scanned.notes, ...anchored.notes }
  if (Object.keys(answers).length === 0) return null
  return { answers, notes }
}

function AnsweredCard({
  questions,
  result,
  initialOpen,
  toolCallId,
}: {
  questions: AskUserQuestion[]
  result: unknown
  // True for the LIVE submit path (user just clicked Submit in this
  // session) so the card opens expanded with the selections in view.
  // False when a reloaded session is rehydrating a previously-answered
  // tool call from the persisted transcript — those land collapsed so
  // the page doesn't open with every historical AskUserQuestion fully
  // unfurled. The chevron toggles either way.
  initialOpen: boolean
  toolCallId: string
}) {
  const t = useT()
  const [open, setOpen] = useState(() => {
    const stored = answeredCardOpenState.get(toolCallId)
    if (stored !== undefined) return stored
    return initialOpen
  })
  // Keep the map in sync — covers the initial mount (so a later remount sees
  // the live-submit expanded state) and every user toggle.
  useEffect(() => {
    rememberBounded(answeredCardOpenState, toolCallId, open)
  }, [toolCallId, open])
  // Pass the questions so the digest anchors on their exact texts — a `"`
  // anywhere in a question or an option label otherwise re-pairs the generic
  // scan and blanks that row to "(no answer)".
  const digest = useMemo(
    () => digestFromResult(result, questions),
    [result, questions],
  )

  const resultText =
    typeof result === 'string'
      ? result
      : result !== undefined
        ? JSON.stringify(result, null, 2)
        : null

  return (
    <ToolFallbackRoot open={open} onOpenChange={setOpen}>
      <ToolFallbackTrigger
        toolName={ASK_TOOL_ID}
        args={undefined}
        // Always "complete" — by the time we render `AnsweredCard` we
        // already have the answer prose in hand (either from the
        // `result` prop or locally cached from the click), so the
        // ToolFallbackTrigger shimmer would be misleading. The
        // submit-in-flight gap is invisible to the user; there is no
        // intermediate "running" UI.
        status={{ type: 'complete' }}
      />
      <ToolFallbackContent>
        <div className="space-y-3 px-4 py-2 text-sm">
          {questions.map(q => {
            const answer = digest?.answers[q.question]
            const note = digest?.notes[q.question]
            return (
              <div key={q.question} className="space-y-1">
                <div className="flex items-center gap-2">
                  <span
                    title={q.header}
                    className="max-w-[18ch] shrink-0 truncate rounded-md bg-muted px-2 py-0.5 text-xs font-medium"
                  >
                    {q.header}
                  </span>
                  <span className="font-medium">{q.question}</span>
                </div>
                <div className="pl-1 text-muted-foreground">
                  {`→ ${
                    answer !== undefined && answer.length > 0
                      ? answer
                      : t('question.noAnswer')
                  }`}
                  {note ? (
                    <p className="mt-0.5 text-xs">
                      {t('question.notes', { note })}
                    </p>
                  ) : null}
                </div>
              </div>
            )
          })}
          {/* Fallback: if the prose digest couldn't be parsed (e.g. an
              older session whose result string predates the current
              format), drop the raw model-facing result so the user
              still sees the actual answer text. */}
          {!digest && resultText ? (
            <pre className="whitespace-pre-wrap rounded-md bg-muted px-3 py-2 font-mono text-xs">
              {resultText}
            </pre>
          ) : null}
        </div>
      </ToolFallbackContent>
    </ToolFallbackRoot>
  )
}

// A question call the tool REJECTED (validation error) or that was otherwise
// superseded — the model already retried (or moved on), so there is nothing for
// the user to answer. Render a compact muted chip with the rejection message
// instead of an AnsweredCard that would show "(no answer)" for every question
// (the duplicate-card defect). The raw message is shown so nothing is lost.
function SupersededCard({ message }: { message: string }) {
  const t = useT()
  return (
    <div className="my-2 flex items-start gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
      <CircleSlashIcon
        className="mt-0.5 size-3.5 shrink-0 opacity-70"
        aria-hidden="true"
      />
      <div className="min-w-0 space-y-0.5">
        <div className="font-medium">{t('question.superseded')}</div>
        <div className="break-words opacity-80">{message}</div>
      </div>
    </div>
  )
}

export const AskUserQuestionToolUI =
  makeAssistantToolUI<AskUserQuestionInput, AskUserQuestionOutput>({
    toolName: ASK_TOOL_ID,
    render: function AskUserQuestionUI({ args, result, addResult, toolCallId }) {
      const t = useT()
      const questions = useMemo<AskUserQuestion[]>(
        () => args?.questions ?? [],
        [args?.questions],
      )
      const [states, setStates] = useState<Record<string, AskFormState>>({})
      // Locally-cached version of the prose result string we ship to
      // the model on Submit. Lets the `AnsweredCard` render the
      // question + answer immediately, without waiting for the
      // worker round-trip that eventually populates the `result`
      // prop. Without this cache the user would briefly (or, when
      // the round-trip stalls, indefinitely) see a "submitting"
      // animation even though they already clicked Submit.
      const [pendingResult, setPendingResult] = useState<string | null>(null)

      // Prop first, then the local pending prose, then `answeredResultCache` (survives a
      // remount), so the answered state never reverts to the question form.
      const effectiveResult = resolveEffectiveAskResult(
        result,
        pendingResult,
        answeredResultCache.get(toolCallId),
      )
      const isAnswered = effectiveResult !== null && effectiveResult !== undefined

      // A DEFINED result that is NOT the answer prose means the tool rejected
      // this call (validation error) or it was superseded — the model already
      // retried. Render a compact superseded chip rather than a phantom
      // "(no answer)" card, and do NOT gate the composer on it.
      const isSuperseded = isSupersededAskResult(result)

      // While this card is showing real, unanswered questions the turn is
      // blocked on the user — register so the composer disables itself (and so
      // a question buried in a collapsed plan step still gates input).
      usePendingQuestionRegistration(
        !isAnswered && !isSuperseded && questions.length > 0,
      )

      // Once the persisted `result` prop arrives (the worker round-trip has
      // landed and the transcript now carries the tool-result), the cache entry
      // is redundant — drop it so the module-level map doesn't grow without
      // bound across a long session's many AskUserQuestion calls.
      // The restart sentinel is not that arrival (see resolveEffectiveAskResult)
      // — dropping the cache on it is exactly what turned the card into
      // "(no answer)" for the rest of the turn.
      useEffect(() => {
        if (result !== undefined && !isInterruptedToolResult(result)) {
          answeredResultCache.delete(toolCallId)
        }
      }, [result, toolCallId])

      if (isSuperseded) {
        return <SupersededCard message={result as string} />
      }

      if (isAnswered) {
        // `pendingResult` is only set by this component's own
        // handleSubmit, so it's a reliable "this is a live submit in
        // the current session" flag — that path opens the card. The
        // reload path arrives with `pendingResult === null` and only
        // the prop `result` populated; that path stays collapsed.
        const liveSubmit = pendingResult !== null
        return (
          <div className="my-2">
            <AnsweredCard
              questions={questions}
              result={effectiveResult}
              initialOpen={liveSubmit}
              toolCallId={toolCallId}
            />
          </div>
        )
      }

      if (questions.length === 0) {
        return (
          <div className="my-2 rounded-lg border p-3 text-sm text-muted-foreground">
            {t('question.none')}
          </div>
        )
      }

      const updateQuestion = (
        questionText: string,
        updater: (previous: AskFormState) => AskFormState,
      ) => {
        setStates(current => {
          const previous = current[questionText] ?? emptyQuestionState()
          return { ...current, [questionText]: updater(previous) }
        })
      }

      const handleSelectSingle = (question: AskUserQuestion, label: string) => {
        updateQuestion(question.question, () => ({
          selected: new Set([label]),
          otherChecked: false,
          otherText: '',
        }))
      }

      const handleToggleMulti = (question: AskUserQuestion, label: string) => {
        updateQuestion(question.question, previous => {
          const nextSelected = new Set(previous.selected)
          if (nextSelected.has(label)) nextSelected.delete(label)
          else nextSelected.add(label)
          return { ...previous, selected: nextSelected }
        })
      }

      const handleSelectOther = (question: AskUserQuestion) => {
        updateQuestion(question.question, previous => {
          if (question.multiSelect) {
            return { ...previous, otherChecked: !previous.otherChecked }
          }
          return {
            selected: new Set<string>(),
            otherChecked: true,
            otherText: previous.otherText,
          }
        })
      }

      const handleOtherText = (question: AskUserQuestion, text: string) => {
        updateQuestion(question.question, previous => ({
          ...previous,
          otherChecked: text.trim().length > 0 ? true : previous.otherChecked,
          otherText: text,
        }))
      }

      const allAnswered = questions.every(q =>
        isQuestionAnswered(states[q.question] ?? emptyQuestionState()),
      )

      const handleSubmit = () => {
        const { answers, annotations } = buildAnswers(questions, states)
        // Build the prose string the model will see. The AskUserQuestion
        // tool result wording: "The user answered: …. Continue,
        // taking these answers into account." The same shape is parsed
        // back by `digestFromResult`
        // on the answered card so the expand view can render the
        // question / answer pairs without a separate persistence
        // channel.
        const answersText = questions
          .map(q => {
            const selected = answers[q.question] ?? '(no answer)'
            const noteSuffix = annotations[q.question]?.notes
              ? ` (notes: ${annotations[q.question]?.notes})`
              : ''
            return `"${q.question}"="${selected}"${noteSuffix}`
          })
          .join(', ')
        const resultString: AskUserQuestionOutput = `The user answered: ${answersText}. Continue, taking these answers into account.`
        // Cache the prose locally first so the very next render
        // shows the answered card directly — no spinner gap while
        // we wait for `result` to propagate through the worker
        // round-trip. The model still receives the same string via
        // addResult.
        setPendingResult(resultString)
        // Also cache in the module-level map so the answered state
        // survives a component REMOUNT (the live → persisted message-
        // id swap wipes `pendingResult` back to null). Without this,
        // a remount that lands before the worker round-trip populates
        // the `result` prop would revert the card to its unanswered
        // form — dropping the user's selection. Cleaned up once the
        // persisted `result` arrives (see the effect above).
        answeredResultCache.set(toolCallId, resultString)
        addResult(resultString)
      }

      return (
        <div
          className="my-2 space-y-4 rounded-lg border p-4"
          // The live (unanswered) question card — an attention reveal
          // scrolls to it and focuses its first option
          // (webview/attentionSource.ts). Only THIS branch carries it: the
          // answered and superseded cards want nothing from the user.
          data-attention-source="ask-user-question"
        >
          <div className="flex items-center gap-2">
            <HelpCircleIcon className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">
              {questions.length === 1
                ? t('ask.oneQuestion')
                : t('ask.manyQuestions', { count: questions.length })}
            </span>
          </div>

          {questions.map(question => {
            const state = states[question.question] ?? emptyQuestionState()
            const inputType = question.multiSelect ? 'checkbox' : 'radio'
            const inputName = `aui-q-${question.question}`
            return (
              <div key={question.question} className="space-y-2">
                <div className="flex items-center gap-2">
                  <span
                    title={question.header}
                    className="max-w-[18ch] shrink-0 truncate rounded-md bg-muted px-2 py-0.5 text-xs font-medium"
                  >
                    {question.header}
                  </span>
                  <span className="text-sm font-medium">{question.question}</span>
                </div>
                <div className="space-y-1.5 pl-1">
                  {question.options.map(option => {
                    const checked = state.selected.has(option.label)
                    const showPreview =
                      !question.multiSelect &&
                      checked &&
                      typeof option.preview === 'string' &&
                      option.preview.length > 0
                    return (
                      <div key={option.label}>
                        <label className="flex cursor-pointer items-start gap-2">
                          <input
                            type={inputType}
                            name={inputName}
                            checked={checked}
                            onChange={() =>
                              question.multiSelect
                                ? handleToggleMulti(question, option.label)
                                : handleSelectSingle(question, option.label)
                            }
                            className="mt-1"
                          />
                          <div className="flex-1">
                            <div className="text-sm">{option.label}</div>
                            {option.description ? (
                              <p className="text-xs text-muted-foreground">
                                {option.description}
                              </p>
                            ) : null}
                            {showPreview ? (
                              <pre className="mt-2 whitespace-pre-wrap rounded-md bg-muted px-3 py-2 font-mono text-xs">
                                {option.preview}
                              </pre>
                            ) : null}
                          </div>
                        </label>
                      </div>
                    )
                  })}
                  <div>
                    <label className="flex cursor-pointer items-start gap-2">
                      <input
                        type={inputType}
                        name={inputName}
                        checked={state.otherChecked}
                        onChange={() => handleSelectOther(question)}
                        className="mt-1"
                      />
                      <div className="flex-1">
                        <div className="text-sm">{t('question.other')}</div>
                        <input
                          type="text"
                          value={state.otherText}
                          placeholder={t('question.specify')}
                          onChange={event =>
                            handleOtherText(question, event.target.value)
                          }
                          className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
                        />
                      </div>
                    </label>
                  </div>
                </div>
              </div>
            )
          })}

          <button
            type="button"
            disabled={!allAnswered}
            onClick={handleSubmit}
            className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {t('question.submit')}
          </button>
        </div>
      )
    },
  })

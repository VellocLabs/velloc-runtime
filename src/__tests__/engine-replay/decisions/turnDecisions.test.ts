/**
 * The turn machine's decision table: each replay fixture is assigned to the one decision it exercises and
 * replayed with the real `advanceTurn` through the fake interpreter; fixtures that never reach the loop have no
 * loop terminal.
 */
import { describe, expect, it } from 'vitest'
import type { Message } from '../../../runtime/RuntimeTypes'
import type { TurnEffect } from '../../../engine/turnEffects'
import { OUTPUT_CAP_CONTINUE_NOTE, resultPartsOf } from '../../../engine/turnRows'
import type { ScheduledArrival } from '../fakes/fakeInterpreter'
import { driveMachine, fixtureNames, ledgerWith, recordedTerminal, type MachineRun, type MachineScript } from './driveMachine'

const userRow = (text: string): Message => ({ type: 'user', message: { role: 'user', content: text } }) as Message
const PROMPT = userRow('hello')
const call = (id: string, name = 'Read') => ({ id, name })
const toolStep = (id: string, name = 'Read') => ({ reply: 'working', toolCalls: [call(id, name)] })
const TEXT = { reply: 'answer' }

/** Keeps `n` serial effects free before a cancellation arrives. */
export function cancelAfter(n: number): ScheduledArrival[] {
  const pad: ScheduledArrival[] = Array.from({ length: n }, (_, i) => ({ label: `pad${i}`, kind: 'fragment' as const }))
  return [...pad, { label: 'cancel', kind: 'cancel', payload: 'user' }]
}

const answered = (rows: readonly Message[]): Set<string> => new Set(rows.flatMap((r) => resultPartsOf(r).map((p) => p.toolCallId)))
const outputRows = (run: MachineRun): Message[] => run.trace.flatMap((e) => (e.kind === 'output' ? [e.output.message] : []))
const ofKind = <K extends TurnEffect['kind']>(run: MachineRun, kind: K) =>
  run.trace.flatMap((e) => (e.kind === 'effect' && e.effect.kind === kind ? [e.effect as Extract<TurnEffect, { kind: K }>] : []))

type Decision = {
  readonly decision: string
  readonly fixtures: readonly string[]
  /** Compare the whole recorded terminal, not just its reason. */
  readonly exact?: boolean
  readonly script: (recorded: Record<string, unknown> | undefined) => MachineScript
  readonly check?: (run: MachineRun) => void
}

const failingLedger = ledgerWith(2)
const failTools = { Bad: { isError: true, text: 'failed' }, Read: { text: 'ok' } }

const DECISIONS: readonly Decision[] = [
  {
    decision: 'a text-only reply runs the Stop hooks and completes',
    fixtures: [
      'completed-text-answer', 'thinking-and-text-assembled', 'title-after-a-successful-turn',
      'title-asked-again-after-every-successful-turn', 'title-failure-retries-once-on-the-parent-model',
      'no-title-over-a-chosen-name', 'rename-during-title-request-wins', 'retry-then-success',
      'idle-timeout-is-retried', 'rate-limit-honours-retry-after', 'retry-ladder-notice-from-attempt-four',
      'stream-unavailable-uses-blocking-fallback', 'clear-then-next-prompt-starts-fresh',
      'reload-after-turn-settles-before-the-next-turn', 'reload-after-turn-then-clear-then-turn',
      'cancel-then-next-prompt-carries-the-interruption', 'session-receive-rewrites-a-delivery',
    ],
    script: () => ({ model: [TEXT], state: { messages: [PROMPT] } }),
    check: (run) => {
      expect(run.requests).toHaveLength(1)
      expect(ofKind(run, 'runStopHooks').map((e) => e.event)).toEqual(['Stop'])
      expect(run.effectKinds.at(-1)).toBe('commitTerminal')
    },
  },
  {
    decision: 'a text-only reply leaves queued input for the idle drain',
    fixtures: ['text-only-answer-leaves-queued-input-for-idle'],
    script: () => ({ model: [TEXT] }),
    check: (run) => expect(run.effectKinds).not.toContain('drainQueuedInput'),
  },
  {
    decision: 'rows the prompt-submit hooks add reach the first request',
    fixtures: ['prompt-submit-hook-adds-context', 'prompt-submit-rewrites-and-adds-context'],
    script: () => ({
      model: [TEXT],
      state: { messages: [PROMPT] },
      other: (e) => (e.kind === 'runPromptSubmitHooks'
        ? { type: 'promptSubmitHooksDone', blocked: false, rows: [userRow('hook context')], identity: e.identity }
        : undefined),
    }),
    check: (run) => expect(run.requests[0].messages.at(-1)).toEqual(userRow('hook context')),
  },
  {
    decision: 'a blocking prompt-submit hook rejects the prompt before any request',
    fixtures: ['prompt-rejected-by-submit-hook'],
    exact: true,
    script: () => ({
      model: [],
      other: (e) => (e.kind === 'runPromptSubmitHooks'
        ? { type: 'promptSubmitHooksDone', blocked: true, rows: [], identity: e.identity }
        : undefined),
    }),
    check: (run) => expect(run.requests).toHaveLength(0),
  },
  {
    decision: 'a reply with tool calls runs the batch and the next request carries every result',
    fixtures: [
      'completed-after-tool-round', 'context-modifiers-apply-in-call-order', 'declared-tool-defaults-refused-in-plan-mode',
      'declared-tool-defaults-run-serially-and-allowed', 'deny-rule-refuses-without-asking', 'headless-ask-is-refused-without-prompt',
      'mixed-batch-parallel-then-solo-then-parallel', 'path-safety-ask-not-lifted-by-extension-allow',
      'plan-exit-approved-through-dialog-leaves-plan-mode', 'plan-exit-kept-planning-through-dialog',
      'plan-exit-outside-plan-mode-is-refused', 'plan-mode-refuses-a-mutating-tool', 'post-tool-hook-once-per-call-including-failures',
      'queued-confirm-abort-stops-the-turn', 'queued-confirm-allow-runs-the-call', 'queued-confirm-reject-answers-the-model',
      'tool-call-hook-answers-in-place-of-the-tool', 'tool-call-hook-denies-the-call', 'tool-call-hook-passes-through-to-the-tool',
      'tool-call-hook-unrecognised-answer-falls-back-to-the-tool', 'unknown-tool-and-invalid-input-answer-errors',
      'ask-rule-routes-through-dialog', 'session-receive-on-a-mid-turn-notification',
    ],
    script: () => ({ model: [{ reply: 'two', toolCalls: [call('c1'), call('c2', 'Grep')] }, TEXT], state: { messages: [PROMPT] } }),
    check: (run) => {
      expect(run.requests.map((r) => r.k)).toEqual([1, 2])
      expect([...answered(run.requests[1].messages)].sort()).toEqual(['c1', 'c2'])
      expect(run.effectKinds).toContain('drainQueuedInput')
    },
  },
  {
    decision: 'a tool call id repeated in one reply runs once',
    fixtures: ['duplicate-tool-call-id-runs-once'],
    script: () => ({ model: [{ reply: 'dup', toolCalls: [call('c1'), call('c1')] }, TEXT] }),
    check: (run) => expect(run.batches[0].calls.map((c) => c.toolCallId)).toEqual(['c1']),
  },
  {
    decision: 'a call that halts for the person ends the turn awaiting them',
    fixtures: ['awaiting-user-interaction', 'ask-without-dialog-halts-on-pending-entry', 'batch-stops-at-a-halting-call', 'plan-exit-hands-the-turn-to-the-person'],
    script: () => ({ model: [toolStep('c1', 'Ask')], tools: { Ask: { halt: true } } }),
    check: (run) => {
      expect(run.requests).toHaveLength(1)
      expect(run.effectKinds).not.toContain('drainQueuedInput')
    },
  },
  {
    decision: 'a cancellation during the model request ends the turn aborted',
    fixtures: ['aborted-mid-stream', 'cancel-during-retry-backoff'],
    exact: true,
    script: () => ({ model: [TEXT], arrivals: cancelAfter(3) }),
    check: (run) => {
      expect(run.trace.some((e) => e.kind === 'abortedEffect' && e.effect.kind === 'requestModel')).toBe(true)
      expect(run.effectKinds).not.toContain('runStopHooks')
    },
  },
  {
    decision: 'a cancellation during the tool batch answers every call and drains nothing',
    fixtures: ['cancel-mid-tool', 'abort-mid-batch-fills-every-missing-result', 'aborted-round-drains-no-typed-or-team-input'],
    exact: true,
    script: () => ({ model: [{ reply: 'three', toolCalls: [call('c1'), call('c2'), call('c3')] }], arrivals: cancelAfter(4) }),
    check: (run) => {
      expect([...answered(outputRows(run))].sort()).toEqual(['c1', 'c2', 'c3'])
      expect(run.effectKinds).not.toContain('drainQueuedInput')
    },
  },
  {
    decision: 'a cancellation in the last allowed step also notes the step limit',
    fixtures: ['cancel-on-the-last-step'],
    exact: true,
    script: () => ({ model: [toolStep('c1'), toolStep('c2')], state: { limits: { maxTurns: 2 } }, arrivals: cancelAfter(10) }),
    check: (run) => {
      const rows = outputRows(run) as Array<{ attachment?: { type?: string } }>
      expect(rows.some((r) => r.attachment?.type === 'max_turns_reached')).toBe(true)
    },
  },
  {
    decision: 'a provider error runs the failure hooks and ends with api_error',
    fixtures: ['api-error-terminal', 'no-title-after-a-failed-turn', 'retries-exhausted-api-error', 'started-stream-error-is-not-sent-to-fallback'],
    exact: true,
    script: (t) => ({ model: [{ fail: 'api_error', error: t?.error as string }] }),
    check: (run) => expect(ofKind(run, 'runStopHooks').map((e) => e.event)).toEqual(['StopFailure']),
  },
  {
    decision: 'the provider refusing the prompt as too long ends with prompt_too_long',
    fixtures: ['prompt-too-long-at-stream-start', 'prompt-too-long-from-provider'],
    exact: true,
    script: () => ({ model: [{ fail: 'prompt_too_long' }] }),
  },
  {
    decision: 'a context over the blocking limit ends before any request',
    fixtures: ['prompt-too-long-before-any-request'],
    exact: true,
    script: () => ({ model: [], state: { messages: [PROMPT], limits: { blockingLimitTokens: 0 } } }),
    check: (run) => expect(run.requests).toHaveLength(0),
  },
  {
    decision: 'a compaction pushes the host reset and the request is built from the summary',
    fixtures: ['auto-compaction-then-continue', 'compact-replaces-history-with-summary'],
    script: () => ({
      model: [TEXT],
      state: { messages: [PROMPT, userRow('old'), userRow('older')] },
      other: (e) => (e.kind === 'summarizeForCompaction' && e.messages.length > 1
        ? { type: 'contextFitted', messages: e.messages, compacted: true, rows: [userRow('summary')], identity: e.identity }
        : undefined),
    }),
    check: (run) => {
      expect(run.effectKinds).toContain('pushHostSettings')
      expect(run.requests[0].messages[0]).toEqual(userRow('summary'))
    },
  },
  {
    decision: 'a compaction followed by an oversized request still ends with prompt_too_long',
    fixtures: ['prompt-too-long-after-compaction'],
    exact: true,
    script: () => ({
      model: [{ fail: 'prompt_too_long' }],
      other: (e) => (e.kind === 'summarizeForCompaction'
        ? { type: 'contextFitted', messages: e.messages, compacted: true, rows: [userRow('summary')], identity: e.identity }
        : undefined),
    }),
  },
  {
    decision: 'no compaction keeps the history as it was',
    fixtures: ['compaction-below-threshold-does-nothing', 'compaction-failure-then-continue-uncompacted'],
    script: () => ({ model: [TEXT], state: { messages: [PROMPT] } }),
    check: (run) => {
      expect(run.effectKinds).not.toContain('pushHostSettings')
      expect(run.requests[0].messages).toEqual([PROMPT])
    },
  },
  {
    decision: 'a cut reply is retried once with the full output allowance',
    fixtures: ['max-tokens-escalate-then-completes'],
    script: () => ({ model: [{ fail: 'output_cap' }, TEXT], state: { limits: { outputCeilingTokens: 32_000 } } }),
    check: (run) => expect(run.requests.map((r) => r.outputTokenCapOverride)).toEqual([undefined, 32_000]),
  },
  {
    decision: 'a reply cut again is resumed with the continue note',
    fixtures: ['max-tokens-resume-then-completes'],
    script: () => ({ model: [{ fail: 'output_cap' }, { fail: 'output_cap' }, TEXT] }),
    check: (run) => {
      const last = run.requests.at(-1)!.messages.at(-1) as { message?: { content?: unknown } }
      expect(last.message?.content).toBe(OUTPUT_CAP_CONTINUE_NOTE)
      expect(run.requests.map((r) => r.k)).toEqual([1, 1, 1])
    },
  },
  {
    decision: 'after three resumes a cut reply ends with max_output_tokens',
    fixtures: ['max-tokens-escalate-then-three-resumes-then-terminal'],
    exact: true,
    script: () => ({ model: Array.from({ length: 8 }, () => ({ fail: 'output_cap' as const })) }),
  },
  ...[
    { fixture: 'max-turns', maxTurns: 2 },
    { fixture: 'last-step-tool-call-reaches-max-turns-without-nudge', maxTurns: 3 },
    { fixture: 'step-cap-round-drains-nothing', maxTurns: 1 },
  ].map(({ fixture, maxTurns }): Decision => ({
    decision: `a tool step past a step limit of ${maxTurns} ends with max_turns`,
    fixtures: [fixture],
    exact: true,
    script: () => ({ model: Array.from({ length: maxTurns }, (_, i) => toolStep(`c${i}`)), state: { limits: { maxTurns } } }),
    check: (run) => {
      expect(run.requests.at(-1)!.finalResponse).toBe(true)
      expect(ofKind(run, 'drainQueuedInput').at(-1)!.planModeAttachment).toBe(true)
    },
  })),
  {
    decision: 'the last allowed request asks for the final reply',
    fixtures: ['last-step-request-carries-no-nudge'],
    script: () => ({ model: [toolStep('c1'), TEXT], state: { limits: { maxTurns: 2 } } }),
    check: (run) => expect(run.requests.map((r) => r.finalResponse)).toEqual([false, true]),
  },
  {
    decision: 'input drained after a tool step reaches the next request',
    fixtures: ['typed-input-reaches-the-next-request', 'notifications-team-and-typed-drain-in-queue-order'],
    script: () => ({
      model: [toolStep('c1'), TEXT],
      other: (e) => (e.kind === 'drainQueuedInput' ? { type: 'queuedInputDrained', rows: [userRow('typed')], identity: e.identity } : undefined),
    }),
    check: (run) => expect(run.requests[1].messages.at(-1)).toEqual(userRow('typed')),
  },
  {
    decision: 'a nudge is yielded as a meta row and is the row the next request carries',
    fixtures: ['repeated-action-loop-nudge', 'budget-warning-at-three-quarters'],
    script: () => ({
      model: [toolStep('c1'), TEXT],
      state: { loopLedger: ledgerWith(5) },
      policies: { chooseNudge: () => ({ kind: 'BUDGET_75', text: 'budget nudge' }) },
    }),
    check: (run) => {
      const sent = run.requests[1].messages.at(-1) as unknown as { isMeta?: boolean; message: { content: unknown } }
      expect(sent.isMeta).toBe(true)
      expect(String(sent.message.content)).toContain('budget nudge')
      const nudge = run.trace.find((e) => e.kind === 'output' && e.output.origin === 'nudge')
      expect(nudge?.kind === 'output' && nudge.output.message).toEqual(sent)
    },
  },
  {
    decision: 'a Stop hook that prevents continuation ends the turn',
    fixtures: ['stop-hook-prevented'],
    exact: true,
    script: () => ({
      model: [TEXT],
      other: (e) => (e.kind === 'runStopHooks' ? { type: 'stopHandled', preventContinuation: true, blockerRows: [], identity: e.identity } : undefined),
    }),
  },
  {
    decision: 'a blocking Stop hook sends its rows back to the model once more',
    fixtures: ['stop-hook-blocking-then-completed'],
    script: () => {
      let first = true
      return {
        model: [TEXT, TEXT],
        other: (e) => {
          if (e.kind !== 'runStopHooks' || !first) return undefined
          first = false
          return { type: 'stopHandled', preventContinuation: false, blockerRows: [userRow('hook says no')], identity: e.identity }
        },
      }
    },
    check: (run) => {
      expect(run.requests).toHaveLength(2)
      expect(run.requests[1].messages.at(-1)).toEqual(userRow('hook says no'))
    },
  },
  {
    decision: 'a successful step clears the failure streak',
    fixtures: ['a-success-resets-the-failure-count', 'failure-count-starts-fresh-on-the-next-prompt'],
    script: () => ({ model: [toolStep('c1', 'Bad'), toolStep('c2', 'Read'), toolStep('c3', 'Bad'), TEXT], tools: failTools, state: { loopLedger: failingLedger } }),
    check: (run) => {
      expect(run.state.loopLedger?.failureStreak).toBe(1)
      expect(run.requests.every((r) => !r.finalResponse)).toBe(true)
    },
  },
  {
    decision: 'a recovery reply in text ends completed once the Stop hooks reset the ledger',
    fixtures: ['max-failures-recovery-turn-text-ends-completed'],
    script: () => ({
      model: [toolStep('c1', 'Bad'), toolStep('c2', 'Bad'), TEXT],
      tools: failTools,
      state: { loopLedger: failingLedger },
      other: (e) => (e.kind === 'runStopHooks'
        ? { type: 'stopHandled', preventContinuation: false, blockerRows: [], identity: e.identity, patch: { loopLedger: ledgerWith(2) } }
        : undefined),
    }),
    check: (run) => expect(run.requests.at(-1)!.finalResponse).toBe(true),
  },
  {
    decision: 'a recovery reply that calls tools still ends with max_failures',
    fixtures: ['max-failures-recovery-turn-that-calls-tools-still-exits'],
    script: () => ({ model: [toolStep('c1', 'Bad'), toolStep('c2', 'Bad'), toolStep('c3', 'Bad')], tools: failTools, state: { loopLedger: failingLedger } }),
    check: (run) => expect(run.requests).toHaveLength(3),
  },
]

/** Turns the loop never concluded: the fixture records no loop terminal. */
const OUTSIDE_THE_LOOP: Readonly<Record<string, string>> = {
  'compact-failure-keeps-history': 'the compact command answers without a loop terminal',
  'mcp-opens-settings-without-model-request': 'a local command',
  'plugins-reload-without-model-request': 'a local command',
  'prompt-submit-drops-the-prompt': 'the prompt is dropped before the loop starts',
  'rename-sets-the-title': 'a local command',
  'session-receive-consumes-a-delivery': 'the delivery is consumed before a turn starts',
  'unknown-command-answers-without-model-request': 'a local command',
}

describe('turn decisions', () => {
  it('assigns every replay fixture to exactly one decision', () => {
    const assigned = [...DECISIONS.flatMap((d) => d.fixtures), ...Object.keys(OUTSIDE_THE_LOOP)]
    expect(new Set(assigned).size).toBe(assigned.length)
    expect([...assigned].sort()).toEqual(fixtureNames())
  })

  for (const row of DECISIONS) {
    describe(row.decision, () => {
      for (const fixture of row.fixtures) {
        it(fixture, () => {
          const recorded = recordedTerminal(fixture)
          expect(recorded, 'the fixture recorded a loop terminal').toBeDefined()
          const run = driveMachine(row.script(recorded))
          expect(run.commits).toBe(1)
          const outcome = run.conclusion?.kind === 'outcome' ? run.conclusion.outcome : undefined
          if (row.exact) expect(outcome).toEqual(recorded)
          else expect(outcome?.reason).toBe(recorded!.reason)
          row.check?.(run)
        })
      }
    })
  }

  for (const [fixture, why] of Object.entries(OUTSIDE_THE_LOOP)) {
    it(`${fixture} never reaches the loop (${why})`, () => {
      expect(recordedTerminal(fixture)).toBeUndefined()
    })
  }
})

/**
 * One scenario per way a turn ends (the loop's terminal reasons), driven
 * through the engine's public surface.
 */
import { expect } from 'vitest'
import type { Scenario } from '../harness/scenario'
import type { Trace } from '../harness/trace'
import { engineWorld } from '../harness/world'

const title = { label: 'title', querySource: 'rename_generate_name', text: 'A title' }

export const endsWith = (reason: string) => (t: Trace) =>
  expect(JSON.stringify(t.terminal)).toContain(`"reason":"${reason}"`)

export const scenarios: Scenario[] = [
  {
    name: 'completed-text-answer',
    async run() {
      const w = engineWorld({ replies: [{ label: 'answer', text: 'Hello there.' }, title] })
      await w.submit('hello')
      return w.finish()
    },
    check: endsWith('completed'),
  },
  {
    name: 'completed-after-tool-round',
    async run() {
      const w = engineWorld({
        tools: [{ name: 'Lookup', readOnly: true, concurrencySafe: true }],
        replies: [
          { label: 'call', text: 'Looking.', calls: [{ id: 'c1', name: 'Lookup' }] },
          { label: 'answer', text: 'Found it.' },
          title,
        ],
      })
      await w.submit('find it')
      return w.finish()
    },
    check: endsWith('completed'),
  },
  {
    name: 'awaiting-user-interaction',
    async run() {
      const w = engineWorld({
        tools: [{ name: 'AskPerson', haltsForUser: true }],
        // A halt for the person counts as a successful end: the session is titled.
        replies: [{ label: 'ask', calls: [{ id: 'q1', name: 'AskPerson' }] }, title],
      })
      await w.submit('ask me')
      w.recorder.note({ pendingUserInteraction: w.engine.getPendingUserInteraction() })
      return w.finish()
    },
    check: endsWith('awaiting_user_interaction'),
  },
  {
    name: 'stop-hook-prevented',
    async run() {
      const w = engineWorld({
        replies: [{ label: 'answer', text: 'Done.' }, title],
        deps: {
          async runTurnEndHooks() {
            return { preventContinuation: true, blockerRows: [] }
          },
        },
      })
      await w.submit('stop me')
      return w.finish()
    },
    check: endsWith('stop_hook_prevented'),
  },
  {
    name: 'stop-hook-blocking-then-completed',
    async run() {
      let stops = 0
      const w = engineWorld({
        hooks: [{ event: 'Stop' }],
        hookAnswers: {
          Stop: () => (++stops === 1 ? { output: 'Run the tests first.', exit_code: 2 } : {}),
        },
        replies: [
          { label: 'first', text: 'All done.' },
          { label: 'after-block', text: 'Tests ran; done.' },
          title,
        ],
      })
      await w.submit('finish the job')
      return w.finish()
    },
    check: endsWith('completed'),
  },
  {
    name: 'prompt-rejected-by-submit-hook',
    async run() {
      const w = engineWorld({
        hooks: [{ event: 'UserPromptSubmit' }],
        hookAnswers: { UserPromptSubmit: () => ({ output: 'No secrets in prompts.', exit_code: 2 }) },
        replies: [],
      })
      await w.submit('my password is hunter2')
      return w.finish()
    },
    check: endsWith('prompt_rejected'),
  },
  {
    name: 'prompt-submit-hook-adds-context',
    async run() {
      const w = engineWorld({
        hooks: [{ event: 'UserPromptSubmit' }],
        hookAnswers: { UserPromptSubmit: () => ({ output: 'Today is a holiday.', exit_code: 0 }) },
        replies: [{ label: 'answer', text: 'Noted.' }, title],
      })
      await w.submit('what day is it')
      return w.finish()
    },
    check: endsWith('completed'),
  },
  {
    name: 'max-turns',
    async run() {
      const w = engineWorld({
        // A main session's step cap is fixed high; a sub-agent's is its own.
        config: { isSubAgent: true, maxTurns: 2 },
        tools: [{ name: 'Step', readOnly: true }],
        replies: [
          { label: 'step-1', calls: [{ id: 's1', name: 'Step', args: { value: 's1' } }] },
          { label: 'step-2', calls: [{ id: 's2', name: 'Step', args: { value: 's2' } }] },
          title,
        ],
      })
      await w.submit('keep going')
      return w.finish()
    },
    check: endsWith('max_turns'),
  },
  {
    name: 'api-error-terminal',
    async run() {
      const w = engineWorld({
        env: { e2eProviderMaxRetries: '0' },
        replies: [{ label: 'auth-failure', streamError: { type: 'authentication_error', message: 'invalid x-api-key', httpStatus: 401 } }],
      })
      await w.submit('hello')
      return w.finish()
    },
    check: endsWith('api_error'),
  },
  {
    name: 'prompt-too-long-from-provider',
    async run() {
      const w = engineWorld({
        replies: [{ label: 'too-long', streamError: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens > 200000 maximum', httpStatus: 400 } }],
      })
      await w.submit('a long prompt')
      return w.finish()
    },
    check: endsWith('prompt_too_long'),
  },
  {
    name: 'aborted-mid-stream',
    async run() {
      const holder: { stop?: () => void } = {}
      const w = engineWorld({
        replies: [{ label: 'held', text: 'Partial answ', hang: true, beforeRead: i => (i === 1 ? holder.stop?.() : undefined) }],
      })
      holder.stop = () => w.engine.cancelTurn()
      await w.submit('write an essay')
      return w.finish()
    },
    check: endsWith('aborted_streaming'),
  },
]

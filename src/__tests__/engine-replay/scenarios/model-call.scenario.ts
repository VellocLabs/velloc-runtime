/**
 * One model call and its recovery: the output-cap escalation and resume
 * ladder, the retry ladder (backoff decided, never waited), the blocking
 * fallback, and the rule that a stream that already started is never re-sent
 * through the fallback.
 */
import { expect } from 'vitest'
import type { Scenario } from '../harness/scenario'
import { engineWorld } from '../harness/world'
import { endsWith } from './terminals.scenario'

const title = { label: 'title', querySource: 'rename_generate_name', text: 'A title' }
const cut = (label: string) => ({ label, text: `${label} text…`, stopReason: 'max_tokens' })
const overloaded = (label: string) => ({
  label,
  streamError: { type: 'overloaded_error', message: 'Overloaded', httpStatus: 529 },
})

export const scenarios: Scenario[] = [
  {
    name: 'max-tokens-escalate-then-three-resumes-then-terminal',
    async run() {
      const w = engineWorld({
        // Known quirk, kept: each resume drops the raised cap, so the next cut
        // escalates again before the next resume.
        replies: [
          cut('first'), cut('escalated'), cut('resume-1'), cut('re-escalated-1'),
          cut('resume-2'), cut('re-escalated-2'), cut('resume-3'), cut('re-escalated-3'),
        ],
      })
      await w.submit('write a very long report')
      return w.finish()
    },
    check: endsWith('max_output_tokens'),
  },
  {
    name: 'max-tokens-escalate-then-completes',
    async run() {
      const w = engineWorld({ replies: [cut('first'), { label: 'escalated', text: 'Complete answer.' }, title] })
      await w.submit('write a report')
      return w.finish()
    },
    check: endsWith('completed'),
  },
  {
    name: 'max-tokens-resume-then-completes',
    async run() {
      const w = engineWorld({ replies: [cut('first'), cut('escalated'), { label: 'resume-1', text: 'The rest.' }, title] })
      await w.submit('write a report')
      return w.finish()
    },
    check: endsWith('completed'),
  },
  {
    name: 'retries-exhausted-api-error',
    async run() {
      const w = engineWorld({
        env: { e2eProviderMaxRetries: '3' },
        replies: [overloaded('attempt-1'), overloaded('attempt-2'), overloaded('attempt-3'), overloaded('attempt-4')],
      })
      await w.submit('hello')
      return w.finish()
    },
    check: t => {
      endsWith('api_error')(t)
      expect(t.retryDelays).toHaveLength(3)
    },
  },
  {
    name: 'retry-then-success',
    async run() {
      const w = engineWorld({ replies: [overloaded('attempt-1'), { label: 'attempt-2', text: 'Recovered.' }, title] })
      await w.submit('hello')
      return w.finish()
    },
    check: t => {
      endsWith('completed')(t)
      expect(t.retryDelays).toHaveLength(1)
    },
  },
  {
    name: 'retry-ladder-notice-from-attempt-four',
    async run() {
      const w = engineWorld({
        env: { e2eProviderMaxRetries: '5' },
        replies: [
          overloaded('attempt-1'),
          overloaded('attempt-2'),
          overloaded('attempt-3'),
          overloaded('attempt-4'),
          overloaded('attempt-5'),
          { label: 'attempt-6', text: 'Finally.' },
          title,
        ],
      })
      await w.submit('hello')
      return w.finish()
    },
    check: endsWith('completed'),
  },
  {
    name: 'rate-limit-honours-retry-after',
    async run() {
      const w = engineWorld({
        replies: [
          { label: 'limited', streamError: { type: 'rate_limit_error', message: 'Rate limited', httpStatus: 429, retryAfterSeconds: 12 } },
          { label: 'after-wait', text: 'Here.' },
          title,
        ],
      })
      await w.submit('hello')
      return w.finish()
    },
    check: t => expect(t.retryDelays).toEqual([12_000]),
  },
  {
    name: 'idle-timeout-is-retried',
    async run() {
      const w = engineWorld({ replies: [{ label: 'silent', timeout: true }, { label: 'retry', text: 'Back.' }, title] })
      await w.submit('hello')
      return w.finish()
    },
    check: endsWith('completed'),
  },
  {
    name: 'stream-unavailable-uses-blocking-fallback',
    async run() {
      const w = engineWorld({
        replies: [
          {
            label: 'no-stream',
            startError: { code: 'unknown_action', message: 'model.streamStart is not supported by this host' },
            blocking: { ok: true, text: 'Answered without streaming.' },
          },
          {
            label: 'title-no-stream',
            querySource: 'rename_generate_name',
            startError: { code: 'unknown_action', message: 'model.streamStart is not supported by this host' },
            blocking: { ok: true, text: 'A title' },
          },
        ],
      })
      await w.submit('hello')
      return w.finish()
    },
    check: endsWith('completed'),
  },
  {
    name: 'started-stream-error-is-not-sent-to-fallback',
    async run() {
      const w = engineWorld({
        env: { e2eProviderMaxRetries: '0' },
        replies: [{ label: 'broke-mid-stream', text: 'Half an ans', streamError: { type: 'api_error', message: 'Internal server error', httpStatus: 500 } }],
      })
      await w.submit('hello')
      return w.finish()
    },
    check: t => {
      endsWith('api_error')(t)
      expect(t.transport).not.toContain('call')
    },
  },
  {
    name: 'prompt-too-long-at-stream-start',
    async run() {
      const w = engineWorld({
        replies: [
          {
            label: 'rejected',
            startError: { code: 'invalid_request_error', message: 'prompt is too long: 300000 tokens > 200000 maximum' },
            blocking: { ok: false, code: 'invalid_request_error', message: 'prompt is too long: 300000 tokens > 200000 maximum' },
          },
        ],
      })
      await w.submit('a huge paste')
      return w.finish()
    },
    check: endsWith('prompt_too_long'),
  },
  {
    name: 'thinking-and-text-assembled',
    async run() {
      const w = engineWorld({ replies: [{ label: 'thought', thinking: 'Consider the question.', text: 'Answer.' }, title] })
      await w.submit('think first')
      return w.finish()
    },
    check: endsWith('completed'),
  },
]

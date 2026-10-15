/**
 * Context pressure: automatic compaction before a request and the turn that
 * continues on the compacted tape; a summarizer failure that leaves the turn
 * running uncompacted; a conversation too long to send before any request;
 * and a provider rejection after a compaction.
 */
import { expect } from 'vitest'
import type { Scenario } from '../harness/scenario'
import type { Message } from '../../../runtime/RuntimeTypes'
import { engineWorld, loopWorld } from '../harness/world'
import { endsWith } from './terminals.scenario'

const title = { label: 'title', querySource: 'rename_generate_name', text: 'A title' }
const summary = { label: 'summary', text: '<summary>The user asked for a long review; nothing is done yet.</summary>' }
const longPrompt = `Review this: ${'lorem ipsum dolor sit amet '.repeat(40)}`
const tooLong = 'prompt is too long: 300000 tokens > 200000 maximum'

export const scenarios: Scenario[] = [
  {
    name: 'auto-compaction-then-continue',
    async run() {
      const w = engineWorld({
        compaction: { threshold: 100 },
        replies: [summary, { label: 'answer', text: 'Reviewed.' }, title],
      })
      await w.submit(longPrompt)
      return w.finish()
    },
    check: t => {
      endsWith('completed')(t)
      expect(JSON.stringify(t.emitted)).toContain('compact_boundary')
    },
  },
  {
    name: 'compaction-failure-then-continue-uncompacted',
    async run() {
      const w = engineWorld({
        env: { e2eProviderMaxRetries: '0' },
        compaction: { threshold: 100 },
        replies: [
          { label: 'summary-fails', streamError: { type: 'invalid_request_error', message: 'summarizer rejected the request', httpStatus: 400 } },
          { label: 'answer', text: 'Reviewed anyway.' },
          title,
        ],
      })
      await w.submit(longPrompt)
      return w.finish()
    },
    check: t => {
      endsWith('completed')(t)
      expect(JSON.stringify(t.emitted)).not.toContain('compact_boundary')
    },
  },
  {
    name: 'compaction-below-threshold-does-nothing',
    async run() {
      const w = engineWorld({
        compaction: { threshold: 100_000 },
        replies: [{ label: 'answer', text: 'Short.' }, title],
      })
      await w.submit('hi')
      return w.finish()
    },
    check: t => expect(t.modelRequests).toHaveLength(2),
  },
  {
    name: 'prompt-too-long-before-any-request',
    // The request loop alone, so the oversized input is not copied into the
    // fixture: the loop gets it as its starting messages.
    async run() {
      const w = loopWorld({ replies: [] })
      return w.run({
        messages: [
          { type: 'user', uuid: 'prompt-1', message: { role: 'user', content: `Read all of this: ${'word '.repeat(220_000)}` } } as Message,
        ],
      })
    },
    check: t => {
      expect(t.terminal).toEqual({ reason: 'prompt_too_long', turnCount: 1 })
      expect(t.modelRequests).toHaveLength(0)
    },
  },
  {
    name: 'prompt-too-long-after-compaction',
    async run() {
      const w = engineWorld({
        compaction: { threshold: 100 },
        replies: [
          summary,
          {
            label: 'still-rejected',
            startError: { code: 'invalid_request_error', message: tooLong },
            blocking: { ok: false, code: 'invalid_request_error', message: tooLong },
          },
        ],
      })
      await w.submit(longPrompt)
      return w.finish()
    },
    check: endsWith('prompt_too_long'),
  },
]

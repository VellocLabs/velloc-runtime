/**
 * Failure recovery and the four nudge timings. A nudge is a recorded meta
 * row: stored in the session right before the model request that first
 * carries it, and part of every later request built from the session.
 */
import { expect } from 'vitest'
import type { Scenario } from '../harness/scenario'
import type { Trace } from '../harness/trace'
import { engineWorld } from '../harness/world'
import { endsWith } from './terminals.scenario'

const title = { label: 'title', querySource: 'rename_generate_name', text: 'A title' }
const round = (n: number, name = 'Act') => ({ label: `round-${n}`, calls: [{ id: `call-${n}`, name }] })
const rounds = (count: number, name = 'Act') => Array.from({ length: count }, (_, i) => round(i + 1, name))

/** Which model requests carry a nudge of this kind (by its opening words). */
function requestsCarrying(trace: Trace, opening: string): number[] {
  return trace.modelRequests.flatMap((request, index) => (JSON.stringify(request).includes(opening) ? [index] : []))
}

const subAgent = (maxTurns: number) => ({ config: { isSubAgent: true, maxTurns } })

export const scenarios: Scenario[] = [
  {
    // Known quirk, kept: the recovery request still carries the tools, and a
    // text-only recovery turn ends `completed` — the turn-end reset clears
    // the max-failures latch before the exit check reads it.
    name: 'max-failures-recovery-turn-text-ends-completed',
    async run() {
      const w = engineWorld({
        tools: [{ name: 'Act', throws: 'The action failed.' }],
        replies: [...rounds(5), { label: 'recovery', text: 'Five attempts failed; here is what I have.' }, title],
      })
      await w.submit('do the thing')
      return w.finish()
    },
    check: t => {
      endsWith('completed')(t)
      expect(requestsCarrying(t, 'times consecutively')).toEqual([5])
    },
  },
  {
    name: 'max-failures-recovery-turn-that-calls-tools-still-exits',
    async run() {
      const w = engineWorld({
        tools: [{ name: 'Act', throws: 'The action failed.' }],
        replies: [...rounds(6)],
      })
      await w.submit('do the thing')
      return w.finish()
    },
    check: endsWith('max_failures'),
  },
  {
    name: 'a-success-resets-the-failure-count',
    async run() {
      const w = engineWorld({
        tools: [
          { name: 'Act', throws: 'The action failed.' },
          { name: 'Fine' },
        ],
        replies: [...rounds(4), round(5, 'Fine'), round(6), { label: 'done', text: 'Done.' }, title],
      })
      await w.submit('do the thing')
      return w.finish()
    },
    check: t => {
      endsWith('completed')(t)
      expect(requestsCarrying(t, 'times consecutively')).toEqual([])
    },
  },
  {
    name: 'failure-count-starts-fresh-on-the-next-prompt',
    async run() {
      const w = engineWorld({
        tools: [{ name: 'Act', throws: 'The action failed.' }],
        replies: [
          ...rounds(5),
          { label: 'recovery', text: 'Gave up.' },
          title,
          { label: 'second-prompt', calls: [{ id: 'call-7', name: 'Act' }] },
          { label: 'second-done', text: 'Still failing, stopping.' },
          title,
        ],
      })
      await w.submit('do the thing')
      await w.submit('try once more')
      return w.finish()
    },
    check: endsWith('completed'),
  },
  {
    name: 'budget-warning-at-three-quarters',
    async run() {
      const w = engineWorld({ ...subAgent(4), tools: [{ name: 'Act' }], replies: [...rounds(3), { label: 'done', text: 'Done.' }, title] })
      await w.submit('work')
      return w.finish()
    },
    check: t => expect(requestsCarrying(t, 'BUDGET WARNING')).toEqual([3]),
  },
  {
    // Known quirk, kept: the last-step nudge needs the completed step count to
    // reach the cap between steps, but the cap ends the loop first — the last
    // allowed request carries no nudge.
    name: 'last-step-request-carries-no-nudge',
    async run() {
      const w = engineWorld({ ...subAgent(3), tools: [{ name: 'Act' }], replies: [...rounds(2), { label: 'final', text: 'Final answer.' }, title] })
      await w.submit('work')
      return w.finish()
    },
    check: t => {
      endsWith('completed')(t)
      expect(requestsCarrying(t, 'this is your last step')).toEqual([])
    },
  },
  {
    name: 'last-step-tool-call-reaches-max-turns-without-nudge',
    async run() {
      const w = engineWorld({ ...subAgent(3), tools: [{ name: 'Act' }], replies: [...rounds(3), title] })
      await w.submit('work')
      return w.finish()
    },
    check: t => {
      endsWith('max_turns')(t)
      expect(requestsCarrying(t, 'this is your last step')).toEqual([])
    },
  },
  {
    name: 'repeated-action-loop-nudge',
    async run() {
      const w = engineWorld({
        tools: [{ name: 'Act', result: { data: { ok: true }, agentMeta: { actionHashes: ['click:#same'] } } }],
        replies: [...rounds(5), { label: 'done', text: 'Done.' }, title],
      })
      await w.submit('click it')
      return w.finish()
    },
    check: t => expect(requestsCarrying(t, 'repeated a similar action')).toEqual([5]),
  },
]

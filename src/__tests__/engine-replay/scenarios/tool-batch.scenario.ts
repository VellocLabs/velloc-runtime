/**
 * One assistant turn's tool calls: adjacent concurrency-safe calls share a
 * parallel batch, every other call runs alone, batches run in order; context
 * changes apply in call order; a halt stops the rest of the turn; the
 * post-tool hook runs exactly once per call; an abort fills every missing
 * result.
 */
import { expect } from 'vitest'
import type { Scenario } from '../harness/scenario'
import type { Trace } from '../harness/trace'
import { engineWorld, type EngineWorld } from '../harness/world'
import { endsWith } from './terminals.scenario'

const title = { label: 'title', querySource: 'rename_generate_name', text: 'A title' }
const call = (id: string, name: string) => ({ id, name })
type ToolEvent = { event: string; id?: string; inFlight?: string[]; tag?: string }
const starts = (t: Trace) => (t.toolCalls as ToolEvent[]).filter(e => e.event === 'start')

export const scenarios: Scenario[] = [
  {
    name: 'mixed-batch-parallel-then-solo-then-parallel',
    async run() {
      const w = engineWorld({
        tools: [
          { name: 'Look', readOnly: true, concurrencySafe: true },
          { name: 'Change' },
        ],
        replies: [
          {
            label: 'calls',
            calls: [call('look-1', 'Look'), call('look-2', 'Look'), call('change-1', 'Change'), call('look-3', 'Look'), call('look-4', 'Look')],
          },
          { label: 'done', text: 'Done.' },
          title,
        ],
      })
      await w.submit('look and change')
      return w.finish()
    },
    check: t => {
      const s = starts(t)
      expect(s.map(e => e.id)).toEqual(['look-1', 'look-2', 'change-1', 'look-3', 'look-4'])
      expect(s.find(e => e.id === 'change-1')!.inFlight).toEqual(['change-1'])
      expect(s.find(e => e.id === 'look-2')!.inFlight).toEqual(['look-1', 'look-2'])
    },
  },
  {
    name: 'context-modifiers-apply-in-call-order',
    async run() {
      const w = engineWorld({
        tools: [
          { name: 'Slow', readOnly: true, concurrencySafe: true, contextTag: 'slow', ticks: 12 },
          { name: 'Fast', readOnly: true, concurrencySafe: true, contextTag: 'fast', ticks: 1 },
          { name: 'Solo', contextTag: 'solo' },
        ],
        replies: [
          { label: 'calls', calls: [call('slow-1', 'Slow'), call('fast-1', 'Fast'), call('solo-1', 'Solo')] },
          { label: 'done', text: 'Done.' },
          title,
        ],
      })
      await w.submit('go')
      return w.finish()
    },
    check: t => {
      const tags = (t.toolCalls as ToolEvent[]).filter(e => e.event === 'contextModifier').map(e => e.tag)
      expect(tags).toEqual(['slow', 'fast', 'solo'])
    },
  },
  {
    name: 'batch-stops-at-a-halting-call',
    async run() {
      const w = engineWorld({
        tools: [
          { name: 'Ask', haltsForUser: true, selfVerdict: { behavior: 'ask', message: 'Answer me.' } },
          { name: 'After' },
        ],
        replies: [{ label: 'calls', calls: [call('ask-1', 'Ask'), call('after-1', 'After')] }, title],
      })
      await w.submit('ask then act')
      return w.finish()
    },
    check: t => {
      endsWith('awaiting_user_interaction')(t)
      expect(starts(t).map(e => e.id)).not.toContain('after-1')
    },
  },
  {
    name: 'post-tool-hook-once-per-call-including-failures',
    async run() {
      const w = engineWorld({
        hooks: [{ event: 'PostToolUse' }, { event: 'PostToolUseFailure' }],
        tools: [
          { name: 'Look', readOnly: true, concurrencySafe: true },
          { name: 'Breaks', readOnly: true, concurrencySafe: true, throws: 'It broke.' },
        ],
        replies: [
          { label: 'calls', calls: [call('look-1', 'Look'), call('breaks-1', 'Breaks'), call('look-2', 'Look')] },
          { label: 'done', text: 'Done.' },
          title,
        ],
      })
      await w.submit('go')
      return w.finish()
    },
    check: t => {
      const hookEvents = (t.hooks as Array<{ event: string }>).map(h => h.event)
      expect(hookEvents.filter(e => e === 'PostToolUse')).toHaveLength(2)
      expect(hookEvents.filter(e => e === 'PostToolUseFailure')).toHaveLength(1)
    },
  },
  {
    name: 'abort-mid-batch-fills-every-missing-result',
    async run() {
      const box: { w?: EngineWorld } = {}
      const w = engineWorld({
        tools: [
          { name: 'Look', readOnly: true, concurrencySafe: true, ticks: 2 },
          { name: 'Stopper', during: () => box.w!.engine.cancelTurn() },
          { name: 'Never' },
        ],
        replies: [{ label: 'calls', calls: [call('look-1', 'Look'), call('stopper-1', 'Stopper'), call('never-1', 'Never')] }],
      })
      box.w = w
      await w.submit('go')
      return w.finish()
    },
    check: t => {
      endsWith('aborted_streaming')(t)
      expect(starts(t).map(e => e.id)).not.toContain('never-1')
    },
  },
  {
    name: 'duplicate-tool-call-id-runs-once',
    async run() {
      const w = engineWorld({
        tools: [{ name: 'Look', readOnly: true, concurrencySafe: true }],
        replies: [{ label: 'calls', calls: [call('look-1', 'Look'), call('look-1', 'Look')] }, { label: 'done', text: 'Done.' }, title],
      })
      await w.submit('go')
      return w.finish()
    },
    check: t => expect(starts(t)).toHaveLength(1),
  },
  {
    name: 'unknown-tool-and-invalid-input-answer-errors',
    async run() {
      const w = engineWorld({
        tools: [{ name: 'Picky', invalid: 'value must be a number' }],
        replies: [{ label: 'calls', calls: [call('ghost-1', 'Ghost'), call('picky-1', 'Picky')] }, { label: 'done', text: 'Done.' }, title],
      })
      await w.submit('go')
      return w.finish()
    },
    check: t => {
      endsWith('completed')(t)
      expect(starts(t)).toHaveLength(0)
    },
  },
]

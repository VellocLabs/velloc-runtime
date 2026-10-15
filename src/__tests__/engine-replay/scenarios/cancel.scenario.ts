/**
 * Stop at each point of a turn: while a tool runs, while a retry waits, on
 * the last allowed step, and the prompt after a stop. (Stop while the answer
 * streams is `aborted-mid-stream` among the terminals.)
 */
import { expect } from 'vitest'
import type { Scenario } from '../harness/scenario'
import { engineWorld, type EngineWorld } from '../harness/world'
import { endsWith } from './terminals.scenario'

const overloaded = { label: 'overloaded', streamError: { type: 'overloaded_error', message: 'Overloaded', httpStatus: 529 } }

export const scenarios: Scenario[] = [
  {
    name: 'cancel-mid-tool',
    async run() {
      const box: { w?: EngineWorld } = {}
      const w = engineWorld({
        tools: [{ name: 'Long', during: () => box.w!.engine.cancelTurn() }],
        replies: [{ label: 'calls', calls: [{ id: 'long-1', name: 'Long' }] }],
      })
      box.w = w
      await w.submit('run it')
      return w.finish()
    },
    check: endsWith('aborted_streaming'),
  },
  {
    name: 'cancel-during-retry-backoff',
    async run() {
      const box: { w?: EngineWorld } = {}
      const w = engineWorld({ onRetry: () => box.w!.engine.cancelTurn(), replies: [overloaded] })
      box.w = w
      await w.submit('hello')
      return w.finish()
    },
    check: t => expect(t.retryDelays).toHaveLength(1),
  },
  {
    name: 'cancel-on-the-last-step',
    async run() {
      const box: { w?: EngineWorld } = {}
      const w = engineWorld({
        config: { isSubAgent: true, maxTurns: 2 },
        tools: [{ name: 'Act' }, { name: 'Long', during: () => box.w!.engine.cancelTurn() }],
        replies: [
          { label: 'step-1', calls: [{ id: 'act-1', name: 'Act' }] },
          { label: 'step-2', calls: [{ id: 'long-1', name: 'Long' }] },
        ],
      })
      box.w = w
      await w.submit('work')
      return w.finish()
    },
    check: endsWith('aborted_streaming'),
  },
  {
    name: 'cancel-then-next-prompt-carries-the-interruption',
    async run() {
      const box: { w?: EngineWorld } = {}
      const w = engineWorld({
        tools: [{ name: 'Long', during: () => box.w!.engine.cancelTurn() }],
        replies: [
          { label: 'calls', calls: [{ id: 'long-1', name: 'Long' }] },
          { label: 'after', text: 'Understood.' },
          { label: 'title', querySource: 'rename_generate_name', text: 'A title' },
        ],
      })
      box.w = w
      await w.submit('run it')
      await w.submit('never mind')
      return w.finish()
    },
    check: t => expect(JSON.stringify(t.modelRequests[1])).toContain('interrupted'),
  },
]

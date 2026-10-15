/**
 * What arrives while a turn runs is drained between rounds, in the order it
 * was queued, and reaches the next model request: typed input, background
 * task notifications, teammate messages. Only a tool round drains: a text
 * answer, the round that ends the turn on the step cap and an aborted round
 * drain nothing.
 */
import { expect } from 'vitest'
import type { Scenario } from '../harness/scenario'
import type { Trace } from '../harness/trace'
import { engineWorld, type EngineWorld } from '../harness/world'
import { endsWith } from './terminals.scenario'

const title = { label: 'title', querySource: 'rename_generate_name', text: 'A title' }
const toolRound = { label: 'round-1', calls: [{ id: 'act-1', name: 'Act' }] }
const done = { label: 'done', text: 'Done.' }
const drains = (t: Trace) => t.notes.filter(n => 'drain' in (n as object))
const inRequest = (t: Trace, index: number, text: string) => JSON.stringify(t.modelRequests[index]).includes(text)

export const scenarios: Scenario[] = [
  {
    name: 'typed-input-reaches-the-next-request',
    async run() {
      const w = engineWorld({
        tools: [{ name: 'Act' }],
        queued: { typed: round => (round === 1 ? [{ uuid: 'typed-1', prompt: 'also check the footer', enqueuedAt: 10 }] : []) },
        replies: [toolRound, done, title],
      })
      await w.submit('check the header')
      return w.finish()
    },
    check: t => {
      endsWith('completed')(t)
      expect(inRequest(t, 0, 'also check the footer')).toBe(false)
      expect(inRequest(t, 1, 'also check the footer')).toBe(true)
    },
  },
  {
    name: 'notifications-team-and-typed-drain-in-queue-order',
    async run() {
      const w = engineWorld({
        tools: [{ name: 'Act' }],
        queued: {
          taskNotifications: round => (round === 1 ? { prompt: '<task-notification>build finished</task-notification>', enqueuedAt: 30 } : null),
          teamMessages: round => (round === 1 ? [{ prompt: 'reviewer: looks good', enqueuedAt: 10 }] : []),
          typed: round => (round === 1 ? [{ uuid: 'typed-1', prompt: 'thanks', enqueuedAt: 20 }] : []),
        },
        replies: [toolRound, done, title],
      })
      await w.submit('build it')
      return w.finish()
    },
    check: t => {
      const request = JSON.stringify(t.modelRequests[1])
      const order = ['reviewer: looks good', 'thanks', 'build finished'].map(text => request.indexOf(text))
      expect(order.every(at => at >= 0)).toBe(true)
      expect([...order].sort((a, b) => a - b)).toEqual(order)
    },
  },
  {
    // A round without tool calls ends the turn without draining: what was
    // queued waits for the session to be idle.
    name: 'text-only-answer-leaves-queued-input-for-idle',
    async run() {
      const w = engineWorld({
        queued: { typed: () => [{ uuid: 'typed-1', prompt: 'one more thing', enqueuedAt: 10 }] },
        replies: [{ label: 'answer', text: 'Answer.' }, title],
      })
      await w.submit('question')
      return w.finish()
    },
    check: t => {
      endsWith('completed')(t)
      expect(drains(t)).toEqual([])
    },
  },
  {
    name: 'step-cap-round-drains-nothing',
    async run() {
      const w = engineWorld({
        config: { isSubAgent: true, maxTurns: 1 },
        tools: [{ name: 'Act' }],
        queued: { typed: () => [{ uuid: 'typed-1', prompt: 'never drained', enqueuedAt: 10 }] },
        replies: [toolRound, title],
      })
      await w.submit('go')
      return w.finish()
    },
    check: t => {
      endsWith('max_turns')(t)
      expect(drains(t)).toEqual([])
    },
  },
  {
    name: 'aborted-round-drains-no-typed-or-team-input',
    async run() {
      const box: { w?: EngineWorld } = {}
      const w = engineWorld({
        tools: [{ name: 'Long', during: () => box.w!.engine.cancelTurn() }],
        queued: {
          teamMessages: () => [{ prompt: 'peer note', enqueuedAt: 10 }],
          typed: () => [{ uuid: 'typed-1', prompt: 'typed note', enqueuedAt: 20 }],
        },
        replies: [{ label: 'round-1', calls: [{ id: 'long-1', name: 'Long' }] }],
      })
      box.w = w
      await w.submit('go')
      return w.finish()
    },
    check: t => {
      expect(JSON.stringify(t.emitted)).not.toContain('peer note')
      expect(JSON.stringify(t.emitted)).not.toContain('typed note')
    },
  },
]

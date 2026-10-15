/**
 * The extension events the engine raises around a turn: `prompt.submit`
 * dropping, rewriting and adding context to a prompt; `session.receive`
 * consuming or rewriting a delivered message; `tool.call` answering in place
 * of the tool; and the reload after a turn, which the next turn waits for —
 * across a `/clear` too.
 */
import { expect } from 'vitest'
import type { Scenario } from '../harness/scenario'
import type { Trace } from '../harness/trace'
import { engineWorld } from '../harness/world'
import { endsWith } from './terminals.scenario'

const title = { label: 'title', querySource: 'rename_generate_name', text: 'A title' }
const answer = { label: 'answer', text: 'Answer.' }
const modEvents = (t: Trace) => (t.mods as Array<{ event: string }>).map(m => m.event)

export const scenarios: Scenario[] = [
  {
    name: 'prompt-submit-drops-the-prompt',
    async run() {
      const w = engineWorld({
        mods: { promptSubmit: () => ({ entered: false, reason: 'Prompts mentioning secrets are blocked.' }) },
        replies: [],
      })
      await w.submit('here is my secret')
      return w.finish()
    },
    check: t => expect(t.modelRequests).toHaveLength(0),
  },
  {
    name: 'prompt-submit-rewrites-and-adds-context',
    async run() {
      const w = engineWorld({
        mods: { promptSubmit: text => ({ entered: true, text: `${text} (in British English)`, context: ['The user prefers short answers.'] }) },
        replies: [answer, title],
      })
      await w.submit('describe the colour wheel')
      return w.finish()
    },
    check: t => {
      const request = JSON.stringify(t.modelRequests[0])
      expect(request).toContain('(in British English)')
      expect(request).toContain('The user prefers short answers.')
    },
  },
  {
    name: 'session-receive-consumes-a-delivery',
    async run() {
      const w = engineWorld({
        mods: { sessionReceive: () => ({ consumed: 'handled by the plugin' }) },
        replies: [],
      })
      await w.submit('<task-notification>job 4 finished</task-notification>', { delivery: 'task-notification' })
      return w.finish()
    },
    check: t => {
      expect(t.modelRequests).toHaveLength(0)
      expect(t.sessionWrites).toEqual([])
    },
  },
  {
    name: 'session-receive-rewrites-a-delivery',
    async run() {
      const w = engineWorld({
        mods: { sessionReceive: input => ({ text: input.text.replace('job 4', 'the nightly build') }) },
        replies: [answer, title],
      })
      await w.submit('<task-notification>job 4 finished</task-notification>', { delivery: 'task-notification' })
      return w.finish()
    },
    check: t => expect(JSON.stringify(t.modelRequests[0])).toContain('the nightly build finished'),
  },
  {
    name: 'session-receive-on-a-mid-turn-notification',
    async run() {
      const w = engineWorld({
        tools: [{ name: 'Act' }],
        mods: { sessionReceive: input => (input.text.includes('noise') ? { consumed: 'dropped' } : { text: input.text.toUpperCase() }) },
        queued: {
          taskNotifications: round => (round === 1 ? { prompt: 'build done', enqueuedAt: 10 } : null),
          teamMessages: round => (round === 1 ? [{ prompt: 'noise from a peer', enqueuedAt: 20 }] : []),
        },
        replies: [{ label: 'round-1', calls: [{ id: 'act-1', name: 'Act' }] }, answer, title],
      })
      await w.submit('build')
      return w.finish()
    },
    check: t => {
      const request = JSON.stringify(t.modelRequests[1])
      expect(request).toContain('BUILD DONE')
      expect(request).not.toContain('noise from a peer')
    },
  },
  {
    name: 'tool-call-hook-answers-in-place-of-the-tool',
    async run() {
      const w = engineWorld({
        tools: [{ name: 'Act' }],
        mods: { toolCall: () => ({ result: 'answered by the plugin' }) },
        replies: [{ label: 'round-1', calls: [{ id: 'act-1', name: 'Act' }] }, answer, title],
      })
      await w.submit('act')
      return w.finish()
    },
    check: t => expect((t.toolCalls as Array<{ event: string }>).filter(e => e.event === 'start')).toHaveLength(0),
  },
  {
    name: 'tool-call-hook-denies-the-call',
    async run() {
      const w = engineWorld({
        tools: [{ name: 'Act' }],
        mods: { toolCall: () => ({ deny: 'The plugin refuses this call.' }) },
        replies: [{ label: 'round-1', calls: [{ id: 'act-1', name: 'Act' }] }, answer, title],
      })
      await w.submit('act')
      return w.finish()
    },
    check: t => expect((t.toolCalls as Array<{ event: string }>).filter(e => e.event === 'start')).toHaveLength(0),
  },
  {
    name: 'tool-call-hook-unrecognised-answer-falls-back-to-the-tool',
    async run() {
      const w = engineWorld({
        tools: [{ name: 'Act' }],
        mods: { toolCall: () => ({ content: 'not a result' }) },
        replies: [{ label: 'round-1', calls: [{ id: 'act-1', name: 'Act' }] }, answer, title],
      })
      await w.submit('act')
      return w.finish()
    },
    check: t => expect((t.toolCalls as Array<{ event: string }>).filter(e => e.event === 'start')).toHaveLength(1),
  },
  {
    name: 'tool-call-hook-passes-through-to-the-tool',
    async run() {
      const w = engineWorld({
        tools: [{ name: 'Act' }],
        mods: { toolCall: () => 'pass' },
        replies: [{ label: 'round-1', calls: [{ id: 'act-1', name: 'Act' }] }, answer, title],
      })
      await w.submit('act')
      return w.finish()
    },
    check: t => expect((t.toolCalls as Array<{ event: string }>).filter(e => e.event === 'start')).toHaveLength(1),
  },
  {
    name: 'reload-after-turn-settles-before-the-next-turn',
    async run() {
      const w = engineWorld({
        mods: { afterTurnDelay: 5 },
        replies: [answer, title, { label: 'second', text: 'Second.' }, title],
      })
      await w.submit('first')
      await w.submit('second')
      return w.finish()
    },
    check: t => {
      const events = modEvents(t)
      const settled = events.indexOf('afterTurn.settled')
      const secondStart = events.indexOf('turn.start', events.indexOf('turn.start') + 1)
      expect(settled).toBeGreaterThan(-1)
      expect(settled).toBeLessThan(secondStart)
    },
  },
  {
    name: 'reload-after-turn-then-clear-then-turn',
    async run() {
      const w = engineWorld({
        mods: { afterTurnDelay: 5 },
        replies: [answer, title, { label: 'after-clear', text: 'Fresh.' }, title],
      })
      await w.submit('first')
      await w.submit('/clear')
      await w.submit('again')
      return w.finish()
    },
    check: t => {
      const events = modEvents(t)
      expect(events.indexOf('afterTurn.settled')).toBeLessThan(events.indexOf('session.end'))
      endsWith('completed')(t)
    },
  },
]

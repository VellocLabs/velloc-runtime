/**
 * The five built-in commands, each typed after a first exchange so its
 * effect on the conversation shows: `/clear` starts a new conversation the
 * next prompt builds on, `/compact` replaces the history with a summary,
 * `/plugins`, `/mcp` and `/rename` answer without a model request. An
 * unknown command answers without one too.
 */
import { expect } from 'vitest'
import type { Scenario } from '../harness/scenario'
import type { Trace } from '../harness/trace'
import { engineWorld } from '../harness/world'

const title = { label: 'title', querySource: 'rename_generate_name', text: 'A title' }
const first = [{ label: 'first-answer', text: 'First answer.' }, title]
const ops = (t: Trace) => (t.sessionWrites as Array<{ op: string }>).map(w => w.op)

export const scenarios: Scenario[] = [
  {
    name: 'clear-then-next-prompt-starts-fresh',
    async run() {
      const w = engineWorld({
        hooks: [{ event: 'SessionEnd' }, { event: 'SessionStart' }],
        replies: [...first, { label: 'after-clear', text: 'Fresh start.' }, title],
      })
      await w.submit('remember the number 7')
      await w.submit('/clear')
      await w.submit('what number?')
      return w.finish()
    },
    check: t => {
      expect(ops(t)).toContain('startNewConversation')
      expect(JSON.stringify(t.modelRequests[2])).not.toContain('remember the number 7')
    },
  },
  {
    name: 'compact-replaces-history-with-summary',
    async run() {
      const w = engineWorld({
        compaction: { threshold: 1_000_000 },
        replies: [
          ...first,
          { label: 'summary', text: '<summary>The user asked one question and got an answer.</summary>' },
          { label: 'after-compact', text: 'Continuing.' },
          title,
        ],
      })
      await w.submit('first question')
      await w.submit('/compact keep it short')
      await w.submit('next question')
      return w.finish()
    },
    check: t => {
      expect(JSON.stringify(t.modelRequests[2])).toContain('keep it short')
      expect(JSON.stringify(t.modelRequests[3])).not.toContain('First answer.')
    },
  },
  {
    name: 'compact-failure-keeps-history',
    async run() {
      const w = engineWorld({
        env: { e2eProviderMaxRetries: '0' },
        compaction: { threshold: 1_000_000 },
        replies: [
          ...first,
          { label: 'summary-fails', streamError: { type: 'invalid_request_error', message: 'summarizer rejected the request', httpStatus: 400 } },
        ],
      })
      await w.submit('first question')
      await w.submit('/compact')
      return w.finish()
    },
    check: t => expect(JSON.stringify(t.emitted)).not.toContain('compact_boundary'),
  },
  {
    name: 'plugins-reload-without-model-request',
    async run() {
      const w = engineWorld({ replies: [...first] })
      await w.submit('hello')
      await w.submit('/plugins')
      return w.finish()
    },
    check: t => expect(t.modelRequests).toHaveLength(2),
  },
  {
    name: 'mcp-opens-settings-without-model-request',
    async run() {
      const w = engineWorld({ replies: [...first] })
      await w.submit('hello')
      await w.submit('/mcp')
      return w.finish()
    },
    check: t => expect(t.modelRequests).toHaveLength(2),
  },
  {
    name: 'rename-sets-the-title',
    async run() {
      const w = engineWorld({ replies: [...first] })
      await w.submit('hello')
      await w.submit('/rename Release checklist')
      return w.finish()
    },
    check: t => expect(t.sessionWrites).toContainEqual(expect.objectContaining({ op: 'customTitle', customTitle: 'Release checklist' })),
  },
  {
    name: 'unknown-command-answers-without-model-request',
    async run() {
      const w = engineWorld({ replies: [] })
      await w.submit('/frobnicate now')
      return w.finish()
    },
    check: t => expect(t.modelRequests).toHaveLength(0),
  },
]

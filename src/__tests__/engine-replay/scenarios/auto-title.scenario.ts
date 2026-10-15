/**
 * The session title the engine asks a fast model for: only after a turn that
 * ended successfully, never over a name the user chose, and a rename while
 * the request is in flight wins over its answer.
 */
import { expect } from 'vitest'
import type { Scenario } from '../harness/scenario'
import type { Trace } from '../harness/trace'
import { engineWorld, type EngineWorld } from '../harness/world'
import { endsWith } from './terminals.scenario'

const titleRequests = (t: Trace) =>
  (t.modelResponses as Array<{ querySource?: string }>).filter(r => r.querySource === 'rename_generate_name')
const aiTitles = (t: Trace) => (t.sessionWrites as Array<{ op: string }>).filter(w => w.op === 'aiTitle')

export const scenarios: Scenario[] = [
  {
    name: 'title-after-a-successful-turn',
    async run() {
      const w = engineWorld({ replies: [{ label: 'answer', text: 'Answer.' }, { label: 'title', querySource: 'rename_generate_name', text: 'Colour wheel basics' }] })
      await w.submit('explain the colour wheel')
      return w.finish()
    },
    check: t => expect(aiTitles(t)).toEqual([{ op: 'aiTitle', aiTitle: 'Colour wheel basics' }]),
  },
  {
    name: 'no-title-after-a-failed-turn',
    async run() {
      const w = engineWorld({
        env: { e2eProviderMaxRetries: '0' },
        replies: [{ label: 'fails', streamError: { type: 'api_error', message: 'Internal server error', httpStatus: 500 } }],
      })
      await w.submit('explain the colour wheel')
      return w.finish()
    },
    check: t => {
      endsWith('api_error')(t)
      expect(titleRequests(t)).toEqual([])
    },
  },
  {
    name: 'no-title-over-a-chosen-name',
    async run() {
      const w = engineWorld({ replies: [{ label: 'answer', text: 'Answer.' }] })
      await w.submit('/rename My session')
      await w.submit('explain the colour wheel')
      return w.finish()
    },
    check: t => expect(titleRequests(t)).toEqual([]),
  },
  {
    // Known behaviour, kept: only a name the user chose stops the request, so
    // every successful turn asks again and rewrites the generated title.
    name: 'title-asked-again-after-every-successful-turn',
    async run() {
      const title = (text: string) => ({ label: `title-${text}`, querySource: 'rename_generate_name', text })
      const w = engineWorld({
        replies: [{ label: 'first', text: 'First.' }, title('First title'), { label: 'second', text: 'Second.' }, title('Second title')],
      })
      await w.submit('first question')
      await w.submit('second question')
      return w.finish()
    },
    check: t => expect(aiTitles(t)).toHaveLength(2),
  },
  {
    name: 'rename-during-title-request-wins',
    async run() {
      const box: { w?: EngineWorld } = {}
      const w = engineWorld({
        replies: [
          { label: 'answer', text: 'Answer.' },
          {
            label: 'title-cancelled',
            querySource: 'rename_generate_name',
            text: 'Generated title',
            beforeRead: index => {
              if (index === 0) box.w!.engine.cancelAutoTitleGeneration()
            },
          },
        ],
      })
      box.w = w
      await w.submit('explain the colour wheel')
      return w.finish()
    },
    check: t => expect(aiTitles(t)).toEqual([]),
  },
  {
    name: 'title-failure-retries-once-on-the-parent-model',
    async run() {
      const w = engineWorld({
        env: { e2eProviderMaxRetries: '0' },
        replies: [
          { label: 'answer', text: 'Answer.' },
          { label: 'title-fast-fails', querySource: 'rename_generate_name', streamError: { type: 'api_error', message: 'fast model unavailable', httpStatus: 503 } },
          { label: 'title-parent', querySource: 'rename_generate_name', text: 'Parent model title' },
        ],
      })
      await w.submit('explain the colour wheel')
      return w.finish()
    },
    check: t => expect(aiTitles(t)).toEqual([{ op: 'aiTitle', aiTitle: 'Parent model title' }]),
  },
]

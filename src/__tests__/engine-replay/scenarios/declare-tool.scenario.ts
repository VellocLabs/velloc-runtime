/**
 * A tool declared with only the required fields gets the defaults: it is not
 * read-only and not concurrency-safe (so two calls run one after the other),
 * its own permission check allows, and its input passes validation.
 */
import { expect } from 'vitest'
import type { Scenario } from '../harness/scenario'
import type { Trace } from '../harness/trace'
import { engineWorld } from '../harness/world'
import { endsWith } from './terminals.scenario'

const title = { label: 'title', querySource: 'rename_generate_name', text: 'A title' }
type ToolEvent = { event: string; id?: string; inFlight?: string[] }
const starts = (t: Trace) => (t.toolCalls as ToolEvent[]).filter(e => e.event === 'start')

export const scenarios: Scenario[] = [
  {
    name: 'declared-tool-defaults-run-serially-and-allowed',
    async run() {
      const w = engineWorld({
        tools: [{ name: 'Plain', minimal: true }],
        replies: [
          { label: 'calls', calls: [{ id: 'plain-1', name: 'Plain' }, { id: 'plain-2', name: 'Plain' }] },
          { label: 'done', text: 'Done.' },
          title,
        ],
      })
      await w.submit('use the plain tool twice')
      return w.finish()
    },
    check: t => {
      endsWith('completed')(t)
      expect(starts(t).map(e => e.inFlight)).toEqual([['plain-1'], ['plain-2']])
    },
  },
  {
    name: 'declared-tool-defaults-refused-in-plan-mode',
    async run() {
      const w = engineWorld({
        permissionMode: 'plan',
        tools: [{ name: 'Plain', minimal: true }],
        replies: [{ label: 'calls', calls: [{ id: 'plain-1', name: 'Plain' }] }, { label: 'done', text: 'Planning only.' }, title],
      })
      await w.submit('use the plain tool')
      return w.finish()
    },
    check: t => expect(starts(t)).toEqual([]),
  },
]

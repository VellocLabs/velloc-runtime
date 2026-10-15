/**
 * Model-visible means recorded: a nudge the engine adds between steps is a
 * stored meta row, the same row the next model request carries, and it is
 * there again when the session is read back from the store.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Message } from '../../../runtime/RuntimeTypes'
import { engineWorld, type EngineWorld } from '../harness/world'

const round = (n: number) => ({ label: `round-${n}`, calls: [{ id: `call-${n}`, name: 'Act' }] })

function contentOf(row: Message): string {
  const content = (row as { message?: { content?: unknown } }).message?.content
  return typeof content === 'string' ? content : JSON.stringify(content)
}

describe('nudge rows are recorded', () => {
  let w: EngineWorld | undefined
  afterEach(() => w?.dispose())

  it('stores the budget nudge as a meta row and sends that row to the next request', async () => {
    w = engineWorld({
      config: { isSubAgent: true, maxTurns: 4 },
      tools: [{ name: 'Act' }],
      replies: [round(1), round(2), round(3), { label: 'done', text: 'Done.' }, { label: 'title', querySource: 'rename_generate_name', text: 'A title' }],
    })
    await w.submit('work')
    const trace = await w.finish()

    const reloaded = await w.store.hydrateMessagesForModel()
    const nudges = reloaded.filter((row) => contentOf(row).includes('BUDGET WARNING'))
    expect(nudges).toHaveLength(1)
    const nudge = nudges[0]
    expect((nudge as { isMeta?: boolean }).isMeta).toBe(true)

    // Stored immediately before the reply to the request that carried it.
    const at = reloaded.indexOf(nudge)
    expect(reloaded[at + 1]?.type).toBe('assistant')

    // The request that follows carries exactly this row's text.
    const carrying = trace.modelRequests.flatMap((r, i) => (JSON.stringify(r).includes('BUDGET WARNING') ? [i] : []))
    expect(carrying[0]).toBe(3)
    expect(JSON.stringify(trace.modelRequests[3])).toContain(JSON.stringify(contentOf(nudge)).slice(1, -1))
  })
})

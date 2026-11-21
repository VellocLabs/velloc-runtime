import { describe, expect, it } from 'vitest'
import { makeWorkerAppState } from '../mods/app/workerAppNoun'
import { APP_PATCH_BATCH_MAX, applyAppPatches, checkAppPatches } from '../mods/app/appStateDiff'

type AppNoun = { state: { update(fn: (draft: Record<string, unknown>) => void): Promise<unknown> } }

function runtime(initial: unknown) {
  let value = initial
  const sent: unknown[][] = []
  const call = async (method: string, args: unknown[]): Promise<unknown> => {
    if (method === 'state') return { value }
    if (method === 'publish') {
      const refused = checkAppPatches(args[0])
      if (refused) throw new TypeError(refused)
      sent.push(args[0] as unknown[])
      value = applyAppPatches(value, args[0] as never)
      return { version: sent.length }
    }
    throw new Error(method)
  }
  return { noun: makeWorkerAppState().noun(call) as AppNoun, sent, value: () => value }
}

describe('$.app.state.update with a change wider than one call', () => {
  const rows = (price: string) => Array.from({ length: APP_PATCH_BATCH_MAX + 50 }, (_, i) => ({ id: i, price }))

  it('is published as the whole state, not refused', async () => {
    const app = runtime({ rows: rows('-'), title: 'x' })
    await app.noun.state.update(draft => { draft.rows = rows('$1') })
    expect(app.sent).toHaveLength(1)
    expect(app.sent[0]).toEqual([{ path: '', value: { rows: rows('$1'), title: 'x' } }])
    expect(app.value()).toEqual({ rows: rows('$1'), title: 'x' })
  })

  it('still sends a narrow change as patches', async () => {
    const app = runtime({ rows: rows('-'), title: 'x' })
    await app.noun.state.update(draft => { draft.title = 'y' })
    expect(app.sent).toEqual([[{ path: '/title', value: 'y' }]])
  })
})

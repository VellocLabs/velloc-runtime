/**
 * turn.request's `effort` is the wire word: the engine's `extra-high` tier is
 * raised as `xhigh`, and a hook's `xhigh` is rebuilt at the `extra-high` tier.
 */
import { describe, expect, it } from 'vitest'
import { requestThroughTurnRequest } from '../engine/turn/requestThroughMods'
import type { QueryModelCallParams } from '../engine/turn/modelCallTypes'
import type { TurnRequestInput } from '../mods/turnRequestEvent'

function built() {
  return {
    payload: { systemPrompt: 'sys', messages: [], tools: [] },
    facts: { effectiveModel: 'big', transcriptLength: 0, toolCount: 0 },
    trace: { transcriptLength: 0, toolCount: 0 },
  }
}

function params(thinkingTier: string, answer: (e: TurnRequestInput) => Partial<TurnRequestInput>, seen: TurnRequestInput[]) {
  return {
    thinkingTier,
    modStep: { turnId: 't', index: 0 },
    callContext: {
      cancelSource: new AbortController(),
      options: {
        mods: {
          hasTurnRequestHooks: () => true,
          turnRequest: async (e: TurnRequestInput) => {
            seen.push(e)
            return { ...e, ...answer(e) }
          },
        },
      },
    },
  } as unknown as QueryModelCallParams
}

describe('turn.request — effort', () => {
  it("the engine's extra-high is the event's xhigh, and a hook's xhigh is the extra-high tier", async () => {
    const seen: TurnRequestInput[] = []
    const rebuilt: QueryModelCallParams[] = []
    const rebuild = (p: QueryModelCallParams) => (rebuilt.push(p), built())
    await requestThroughTurnRequest(built(), params('extra-high', () => ({}), seen), rebuild)
    expect(seen[0]!.effort).toBe('xhigh')
    expect(rebuilt).toHaveLength(0)
    await requestThroughTurnRequest(built(), params('medium', () => ({ effort: 'xhigh' }), seen), rebuild)
    expect(rebuilt.map(p => p.thinkingTier)).toEqual(['extra-high'])
  })
})

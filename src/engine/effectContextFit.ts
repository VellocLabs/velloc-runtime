/**
 * Fits the context before a request: the rows after the last compaction
 * boundary in their stored form, then the observation strip, the save of
 * stripped results, and the summarizer. While the summarizer is still busy
 * after one tick, start and end progress events are yielded around it.
 * Answers with the fitted rows, the compaction rows if it compacted, and the
 * updated compaction ledger.
 */
import type { AutoCompactLedger, QueryRuntimeDeps } from '../runtime/interfaces/QueryRuntimeDeps'
import type { Message, StreamEvent } from '../runtime/RuntimeTypes'
import { MSG_TYPE_STREAM_EVENT, STREAM_COMPACT_PROGRESS } from '../runtime/VercelModelConstants'
import { rowsSinceFoldLine } from '../context/compaction/boundary'
import type { TurnEffect } from './turnEffects'
import { mintRows, type EffectRunner } from './turnEnvironment'

type Summary = Awaited<ReturnType<QueryRuntimeDeps['autocompact']>>

function progress(stage: 'start' | 'end'): StreamEvent {
  return { type: MSG_TYPE_STREAM_EVENT, event: { type: STREAM_COMPACT_PROGRESS, stage } }
}

async function* summarizeWithProgress(pending: Promise<Summary>): AsyncGenerator<StreamEvent, Summary> {
  let settled = false
  const watched = pending.finally(() => {
    settled = true
  })
  const first = await Promise.race([
    watched.then(() => 'done' as const),
    new Promise<'busy'>((resolve) => setTimeout(() => resolve('busy'), 0)),
  ])
  const shown = first === 'busy' && !settled
  if (shown) yield progress('start')
  try {
    return await watched
  } finally {
    if (shown) yield progress('end')
  }
}

export const fitContext: EffectRunner<Extract<TurnEffect, { kind: 'summarizeForCompaction' }>> =
  async function* (effect, env, state) {
    const { deps, input } = env
    deps.logEvent('browser_query_iteration_started', {
      querySource: input.turnCaller,
      turnCount: state.k,
      queryChainId: env.chain.chainId,
      queryDepth: env.chain.depth,
    })
    env.ctx = { ...env.ctx, turnChain: env.chain }
    const visible = rowsSinceFoldLine(mintRows(env, effect.messages))
    let rows: Message[] = input.keptRow ? visible.map(input.keptRow) : [...visible]
    let ledger: AutoCompactLedger = effect.autoCompactLedger
      ? { ...effect.autoCompactLedger, turnOrdinal: (effect.autoCompactLedger.turnOrdinal ?? 0) + 1 }
      : { compacted: false, turnId: env.ambient.ids.turn(), turnOrdinal: 1 }

    const stripped = await deps.microcompact(rows, env.ctx, input.turnCaller)
    rows = stripped.messages
    if (stripped.strippedToolCallIds?.size && deps.saveStrippedResults) {
      await deps.saveStrippedResults(stripped.strippedToolCallIds)
    }

    const { compactionResult, failureStreak } = yield* summarizeWithProgress(
      deps.autocompact(
        rows,
        env.ctx,
        {
          baseInstructions: state.baseInstructions,
          userContext: state.userAmbient as { [k: string]: string },
          systemAmbient: state.systemAmbient as { [k: string]: string },
          callContext: env.ctx,
          forkSeedRows: rows,
          // The summarizer's request resolves its model through the provider.
          providerId: input.providerId,
        },
        input.turnCaller,
        ledger,
      ),
    )
    if (compactionResult) {
      ledger = { compacted: true, turnId: env.ambient.ids.turn(), turnOrdinal: 0, failureStreak: 0 }
      return {
        type: 'contextFitted',
        messages: rows,
        compacted: true,
        rows: [compactionResult.boundaryMarker, ...compactionResult.summaryMessages],
        autoCompactLedger: ledger,
        identity: effect.identity,
      }
    }
    if (failureStreak !== undefined) ledger = { ...ledger, failureStreak }
    return { type: 'contextFitted', messages: rows, compacted: false, rows: [], autoCompactLedger: ledger, identity: effect.identity }
  }

/**
 * Runs one tool batch. First the cache-safe request envelope is saved, so a
 * fork started by a tool shares this request's prompt prefix; then every
 * update of the batch is applied to the live call context and its row
 * yielded as it comes. Answers with the rows, the halted calls and what the
 * batch changed on the call context.
 */
import type { Message } from '../runtime/RuntimeTypes'
import { MSG_TYPE_STREAM_EVENT } from '../runtime/VercelModelConstants'
import { runToolBatch } from '../toolkit/run/toolBatchRunner'
import { captureForkPrefix, rememberForkPrefix } from '../agents/forkedRun'
import type { FileStateEntry } from '../runtime/RuntimeTypes'
import type { ToolBatchUpdate, ToolResultDigest, TurnEffect } from './turnEffects'
import { mintRows, type EffectRunner } from './turnEnvironment'
import { resultPartsOf } from './turnRows'

export const runToolBatchEffect: EffectRunner<Extract<TurnEffect, { kind: 'runToolBatch' }>> =
  async function* (effect, env, state) {
    const { deps, input } = env
    const replies = [...effect.replies]
    rememberForkPrefix(
      captureForkPrefix({
        systemPrompt: state.baseInstructions,
        userContext: state.userAmbient as { [k: string]: string },
        systemContext: state.systemAmbient as { [k: string]: string },
        toolUseContext: env.ctx,
        messages: mintRows(env, state.messages),
        // A fork that keeps this model also keeps its provider and effort.
        providerId: input.providerId,
        thinkingTier: input.thinkingTier,
        renderSystemPromptForModel: input.renderSystemPromptForModel,
      }),
      env.ctx.options.runtimeConfig,
    )
    const updates: ToolBatchUpdate[] = []
    const results: ToolResultDigest[] = []
    for await (const update of runToolBatch([...effect.calls], replies, input.decidePermission, env.ctx, deps)) {
      env.ctx = update.newContext
      const row = update.message as Message | undefined
      if (row) {
        yield row
        if ((row as { type?: unknown }).type !== MSG_TYPE_STREAM_EVENT) {
          updates.push({ kind: 'row', message: row })
          for (const part of resultPartsOf(row)) results.push({ toolCallId: part.toolCallId, isError: part.failed })
        }
      }
      if (update.pendingToolUse) updates.push({ kind: 'halt', pending: update.pendingToolUse })
    }
    const ctx = env.ctx
    updates.push({
      kind: 'contextPatch',
      patch: {
        fileReadLedger: new Map(ctx.fileReadLedger as unknown as Iterable<[string, FileStateEntry]>),
        nestedMemoryPathsSeen: new Set(ctx.nestedMemoryPathsSeen ?? []),
        visibleTools: ctx.options.tools,
      },
    })
    return { type: 'toolBatchDone', updates, results, cancelled: false, identity: effect.identity }
  }

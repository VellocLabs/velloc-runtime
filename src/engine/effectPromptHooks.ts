/**
 * Runs the prompt-submit hooks (the settings hooks beneath the extensions'
 * classic event) for the prompt that opened the turn, and answers with the
 * rows they produced: the rejection note when a hook blocked, otherwise the
 * context the hooks added, if any.
 */
import type { Message } from '../runtime/RuntimeTypes'
import { MSG_TYPE_USER } from '../runtime/VercelModelConstants'
import { createGeneratedUserMessage } from '../messages/messageFactories'
import { traceLine } from '../utils/debugLog'
import { firePromptSubmitted } from '../lifecycleHooks/runHooks'
import { buildHookInput } from '../lifecycleHooks/hookInput'
import { runClassicHooks } from '../lifecycleHooks/classicThroughMods'
import { createBashHookCommandRunner } from '../lifecycleHooks/hookCommandRunner'
import { createModelHookPromptRunner } from '../lifecycleHooks/hookPromptRunner'
import { createForkedAgentHookRunner } from '../lifecycleHooks/hookAgentRunner'
import { createNetworkHookHttpRunner } from '../lifecycleHooks/hookHttpRunner'
import type { TurnEffect } from './turnEffects'
import type { EffectRunner } from './turnEnvironment'

/** The text of the newest user row, for hooks that inspect the prompt. A row
 *  whose content has no text part (a tool result) gives undefined. */
export function newestPromptText(messages: readonly Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const row = messages[i]
    if (!row || row.type !== MSG_TYPE_USER) continue
    const content = (row.message as { content?: unknown } | undefined)?.content
    if (typeof content === 'string') return content || undefined
    if (!Array.isArray(content)) return undefined
    const text = content
      .filter(
        (part): part is { type: 'text'; text: string } =>
          !!part && typeof part === 'object' &&
          (part as { type?: unknown }).type === 'text' &&
          typeof (part as { text?: unknown }).text === 'string',
      )
      .map((part) => part.text)
      .join('\n')
    return text || undefined
  }
  return undefined
}

export const runPromptSubmitHooks: EffectRunner<Extract<TurnEffect, { kind: 'runPromptSubmitHooks' }>> =
  async function* (effect, env) {
    const ctx = env.ctx
    const sessionId = ctx.options.sessionId
    const signal = ctx.cancelSource.signal
    const hookInput = {
      cwd: ctx.options.cwd,
      projectRoot: ctx.options.projectRoot,
      permissionMode: ctx.readAppState().permissionRules?.mode,
      prompt: newestPromptText(effect.prompt),
    }
    const outcome = await runClassicHooks(
      ctx.options.mods,
      'UserPromptSubmit',
      () =>
        buildHookInput({
          event: 'UserPromptSubmit',
          sessionId: sessionId as string,
          cwd: hookInput.cwd,
          permissionMode: hookInput.permissionMode,
          prompt: hookInput.prompt,
        }),
      () =>
        firePromptSubmitted({
          sessionId: sessionId as string,
          appState: ctx.readAppState(),
          setAppState: ctx.writeAppState,
          signal,
          commandRunner: createBashHookCommandRunner(ctx),
          promptRunner: createModelHookPromptRunner(ctx),
          agentRunner: createForkedAgentHookRunner(ctx),
          httpRunner: createNetworkHookHttpRunner(ctx),
          hookInput,
        }),
      signal,
    )
    if (outcome.blocked) {
      const reason = outcome.errors.length > 0
        ? outcome.errors.join('\n')
        : 'Prompt rejected by a UserPromptSubmit hook.'
      traceLine(`[turn] prompt refused by a submit hook: sid=${sessionId ?? '?'} ${reason}`, { level: 'info' })
      return {
        type: 'promptSubmitHooksDone',
        blocked: true,
        rows: [createGeneratedUserMessage(`[UserPromptSubmit hook]: ${reason}`, { isMeta: true })],
        identity: effect.identity,
      }
    }
    const added = [...outcome.additionalContext, ...outcome.systemMessages]
    const rows = added.length > 0 ? [createGeneratedUserMessage(added.join('\n\n'), { isMeta: true })] : []
    return { type: 'promptSubmitHooksDone', blocked: false, rows, identity: effect.identity }
  }

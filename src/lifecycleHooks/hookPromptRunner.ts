/**
 * Hook prompt runner: a one-shot, tool-less, non-streaming fast-model
 * evaluation via `queryFastModel` and the context's `options.callModel`. A
 * hook's `model:` overrides the per-provider fast model.
 */
import { queryFastModel } from '../models/fastModelCall'
import type { ToolCallContext } from '../toolkit/toolCallContext'

export type HookPromptRunnerInput = {
  /** Full user prompt — the hook's `prompt` with the hook-input JSON
   *  substituted in. */
  prompt: string
  /** Eval system prompt — the `{ok}` / `{ok, reason}` response contract. */
  systemPrompt: readonly string[]
  /** The hook's declared `model:`, if any. Overrides the provider fast model. */
  model?: string
  signal: AbortSignal
}

/** Returns the model's plain-text response (expected to be JSON). */
export type HookPromptRunner = (input: HookPromptRunnerInput) => Promise<string>

/**
 * Build a prompt runner backed by `queryFastModel`. Always returns a runner;
 * if the fast-model handle was never initialised (boot-order bug, or a runtime
 * with no model bridge), `queryFastModel` throws and the executor surfaces it
 * as a non-blocking error rather than blocking the operation.
 */
export function createModelHookPromptRunner(
  context: ToolCallContext,
): HookPromptRunner {
  return async (input: HookPromptRunnerInput): Promise<string> => {
    return queryFastModel({
      userPrompt: input.prompt,
      systemPrompt: input.systemPrompt,
      signal: input.signal,
      toolUseContext: context,
      providerId: context.options.mainLoopProviderId ?? '',
      querySource: 'fast_model_call',
      model: input.model,
    })
  }
}

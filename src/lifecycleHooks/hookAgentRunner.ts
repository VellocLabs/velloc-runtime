/**
 * Hook agent runner: an `agent` hook's multi-turn verifier, run with
 * `launchFork` on the parent's cache-safe params under a verifier prompt and a
 * small turn budget. Without cache-safe params it throws (a non-blocking error).
 * Security: allow-all gate bounded by the read-only `VERIFIER_ALLOWED_TOOLS`.
 */
import type { PermissionDecider } from '../toolkit/permissionVerdict'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import {
  recallForkPrefix,
  launchFork,
  type ChildContextOptions,
} from '../agents/forkedRun'
import {
  getModelForSessionType,
  getSessionModelPolicyFor,
} from '../engine/contextWindow'
import { getContextSidechainStore } from '../utils/sidechainTranscripts'
import { createGeneratedUserMessage } from '../messages/messageFactories'
import { extractFinalAssistantText } from '../utils/extractForkText'
import { READ_TOOL_ID } from '../prompting/fileToolNames'
import { FIND_FILES_TOOL_ID, SEARCH_TEXT_TOOL_ID } from '../prompting/processToolNames'

export type HookAgentRunnerInput = {
  /** Full user prompt — the hook's `prompt` with the hook-input JSON
   *  substituted in. */
  prompt: string
  /** Verifier system prompt — the `{ok}` / `{ok, reason}` response contract. */
  systemPrompt: string
  /** The hook's declared `model:`, if any. Overrides the fork's model. */
  model?: string
  signal: AbortSignal
}

/** Returns the verifier fork's final assistant text (expected to be JSON). */
export type HookAgentRunner = (input: HookAgentRunnerInput) => Promise<string>

/** Allow-all gate for the verifier fork — bounded by the read-only tool
 *  allowlist below, so "allow all" only ever permits inspection tools. */
const ALLOW_ALL_CAN_USE_TOOL: PermissionDecider = (async () => ({
  behavior: 'allow' as const,
  updatedInput: {},
})) as PermissionDecider

/**
 * Security: tools the verifier fork may use, read-only inspection only: it runs
 * automatically with an allow-all gate and must not mutate state.
 */
const VERIFIER_ALLOWED_TOOLS = new Set<string>([
  READ_TOOL_ID,
  FIND_FILES_TOOL_ID,
  SEARCH_TEXT_TOOL_ID,
])

/** Verifier turn cap. */
const MAX_AGENT_HOOK_TURNS = 50

/**
 * Build an agent-hook runner backed by `launchFork`. Always returns a
 * runner; if no cache-safe params are available when it fires, it throws and
 * the executor maps that to a non-blocking error (never a block).
 */
export function createForkedAgentHookRunner(
  context: ToolCallContext,
): HookAgentRunner {
  return async (input: HookAgentRunnerInput): Promise<string> => {
    // THIS runtime's snapshot (keyed by the context's `runtimeConfig`).
    const forkPrefix = recallForkPrefix(context.options.runtimeConfig)
    if (!forkPrefix) {
      throw new Error(
        'agent hook could not start: no cache-safe params captured for this turn',
      )
    }

    // Sub-session model policy (Settings → Session models): a HARD user
    // route (`specific`/`same-as-parent`/`tier`) beats the hook's declared
    // `model:`; `default`/absent honors it — the feature's own assignment.
    const baseOptions = forkPrefix.toolUseContext.options
    const policy = getSessionModelPolicyFor('hook_agent')
    const usePolicy = policy !== undefined && policy.mode !== 'default'
    const modelLadder = usePolicy
      ? getModelForSessionType(
          'hook_agent',
          baseOptions.mainLoopProviderId ?? '',
          baseOptions.mainLoopModel,
        )
      : undefined

    // Restrict the verifier to read-only inspection tools, and optionally
    // swap the model. Always builds an options override (the tool filter is
    // mandatory; the model swap is conditional — policy routes ride
    // `modelLadder` instead so they get the window gate + retry-once).
    const overrides: ChildContextOptions = {
      options: {
        ...baseOptions,
        tools: baseOptions.tools.filter(tool =>
          VERIFIER_ALLOWED_TOOLS.has(tool.name),
        ),
        ...(!usePolicy && input.model ? { mainLoopModel: input.model } : {}),
      },
    }

    const forkPrompt = createGeneratedUserMessage(input.prompt, { isMeta: false })

    const forkResult = await launchFork({
      openingRows: [forkPrompt],
      forkPrefix,
      canUseTool: ALLOW_ALL_CAN_USE_TOOL,
      modelLadder,
      querySource: 'hook_agent',
      forkLabel: 'hook_agent',
      maxTurns: MAX_AGENT_HOOK_TURNS,
      overrides,
      systemPromptOverride: input.systemPrompt,
      // Foreground fork: the verifier's verdict must come from the real model.
      useRealModelTransport: true,
      sidechainStore: getContextSidechainStore(context),
      spawnerSessionId: context.options.sessionId || undefined,
    })

    return extractFinalAssistantText(forkResult.messages)
  }
}

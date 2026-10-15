import type { PermissionDecider } from '../permissionVerdict'
import type { ToolContract, InputCheck } from '../toolContract'
import type { ToolCallContext } from '../toolCallContext'
import { ENGINE_PROVIDER } from '../../mods/agentEvents'
import {
  agentOfferedThroughMods,
  agentSpawnThroughMods,
  offeredAgentsThroughMods,
} from '../../agents/agentEventsThroughMods'
import { declareTool } from '../toolContract'
import { filterSubAgentTools } from '../../agents/subAgentToolScope'
import { withoutBlockedAgents } from '../../permissions/ruleEngine'
import type {
  AgentProfile,
  Message,
  InstructionText,
} from '../../runtime/RuntimeTypes'
import { getSubAgentSpawner } from '../../team/subAgentSpawner'
import { getSubAgentController } from '../../team/subAgentController'
import { routineOriginIdOf } from '../../routines/routineOrigin'
import type { ChildContextOptions } from '../../agents/forkedRun'
import { FORK_ROUTE_KIND } from './subagentFork'
import { isInternalUser } from '../../utils/internalUser'
import {
  createSidechainAgentId,
  getContextSidechainStore,
} from '../../utils/sidechainTranscripts'
import { mainRepoRoot } from '../../utils/gitInfo'
import { fsForContext } from '../../utils/fs/runtimeFs'
import {
  getBalancedModel,
  topTierModel,
  getFastModel,
  getSessionModelPolicyFor,
  getAutoTierModel,
  type SubagentModelTier,
  type TierModelCandidate,
} from '../../engine/contextWindow'
import { getModelTierPin } from '../../models/tierSettingsSnapshot'
import {
  openAgentCheckout,
  worktreeHasChanges,
  closeAgentCheckout,
} from '../../utils/agentWorktree'

export const SPAWN_TOOL_ID = 'Agent'

// How long a foreground named agent may run before the call hands back a task id.
const SUBAGENT_FOREGROUND_BUDGET_MS = 120_000

export type SpawnArgs = {
  description?: string
  prompt?: string
  subagent_type?: string
  model?: SubagentModelTier
  run_in_background?: boolean
  isolation?: 'worktree'
}

export type AgentToolOutput = string

// Loose view of an agent definition for the tool description; fields are unchecked.
type AgentListEntry = {
  name?: unknown
  description?: unknown
  tools?: unknown
  disallowedTools?: unknown
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

// Summarises an agent's tool access from its allow and deny lists.
function describeAgentTools(agent: AgentListEntry): string {
  const tools = stringList(agent.tools)
  const disallowed = stringList(agent.disallowedTools)
  const hasAllow = tools.length > 0
  const hasDeny = disallowed.length > 0
  if (hasAllow && hasDeny) {
    const denySet = new Set(disallowed)
    const effective = tools.filter(name => !denySet.has(name))
    return effective.length > 0 ? effective.join(', ') : 'None'
  }
  if (hasAllow) return tools.join(', ')
  if (hasDeny) return `All tools except ${disallowed.join(', ')}`
  return 'All tools'
}

function agentSummaryLine(agent: AgentListEntry): string {
  const name = typeof agent.name === 'string' ? agent.name : 'unknown'
  const description =
    typeof agent.description === 'string' ? agent.description : ''
  return `- ${name}: ${description} (Tools: ${describeAgentTools(agent)})`
}

// Model-facing description of the Agent tool, listing the agent types offered.
function buildAgentToolPrompt(agents: readonly AgentProfile[]): string {
  const agentListSection =
    agents.length > 0
      ? `
Available agent types and the tools they have access to:
${agents.map(agent => agentSummaryLine(agent as AgentListEntry)).join('\n')}
`
      : ''

  return `Launch a sub-agent to handle research or multi-step work whose intermediate tool output isn't worth keeping in your context.

By DEFAULT the sub-agent runs **synchronously**: it runs in this turn and returns a single summary as the tool result — so you get its answer back inline and can act on it immediately. Its raw tool calls and search output stay out of your main conversation.

Choosing \`subagent_type\`:
- **Leave it unset** for the general-purpose agent: a new agent with its own system prompt and every tool, and no memory of this conversation. Its prompt has to carry everything it needs.
- **Name one of the agents below** (\`Explore\`, \`Plan\`, …) for that specialist; it starts from scratch in the same way, so brief it fully.
- **Pass \`"fork"\`** to split off a copy of yourself: it keeps your whole conversation, system prompt, tools and prompt cache, so its prompt is an instruction, not a briefing. Fork when the job depends on what you already know; use a fresh agent for work that stands on its own.
${agentListSection}
Pick a model tier for the sub-agent with \`model\`:
- \`"fast"\` — fast and efficient for simple, mechanical tasks: exact lookups, file/symbol finding, extraction, short summaries.
- \`"balanced"\` — balanced performance, right for most sub-agents: typical research, multi-file surveys, routine implementation.
- \`"best"\` — most capable, for complex reasoning: hard debugging, design/architecture review, adversarial verification.
The tier resolves against your provider and takes precedence over the agent's own model setting; omit \`model\` to use the agent's setting, or inherit your model. Don't set \`model\` on a \`subagent_type: "fork"\` — forks are cheap because they share your prompt cache, and a different model can't reuse it (the parameter is ignored there).

Run it in the BACKGROUND with \`run_in_background: true\` when you do NOT need the answer this turn — e.g. long-running work, or parallel fan-out. A background sub-agent runs in its own isolated session (fresh context, write a self-contained prompt) and its result is delivered to you in a LATER turn as a system message (a \`<task-notification>\` carrying its task id + status + summary); this call returns immediately with a task id. \`isolation: "worktree"\` (its own git checkout for parallel file-mutating work) implies background. While a background sub-agent runs you can read its status/output with \`TaskOutput\`, stop it with \`TaskStop\`, and after it finishes continue it (context preserved) with \`AgentResume\` — all keyed by the task id from this call; \`AgentList\` enumerates the background sub-agents you've launched.

When to use a sub-agent:
- **Research**: open-ended questions that may require many Grep/Read/WebFetch calls. The sub-agent returns the answer; you never see the raw search noise.
- **Implementation surveys**: "what changed on this branch", "which files use API X", "is feature Y wired up end-to-end".
- **Independent checks**: a second-opinion review of work you just did, where you want a fresh-eyed analysis without your own reasoning in the loop.

When NOT to use a sub-agent:
- Single-file edits or reads — just do them directly.
- Tasks where you need the intermediate tool output (you want every file that matched, not a summary).
- Conversational responses to the user.

Writing the prompt:
Be specific about scope: what's in, what's out, what success looks like.
- State the task and the success criterion ("Report a punch list — done vs. missing. Under 200 words.").
- A \`subagent_type: "fork"\` already has your context — its prompt is a directive. Omitting \`subagent_type\` (general-purpose) or naming a specialist starts WITHOUT your context, so make those prompts self-contained (state the situation AND the task, with paths/constraints).
- If you want a short response, say so explicitly.
- For lookups, give the exact command. For investigations, give the question — prescribed steps become dead weight if the premise is wrong.

**Keep the understanding on your side.** A prompt such as "fix the bug once you know the cause" or "implement what the research suggests" hands the agent the judgement that was yours to make. Ask it for findings; you decide what they mean.

Also:
- Give every launch a \`description\` of three to five words; the user sees it while the agent runs.
- A synchronous agent's summary comes back as this call's result. A background agent's arrives in a later turn, after the task id this call returns. Either way the initial completed result is one summary, so ask for what you need in it rather than counting on a follow-up.
- Independent agents can run together: put several Agent calls in one reply. Background calls return at once; synchronous calls in the same reply are started together.
- Nothing an agent returns is shown to the user automatically. Relay what matters in your own message.

Example:

<example>
user: "Which of our API routes still have no rate limit?"
assistant: <thinking>A survey across the routes directory; I want the list, not the grep output, and I need it now.</thinking>
Agent({
  description: "Rate-limit coverage survey",
  subagent_type: "general-purpose",
  prompt: "In the repo at <path>, list every route under src/api that is registered without the rateLimit middleware. Give file and route path for each, nothing else. Under 150 words."
})
</example>
`
}

// Outcome of mapping a requested tier (or the session model policy) to a model.
export type TierResolution =
  | { kind: 'none' }
  | { kind: 'parent'; note?: string }
  | {
      kind: 'resolved'
      modelId: string
      providerId: string
      thinkingTier?: string
      note?: string
    }
  | { kind: 'failed'; note: string }

// Picks the model for a named sub-agent. A session-wide policy wins over the
// requested tier; an unknown or unconfigured tier falls back to the parent
// model and carries a note explaining why.
export function resolveModelTier(
  tier: string | undefined,
  parentProviderId: string | undefined,
  parentModelId: string,
): TierResolution {
  const policy = getSessionModelPolicyFor('agent_tool')
  if (policy?.mode === 'same-as-parent') {
    return {
      kind: 'parent',
      ...(tier
        ? {
            note: `model tier "${tier}" was overridden by the user's session-model policy (same as parent); the sub-agent runs the parent model`,
          }
        : {}),
    }
  }
  if (policy?.mode === 'specific') {
    const overriddenNote = tier
      ? {
          note: `model tier "${tier}" was overridden by the user's session-model policy (${policy.providerId}/${policy.modelId})`,
        }
      : {}
    if (
      policy.providerId === parentProviderId &&
      policy.modelId === parentModelId
    ) {
      return { kind: 'parent', ...overriddenNote }
    }
    return {
      kind: 'resolved',
      modelId: policy.modelId,
      providerId: policy.providerId,
      ...(policy.thinkingTier ? { thinkingTier: policy.thinkingTier } : {}),
      ...overriddenNote,
    }
  }
  const effectiveTier =
    tier ?? (policy?.mode === 'tier' ? policy.tier : undefined)

  if (!effectiveTier) return { kind: 'none' }
  if (
    effectiveTier !== 'fast' &&
    effectiveTier !== 'balanced' &&
    effectiveTier !== 'best'
  ) {
    return {
      kind: 'failed',
      note: `model tier "${effectiveTier}" is not recognized (expected "fast", "balanced", or "best"); the sub-agent inherits the parent model`,
    }
  }
  if (!parentProviderId) {
    return {
      kind: 'failed',
      note: `model tier "${effectiveTier}" could not be resolved (no active provider id); the sub-agent inherits the parent model`,
    }
  }
  const helper =
    effectiveTier === 'fast'
      ? getFastModel
      : effectiveTier === 'balanced'
        ? getBalancedModel
        : topTierModel
  const candidate = helper(parentProviderId, parentModelId, 'agent_tool')[0]
  const sameModel =
    candidate.modelId === parentModelId &&
    candidate.providerId === parentProviderId
  if (
    !getModelTierPin(effectiveTier) &&
    !getAutoTierModel(parentProviderId, parentModelId, effectiveTier) &&
    !(sameModel && candidate.thinkingTier)
  ) {
    return {
      kind: 'failed',
      note: `model tier "${effectiveTier}" is not configured for provider "${parentProviderId}"; the sub-agent inherits the parent model`,
    }
  }
  if (sameModel && !candidate.thinkingTier) {
    return { kind: 'parent' }
  }
  return {
    kind: 'resolved',
    modelId: candidate.modelId,
    providerId: candidate.providerId,
    ...(candidate.thinkingTier ? { thinkingTier: candidate.thinkingTier } : {}),
  }
}

// Finds the id of the Agent tool call that triggered this run, preferring the
// call whose arguments match the input. Empty string when it cannot tell.
function agentToolUseIdOf(invokingRow: unknown, input: SpawnArgs): string {
  const message = (invokingRow as { message?: { content?: unknown } } | undefined)?.message
  const parts = Array.isArray(message?.content) ? (message!.content as unknown[]) : []
  const calls = parts.filter(
    (part): part is { toolCallId?: string; toolName?: string; args?: unknown } =>
      typeof part === 'object' &&
      part !== null &&
      ((part as { type?: string }).type === 'tool-call' || (part as { type?: string }).type === 'tool_use') &&
      ((part as { toolName?: string }).toolName ?? (part as { name?: string }).name) === SPAWN_TOOL_ID,
  )
  const same = calls.find(call => JSON.stringify(call.args) === JSON.stringify(input))
  const chosen = same ?? (calls.length === 1 ? calls[0] : undefined)
  return typeof chosen?.toolCallId === 'string' ? chosen.toolCallId : ''
}

export const SpawnAgentTool: ToolContract<SpawnArgs, AgentToolOutput> = declareTool({
  name: SPAWN_TOOL_ID,
  discoveryHint: 'launch a sub-agent for research or multi-step work',
  argsSchema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description:
          'A short (3-5 word) description of the task. Shown to the user while the sub-agent runs.',
      },
      prompt: {
        type: 'string',
        description:
          'The task for the sub-agent. A `subagent_type: "fork"` inherits your conversation, so write a directive. Omitting subagent_type (general-purpose) or naming a specialist starts WITHOUT your context, so write a self-contained briefing — state the situation AND the task, with any paths/constraints. Specify scope and success criteria explicitly.',
      },
      run_in_background: {
        type: 'boolean',
        description:
          'Run the sub-agent in the BACKGROUND instead of synchronously: the tool returns immediately and the result is delivered in a LATER turn. Default false = synchronous (returns the summary inline this turn). Whether the sub-agent inherits your context is controlled by `subagent_type` (only "fork" inherits) — NOT by this flag. Use background for long work or parallel fan-out where you do not need the answer now.',
      },
      isolation: {
        type: 'string',
        enum: ['worktree'],
        description:
          'Run the sub-agent in its own git worktree (a separate checkout off the project\'s git HEAD) so several parallel file-mutating sub-agents do not clobber each other. Implies run_in_background. Takes effect only when the project is a git repo; otherwise the sub-agent shares the working tree.',
      },
      subagent_type: {
        type: 'string',
        description:
          'Which sub-agent to run. Omit → the general-purpose agent (ISOLATED: its own system prompt + full tools, none of your context). A registered agent name (e.g. "Explore", "Plan") → that specialist (also isolated). "fork" → fork yourself: the sub-agent inherits your full conversation, system prompt, and tools, and shares your prompt cache. "fork" is reserved for this.',
      },
      model: {
        type: 'string',
        enum: ['fast', 'balanced', 'best'],
        description:
          'Optional model tier for this sub-agent, resolved against the parent session\'s provider. "fast": fast and efficient for simple, mechanical tasks — exact lookups, extraction, short summaries. "balanced": balanced performance, right for most sub-agents — typical research, multi-file surveys, routine implementation. "best": most capable, for complex reasoning — hard debugging, design review, adversarial verification. Takes precedence over the agent definition\'s model. If omitted, uses the agent definition\'s model, or inherits the parent\'s model; a tier not configured for the current provider also inherits the parent\'s model. Ignored for subagent_type "fork" (a different model cannot reuse your prompt cache).',
      },
    },
    required: ['description', 'prompt'],
  },
  description: async (_input, options) =>
    buildAgentToolPrompt(
      await offeredAgentsThroughMods(
        options?.mods,
        withoutBlockedAgents(options?.agents ?? [], options?.permissionRules),
      ),
    ),
  parallelSafe: () => true,
  readsOnly: () => true,
  async checkInput(
    input: SpawnArgs,
    _context: ToolCallContext,
  ): Promise<InputCheck> {
    if (typeof input.description !== 'string' || input.description.trim().length === 0) {
      return {
        result: false,
        message: 'description is required and must be a non-empty string.',
        errorCode: 1,
      }
    }
    if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
      return {
        result: false,
        message: 'prompt is required and must be a non-empty string.',
        errorCode: 2,
      }
    }
    return { result: true }
  },
  async call(
    rawInput: SpawnArgs,
    context: ToolCallContext,
    canUseTool: PermissionDecider,
    invokingRow?: unknown,
  ) {
    // Nested spawning is limited to internal users.
    let input = rawInput
    if (
      !isInternalUser()
      && (context.agentId !== undefined
        || (context.options.sessionId ?? '').startsWith('subagent-')
        || (context.options.sessionId ?? '').startsWith('teammate-'))
    ) {
      return {
        data:
          'Agent spawning is not available inside a sub-agent. Complete the '
          + 'task directly using your tools.',
      }
    }
    const spawn = getSubAgentSpawner()
    const { resolveSubagentRoute } = await import('../../agents/builtInAgents')

    // Let mods inspect, rewrite or veto the spawn before any work starts; their
    // result replaces the input below.
    {
      const preRoute = resolveSubagentRoute(
        input.subagent_type,
        context.options.agentDefinitions.enabledAgents,
        { depth: context.turnChain?.depth },
      )
      if (preRoute.kind === 'error') {
        return { data: preRoute.message }
      }
      const mods = context.options.mods
      if (preRoute.kind === 'named' && !(await agentOfferedThroughMods(mods, preRoute.agent))) {
        return {
          data: `Agent could not start: the agent type "${preRoute.agent.name}" is not offered in this session.`,
        }
      }
      const modelFor = (requested: string | undefined, route: ReturnType<typeof resolveSubagentRoute>): string => {
        if (route.kind !== 'named') return context.options.mainLoopModel
        const tier = resolveModelTier(requested, context.options.mainLoopProviderId, context.options.mainLoopModel)
        if (tier.kind === 'resolved') return tier.modelId
        if (tier.kind === 'none') return route.agent.model ?? context.options.mainLoopModel
        return context.options.mainLoopModel
      }
      const spawnedType = preRoute.kind === 'fork' ? FORK_ROUTE_KIND : (preRoute.agent.name ?? '')
      const settled = await agentSpawnThroughMods(
        mods,
        {
          tool_use_id: agentToolUseIdOf(invokingRow, input),
          prompt: input.prompt ?? '',
          description: input.description ?? '',
          subagentType: spawnedType,
          provider: ENGINE_PROVIDER,
          ...(input.model !== undefined ? { model: input.model } : {}),
          parentModel: context.options.mainLoopModel,
          ...(context.agentId !== undefined ? { parentAgentId: context.agentId } : {}),
          ...(context.readAppState().permissionRules?.mode !== undefined
            ? { permissionMode: context.readAppState().permissionRules.mode }
            : {}),
          background: input.run_in_background === true || input.isolation === 'worktree',
          fork: preRoute.kind === 'fork',
        },
        e => ({
          model: modelFor(
            e.model,
            resolveSubagentRoute(e.subagentType, context.options.agentDefinitions.enabledAgents, {
              depth: context.turnChain?.depth,
            }),
          ),
        }),
        context.cancelSource.signal,
      )
      if ('deny' in settled) {
        return { data: `Agent could not start: ${settled.deny}` }
      }
      if (settled.subagentType !== spawnedType) {
        const rewritten = settled.subagentType || 'general-purpose'
        if (
          withoutBlockedAgents([{ name: rewritten }], context.readAppState().permissionRules).length === 0
        ) {
          return {
            data: `Agent could not start: the agent type "${rewritten}" is denied by a permission rule.`,
          }
        }
      }
      input = {
        ...input,
        prompt: settled.prompt,
        description: settled.description,
        subagent_type: settled.subagentType,
        ...(settled.model !== undefined ? { model: settled.model as SpawnArgs['model'] } : {}),
        run_in_background: settled.background,
      }
    }
    // Route the (possibly rewritten) request and resolve its model tier.
    const runInBackground =
      input.run_in_background === true || input.isolation === 'worktree'
    const route = resolveSubagentRoute(
      input.subagent_type,
      context.options.agentDefinitions.enabledAgents,
      { depth: context.turnChain?.depth },
    )
    if (route.kind === 'error') {
      return { data: route.message }
    }
    const tierResolution: TierResolution =
      route.kind === 'named'
        ? resolveModelTier(
            input.model,
            context.options.mainLoopProviderId,
            context.options.mainLoopModel,
          )
        : { kind: 'none' }
    if (tierResolution.kind === 'failed') {
      console.warn('[SpawnAgentTool] %s', tierResolution.note)
    }
    const tierNote =
      tierResolution.kind !== 'none' ? tierResolution.note : undefined
    const modelNoteSuffix = tierNote ? `\n\n[model note: ${tierNote}]` : ''
    // Named foreground agents go through the session spawner so they can be
    // waited on and, if slow, left running as a background task.
    const useMiddleLayer = route.kind === 'named' && !runInBackground && !!spawn

    // Runs the sub-agent within this turn and returns its final text.
    const runInlineSubAgent = async (): Promise<{ data: string }> => {
      const [
        { recallForkPrefix, launchFork },
        { createGeneratedUserMessage },
        { extractFinalAssistantText },
      ] = await Promise.all([
        import('../../agents/forkedRun'),
        import('../../messages/messageFactories'),
        import('../../utils/extractForkText'),
      ])

      const forkPrefix = recallForkPrefix(context.options.runtimeConfig)
      if (!forkPrefix) {
        return {
          data:
            'Agent could not start: the runtime has not captured cache-safe parameters for this turn. Perform the task directly with the available tools instead.',
        }
      }

      const forkPrompt = createGeneratedUserMessage(input.prompt ?? '', {
        isMeta: false,
      })

      let overrides: ChildContextOptions | undefined
      let systemPromptOverride: InstructionText | undefined
      const omitParentContext = route.kind === 'named'
      if (route.kind === 'named') {
        const agent = route.agent
        systemPromptOverride = agent.systemPrompt
        const baseOptions = forkPrefix.toolUseContext.options
        const tools = filterSubAgentTools(
          baseOptions.tools,
          agent.tools,
          agent.disallowedTools,
        )
        overrides = {
          options: {
            ...baseOptions,
            tools,
            mainLoopModel:
              tierResolution.kind === 'none'
                ? (agent.model ?? baseOptions.mainLoopModel)
                : baseOptions.mainLoopModel,
          },
        }
      }
      const resolvedAgentType =
        route.kind === 'fork' ? FORK_ROUTE_KIND : route.agent.name

      const inlineResolvedModel: TierModelCandidate[] | undefined =
        tierResolution.kind === 'resolved'
          ? [
              {
                providerId: tierResolution.providerId,
                modelId: tierResolution.modelId,
                ...(tierResolution.thinkingTier
                  ? { thinkingTier: tierResolution.thinkingTier }
                  : {}),
              },
              {
                providerId: context.options.mainLoopProviderId ?? '',
                modelId: context.options.mainLoopModel,
              },
            ]
          : undefined

      let forkResult
      try {
        forkResult = await launchFork({
          openingRows: [forkPrompt],
          forkPrefix,
          canUseTool,
          modelLadder: inlineResolvedModel,
          querySource: 'agent_tool',
          forkLabel: resolvedAgentType ?? input.description ?? SPAWN_TOOL_ID,
          agentType: resolvedAgentType,
          description: input.description,
          maxTurns: 25,
          overrides,
          systemPromptOverride,
          omitParentContext,
          useRealModelTransport: true,
          sidechainStore: getContextSidechainStore(context),
          spawnerSessionId: context.options.sessionId || undefined,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { data: `Agent fork failed: ${message}` }
      }

      return { data: extractFinalAssistantText(forkResult.messages) + modelNoteSuffix }
    }

    // Everything else becomes a separate sub-agent session.
    if (!runInBackground && !useMiddleLayer) {
      return runInlineSubAgent()
    }

    if (!spawn) {
      return {
        data:
          'Sub-agent spawn unavailable: no active session manager (not running inside the SharedWorker runtime). Perform the task directly with the available tools instead.',
      }
    }

    let systemPrompt: string | undefined
    let model: string | undefined
    let modelProviderId: string | undefined
    let modelThinkingTier: string | undefined
    let allowTools: string[] | undefined
    let disallowTools: string[] | undefined
    let forkSeedMessages: Message[] | undefined
    let forkExactTools: boolean | undefined
    if (route.kind === 'named') {
      const agent = route.agent
      systemPrompt = agent.systemPrompt
      if (tierResolution.kind === 'resolved') {
        model = tierResolution.modelId
        modelProviderId = tierResolution.providerId
        modelThinkingTier = tierResolution.thinkingTier
      } else if (tierResolution.kind === 'none') {
        model = agent.model
      }
      allowTools = agent.tools
      disallowTools = agent.disallowedTools
    // Fork: seed the new session with the parent's conversation and tools.
    } else {
      const { recallForkPrefix } = await import('../../agents/forkedRun')
      const forkPrefix = recallForkPrefix(context.options.runtimeConfig)
      if (!forkPrefix) {
        return {
          data:
            'Agent could not start: the runtime has not captured cache-safe parameters for this turn. Perform the task directly with the available tools instead.',
        }
      }
      forkSeedMessages = forkPrefix.forkSeedRows
      forkExactTools = true
      model = forkPrefix.toolUseContext.options.mainLoopModel
    }
    const resolvedAgentType =
      route.kind === 'fork' ? FORK_ROUTE_KIND : route.agent.name

    let projectRootOverride: string | undefined
    let cwdOverride: string | undefined
    let onCleanup: (() => void | Promise<void>) | undefined
    // Worktree isolation is best effort: without a git repo, or on any failure,
    // the sub-agent shares the working tree. A worktree with no changes is
    // removed once the sub-agent finishes.
    if (input.isolation === 'worktree') {
      try {
        const repoRoot = await mainRepoRoot(
          context.options.projectRoot,
          fsForContext(context),
        )
        if (repoRoot) {
          const wtAgentId = createSidechainAgentId(
            input.subagent_type ?? input.description ?? SPAWN_TOOL_ID,
          )
          const worktree = await openAgentCheckout(context, repoRoot, wtAgentId)
          if (worktree) {
            projectRootOverride = repoRoot
            cwdOverride = worktree.checkoutDir
            onCleanup = async () => {
              try {
                const changed = await worktreeHasChanges(context, worktree)
                if (!changed) await closeAgentCheckout(context, repoRoot, worktree)
              } catch {
                // leave the worktree in place
              }
            }
          }
        }
      } catch {
        // fall back to the shared working tree
      }
    }

    const spawnerSessionId = context.options.sessionId
    if (!spawnerSessionId) {
      return {
        data:
          'Sub-agent spawn could not start: this turn has no session id. Perform the task directly with the available tools instead.',
      }
    }

    const sessionId = spawn({
      spawnerSessionId,
      prompt: input.prompt ?? '',
      description: input.description ?? '',
      agentType: resolvedAgentType,
      systemPrompt,
      model,
      modelProviderId,
      modelThinkingTier,
      allowTools,
      disallowTools,
      projectRoot: projectRootOverride,
      cwd: cwdOverride,
      onCleanup,
      forkSeedMessages,
      forkExactTools,
      routineOriginId: routineOriginIdOf(context.options),
    })
    // No session was created: release the worktree, and run inline when possible.
    if (!sessionId) {
      await onCleanup?.()
      if (useMiddleLayer) {
        return runInlineSubAgent()
      }
      return {
        data:
          'Sub-agent spawn deferred: the runtime needs at least one active UI session, or the maximum sub-agent nesting depth was reached. Continue with other work, or perform the task directly.',
      }
    }

    // Wait a bounded time for a foreground result; past that it reports as background.
    if (useMiddleLayer) {
      const controller = getSubAgentController()
      if (controller) {
        const snap = await controller.waitForCompletion(
          sessionId,
          SUBAGENT_FOREGROUND_BUDGET_MS,
          context.cancelSource?.signal,
        )
        if (snap && snap.status !== 'running') {
          controller.acknowledgeResult?.(sessionId)
          return { data: `(task id ${sessionId})\n\n${snap.output || '(no output)'}${modelNoteSuffix}` }
        }
      }
    }
    return {
      data:
        `Launched background sub-agent "${input.description}"`
        + (resolvedAgentType ? ` (${resolvedAgentType})` : '')
        + ` (task id ${sessionId}). ${
            route.kind === 'fork'
              ? 'It continues your conversation in the background'
              : 'It runs in its own isolated context'
          } and will`
        + ` report its result to you in a later turn as a system message — you`
        + ` will NOT see it inline. While it runs you can poll it with`
        + ` TaskOutput(task_id:"${sessionId}"), stop it with TaskStop, and after`
        + ` it finishes continue it with AgentResume; AgentList enumerates all`
        + ` your background sub-agents. Continue with other work, launch more`
        + ` sub-agents in parallel, or end your turn.`
        + modelNoteSuffix,
    }
  },
})

import type { ChromiumCommandMetadata } from '../runtime/CommandTypes'
import type { PermissionDecider } from '../toolkit/permissionVerdict'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { toolAnswersTo } from '../toolkit/toolContract'
import { type AgentDefinitionFull, findAgentDefinition } from '../agents/agentRegistry'
import type { AgentProfile, InstructionText } from '../runtime/RuntimeTypes'
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
import { formatSkillInvocationMessage } from './buildSkillBody'
import { createGeneratedUserMessage } from '../messages/messageFactories'
import { extractFinalAssistantText } from '../utils/extractForkText'

/**
 * Resolve a forked skill's `agent:` reference: none → built-in
 * `general-purpose` (never a plugin agent of that name); a plugin skill's bare
 * name → its own plugin's agent first; then an exact name match; unknown →
 * `general-purpose`, never an arbitrary agent.
 */
function resolveForkAgent(
  activeAgents: readonly AgentProfile[],
  command: Pick<ChromiumCommandMetadata, 'agent' | 'pluginName'>,
): AgentDefinitionFull | undefined {
  const explicit = command.agent
  if (explicit === undefined) {
    return findAgentDefinition(activeAgents, 'general-purpose')
  }
  if (command.pluginName && !explicit.includes(':')) {
    const prefix = `${command.pluginName}:`
    const sibling =
      findAgentDefinition(activeAgents, `${prefix}${explicit}`) ??
      // Nested sibling: plugin prefix + the bare name as the LAST segment.
      // Segments are colon-joined and `:` cannot appear inside one, so
      // endsWith matches the whole segment (`:reviewer` ≠ `code-reviewer`).
      findAgentDefinition(
        activeAgents,
        activeAgents.find(
          a => a.name?.startsWith(prefix) && a.name.endsWith(`:${explicit}`),
        )?.name ?? '',
      )
    if (sibling) return sibling
  }
  return (
    findAgentDefinition(activeAgents, explicit) ??
    findAgentDefinition(activeAgents, 'general-purpose')
  )
}

export type ForkedSkillResult = {
  /** The fork's final assistant text — the model/user-facing skill result. */
  text: string
  /** Sidechain agentId for this fork run (log/debug breadcrumb). */
  agentId: string
}

/**
 * Run a `context: 'fork'` skill as a forked sub-agent and return its final
 * assistant text; shared by the model and slash paths. `command.agent` picks
 * the agent (see `resolveForkAgent`). `null` when no cache-safe params were
 * captured for the turn; callers then inject inline.
 */
export async function runSkillInFork(params: {
  command: ChromiumCommandMetadata
  /** Skill body, already arg/dir/shell-expanded by the caller. */
  body: string
  /** Raw args string (for the `<command-args>` metadata tag). The body's
   *  `$ARGUMENTS`/`$1` placeholders are already substituted; this is the
   *  literal arg text for the loading-metadata tags only. */
  args?: string
  context: ToolCallContext
  canUseTool: PermissionDecider
}): Promise<ForkedSkillResult | null> {
  const { command, body, args, context, canUseTool } = params

  // THIS runtime's snapshot (keyed by the context's `runtimeConfig`).
  const forkPrefix = recallForkPrefix(context.options.runtimeConfig)
  if (!forkPrefix) {
    return null
  }

  // Named-agent selection — same shape as SpawnAgentTool's `subagent_type` branch.
  // When the agent resolves, fork with that agent's system prompt, tool
  // allowlist, and model. Resolution (default, plugin-namespace, fallback) is
  // resolveForkAgent's contract — see its doc. With the general-purpose
  // fallback there, the `else if` below is reachable only when the built-in
  // itself isn't registered in `activeAgents` (test-only today).
  let overrides: ChildContextOptions | undefined
  let systemPromptOverride: InstructionText | undefined
  const baseOptions = forkPrefix.toolUseContext.options

  // Sub-session model policy (Settings → Session models): a HARD user route
  // (`specific`/`same-as-parent`/`tier`) beats the skill's own assignment
  // (agent frontmatter model / command `model:`); `default`/absent honors it.
  // Policy routes ride `modelLadder` (window gate + retry-once); the local
  // model assignments below are suppressed so a hard route can't be shadowed.
  const policy = getSessionModelPolicyFor('skill_fork')
  const usePolicy = policy !== undefined && policy.mode !== 'default'
  const modelLadder = usePolicy
    ? getModelForSessionType(
        'skill_fork',
        baseOptions.mainLoopProviderId ?? '',
        baseOptions.mainLoopModel,
      )
    : undefined

  // `model: inherit` in frontmatter means "no own model" — it
  // must never reach the fork as a model literally named "inherit".
  const commandModel =
    command.model && command.model !== 'inherit' ? command.model : undefined

  const agent = resolveForkAgent(
    context.options.agentDefinitions.enabledAgents,
    command,
  )
  if (agent) {
    systemPromptOverride = agent.systemPrompt
    const tools = agent.tools
      ? baseOptions.tools.filter(tool =>
          agent.tools!.some(name => toolAnswersTo(tool, name)),
        )
      : baseOptions.tools
    overrides = {
      options: {
        ...baseOptions,
        tools,
        mainLoopModel: usePolicy
          ? baseOptions.mainLoopModel
          : (agent.model ?? commandModel ?? baseOptions.mainLoopModel),
      },
    }
  } else if (!usePolicy && commandModel) {
    overrides = {
      options: { ...baseOptions, mainLoopModel: commandModel },
    }
  }

  const forkPrompt = createGeneratedUserMessage(
    formatSkillInvocationMessage(command, args, body),
    { isMeta: false },
  )

  const forkResult = await launchFork({
    openingRows: [forkPrompt],
    forkPrefix,
    canUseTool,
    modelLadder,
    querySource: 'skill_fork',
    forkLabel: command.name,
    // Generous cap for a forked skill; matches SpawnAgentTool's order of magnitude.
    maxTurns: 25,
    overrides,
    systemPromptOverride,
    // Foreground fork: the model-facing result is the fork's text, so it must
    // reach the real model (not query()'s placeholder transport).
    useRealModelTransport: true,
    // Persist the fork's transcript through THIS session's store.
    // Unset in tests / mock-host → runs without persistence.
    sidechainStore: getContextSidechainStore(context),
    spawnerSessionId: context.options.sessionId || undefined,
  })

  return {
    text: extractFinalAssistantText(forkResult.messages),
    agentId: forkResult.agentId,
  }
}

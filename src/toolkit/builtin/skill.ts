import type { ChromiumCommandMetadata } from '../../runtime/CommandTypes'
import type { PermissionDecider } from '../permissionVerdict'
import type { ToolContract } from '../toolContract'
import type { ToolCallContext } from '../toolCallContext'
import { declareTool } from '../toolContract'
import { buildSkillBody } from '../../skillLibrary/buildSkillBody'
import { createSkillInvocationMessage } from '../../skillLibrary/skillInvocationMessage'
import { getBundledSkillDynamicContent } from '../../skillLibrary/builtinSkills'
import { expandSkillBodyShell } from '../../skillLibrary/inlineShellExpansion'
import { skillPromptThroughMods } from '../../skillLibrary/skillPromptThroughMods'
import { noteSkillUse } from '../../skillLibrary/invokedSkillsStore'
import { recordSkillInvocationEvent } from '../../skillLibrary/skillInvocationLog'
import { skillBodyDetailId } from '../../skillLibrary/skillInvocationTags'
import { createGeneratedUuid } from '../../messages/messageFactories'
import { runSkillInFork } from '../../skillLibrary/executeForkedSkill'
import {
  findCommandByName,
  isSkillDeniedByTemplate,
  normalizeSkillName,
  skillDeniedMessage,
} from '../../skillLibrary/skillDiscovery'
import { armSkillHooks } from '../../lifecycleHooks/skillHookRegistration'
import {
  activateSkills,
  deferralKeyFromContext,
} from '../run/deferredTools'

// Defined in a leaf module so consumers that need only the name never have to
// import this file — see prompting/skillToolName.ts for why. Re-exported here
// so this module's public surface is unchanged.
export { SKILL_TOOL_NAME } from '../../prompting/skillToolName'
import { SKILL_TOOL_NAME } from '../../prompting/skillToolName'

type SkillToolInput = {
  skill?: string
  args?: string
}

// The model-facing result is "Launching skill: <name>"
// for inline execution. {success, skill, path} was diagnostic-only.
type SkillToolOutput = string

function getSkillCommands(
  commands: readonly ChromiumCommandMetadata[],
): ChromiumCommandMetadata[] {
  return commands.filter(command => command.type === 'prompt')
}

export const SkillRunTool: ToolContract<SkillToolInput, SkillToolOutput> = declareTool({
  name: SKILL_TOOL_NAME,
  discoveryHint: 'execute a local prompt skill',
  argsSchema: {
    type: 'object',
    properties: {
      skill: {
        type: 'string',
        description: 'The name of a skill from the available-skills list. Do not guess names.',
      },
      args: {
        type: 'string',
        description: 'Optional arguments for the skill',
      },
    },
    required: ['skill'],
  },
  // `Execute skill: <name>`, per-call dynamic so hover tooltips / UI surfaces
  // show the specific
  // skill being invoked.
  description: async (input: SkillToolInput) =>
    `Execute skill: ${input.skill ?? ''}`.trimEnd(),
  async checkInput(input: SkillToolInput, context: ToolCallContext) {
    if (typeof input.skill !== 'string') {
      return {
        result: false,
        message: 'skill is required.',
        errorCode: 1,
      }
    }

    // Trim first so whitespace-only inputs fail with an "Invalid skill
    // format" message rather than landing on an opaque "Unknown skill"
    // later.
    const trimmed = input.skill.trim()
    if (!trimmed) {
      return {
        result: false,
        message: `Invalid skill format: ${JSON.stringify(input.skill)}`,
        errorCode: 1,
      }
    }

    // Accept a leading slash for compatibility with users typing `/foo`. A
    // slash anywhere else (e.g. `commit/extra`) is rejected — the model is
    // not allowed to use the SkillRunTool to traverse into arbitrary paths.
    const normalized = trimmed.replace(/^\/+/, '')
    if (normalized.includes('/') || normalized.includes('\\')) {
      return {
        result: false,
        message: `Invalid skill format: ${JSON.stringify(input.skill)}`,
        errorCode: 1,
      }
    }

    const command = findCommandByName(getSkillCommands(context.options.commands), normalized)
    if (!command) {
      return {
        result: false,
        message: isSkillDeniedByTemplate(context, normalized)
          ? skillDeniedMessage(normalized)
          : `Unknown skill: ${normalized}`,
        errorCode: 2,
      }
    }

    if (command.hiddenFromModel) {
      return {
        result: false,
        message: `Skill ${command.name} cannot be used by the model.`,
        errorCode: 3,
      }
    }

    return { result: true }
  },
  call: async (
    input: SkillToolInput,
    context: ToolCallContext,
    canUseTool: PermissionDecider,
  ) => {
    const requested = normalizeSkillName(input.skill ?? '')
    const command = findCommandByName(
      getSkillCommands(context.options.commands),
      requested,
    )
    if (!command) {
      throw new Error(
        isSkillDeniedByTemplate(context, requested)
          ? skillDeniedMessage(requested)
          : `Unknown skill: ${requested}`,
      )
    }

    // Register the skill's frontmatter hooks for the session the moment it is
    // invoked; the user-typed path does the same in
    // `dispatchSkillSlashCommand`. Skipped when the skill declares no hooks.
    if (command.hooks) {
      armSkillHooks({
        setAppState: context.writeAppState,
        sessionId: context.options.sessionId,
        hooks: command.hooks,
        skillRoot: command.baseDir,
      })
    }

    // Bundled skills can ship a dynamic body callback that reads runtime
    // state (e.g. `/debug` tails the worker log buffer). Resolve to live text
    // BEFORE `buildSkillBody`, then
    // swap into `command.content` so the rest of the pipeline runs uniformly.
    // Static-body skills (and every disk-loaded skill) skip this branch.
    const sessionId = context.options.sessionId
    const agentId = context.agentId ?? null

    // Build the body inside a try so a failure — a throwing dynamic-content
    // callback or a failing embedded `!`cmd`` expansion — lands as a `failed`
    // row in the Skills-tab event log before the error propagates to the model.
    let body: string
    try {
      const dynamic = getBundledSkillDynamicContent(command.name)
      const resolvedCommand = dynamic
        ? { ...command, content: await dynamic(input.args ?? '', context) }
        : command

      // Expand `${CLAUDE_SKILL_DIR}` / `$ARGUMENTS` (buildSkillBody), then run
      // any embedded shell commands (!`cmd` / ```! …```) so the body carries
      // live context before it reaches the model. Order: arg/dir substitution
      // → shell expansion.
      body = await expandSkillBodyShell(
        // `Boolean(dynamic)`: the callback above already received `input.args`,
        // so the no-placeholder fallback must not append them again.
        buildSkillBody(resolvedCommand, input.args, sessionId, Boolean(dynamic)),
        context,
      )
    } catch (err) {
      if (sessionId) {
        recordSkillInvocationEvent(sessionId, {
          id: createGeneratedUuid(),
          skillName: command.name,
          skillPath: command.path,
          invokedAt: Date.now(),
          status: 'failed',
          agentId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      throw err
    }
    // `skill.prompt` (F-25): the session's mods may replace the text the
    // model reads for this skill.
    body = await skillPromptThroughMods(
      context.options.mods,
      { skill: command.name, text: body },
      context.cancelSource.signal,
    )

    // Skill-gating: invoking a skill activates it for the session, so
    // any tool whose `skill` field matches becomes visible in tools[]
    // (e.g. a skill bringing the browser tool set into play). Membership is
    // derived C++-side from
    // each tool's `skill` field, so activating the skill name is enough
    // — no per-tool list here. No-op for always-on skills (their tools
    // are never hidden) and when deferral is disarmed. See
    // toolkit/run/deferredTools.ts.
    activateSkills(
      context.writeAppState,
      [command.name],
      deferralKeyFromContext(context),
    )

    // `context: 'fork'` skills run as a sub-agent; only the final assistant text comes
    // back. Falls through to inline when the fork can't start. Security: in PLAN MODE
    // the skill runs inline, since a sub-agent's tool calls skip the plan gate.
    const inPlanMode =
      context.readAppState().permissionRules.mode === 'plan'
    if (command.context === 'fork' && !inPlanMode) {
      const forked = await runSkillInFork({
        command,
        body,
        args: input.args,
        context,
        canUseTool,
      })
      if (forked) {
        return { data: forked.text }
      }
    }

    // Applies the per-skill model override + skill discovery to the rest of the
    // turn. Shared by the inline return below (full load) and the no-session
    // fallback so they stay identical on that axis.
    const contextModifier = (nextContext: ToolCallContext): ToolCallContext => {
      nextContext.skillsFound?.add(command.name)
      if (command.model && command.model !== 'inherit') {
        // Swap the per-turn `mainLoopModel` so downstream tool calls and the
        // trailing assistant response use the skill-requested model. The id is
        // used as given: Nexus does not track model-window variants separately
        // from the model id today.
        return {
          ...nextContext,
          options: { ...nextContext.options, mainLoopModel: command.model },
        }
      }
      return nextContext
    }

    // Records the body for post-compact re-injection and the Skills-tab log. AFTER the
    // fork branch on purpose: a forked skill's body is never stored in the main session.
    const sid = context.options.sessionId
    if (sid) {
      const uuid = createGeneratedUuid()
      // No re-entry dedup — every invocation injects the full
      // expanded body and logs `loaded`, regardless of a prior identical copy.
      const size = new TextEncoder().encode(body).length
      const detailId = skillBodyDetailId(uuid)
      noteSkillUse(sid, command.name, command.path, body, agentId)
      recordSkillInvocationEvent(sid, {
        id: uuid,
        skillName: command.name,
        skillPath: command.path,
        invokedAt: Date.now(),
        status: 'loaded',
        agentId,
        size,
        detailId,
      })
      // SkillRunTool emits "Launching skill: <name>" as the tool_result
      // string for inline execution. `newMessages` carries the isMeta message +
      // lazy-body sidecar — the transcript row keeps only the tags, the SKILL.md
      // body lives in tool-details and is re-inflated for the model on hydration.
      return {
        data: `Launching skill: ${command.name}`,
        extraRows: [
          createSkillInvocationMessage(command, input.args, body, uuid),
        ],
        contextPatch: contextModifier,
      }
    }

    // No session id (rare — e.g. invoked outside a normal query loop): the
    // dedup/log state is unkeyable, so fall back to the original always-inject
    // behavior.
    return {
      data: `Launching skill: ${command.name}`,
      extraRows: [createSkillInvocationMessage(command, input.args, body)],
      contextPatch: contextModifier,
    }
  },
})

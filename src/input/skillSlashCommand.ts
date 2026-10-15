import type { PermissionDecider } from '../toolkit/permissionVerdict'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { ProcessUserInputResult } from '../runtime/interfaces/UserInputPipeline'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import type { ChromiumCommandMetadata } from '../runtime/CommandTypes'
import type { UserRow } from '../runtime/RuntimeTypes'
import { buildSkillBody } from '../skillLibrary/buildSkillBody'
import { createSkillInvocationMessage } from '../skillLibrary/skillInvocationMessage'
import { expandSkillBodyShell } from '../skillLibrary/inlineShellExpansion'
import { skillPromptThroughMods } from '../skillLibrary/skillPromptThroughMods'
import { noteSkillUse } from '../skillLibrary/invokedSkillsStore'
import { recordSkillInvocationEvent } from '../skillLibrary/skillInvocationLog'
import { skillBodyDetailId } from '../skillLibrary/skillInvocationTags'
import { getBundledSkillDynamicContent } from '../skillLibrary/builtinSkills'
import { runSkillInFork } from '../skillLibrary/executeForkedSkill'
import {
  findCommandByName,
  isSkillDeniedByTemplate,
  normalizeSkillName,
} from '../skillLibrary/skillDiscovery'
import { armSkillHooks } from '../lifecycleHooks/skillHookRegistration'
import {
  createGeneratedUserMessage,
  createGeneratedUuid,
  createLocalizedSystemMessage,
  makeNoticeRow,
} from '../messages/messageFactories'
import { key } from './systemMessageParts'

// No-op `canUseTool` for slash dispatch: built-in slash commands are
// already user-typed (so permission is implicit), and the tools we
// invoke from the slash path (EnterPlanMode / ExitPlanMode) don't
// consult this parameter. Defined once at module scope to keep the
// allocation out of the slash hot path.
export const SLASH_DISPATCH_CAN_USE_TOOL: PermissionDecider = (async () => ({
  behavior: 'allow' as const,
  updatedInput: {},
})) as PermissionDecider

function getSkillCommands(
  commands: readonly ChromiumCommandMetadata[],
): ChromiumCommandMetadata[] {
  return commands.filter(command => command.type === 'prompt')
}

/**
 * Dispatch a user-typed `/<skill-name>`: the expanded body is emitted as a meta
 * user message with `shouldQuery: true`. `null` for an unknown skill.
 */
export async function dispatchSkillSlashCommand(params: {
  command: string
  args: string
  rawInput: string
  context: ToolCallContext
  runtimeConfig: RuntimeConfig
}): Promise<ProcessUserInputResult | null> {
  const commands = getSkillCommands(params.context.options.commands)
  const skill = findCommandByName(commands, params.command)
  // Both refusals below are USER-facing: a `shouldQuery: false` turn never
  // reaches the model, and the transcript view filters `isMeta` user turns
  // (assistantUiAdapter), so an `isMeta` user message here would be seen by
  // nobody — the composer would simply clear. They render as localized
  // system messages, the same shape as the caller's "unknown command"
  // (`dispatchCommandInput.ts`), so the user sees them, translated.
  if (!skill) {
    // Denied by this session type's `skills:` allowlist — say so rather than
    // fall through to "unknown command", which reads as a typo. A name this
    // session never had still falls through (null → the caller's unknown
    // branch).
    if (isSkillDeniedByTemplate(params.context, params.command)) {
      return {
        messages: [
          createLocalizedSystemMessage(params.runtimeConfig, [
            key('slash.out.skillDenied', {
              name: normalizeSkillName(params.command),
            }),
          ]),
        ],
        shouldQuery: false,
        resultText: params.rawInput,
      }
    }
    return null
  }

  if (skill.userCallable === false) {
    // Loaded skill exists but the author opted out of slash invocation
    // (`userCallable: false` in frontmatter). Surface a specific
    // message so users don't think they mistyped — and so authors
    // notice their skill is model-only.
    return {
      messages: [
        createLocalizedSystemMessage(params.runtimeConfig, [
          key('slash.out.skillNotUserInvocable', { name: skill.name }),
        ]),
      ],
      shouldQuery: false,
      resultText: params.rawInput,
    }
  }

  // Register the skill's frontmatter hooks for the session on invoke — the
  // model-tool path does the same in `SkillRunTool.call`, so both entry points
  // activate a skill's hooks the moment it runs.
  if (skill.hooks) {
    armSkillHooks({
      setAppState: params.context.writeAppState,
      sessionId: params.context.options.sessionId,
      hooks: skill.hooks,
      skillRoot: skill.baseDir,
    })
  }

  const sessionId = params.context.options.sessionId
  const agentId = params.context.agentId ?? null

  // Bundled skills can ship a dynamic body callback that builds the body from
  // runtime state. Resolve to live text first,
  // then run the rest of the pipeline uniformly. Identical to SkillRunTool.call.
  // Wrapped so a throwing dynamic callback / embedded shell expansion lands as
  // a `failed` row in the Skills-tab event log before it propagates.
  let body: string
  try {
    const dynamic = getBundledSkillDynamicContent(skill.name)
    const resolvedSkill = dynamic
      ? { ...skill, content: await dynamic(params.args ?? '', params.context) }
      : skill

    // Arg/dir substitution (buildSkillBody) then embedded shell expansion
    // (!`cmd` / ```! …```), the same steps SkillRunTool.call takes.
    body = await expandSkillBodyShell(
      // `Boolean(dynamic)`: the callback above already received `params.args`,
      // so the no-placeholder fallback must not append them again.
      buildSkillBody(
        resolvedSkill,
        params.args || undefined,
        sessionId,
        Boolean(dynamic),
      ),
      params.context,
    )
  } catch (err) {
    if (sessionId) {
      recordSkillInvocationEvent(sessionId, {
        id: createGeneratedUuid(),
        skillName: skill.name,
        skillPath: skill.path,
        invokedAt: Date.now(),
        status: 'failed',
        agentId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    throw err
  }
  // `skill.prompt` (F-25): the same event the Skill tool raises.
  body = await skillPromptThroughMods(
    params.context.options.mods,
    { skill: skill.name, text: body },
    params.context.cancelSource.signal,
  )

  // Mirror SkillRunTool.contextModifier so user-slash and model-tool paths
  // produce identical accounting for compaction-time skill restoration.
  params.context.skillsFound?.add(skill.name)

  // Forked skills (`context: 'fork'`) run as a sub-agent: the fork produces
  // the answer synchronously and we surface its final text, with no follow-up
  // model turn. The fork is always awaited — there is no fire-and-forget
  // variant, since Nexus has no async task framework for slash skills.
  // Falls through to inline injection when the fork can't
  // start (no cache-safe params — e.g. the first input of a fresh session).
  if (skill.context === 'fork') {
    const forked = await runSkillInFork({
      command: skill,
      body,
      args: params.args || undefined,
      context: params.context,
      canUseTool: SLASH_DISPATCH_CAN_USE_TOOL,
    })
    if (forked) {
      return {
        messages: [makeNoticeRow(params.runtimeConfig, forked.text)],
        shouldQuery: false,
        resultText: params.rawInput,
      }
    }
  }

  // Wrap the emitted message with the skill's model / permittedTools passthrough,
  // shared by the inline return below (full load) and the no-session fallback
  // so they stay identical on that axis.
  const buildResult = (message: UserRow): ProcessUserInputResult => {
    const result: ProcessUserInputResult = {
      messages: [message],
      shouldQuery: true,
      resultText: params.rawInput,
    }
    if (skill.model && skill.model !== 'inherit') {
      result.model = skill.model
    }
    if (skill.permittedTools && skill.permittedTools.length > 0) {
      result.permittedTools = skill.permittedTools
    }
    return result
  }

  // Record the (expanded) body for post-compact restoration, mark it as the
  // live copy for dedup, and log the invocation — mirrors the model-invoked
  // SkillRunTool path. Slash invocation runs on the main session so agentId is
  // null. Deliberately AFTER the fork branch: a
  // `context: 'fork'` slash skill that succeeds returns above, so its body is
  // never stored in / logged against the main session.
  if (sessionId) {
    const uuid = createGeneratedUuid()
    // No re-entry dedup — every invocation injects the full
    // expanded body and logs `loaded`, regardless of a prior identical copy.
    const size = new TextEncoder().encode(body).length
    const detailId = skillBodyDetailId(uuid)
    noteSkillUse(sessionId, skill.name, skill.path, body, agentId)
    recordSkillInvocationEvent(sessionId, {
      id: uuid,
      skillName: skill.name,
      skillPath: skill.path,
      invokedAt: Date.now(),
      status: 'loaded',
      agentId,
      size,
      detailId,
    })
    // isMeta message + lazy-body sidecar — see skillLibrary/skillInvocationMessage.ts.
    return buildResult(
      createSkillInvocationMessage(skill, params.args || undefined, body, uuid),
    )
  }

  // No session id: original always-inject behavior (no dedup / no logging).
  return buildResult(
    createSkillInvocationMessage(skill, params.args || undefined, body),
  )
}

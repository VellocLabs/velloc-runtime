/**
 * `SpawnSession`: start a child session from this one, fresh from a briefing or
 * as a fork of this transcript (F-36). Strict schema, every field required,
 * `""` for none. The checks run in the runtime and fail closed; the
 * acknowledgement says the session is registered, never that the task was
 * delivered.
 */

import type { ToolContract, InputCheck, ToolArgsJsonShape } from '../toolContract'
import type { ToolCallContext } from '../toolCallContext'
import { declareTool } from '../toolContract'
import {
  CHILD_BRIEFING_MIN_CHARS,
  SPAWN_SESSION_TOOL_NAME,
  checkChildSessionRequest,
  childSessionRegisteredText,
  type ChildSessionRequest,
  type SpawnSessionInput,
} from '../../sessions/childSessionSpec'
import {
  getChildSessionSpawner,
  type ChildWorktreePrepare,
} from '../../sessions/childSessionSpawner'
import { templateChannel } from '../../prompting/templateCatalog'
import { enabledModelsFor, resolveChildProvider } from '../../team/sessionTrust'
import { getAvailableThinkingTiersForModel } from '../../engine/contextWindow'
import { routineOriginIdOf } from '../../routines/routineOrigin'
import { fsForContext } from '../../utils/fs/runtimeFs'
import { mainRepoRoot } from '../../utils/gitInfo'
import {
  checkoutHead,
  childCheckoutDir,
  openNamedCheckout,
} from '../../utils/agentWorktree'

export { SPAWN_SESSION_TOOL_NAME }

const DESCRIPTION =
  'Start a CHILD SESSION: a full session of its own, listed under this one, with ' +
  'its own page, model and permissions, that reports each finished turn back ' +
  'here. Use it for a task that outlives this turn and that the user may want ' +
  'to open, steer or review apart from this work; a sub-agent (Agent) is for a ' +
  'result you need in this turn. from="fresh" starts it from your briefing ' +
  'alone (it has not seen this conversation; the briefing must say everything, ' +
  `at least ${CHILD_BRIEFING_MIN_CHARS} characters); from="fork" copies this ` +
  'conversation up to the last answered message and then gives it the task. ' +
  'Every field is required; "" means none. The result says the session is ' +
  'registered, not that the task was delivered: end your turn, its report ' +
  'arrives as a later turn.'

const SCHEMA: ToolArgsJsonShape = {
  type: 'object',
  properties: {
    initiation: {
      type: 'string',
      description: 'How this start was decided. "asked": the user asked in words for this work to run in its own session. No other value is accepted yet.',
    },
    title: {
      type: 'string',
      description: 'The session\'s title as the user will see it in the list: under 60 characters, naming the task.',
    },
    task: {
      type: 'string',
      description: 'What the child is to do, and what done looks like. It becomes the task section of the child\'s first message.',
    },
    briefing: {
      type: 'string',
      description: `Everything the child needs to know that you know: the files and area, what was ruled out, the constraints. Required for from="fresh" (at least ${CHILD_BRIEFING_MIN_CHARS} characters); "" allowed for from="fork", whose copy of this conversation is its briefing.`,
    },
    from: {
      type: 'string',
      description: '"fresh": a new session that knows only the briefing and task. "fork": a copy of this conversation up to the last answered message, then the task.',
    },
    name: {
      type: 'string',
      description: 'A short name the family uses to address it (letters, digits, hyphens, at most 24 characters); "" derives one from the title.',
    },
    isolation: {
      type: 'string',
      description: '"shared": the child edits the same checkout as this session. "worktree": the runtime creates a git worktree for it. "" takes the default: shared when this session works in a plain checkout, worktree when it works in one. Must be "" for from="fork".',
    },
    model: {
      type: 'string',
      description: 'An exact model id enabled on this session\'s provider for the child to run on; "" inherits this session\'s model.',
    },
    effort: {
      type: 'string',
      description: 'A reasoning-effort tier the model publishes; "" for its default. Needs model.',
    },
    permissionMode: {
      type: 'string',
      description: 'The child\'s permission mode: this session\'s mode or a less permissive one (plan, default, acceptEdits, dontAsk, bypassPermissions); "" inherits. It can never be raised.',
    },
    cwd: {
      type: 'string',
      description: 'The project folder the child binds to; "" for this session\'s. Must be a folder the user has already opened in this app.',
    },
    baseBranch: {
      type: 'string',
      description: 'For isolation "worktree": the branch or commit the worktree is cut from; "" for this session\'s current HEAD.',
    },
    branchName: {
      type: 'string',
      description: 'For isolation "worktree": the new branch\'s name; "" derives one from the session name.',
    },
  },
  required: [
    'initiation',
    'title',
    'task',
    'briefing',
    'from',
    'name',
    'isolation',
    'model',
    'effort',
    'permissionMode',
    'cwd',
    'baseBranch',
    'branchName',
  ],
  additionalProperties: false,
}

const FIELDS = SCHEMA.required as readonly (keyof SpawnSessionInput)[]

/** Whether the call comes from a loop under the session (a sub-agent or a
 *  teammate), which may not start sessions. */
function isNestedCaller(context: ToolCallContext): boolean {
  const sessionId = context.options.sessionId ?? ''
  return (
    context.agentId !== undefined ||
    context.options.mods?.agentId !== undefined ||
    sessionId.startsWith('subagent-') ||
    sessionId.startsWith('teammate-') ||
    context.options.teammateName !== undefined
  )
}

/** Whether this session itself works in a git worktree of its project: its
 *  working directory is not its project root. */
function callerInWorktree(context: ToolCallContext): boolean {
  const { cwd, projectRoot } = context.options
  return typeof cwd === 'string' && typeof projectRoot === 'string' && cwd !== '' && cwd !== projectRoot
}

/** The worktree maker for a `worktree` child, over this turn's git. `name`
 *  is the family name the runtime allocated: the default branch
 *  `session/<name>` and the directory carry it, so they agree with the name
 *  the parent and the list address the child by. */
function worktreePreparer(
  context: ToolCallContext,
  request: ChildSessionRequest,
): ChildWorktreePrepare {
  return async (name: string) => {
    const anchor = request.cwd ?? context.options.cwd
    let repoRoot: string | undefined
    try {
      repoRoot = await mainRepoRoot(anchor, fsForContext(context), {
        homeDir: context.options.homeDir,
      })
    } catch {
      repoRoot = undefined
    }
    if (!repoRoot) {
      return { ok: false, reason: `${anchor} is not inside a git repository, so no worktree can be made.` }
    }
    const base = request.baseBranch ?? (await checkoutHead(context, context.options.cwd)) ?? 'HEAD'
    const branch = request.branchName ?? `session/${name}`
    // Security: these git commands run on the host without a permission
    // prompt, so every argument is runtime-chosen or allow-listed (the branch
    // and base passed `isGitBranchNameSafe`, the paths are the runtime's) and
    // quoted as one shell word each. Not a surface for arbitrary commands,
    // the same stance a worktree-isolated sub-agent takes.
    const made = await openNamedCheckout(context, repoRoot, {
      checkoutDir: childCheckoutDir(repoRoot, name),
      branch,
      base,
    })
    if (!made.ok) return made
    return { ok: true, cwd: made.worktree.checkoutDir, repoRoot }
  }
}

export async function spawnChildSession(
  input: SpawnSessionInput,
  context: ToolCallContext,
): Promise<{ data: string }> {
  const checked = checkChildSessionRequest(input, {
    channel: templateChannel(),
    templateType: context.options.templateType,
    nested: isNestedCaller(context),
    parentPermissionMode: context.readAppState().permissionRules.mode,
    parentInWorktree: callerInWorktree(context),
  })
  if (!checked.ok) return { data: `Refused: ${checked.reason}` }
  const { request } = checked

  const spawn = getChildSessionSpawner()
  if (!spawn) {
    return { data: 'Refused: child sessions are unavailable here (no session manager in this runtime).' }
  }
  const parentSessionId = context.options.sessionId
  if (!parentSessionId) {
    return { data: 'Refused: this turn has no session id to start a child from.' }
  }

  // The model, when named, must be one the user enabled on this session's
  // provider; the effort, one the model publishes. The provider itself is
  // inherited, never chosen here.
  const homeDir = context.options.homeDir
  const provider = await resolveChildProvider(
    homeDir,
    undefined,
    context.options.userSpecifiedProviderId,
    fsForContext(context),
  )
  const providerId = provider.providerId
  if (request.model && homeDir && providerId) {
    const enabled = await enabledModelsFor(homeDir, providerId, fsForContext(context))
    if (enabled && enabled.length > 0 && !enabled.includes(request.model)) {
      return {
        data: `Refused: model "${request.model}" is not enabled on provider "${providerId}". Enabled: ${enabled.join(', ')}.`,
      }
    }
  }
  if (request.effort && request.model) {
    const tiers = providerId ? (getAvailableThinkingTiersForModel(request.model, providerId) ?? []) : []
    if (!tiers.includes(request.effort)) {
      return {
        data: tiers.length === 0
          ? `Refused: model "${request.model}" publishes no effort tiers; leave effort empty.`
          : `Refused: effort "${request.effort}" is not one model "${request.model}" accepts. Accepted: ${tiers.join(', ')}.`,
      }
    }
  }

  const outcome = await spawn({
    parentSessionId,
    request,
    ...(providerId ? { providerId } : {}),
    ...(request.effort ? { thinkingTier: request.effort } : {}),
    ...(request.isolation === 'worktree'
      ? { prepareWorktree: worktreePreparer(context, request) }
      : {}),
    routineOriginId: routineOriginIdOf(context.options),
  })
  if (outcome === null) {
    return { data: 'Refused: the runtime cannot start a session yet (no session has booted). Try again in a moment.' }
  }
  if (!outcome.ok) return { data: `Refused: ${outcome.reason}` }
  if (outcome.startFailed) {
    return {
      data:
        `Child session "${outcome.name}" (session ${outcome.sessionId}) is registered but did not start: ${outcome.startFailed} ` +
        'It stays listed as not started with that reason; nothing was shared or run. Fix the cause and start it again, or do the work here.',
    }
  }
  return {
    data: childSessionRegisteredText({
      sessionId: outcome.sessionId,
      name: outcome.name,
      from: request.from,
      sharedCheckout: outcome.sharedCheckout,
      ...(outcome.cwd ? { cwd: outcome.cwd } : {}),
    }),
  }
}

export const SpawnSessionTool: ToolContract<SpawnSessionInput, string> = declareTool({
  name: SPAWN_SESSION_TOOL_NAME,
  discoveryHint: 'start a child session of its own under this one, fresh from a briefing or forked from this conversation',
  argsSchema: SCHEMA,
  inputJSONSchemaStrict: SCHEMA,
  strict: true,
  description: async () => DESCRIPTION,
  parallelSafe: () => false,
  readsOnly: () => false,
  async checkInput(input: SpawnSessionInput, _context: ToolCallContext): Promise<InputCheck> {
    for (const [index, field] of FIELDS.entries()) {
      const value = (input as Record<string, unknown>)[field]
      if (typeof value !== 'string') {
        return {
          result: false,
          message: `${field} is required: a string, or "" for none.`,
          errorCode: index + 1,
        }
      }
    }
    return { result: true }
  },
  async call(input: SpawnSessionInput, context: ToolCallContext) {
    return spawnChildSession(input, context)
  },
})

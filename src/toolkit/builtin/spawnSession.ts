/**
 * `SpawnSession`: start a child session from this one, fresh from a briefing or
 * as a fork of this transcript (F-36). Unused fields may be omitted.
 * The checks run in the runtime and fail closed; the
 * acknowledgement says the session is registered, never that the task was
 * delivered. With `proposalId` it starts a proposal exactly as proposed.
 */

import type { ToolContract, InputCheck, ToolArgsJsonShape } from '../toolContract'
import type { ToolCallContext } from '../toolCallContext'
import { declareTool } from '../toolContract'
import {
  CHILD_BRIEFING_MIN_CHARS,
  SPAWN_SESSION_TOOL_NAME,
  checkChildSessionRequest,
  checkChildStringFields,
  CHILD_SESSION_INPUT_FIELDS,
  childSessionNotStartedAckText,
  childSessionRegisteredText,
  type ChildSessionCallerContext,
  type ChildSessionRequest,
  type SpawnSessionInput,
} from '../../sessions/childSessionSpec'
import {
  getChildSessionSpawner,
  getParentSelection,
  getParentPermissionMode,
  type ChildSessionSpawnOutcome,
  type ChildWorktreePrepare,
} from '../../sessions/childSessionSpawner'
import {
  isProposalTaskId,
  proposalStartMismatch,
  proposalStateWords,
} from '../../sessions/childProposals'
import {
  getProposalBoard,
  type ProposalLaunch,
  type ProposalLauncher,
} from '../../sessions/proposalBoard'
import { allocateFamilyName } from '../../sessions/sessionLineage'
import {
  effortNotRaised,
  type SessionSpawnInput as SessionSpawnEvent,
  type SessionSpawnRewrite,
} from '../../mods/sessionFamilyEvents'
import { templateChannel } from '../../prompting/templateCatalog'
import { enabledModelsFor } from '../../team/sessionTrust'
import { getAvailableThinkingTiersForModel } from '../../engine/contextWindow'
import { routineOriginIdOf } from '../../routines/routineOrigin'
import { fsForContext } from '../../utils/fs/runtimeFs'
import { mainRepoRoot } from '../../utils/gitInfo'
import { relativeRuntimePath } from '../../utils/runtimePaths'
import {
  checkoutHead,
  childCheckoutDir,
  childCheckoutParent,
  localBranchExists,
  localBranchesUnder,
  openNamedCheckout,
} from '../../utils/agentWorktree'

export { SPAWN_SESSION_TOOL_NAME }

/** The prefix of a worktree child's default branch. */
const CHILD_BRANCH_PREFIX = 'session/'

const DESCRIPTION =
  'Start a CHILD SESSION: a full session of its own, listed under this one, with ' +
  'its own page, model and permissions, that reports each finished turn back ' +
  'here. Use it for a task that outlives this turn and that the user may want ' +
  'to open, steer or review apart from this work; a sub-agent (Agent) is for a ' +
  'result you need in this turn. from="fresh" starts it from your briefing ' +
  'alone (it has not seen this conversation; the briefing must say everything, ' +
  `at least ${CHILD_BRIEFING_MIN_CHARS} characters); from="fork" copies this ` +
  'conversation up to the last answered message and then gives it the task. ' +
  'With proposalId it starts a proposal of yours exactly as proposed: pass ' +
  'only proposalId (an offer the user accepted also needs its task and ' +
  'briefing now). Omit unused fields; "" is also accepted. from defaults to ' +
  '"fresh". The result says the ' +
  'session is registered, not that the task was delivered: end your turn, its ' +
  'report arrives as a later turn.'

const SCHEMA: ToolArgsJsonShape = {
  type: 'object',
  properties: {
    initiation: {
      type: 'string',
      description: 'Required for a direct start. "asked": the user asked in words for this work to run in its own session, or told you to start a proposal. No other value is accepted yet.',
    },
    title: {
      type: 'string',
      description: 'Required for a direct start. The session\'s title as the user will see it in the list: under 60 characters, naming the task.',
    },
    task: {
      type: 'string',
      description: 'Required for a direct start: what the child is to do, and what done looks like. It becomes the task section of the child\'s first message.',
    },
    briefing: {
      type: 'string',
      description: `Everything the child needs to know that you know: the files and area, what was ruled out, the constraints. Required for a fresh start (at least ${CHILD_BRIEFING_MIN_CHARS} characters); omit for from="fork", whose copy of this conversation is its briefing.`,
    },
    from: {
      type: 'string',
      description: '"fresh": a new session that knows only the briefing and task. "fork": a copy of this conversation up to the last answered message, then the task. Omit for "fresh".',
    },
    name: {
      type: 'string',
      description: 'A short name the family uses to address it (letters, digits, hyphens, at most 24 characters); omit to derive one from the title.',
    },
    isolation: {
      type: 'string',
      description: '"shared": the child edits the same checkout as this session. "worktree": the runtime creates a git worktree for it. Omitting it takes the default: shared when this session works in a plain checkout, worktree when it works in one. Omit for from="fork".',
    },
    model: {
      type: 'string',
      description: 'An exact model id enabled on this session\'s provider for the child to run on; omit to inherit this session\'s model.',
    },
    effort: {
      type: 'string',
      description: 'A reasoning-effort tier the model publishes. Needs model. Omit to inherit the parent tier for the same model, or use the chosen model\'s default when changing models.',
    },
    permissionMode: {
      type: 'string',
      description: 'The child\'s permission mode: this session\'s mode or a less permissive one (plan, default, acceptEdits, dontAsk, bypassPermissions); omit to inherit. It can never be raised.',
    },
    cwd: {
      type: 'string',
      description: 'The project folder the child binds to; omit for this session\'s. Must be a folder the user has already opened in this app.',
    },
    baseBranch: {
      type: 'string',
      description: 'For isolation "worktree": the branch or commit the worktree is cut from; omit for the target folder\'s current HEAD.',
    },
    branchName: {
      type: 'string',
      description: 'For isolation "worktree": the new branch\'s name, which must not exist yet; omit to derive an unused one from the session name.',
    },
    proposalId: {
      type: 'string',
      description: 'The task id of a proposal of yours (ProposeSession) to start, "task_" and eight letters or digits; omit for a direct start.',
    },
  },
  required: [],
  additionalProperties: false,
}

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
  return typeof cwd === 'string' && typeof projectRoot === 'string' && cwd !== '' && relativeRuntimePath(projectRoot, cwd) !== '.'
}

/** What the request checks need to know about the calling turn. */
export function childCallerContext(context: ToolCallContext): ChildSessionCallerContext {
  return {
    channel: templateChannel(),
    templateType: context.options.templateType,
    nested: isNestedCaller(context),
    routineOrigin: routineOriginIdOf(context.options) !== undefined,
    parentPermissionMode: getParentPermissionMode(context.options.sessionId ?? '') ?? context.readAppState().permissionRules.mode,
    parentInWorktree: callerInWorktree(context),
  }
}

/** The repository a worktree child is cut from, or undefined outside git. */
async function childRepoRoot(context: ToolCallContext, request: ChildSessionRequest): Promise<string | undefined> {
  const anchor = request.cwd ?? context.options.cwd
  try {
    return await mainRepoRoot(anchor, fsForContext(context), { homeDir: context.options.homeDir })
  } catch {
    return undefined
  }
}

/** Every child-worktree directory name already present in `repoRoot`. */
async function takenCheckoutDirs(context: ToolCallContext, repoRoot: string): Promise<string[]> {
  try {
    const entries = await fsForContext(context).readdir(childCheckoutParent(repoRoot))
    return entries.map(entry => entry.name)
  } catch {
    return []
  }
}

/** The worktree maker for a `worktree` child, over this turn's git. `name`
 *  is the family name the runtime allocated. The default branch
 *  `session/<name>` and the directory carry it, suffixed like a family name
 *  when the repository already has that branch or directory, so two families
 *  in one repository never collide. */
function worktreePreparer(
  context: ToolCallContext,
  request: ChildSessionRequest,
): ChildWorktreePrepare {
  return async (name: string) => {
    const repoRoot = await childRepoRoot(context, request)
    if (!repoRoot) {
      const anchor = request.cwd ?? context.options.cwd
      return { ok: false, reason: `${anchor} is not inside a git repository, so no worktree can be made.` }
    }
    const base = request.baseBranch ?? (await checkoutHead(context, request.cwd ?? context.options.cwd)) ?? 'HEAD'
    const taken = new Set(await takenCheckoutDirs(context, repoRoot))
    if (!request.branchName) {
      for (const branch of await localBranchesUnder(context, repoRoot, CHILD_BRANCH_PREFIX)) taken.add(branch)
    }
    const checkoutName = allocateFamilyName(name, taken)
    const branch = request.branchName ?? `${CHILD_BRANCH_PREFIX}${checkoutName}`
    // Security: these git commands run on the host without a permission
    // prompt, so every argument is runtime-chosen or allow-listed (the branch
    // and base passed `isGitBranchNameSafe`, the paths are the runtime's) and
    // quoted as one shell word each. Not a surface for arbitrary commands,
    // the same stance a worktree-isolated sub-agent takes.
    const made = await openNamedCheckout(context, repoRoot, {
      checkoutDir: childCheckoutDir(repoRoot, checkoutName),
      branch,
      base,
    })
    if (!made.ok) return made
    return { ok: true, cwd: made.worktree.checkoutDir, repoRoot }
  }
}

/** A refusal: nothing was created. */
function refused(reason: string): Extract<ProposalLaunch, { ok: false }> {
  return { ok: false, reason, text: `Refused: ${reason}` }
}

/** The model and effort a request names, checked against this session's
 *  provider: the model enabled by the user, the effort one it publishes. The
 *  provider itself is inherited, never chosen here. */
export async function checkChildModelChoice(
  request: Pick<ChildSessionRequest, 'model' | 'effort'>,
  context: ToolCallContext,
): Promise<{ ok: true; providerId?: string } | { ok: false; reason: string }> {
  const homeDir = context.options.homeDir
  const parent = getParentSelection(context.options.sessionId ?? '')
  if (!parent) return { ok: false, reason: 'the parent session has no live model selection.' }
  const providerId = parent.providerId
  if (request.model && homeDir && providerId) {
    const enabled = await enabledModelsFor(homeDir, providerId, fsForContext(context))
    if (enabled && enabled.length > 0 && !enabled.includes(request.model)) {
      return {
        ok: false,
        reason: `model "${request.model}" is not enabled on provider "${providerId}". Enabled: ${enabled.join(', ')}.`,
      }
    }
  }
  if (request.effort && request.model) {
    const tiers = providerId ? (getAvailableThinkingTiersForModel(request.model, providerId) ?? []) : []
    if (!tiers.includes(request.effort)) {
      return {
        ok: false,
        reason: tiers.length === 0
          ? `model "${request.model}" publishes no effort tiers; leave effort empty.`
          : `effort "${request.effort}" is not one model "${request.model}" accepts. Accepted: ${tiers.join(', ')}.`,
      }
    }
  }
  return { ok: true, ...(providerId ? { providerId } : {}) }
}

export type ChildLaunchOptions = {
  /** The proposal the start comes from. */
  taskId?: string
  /** The relation recorded on the child; absent is `side_session`. */
  kind?: 'side_session' | 'hand_off'
  /** The acknowledgement for a registered child, replacing the default. */
  registeredText?: (outcome: Extract<ChildSessionSpawnOutcome, { ok: true }>, request: ChildSessionRequest) => string
}

/**
 * Check a request and start the child: the one path every start takes (a
 * direct start, a proposal's, a hand-off). A refusal created nothing; a
 * registered child is on record, started or not.
 */
export async function launchChildSession(
  input: SpawnSessionInput,
  context: ToolCallContext,
  options: ChildLaunchOptions = {},
): Promise<ProposalLaunch> {
  const checked = checkChildSessionRequest(input, childCallerContext(context))
  if (!checked.ok) return refused(checked.reason)
  const { request } = checked

  const spawn = getChildSessionSpawner()
  if (!spawn) return refused('child sessions are unavailable here (no session manager in this runtime).')
  const parentSessionId = context.options.sessionId
  if (!parentSessionId) return refused('this turn has no session id to start a child from.')

  const model = await checkChildModelChoice(request, context)
  if (!model.ok) return refused(model.reason)
  const { providerId } = model

  // An explicit branch must be new: refused with the field named before
  // anything is created, rather than a child that did not start.
  if (request.isolation === 'worktree' && request.branchName) {
    const repoRoot = await childRepoRoot(context, request)
    if (repoRoot && (await localBranchExists(context, repoRoot, request.branchName))) {
      return refused(`branchName "${request.branchName}" already exists in ${repoRoot}; pass a new name, or "" for an unused one.`)
    }
  }

  const start = (chosen: ChildSessionRequest, chosenProvider: string | undefined): Promise<ProposalLaunch> =>
    startChildSession(spawn, parentSessionId, chosen, chosenProvider, context, options)
  const mods = context.options.mods
  if (!mods?.sessionSpawn || mods.hasSessionSpawnHooks?.() === false) return start(request, providerId)

  // The plugins' hooks see the start once its checks passed: a rewrite is
  // checked again as the model's own request would be, a deny creates nothing.
  let launched: ProposalLaunch | undefined
  let entered = false
  const kind = options.kind ?? 'side_session'
  let settled: Awaited<ReturnType<NonNullable<typeof mods.sessionSpawn>>>
  try {
    settled = await mods.sessionSpawn(
      sessionSpawnEventOf(request, parentSessionId, kind, context),
      async rewrite => {
        const chosen = await rewrittenChildRequest(input, request, providerId, rewrite, context)
        // Security: one request starts one session, however often core is
        // asked; a rewrite the checks refused started nothing.
        if (entered) throw new Error('this request has already been started')
        entered = true
        // Past the checks nothing throws: a failed launch is a refusal, never
        // a hook absent that would start the request again.
        try {
          launched = await start(chosen.request, chosen.providerId)
        } catch (error) {
          launched = refused(`the session could not be started: ${error instanceof Error ? error.message : String(error)}`)
        }
        return launched.ok ? { sessionId: launched.sessionId, name: launched.name } : { refused: launched.reason }
      },
      context.cancelSource.signal,
      context.modCallContext,
    )
  } catch (error) {
    if (launched) return launched
    return refused(`the start was cancelled: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (launched) return launched
  if ('deny' in settled) return refused(`a plugin refused this session: ${settled.deny}`)
  return refused('a plugin answered without starting the session.')
}

/** `session.spawn`'s `e` for a checked request. */
function sessionSpawnEventOf(
  request: ChildSessionRequest,
  parentSessionId: string,
  kind: 'side_session' | 'hand_off',
  context: ToolCallContext,
): SessionSpawnEvent {
  const plugin = context.modCallContext?.origin.plugin
  return {
    from: request.from,
    kind,
    initiation: request.initiation,
    title: request.title,
    task: request.task,
    briefing: request.briefing ?? '',
    name: request.name ?? '',
    isolation: request.isolation,
    model: request.model ?? '',
    effort: request.effort ?? '',
    permissionMode: request.permissionMode,
    cwd: request.cwd ?? '',
    parentSessionId,
    origin: plugin !== undefined ? { kind: 'plugin', name: plugin } : { kind: 'model' },
  }
}

/**
 * The request a `session.spawn` rewrite asks for, through the same checks as
 * the model's own: a model enabled on this session's provider, an effort the
 * model publishes and no higher than the one requested. Throws the reason on
 * a rewrite the checks refuse, so the hook counts as absent.
 */
async function rewrittenChildRequest(
  input: SpawnSessionInput,
  request: ChildSessionRequest,
  providerId: string | undefined,
  rewrite: SessionSpawnRewrite,
  context: ToolCallContext,
): Promise<{ request: ChildSessionRequest; providerId: string | undefined }> {
  const unchanged =
    rewrite.title === request.title &&
    rewrite.task === request.task &&
    rewrite.briefing === (request.briefing ?? '') &&
    rewrite.name === (request.name ?? '') &&
    rewrite.model === (request.model ?? '') &&
    rewrite.effort === (request.effort ?? '')
  if (unchanged) return { request, providerId }
  const checked = checkChildSessionRequest({ ...input, ...rewrite }, childCallerContext(context))
  if (!checked.ok) throw new Error(checked.reason)
  const model = await checkChildModelChoice(checked.request, context)
  if (!model.ok) throw new Error(model.reason)
  if (rewrite.effort !== (request.effort ?? '')) {
    const tiers = model.providerId && rewrite.model
      ? (getAvailableThinkingTiersForModel(rewrite.model, model.providerId) ?? [])
      : []
    if (!effortNotRaised(request.effort ?? '', rewrite.effort, tiers)) {
      throw new Error(`effort "${rewrite.effort}" is above the effort requested ("${request.effort ?? ''}")`)
    }
  }
  return { request: checked.request, providerId: model.providerId }
}

/** Start a checked request: the spawner registers it, then it is started. */
async function startChildSession(
  spawn: NonNullable<ReturnType<typeof getChildSessionSpawner>>,
  parentSessionId: string,
  request: ChildSessionRequest,
  providerId: string | undefined,
  context: ToolCallContext,
  options: ChildLaunchOptions,
): Promise<ProposalLaunch> {
  const outcome = await spawn({
    parentSessionId,
    request,
    ...(providerId ? { providerId } : {}),
    ...(request.effort ? { thinkingTier: request.effort } : {}),
    ...(request.isolation === 'worktree'
      ? { prepareWorktree: worktreePreparer(context, request) }
      : {}),
    routineOriginId: routineOriginIdOf(context.options),
    ...(options.taskId ? { taskId: options.taskId } : {}),
    ...(options.kind ? { kind: options.kind } : {}),
  })
  if (outcome === null) {
    return refused('the runtime cannot start a session yet (no session has booted). Try again in a moment.')
  }
  if (!outcome.ok) return refused(outcome.reason)
  context.onChildSessionRegistered?.({ sessionId: outcome.sessionId, name: outcome.name, started: !outcome.startFailed })
  if (outcome.startFailed) {
    return {
      ok: true,
      sessionId: outcome.sessionId,
      name: outcome.name,
      text: childSessionNotStartedAckText({
        name: outcome.name,
        sessionId: outcome.sessionId,
        reason: outcome.startFailed,
      }),
    }
  }
  const text = options.registeredText
    ? options.registeredText(outcome, request)
    : childSessionRegisteredText({
        sessionId: outcome.sessionId,
        name: outcome.name,
        title: request.title,
        from: request.from,
        sharedCheckout: outcome.sharedCheckout,
        ...(outcome.cwd ? { cwd: outcome.cwd } : {}),
      })
  return { ok: true, sessionId: outcome.sessionId, name: outcome.name, text }
}

/** Starts a proposal's request through `context`, the turn it is bound to. */
export function proposalLauncherFor(context: ToolCallContext): ProposalLauncher {
  return (input, taskId) => launchChildSession(input, context, { taskId })
}

/**
 * The model starts one of its proposals: exactly as proposed (P05), once
 * (the board's claim), and only from a state that allows it: a suggestion
 * still waiting, or an offer the user accepted.
 */
async function startProposedChild(
  proposalId: string,
  input: SpawnSessionInput,
  context: ToolCallContext,
): Promise<string> {
  if (!isProposalTaskId(proposalId)) {
    return 'Refused: proposalId must be a task id: "task_" and eight lowercase letters or digits.'
  }
  const initiation = typeof input.initiation === 'string' ? input.initiation.trim() : ''
  if (initiation && initiation !== 'asked') {
    return `Refused: initiation must be "asked" or "" with a proposalId (got ${JSON.stringify(initiation)}).`
  }
  const board = getProposalBoard()
  const sessionId = context.options.sessionId
  if (!board || !sessionId) return 'Refused: proposals are unavailable here (no session manager in this runtime).'
  const proposal = await board.get(sessionId, proposalId)
  if (!proposal) return `Refused: this session has no proposal ${proposalId}.`
  if (proposal.mode === 'offer' && proposal.state === 'proposed') {
    return `Refused: the user has not chosen yet for proposal ${proposalId}; nothing can start before they do.`
  }
  const startable =
    (proposal.mode === 'suggest' && proposal.state === 'proposed') ||
    (proposal.mode === 'offer' && proposal.state === 'accepted_awaiting_brief')
  if (!startable) {
    return `Refused: proposal ${proposalId} is ${proposalStateWords(proposal)}; it cannot be started.`
  }
  const mismatch = proposalStartMismatch(proposal, input)
  if (mismatch) return `Refused: ${mismatch}`

  const launcher = proposalLauncherFor(context)
  board.setLauncher(sessionId, launcher)
  const result = await board.start(sessionId, proposalId, launcher, input)
  if (result.ok) return `Started proposal ${proposalId}. ${result.launch.text}`
  if (result.text) return result.text
  const now = await board.get(sessionId, proposalId)
  return now
    ? `Refused: proposal ${proposalId} is ${proposalStateWords(now)}; it cannot be started.`
    : `Refused: ${result.reason}`
}

export async function spawnChildSession(
  input: SpawnSessionInput,
  context: ToolCallContext,
): Promise<{ data: string }> {
  const typeError = checkChildStringFields(input, CHILD_SESSION_INPUT_FIELDS)
  if (typeError) return { data: `Refused: ${typeError}` }
  if (routineOriginIdOf(context.options) !== undefined) {
    return { data: 'Refused: a routine turn cannot start child sessions; message an existing worker instead.' }
  }
  const proposalId = input.proposalId?.trim() ?? ''
  if (proposalId) return { data: await startProposedChild(proposalId, input, context) }
  return { data: (await launchChildSession(input, context)).text }
}

export const SpawnSessionTool: ToolContract<SpawnSessionInput, string> = declareTool({
  name: SPAWN_SESSION_TOOL_NAME,
  discoveryHint: 'start a child session of its own under this one, fresh from a briefing or forked from this conversation',
  argsSchema: SCHEMA,
  strict: false,
  description: async () => DESCRIPTION,
  parallelSafe: () => false,
  readsOnly: () => false,
  async checkInput(input: SpawnSessionInput, _context: ToolCallContext): Promise<InputCheck> {
    const typeError = checkChildStringFields(input, CHILD_SESSION_INPUT_FIELDS)
    return typeError ? { result: false, message: typeError, errorCode: 1 } : { result: true }
  },
  async call(input: SpawnSessionInput, context: ToolCallContext) {
    return spawnChildSession(input, context)
  },
})

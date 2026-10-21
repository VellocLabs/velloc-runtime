/**
 * Contract: permission for one tool call (F-26). `decideToolPermission` answers
 * allow, deny, or the ONE next ask, with no side effect or wait, in a fixed order:
 * resume → plan-mode gate → file pipeline or rule gate → path-safety ask →
 * explicit allow → the tool's selfVerdict. `settlePermissionAsk` settles an ask.
 * Security: a path-safety ask is never cleared by an extension's allow
 * (`assertSafetyAskStands` fails closed).
 */
import type {
  ModelReplyRow,
  ApprovalMode,
  ToolUseConfirmResolution,
} from '../../runtime/RuntimeTypes'
import type { ToolContract } from '../toolContract'
import { emptyPermissionRuleSet, type ToolPermissionResult } from '../permissionVerdict'
import type { ToolCallContext } from '../toolCallContext'
import { traceLine } from '../../utils/debugLog'
import {
  PERMISSION_REQUEST_DENIED,
  confirmWithPermissionRequestHooks,
  permissionSuggestionsOf,
  permissionUpdatesOfHook,
  runPermissionRequestHooks,
} from '../../lifecycleHooks/permissionRequestHooks'
import { applyRuleEdits } from '../../permissions/ruleUpdates'
import { isToolAllowedInPlanMode, planModeRejectMessage } from '../../permissions/planMode'
import { confinedFileAccessDenial, isLocalAccessConfined } from '../../permissions/chatLocalAccess'
import { planDocPath } from '../../utils/planFiles'
import {
  getScratchpadDirectoryPath,
  resolveSessionStorageBase,
} from '../../utils/conversationStoragePaths'
import {
  evaluateRuleGate,
  suggestAllowRule,
  approvalPromptText,
} from '../../permissions/ruleEngine'
import { autoRejectMessage, dontAskRejectMessage } from '../../permissions/denialMessages'
import { evaluateWriteTarget, describePathGuardAsk } from '../../permissions/protectedPaths'
import {
  vetFileRead,
  vetFileWrite,
  proposeAllowRules,
  type FilePermissionContext,
} from '../../permissions/filesystemPermission'
import { extractFilePath } from '../../permissions/filePathRuleMatching'
import { dirnameRuntimePath, resolveRuntimePath } from '../../utils/runtimePaths'
import { getMemoryDir } from '../../memory/memoryPaths'
import { fsForContext } from '../../utils/fs/runtimeFs'
import { checkToolThroughMods } from './toolCheckThroughMods'
import { raisesToolCall } from './toolCallThroughMods'
import { runInputOf, toolOutcomeMessage } from './toolResultShaping'
import type { AdmittedRun, DeferredMessageUpdate, StageStep } from './executeToolCall'

/** File tools: decided by the file read / write pipelines, not the rule
 *  gate. The nested `exec` gate classifies with the same sets. */
export const FILE_READ_TOOLS = new Set(['Read', 'Glob', 'Grep'])
export const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit'])

/** The rule set a call was decided under. An ask settled later resumes
 *  against this same snapshot. */
type RuleSetSnapshot = ReturnType<ToolCallContext['readAppState']>['permissionRules']

/** Where the verdict stopped for an ask. `hook`: an ask a `tool.check`
 *  extension forced. */
export type PermissionAskStage = 'file' | 'rule' | 'fsSafety' | 'self' | 'hook'

/** What an allowed ask resumes with: its stage, the snapshot, the input the
 *  user approved. */
export type PermissionAskResume = {
  stage: PermissionAskStage
  ruleSet: RuleSetSnapshot
  askedInput: Record<string, unknown>
}

/** What the confirm dialog and the pending banner show beside an ask. */
export type ToolUseConfirmMetadata = {
  summary?: string
  suggestedRule?: string
  reason?: 'sensitive-path' | 'outside-workspace' | 'suspicious-path'
  directory?: string
  planText?: string
  planFilePath?: string
  restoreMode?: ApprovalMode
  /** Permission updates the dialog offers (a mode switch, extra folders). */
  suggestions?: Array<
    | { type: 'setMode'; mode: string }
    | { type: 'addDirectories'; directories: string[] }
  >
}

/**
 * The verdict for one call, before anything is done about it. `allow`
 * carries the input to run; `deny` the model's error (and a debug line);
 * `ask` everything the dialog needs and where to resume. `reason` / `rule`
 * are what `tool.check` reports of the engine's own verdict.
 */
export type ToolPermissionVerdict =
  | {
      decision: 'allow'
      updatedInput: Record<string, unknown>
      /** The tool's own answer when it stands (an interactive tool's `ask`
       *  rides on to its halt), else the allow. */
      permissionResult: ToolPermissionResult | undefined
      reason?: string
      rule?: string
    }
  | { decision: 'deny'; message: string; log?: string; reason?: string; rule?: string }
  | {
      decision: 'ask'
      requestedInput: Record<string, unknown>
      message?: string
      metadata?: ToolUseConfirmMetadata
      /** A path-safety ask: bypass modes and an extension's allow leave it
       *  standing. */
      safety: boolean
      resume: Omit<PermissionAskResume, 'askedInput'>
      reason?: string
      rule?: string
    }

/** The session scratchpad at the address the system prompt advertises. */
export function getScratchpadDirForContext(callContext: ToolCallContext): string | undefined {
  const base = resolveSessionStorageBase({
    storageBase: callContext.options.sessionStorageBase,
    homeDir: callContext.options.homeDir,
    projectRoot: callContext.options.projectRoot,
  })
  return base ? getScratchpadDirectoryPath(base, callContext.options.sessionId) : undefined
}

function memoryDirOf(callContext: ToolCallContext): string | undefined {
  const runtimeConfig = callContext.options.runtimeConfig
  return runtimeConfig
    ? getMemoryDir(callContext.options.cwd, runtimeConfig, {
        projectRoot: callContext.options.projectRoot,
        homeDir: callContext.options.homeDir,
        memorySettings: callContext.options.memorySettings,
      })
    : undefined
}

/** The context the file read / write pipelines decide with: the memory-dir
 *  carve-out, the plan file, the scratchpad, the rules. Shared with the
 *  nested `exec` gate so both decide identically. */
export function buildFilePermissionContext(
  callContext: ToolCallContext,
  ruleSet: RuleSetSnapshot,
): FilePermissionContext {
  const options = callContext.options
  return {
    cwd: options.cwd,
    projectRoot: options.projectRoot,
    homeDir: options.homeDir,
    configHome: options.homeDir
      ? `${options.homeDir.replace(/\\/g, '/').replace(/\/+$/, '')}/.velloc`
      : undefined,
    sessionId: options.sessionId,
    extraWorkspaceRoots: ruleSet.extraWorkspaceRoots,
    mode: ruleSet.mode,
    ruleLists: ruleSet.ruleLists,
    allowRuleBook: ruleSet.allowRuleBook as Record<string, string[]>,
    denyRuleBook: ruleSet.denyRuleBook as Record<string, string[]>,
    askRuleBook: ruleSet.askRuleBook as Record<string, string[]>,
    memoryDir: memoryDirOf(callContext),
    planFilePath: planDocPath(callContext),
    freeWriteDir: getScratchpadDirForContext(callContext),
    fs: fsForContext(callContext),
  }
}

/** The parent folder of an out-of-workspace target, offered so the dialog
 *  can grant the folder rather than one rule. */
function folderToOffer(
  reason: string | undefined,
  target: string,
  callContext: ToolCallContext,
): string | undefined {
  return reason === 'outside-workspace' && target
    ? dirnameRuntimePath(resolveRuntimePath(callContext.options.cwd, target))
    : undefined
}

/**
 * The path-safety ask for `rawInput`, or null when the target is safe:
 * sensitive write paths, suspicious paths and targets outside the workspace.
 * The agent's own memory folder is carved out.
 */
export function filePathSafetyAsk(
  tool: ToolContract,
  rawInput: Record<string, unknown>,
  callContext: ToolCallContext,
  ruleSet: RuleSetSnapshot,
  hasExplicitAllowRule: boolean,
): ToolPermissionVerdict | null {
  const fsSafety = evaluateWriteTarget(tool.name, rawInput, {
    cwd: callContext.options.cwd,
    projectRoot: callContext.options.projectRoot,
    extraWorkspaceRoots: ruleSet.extraWorkspaceRoots,
    hasExplicitAllowRule,
    memoryDir: memoryDirOf(callContext),
  })
  if (!fsSafety) return null
  const target = extractFilePath(rawInput) ?? ''
  const summary = describePathGuardAsk(tool.name, fsSafety, target)
  const { suggestedRule } = suggestAllowRule(tool.name, rawInput)
  const directory = folderToOffer(fsSafety, target, callContext)
  return {
    decision: 'ask',
    requestedInput: rawInput,
    message: 'Permission required',
    metadata: { suggestedRule, summary, reason: fsSafety, directory },
    safety: true,
    resume: { stage: 'fsSafety', ruleSet },
    reason: summary,
  }
}


type GateInputs = {
  tool: ToolContract
  rawInput: Record<string, unknown>
  callContext: ToolCallContext
  ruleSet: RuleSetSnapshot
}

/** Plan mode refuses every tool that is not read-only (or the way out). */
function planModeGate({ tool, rawInput, callContext, ruleSet }: GateInputs): ToolPermissionVerdict | null {
  if (
    ruleSet?.mode !== 'plan' ||
    isToolAllowedInPlanMode(tool, rawInput, {
      cwd: callContext.options.cwd,
      path: planDocPath(callContext),
    })
  ) {
    return null
  }
  const rejection = planModeRejectMessage(tool.name)
  return {
    decision: 'deny',
    message: rejection,
    log: `[tool] ${tool.name} denied by plan-mode gate`,
    reason: rejection,
  }
}

/**
 * The file read / write pipeline for a file tool: a verdict to return, or
 * the allow it settled on (`settled`), or nothing decided. Bypass modes skip
 * its non-safety asks.
 */
/** A chat session's file tools stay inside its memory, skill and upload roots, in every mode. */
function confinedSessionGate({ tool, rawInput, callContext }: GateInputs): ToolPermissionVerdict | null {
  if (!isLocalAccessConfined(callContext.options.templateType)) return null
  const skillRoots = callContext.options.commands
    .map(command => command.baseDir)
    .filter((dir): dir is string => typeof dir === 'string' && dir.length > 0)
  const message = confinedFileAccessDenial(tool.name, rawInput, {
    cwd: callContext.options.cwd,
    memoryDir: memoryDirOf(callContext),
    skillRoots,
  })
  if (!message) return null
  return {
    decision: 'deny',
    message,
    log: `[tool] ${tool.name} denied by confined-session gate`,
    reason: message,
  }
}

async function fileToolGate(
  inputs: GateInputs,
): Promise<{ verdict: ToolPermissionVerdict } | { settled: ToolPermissionResult } | null> {
  const { tool, rawInput, callContext, ruleSet } = inputs
  const fileContext = buildFilePermissionContext(callContext, ruleSet)
  const isWrite = FILE_WRITE_TOOLS.has(tool.name)
  const decision = isWrite
    ? await vetFileWrite(tool.name, rawInput, fileContext)
    : await vetFileRead(tool.name, rawInput, fileContext)

  if (decision.behavior === 'deny') {
    const message = decision.message ?? 'Permission denied.'
    return {
      verdict: {
        decision: 'deny',
        message,
        log: `[tool] ${tool.name} denied by file permission pipeline`,
        reason: message,
      },
    }
  }
  if (decision.behavior === 'ask') {
    const isSafetyAsk = decision.verdictReason?.type === 'safetyCheck'
    const isBypass = ruleSet.mode === 'bypassPermissions'
    if (isBypass && !isSafetyAsk) {
      return { settled: { behavior: 'allow', updatedInput: rawInput } }
    }
    const target = extractFilePath(rawInput) ?? ''
    const { suggestedRule } = suggestAllowRule(tool.name, rawInput)
    const safetyReason =
      decision.verdictReason?.type === 'safetyCheck'
        ? (decision.verdictReason.reason as ToolUseConfirmMetadata['reason'])
      : undefined
    const message = decision.message ?? 'Permission required'
    return {
      verdict: {
        decision: 'ask',
        requestedInput: rawInput,
        message,
        metadata: {
          suggestedRule,
          summary: decision.message,
          reason: safetyReason,
          directory: folderToOffer(safetyReason, target, callContext),
          suggestions: proposeAllowRules(target, isWrite ? 'write' : 'read', fileContext),
        },
        safety: isSafetyAsk,
        resume: { stage: 'file', ruleSet },
        reason: message,
      },
    }
  }
  if (decision.behavior === 'allow') {
    return { settled: { behavior: 'allow', updatedInput: decision.updatedInput ?? rawInput } }
  }
  return null
}

type RuleOutcome = { behavior: string; ruleString?: string; ruleSource?: string }

/** The declarative allow / deny / ask rules and the mode, for tools the file
 *  pipeline did not settle. */
function ruleGateVerdict(inputs: GateInputs, rule: RuleOutcome): ToolPermissionVerdict | null {
  const { tool, rawInput, ruleSet } = inputs
  if (rule.behavior === 'deny') {
    const message = rule.ruleString
      ? `Permission denied by rule "${rule.ruleString}".`
      : 'Permission denied by a deny rule.'
    return {
      decision: 'deny',
      message,
      log: `[tool] ${tool.name} denied by permission rule${rule.ruleString ? ` "${rule.ruleString}"` : ''}`,
      reason: message,
      rule: rule.ruleString,
    }
  }
  if (rule.behavior === 'ask') {
    const { suggestedRule, summary } = suggestAllowRule(tool.name, rawInput)
    const message = rule.ruleString
      ? approvalPromptText(tool.name, {
          type: 'rule',
          rule: rule.ruleString,
          source: (rule.ruleSource ?? 'unknown') as never,
        })
      : 'Permission required'
    return {
      decision: 'ask',
      requestedInput: rawInput,
      message,
      metadata: { suggestedRule, summary },
      safety: false,
      resume: { stage: 'rule', ruleSet },
      reason: message,
      rule: rule.ruleString,
    }
  }
  return null
}

/** The tool's own answer, turned into the verdict's deny / ask / allow. */
function selfVerdictOutcome(
  inputs: GateInputs,
  gateVerdict: ToolPermissionResult | undefined,
  rule: string | undefined,
): ToolPermissionVerdict {
  const { tool, rawInput, ruleSet } = inputs
  const behavior =
    typeof gateVerdict === 'object' && gateVerdict !== null && 'behavior' in gateVerdict
      ? gateVerdict.behavior
      : undefined
  if (behavior === 'deny') {
    const message = `Permission denied: ${(gateVerdict as { message?: string }).message ?? 'Tool use blocked by permission rules.'}`
    return { decision: 'deny', message, reason: message }
  }
  if (behavior === 'ask' && !tool.haltsForUser?.()) {
    const { suggestedRule, summary } = suggestAllowRule(tool.name, rawInput)
    const message = (gateVerdict as { message?: string }).message
    return {
      decision: 'ask',
      requestedInput: runInputOf(gateVerdict, rawInput),
      message,
      metadata: { suggestedRule, summary },
      safety: false,
      resume: { stage: 'self', ruleSet },
      reason: message,
    }
  }
  // Allowed — or an interactive tool's own ask, which rides on to its halt.
  return {
    decision: 'allow',
    updatedInput: runInputOf(gateVerdict, rawInput),
    permissionResult: gateVerdict,
    ...(rule !== undefined ? { rule } : {}),
  }
}

/**
 * Whether `tool` may run `rawInput`: allow, deny, or the first ask; no side effect.
 * `after` resumes from an allowed ask; after a non-file rule ask the path-safety
 * check still runs.
 */
export async function decideToolPermission(
  tool: ToolContract,
  rawInput: Record<string, unknown>,
  callContext: ToolCallContext,
  after?: PermissionAskResume,
): Promise<ToolPermissionVerdict> {
  const ruleSet = after?.ruleSet ?? callContext.readAppState().permissionRules
  const inputs: GateInputs = { tool, rawInput, callContext, ruleSet }
  const isFileTool = FILE_READ_TOOLS.has(tool.name) || FILE_WRITE_TOOLS.has(tool.name)
  const safetyAsk = (hasExplicitAllowRule: boolean) =>
    filePathSafetyAsk(tool, rawInput, callContext, ruleSet, hasExplicitAllowRule)

  const confinedDenial = confinedSessionGate(inputs)
  if (confinedDenial) return confinedDenial

  if (after) {
    if (after.stage === 'rule' && !isFileTool) {
      const ask = safetyAsk(false)
      if (ask) return ask
    }
    return {
      decision: 'allow',
      updatedInput: after.askedInput,
      permissionResult: { behavior: 'allow', updatedInput: after.askedInput },
    }
  }

  const planDenial = planModeGate(inputs)
  if (planDenial) return planDenial

  let gateVerdict: ToolPermissionResult | undefined
  if (isFileTool) {
    const file = await fileToolGate(inputs)
    if (file && 'verdict' in file) return file.verdict
    if (file) gateVerdict = file.settled
  }

  const rule: RuleOutcome = gateVerdict
    ? { behavior: gateVerdict.behavior }
    : (evaluateRuleGate(tool, rawInput, ruleSet) as RuleOutcome)
  const ruled = ruleGateVerdict(inputs, rule)
  if (ruled) return ruled

  // A file tool the pipeline settled already had its safety check.
  if (!(isFileTool && gateVerdict)) {
    const ask = safetyAsk(rule.behavior === 'allow' && Boolean(rule.ruleString))
    if (ask) return ask
  }

  // An explicit allow rule stands in for the tool's own check.
  const explicitAllow = rule.behavior === 'allow'
  gateVerdict ??= explicitAllow
    ? { behavior: 'allow' as const, updatedInput: rawInput }
    : ((await tool.selfVerdict(rawInput, callContext)) as ToolPermissionResult)
  return selfVerdictOutcome(inputs, gateVerdict, explicitAllow ? rule.ruleString : undefined)
}

/**
 * Fail-closed guard: a verdict an extension lifted may not skip a
 * path-safety ask. Returns the ask that must stand, or the verdict.
 */
export function assertSafetyAskStands(
  before: ToolPermissionVerdict,
  after: ToolPermissionVerdict,
): ToolPermissionVerdict {
  if (before.decision === 'ask' && before.safety && after.decision === 'allow') {
    traceLine('[tool] a path-safety ask was lifted by an extension; it stands', {
      level: 'warn',
    })
    return before
  }
  return after
}

/** The confirm dialog for one ask, with the PermissionRequest hooks racing
 *  beside it. Null when no dialog is installed. */
export async function requestQueuedToolUseConfirm(params: {
  tool: ToolContract
  input: Record<string, unknown>
  message?: string
  metadata?: ToolUseConfirmMetadata
  callRef: string
  modelReply: ModelReplyRow
  callContext: ToolCallContext
}): Promise<ToolUseConfirmResolution | null> {
  const requestConfirm = params.callContext.requestToolUseConfirm
  if (!requestConfirm) return null

  let description = params.tool.name
  try {
    const raw = params.callContext.readAppState().permissionRules
    description = await params.tool.description(params.input, {
      isNonInteractiveSession: params.callContext.options.isNonInteractiveSession,
      permissionRules: {
        ...emptyPermissionRuleSet(),
        ...raw,
        extraWorkspaceRoots: raw.extraWorkspaceRoots ?? new Map(),
      },
      tools: params.callContext.options.tools,
      agents: params.callContext.options.agentDefinitions.enabledAgents,
    })
  } catch {
    // The description only labels the dialog.
  }

  return confirmWithPermissionRequestHooks(
    requestConfirm,
    {
      assistantMessage: params.modelReply,
      toolName: params.tool.name,
      description,
      input: params.input,
      approvalCallId: params.callRef,
      permissionResult: {
        behavior: 'ask',
        message: params.message,
        updatedInput: params.input,
        ...params.metadata,
      },
      askedAtMs: Date.now(),
    },
    params.callContext,
    permissionSuggestionsOf(params.metadata),
  )
}

/** The model's text for a declined dialog: the user's words, else the
 *  interruption, else `fallback`. */
export function confirmRejectionMessage(
  behavior: 'reject' | 'abort',
  feedback: string | undefined,
  fallback: string,
): string {
  const trimmed = feedback?.trim()
  if (trimmed) return trimmed
  return behavior === 'abort' ? 'Interrupted by user' : fallback
}

/**
 * A context that cannot show prompts gives PermissionRequest hooks one
 * chance to decide, then denies. A hook's allow may amend the input and
 * add rules for the session; its deny may interrupt the turn; a block with
 * no decision denies with the hook's text. Hook failures fall through to the
 * plain auto-deny. Shared with the nested `exec` / workspace gates.
 */
export async function resolveHeadlessPermissionDecision(
  tool: Pick<ToolContract, 'name'>,
  rawInput: Record<string, unknown>,
  _callRef: string,
  callContext: ToolCallContext,
): Promise<
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string }
> {
  const hookResult = await runPermissionRequestHooks({
    toolName: tool.name,
    input: rawInput,
    toolUseContext: callContext,
  })
  const decision = hookResult?.permissionRequest
  if (decision?.behavior === 'allow') {
    const updates = permissionUpdatesOfHook(decision.updatedPermissions)
    if (updates.length > 0) {
      callContext.writeAppState(prev => ({
        ...prev,
        permissionRules: applyRuleEdits(prev.permissionRules, updates),
      }))
    }
    traceLine(
      `[tool] ${tool.name} allowed by PermissionRequest hook (non-interactive context)`,
      { level: 'info' },
    )
    return {
      behavior: 'allow',
      ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}),
    }
  }
  if (decision?.behavior === 'deny') {
    if (decision.interrupt) {
      traceLine(`[tool] PermissionRequest interrupt: tool=${tool.name}`, { level: 'info' })
      callContext.cancelSource.abort()
    }
    return { behavior: 'deny', message: decision.message || PERMISSION_REQUEST_DENIED }
  }
  if (hookResult?.blocked) {
    const reason = hookResult.errors.join('\n')
    return {
      behavior: 'deny',
      message: reason
        ? `Permission denied by PermissionRequest hook: ${reason}`
        : PERMISSION_REQUEST_DENIED,
    }
  }
  return { behavior: 'deny', message: autoRejectMessage(tool.name) }
}

/** How one ask was settled: run with an input, refuse with a message, or
 *  halt the loop on the legacy pending entry. */
type AskSettlement =
  | { kind: 'allow'; updatedInput: Record<string, unknown> }
  | { kind: 'deny'; message: string }
  | { kind: 'halt' }

/** Settle one ask: dontAsk → headless decision → dialog → pending entry. */
async function settlePermissionAsk(
  run: AdmittedRun,
  ask: Extract<ToolPermissionVerdict, { decision: 'ask' }>,
): Promise<AskSettlement> {
  const { tool, callContext } = run
  const ruleSet = callContext.readAppState().permissionRules
  if (ruleSet.mode === 'dontAsk') {
    return { kind: 'deny', message: dontAskRejectMessage(tool.name) }
  }
  if (ruleSet.suppressAsks) {
    const decision = await resolveHeadlessPermissionDecision(
      tool,
      ask.requestedInput,
      run.block.toolCallId,
      callContext,
    )
    return decision.behavior === 'allow'
      ? { kind: 'allow', updatedInput: decision.updatedInput ?? ask.requestedInput }
      : { kind: 'deny', message: decision.message }
  }
  const resolution = await requestQueuedToolUseConfirm({
    tool,
    input: ask.requestedInput,
    message: ask.message,
    metadata: ask.metadata,
    callRef: run.block.toolCallId,
    modelReply: run.modelReply,
    callContext,
  })
  if (!resolution) {
    // No dialog installed: stage the pending entry for the banner and halt.
    callContext.writeAppState(prev => ({
      ...prev,
      pendingPermissions: {
        ...prev.pendingPermissions,
        [run.block.toolCallId]: {
          toolName: tool.name,
          summary: ask.metadata?.summary,
          suggestedRule: ask.metadata?.suggestedRule ?? tool.name,
          reason: ask.metadata?.reason,
          directory: ask.metadata?.directory,
          suggestions: ask.metadata?.suggestions,
        },
      },
    }))
    return { kind: 'halt' }
  }
  if (resolution.behavior !== 'allow') {
    return {
      kind: 'deny',
      message: confirmRejectionMessage(
        resolution.behavior,
        resolution.feedback,
        'Permission denied by the user. Do not retry this call.',
      ),
    }
  }
  return { kind: 'allow', updatedInput: resolution.updatedInput ?? ask.requestedInput }
}

/** An error tool_result for a refused call. */
export function refusalUpdate(run: AdmittedRun, content: string): DeferredMessageUpdate {
  return {
    message: toolOutcomeMessage({
      content,
      callRef: run.block.toolCallId,
      modelReply: run.modelReply,
      deps: run.deps,
      toolName: run.tool.name,
      toolArgs: run.rawInput,
      toolResultData: content,
      isError: true,
    }),
  }
}

/** Stage 3: the engine's verdict. */
export async function* verdictStage(run: AdmittedRun): AsyncGenerator<DeferredMessageUpdate, StageStep> {
  run.verdict = await decideToolPermission(run.tool, run.rawInput, run.callContext)
  return 'continue'
}

/** Stage 4: `tool.check` — an extension's word on the verdict, raised once
 *  before the first ask. Tools that halt for the user are not raised. */
export async function* extensionCheckStage(run: AdmittedRun): AsyncGenerator<DeferredMessageUpdate, StageStep> {
  const { tool, rawInput, callContext } = run
  const mods = callContext.options.mods
  if (!mods || !raisesToolCall(tool)) return 'continue'
  const before = run.verdict!
  const settled = await checkToolThroughMods({
    mods,
    tool,
    input: rawInput,
    verdict: before,
    callRef: run.block.toolCallId,
    agentId: callContext.agentId ?? mods.agentId,
    signal: callContext.cancelSource.signal,
    context: callContext.modCallContext,
    safetyAsk: () =>
      filePathSafetyAsk(tool, rawInput, callContext, callContext.readAppState().permissionRules, false),
  })
  run.verdict = assertSafetyAskStands(before, settled)
  return 'continue'
}

/** Stage 5: settle asks until the verdict is allow or deny; an allowed ask
 *  is decided again from where it stood. */
export async function* askStage(run: AdmittedRun): AsyncGenerator<DeferredMessageUpdate, StageStep> {
  let verdict = run.verdict!
  while (verdict.decision === 'ask') {
    const settlement = await settlePermissionAsk(run, verdict)
    if (settlement.kind === 'deny') {
      yield refusalUpdate(run, settlement.message)
      return 'stop'
    }
    if (settlement.kind === 'halt') {
      yield { pendingToolUse: { toolUseId: run.block.toolCallId, toolName: run.tool.name } }
      return 'stop'
    }
    verdict = await decideToolPermission(run.tool, run.rawInput, run.callContext, {
      ...verdict.resume,
      askedInput: settlement.updatedInput,
    })
  }
  run.verdict = verdict
  return 'continue'
}

/** Stage 6: a deny becomes the model's error; an allow records the gate's
 *  answer the call runs with. */
export async function* denyGateStage(run: AdmittedRun): AsyncGenerator<DeferredMessageUpdate, StageStep> {
  const verdict = run.verdict!
  if (verdict.decision === 'deny') {
    if (verdict.log) traceLine(verdict.log, { level: 'info' })
    yield refusalUpdate(run, verdict.message)
    return 'stop'
  }
  if (verdict.decision === 'allow') run.gateVerdict = verdict.permissionResult
  return 'continue'
}

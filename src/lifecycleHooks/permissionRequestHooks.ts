/**
 * The `PermissionRequest` classic hooks (F-7; under the mods', F-25). On an
 * interactive ask they run beside the dialog and whichever answers first wins;
 * on a headless ask they get one chance before the auto-deny. A hook decides
 * with `hookSpecificOutput.decision` (`allow` / `deny`); none decides nothing.
 */

import type { ToolCallContext } from '../toolkit/toolCallContext'
import type {
  PendingApproval,
  ToolUseConfirmDecision,
  ToolUseConfirmResolution,
} from '../runtime/RuntimeTypes'
import { traceLine } from '../utils/debugLog'
import type { RuleEdit, RuleTarget } from '../permissions/ruleUpdates'
import { formatRuleText } from '../permissions/ruleText'
import { runClassicHooks } from './classicThroughMods'
import { fireApprovalAsked, type HookBatchVerdict } from './runHooks'
import { buildHookInput } from './hookInput'
import type { PermissionRequestDecision } from './hookOutput'
import { createBashHookCommandRunner } from './hookCommandRunner'
import { createModelHookPromptRunner } from './hookPromptRunner'
import { createForkedAgentHookRunner } from './hookAgentRunner'
import { createNetworkHookHttpRunner } from './hookHttpRunner'

/** The feedback of a hook's deny that gave no message; it names the hook
 *  event, as Velloc's headless deny always has. */
export const PERMISSION_REQUEST_DENIED = 'Permission denied by PermissionRequest hook.'

/**
 * Run the `PermissionRequest` hooks for one ask: matched on the tool name,
 * stdin `{ tool_name, tool_input, permission_suggestions? }`. The aggregate
 * (its `permissionRequest` is the decision, if any hook gave one), or
 * undefined when nothing could run — no session, or the hooks failed.
 */
export async function runPermissionRequestHooks(params: {
  toolName: string
  input: Record<string, unknown>
  suggestions?: unknown[]
  toolUseContext: ToolCallContext
  signal?: AbortSignal
}): Promise<HookBatchVerdict | undefined> {
  const { toolUseContext } = params
  const sessionId = toolUseContext.options.sessionId
  if (!sessionId) return undefined
  const appState = toolUseContext.readAppState()
  const signal = params.signal ?? toolUseContext.cancelSource.signal
  const hookInput = {
    cwd: toolUseContext.options.cwd,
    projectRoot: toolUseContext.options.projectRoot,
    permissionMode: appState.permissionRules?.mode,
    toolInput: params.input,
    ...(params.suggestions?.length ? { alwaysAllowOffers: params.suggestions } : {}),
  }
  try {
    return await runClassicHooks(
      toolUseContext.options.mods,
      'PermissionRequest',
      () =>
        buildHookInput({
          event: 'PermissionRequest',
          sessionId,
          cwd: hookInput.cwd,
          permissionMode: hookInput.permissionMode,
          toolName: params.toolName,
          toolInput: params.input,
          alwaysAllowOffers: params.suggestions,
        }),
      () =>
        fireApprovalAsked({
          toolName: params.toolName,
          sessionId,
          appState,
          setAppState: toolUseContext.writeAppState,
          signal,
          commandRunner: createBashHookCommandRunner(toolUseContext),
          promptRunner: createModelHookPromptRunner(toolUseContext),
          agentRunner: createForkedAgentHookRunner(toolUseContext),
          httpRunner: createNetworkHookHttpRunner(toolUseContext),
          hookInput,
        }),
      signal,
    )
  } catch (error) {
    traceLine(
      `[hooks] PermissionRequest hooks failed: ${error instanceof Error ? error.message : String(error)}`,
      { level: 'warn' },
    )
    return undefined
  }
}

const DESTINATIONS: ReadonlySet<string> = new Set([
  'userSettings',
  'projectSettings',
  'localSettings',
  'session',
  'cliArg',
])
const RULE_BEHAVIORS: ReadonlySet<string> = new Set(['allow', 'deny', 'ask'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string')
}

/** A rule given as an object (`{ toolName, ruleContent? }`) or as a rule
 *  string (`"Bash(git *)"`), as Velloc's rule string. */
function ruleString(rule: unknown): string | undefined {
  if (typeof rule === 'string') return rule || undefined
  if (isRecord(rule) && typeof rule.toolName === 'string' && rule.toolName) {
    return formatRuleText({
      toolName: rule.toolName,
      ...(typeof rule.ruleContent === 'string' ? { ruleContent: rule.ruleContent } : {}),
    })
  }
  return undefined
}

/**
 * A hook's `updatedPermissions` as Velloc's permission updates. Entries that
 * are not well-formed permission updates are dropped, as a malformed rule
 * would be.
 */
export function permissionUpdatesOfHook(updates: readonly unknown[] | undefined): RuleEdit[] {
  const out: RuleEdit[] = []
  for (const update of updates ?? []) {
    if (!isRecord(update) || typeof update.destination !== 'string') continue
    if (!DESTINATIONS.has(update.destination)) continue
    const destination = update.destination as RuleTarget
    switch (update.type) {
      case 'addRules':
      case 'replaceRules':
      case 'removeRules': {
        if (typeof update.behavior !== 'string' || !RULE_BEHAVIORS.has(update.behavior)) continue
        if (!Array.isArray(update.rules)) continue
        const rules = update.rules.map(ruleString)
        if (rules.some(rule => rule === undefined)) continue
        out.push({
          type: update.type,
          behavior: update.behavior as 'allow' | 'deny' | 'ask',
          rules: rules as string[],
          destination,
        })
        break
      }
      case 'setMode':
        if (typeof update.mode !== 'string') continue
        out.push({ type: 'setMode', mode: update.mode as never, destination })
        break
      case 'addDirectories':
      case 'removeDirectories':
        if (!isStringArray(update.directories)) continue
        out.push({ type: update.type, directories: update.directories, destination })
        break
    }
  }
  return out
}

/** What the ask is told when a hook decides it. */
export function confirmDecisionOf(decision: PermissionRequestDecision): ToolUseConfirmDecision {
  if (decision.behavior === 'deny') {
    return { behavior: 'reject', feedback: decision.message || PERMISSION_REQUEST_DENIED }
  }
  const ruleEdits = permissionUpdatesOfHook(decision.updatedPermissions)
  return {
    behavior: 'allow',
    ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}),
    ...(ruleEdits.length > 0 ? { ruleEdits } : {}),
  }
}

/**
 * The "always allow" options of an ask, for the hook input's
 * `permission_suggestions`:
 * the suggested rule (`suggestedRule`, a `Tool(content)` string) as an
 * `addRules` to the local settings, and the ask's mode / directory
 * suggestions for the session.
 */
export function permissionSuggestionsOf(metadata: {
  suggestedRule?: string
  suggestions?: ReadonlyArray<
    { type: 'setMode'; mode: string } | { type: 'addDirectories'; directories: string[] }
  >
} | undefined): unknown[] {
  const out: unknown[] = []
  if (metadata?.suggestedRule) {
    const match = /^([^(]+)(?:\((.*)\))?$/s.exec(metadata.suggestedRule)
    if (match) {
      out.push({
        type: 'addRules',
        rules: [{ toolName: match[1], ...(match[2] ? { ruleContent: match[2] } : {}) }],
        behavior: 'allow',
        destination: 'localSettings',
      })
    }
  }
  for (const suggestion of metadata?.suggestions ?? []) {
    out.push({ ...suggestion, destination: 'session' })
  }
  return out
}

/**
 * Ask through `confirm` while the `PermissionRequest` hooks run beside the
 * dialog. A hook decision first settles the ask (`decidedBy: 'hook'`; a deny
 * with `interrupt` aborts the turn); the person answering first stops the hooks.
 */
export async function confirmWithPermissionRequestHooks(
  confirm: NonNullable<ToolCallContext['requestToolUseConfirm']>,
  item: PendingApproval,
  toolUseContext: ToolCallContext,
  suggestions?: unknown[],
): Promise<ToolUseConfirmResolution> {
  const hooks = new AbortController()
  const parent = toolUseContext.cancelSource.signal
  const stop = () => hooks.abort(parent.reason)
  if (parent.aborted) stop()
  else parent.addEventListener('abort', stop, { once: true })
  let decision: PermissionRequestDecision | undefined
  const decided = runPermissionRequestHooks({
    toolName: item.toolName,
    input: item.input,
    suggestions,
    toolUseContext,
    signal: hooks.signal,
  }).then(result => {
    if (hooks.signal.aborted || !result?.permissionRequest) return null
    decision = result.permissionRequest
    return confirmDecisionOf(decision)
  })
  try {
    const resolution = await confirm(item, { decided })
    if (
      resolution.decidedBy === 'hook' &&
      decision?.behavior === 'deny' &&
      decision.interrupt
    ) {
      traceLine(`[hooks] PermissionRequest interrupt: tool=${item.toolName}`, { level: 'info' })
      toolUseContext.cancelSource.abort()
    }
    return resolution
  } finally {
    parent.removeEventListener('abort', stop)
    hooks.abort()
  }
}

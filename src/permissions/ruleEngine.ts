/**
 * Rule-based permission engine: matches allow/deny/ask rules against a tool
 * call and folds in the permission mode. With empty rules and `default` mode,
 * every tool is `passthrough`.
 */

import {
  EDIT_TOOL_ID,
  READ_TOOL_ID,
  WRITE_TOOL_ID,
} from '../prompting/fileToolNames'
import { SHELL_TOOL_ID } from '../prompting/processToolNames'
import {
  parseRuleText,
  formatRuleText,
  type ToolRuleSpec,
} from './ruleText'
import { commandFitsPattern, compileCommandPattern } from './commandPattern'
import { extractFilePath, pathMatchesRule } from './filePathRuleMatching'
import { webFetchRuleContent, webFetchRuleContentMatches } from './webFetchRuleMatching'
import { PAGE_READ_TOOL_ID } from '../toolkit/builtin/webFetch/fetchPrompt'

import type { RulesByOrigin, VerdictReason } from '../toolkit/permissionVerdict'

export type RuleLists = {
  allow: string[]
  deny: string[]
  ask: string[]
}

/** The mode/rule context the gate reads from `appState.permissionRules`. */
export type RuleGateContext = {
  mode?: string
  ruleLists?: RuleLists
  /** Per-source rule maps. When present, the engine can
   *  report which source a matching rule came from. The merged `ruleLists`
   *  still drives the decision (deny > ask > allow); these maps add attribution
   *  for the UI message and future shadow detection / scoped deletion. */
  allowRuleBook?: RulesByOrigin
  denyRuleBook?: RulesByOrigin
  askRuleBook?: RulesByOrigin
}

export type RuleGateBehavior = 'allow' | 'deny' | 'ask' | 'passthrough'

export type RuleGateDecision = {
  behavior: RuleGateBehavior
  /** The matching rule string (for the deny/ask message + the ask modal). */
  ruleString?: string
  /** Which settings source the matching rule came from. */
  ruleSource?: string
}

const PWSH_TOOL_ID = 'PowerShell'
const NOTEBOOK_TOOL_ID = 'NotebookEdit'
// Local literals (not imports) so the pure rule engine stays free of the
// tools → agents module graph. Mirror `SPAWN_TOOL_ID` in toolkit/builtin/subagentLaunch.ts
// and `DEFAULT_WORKER_AGENT.name` in agents/builtInAgents.ts; the
// permission-rule-engine test pins them against those modules.
const SPAWN_TOOL_ID = 'Agent'
const GENERAL_PURPOSE_SUBAGENT_TYPE = 'general-purpose'
const EDIT_TOOL_NAMES = new Set<string>([
  WRITE_TOOL_ID,
  EDIT_TOOL_ID,
  NOTEBOOK_TOOL_ID,
])
/** Tools whose content rules are matched against a file-path argument. */
const FILE_PATH_TOOL_NAMES = new Set<string>([
  READ_TOOL_ID,
  WRITE_TOOL_ID,
  EDIT_TOOL_ID,
  NOTEBOOK_TOOL_ID,
])

/** Whether a rule's tool name matches an actual tool name (incl. MCP buckets). */
function toolNameMatches(ruleToolName: string, actualToolName: string): boolean {
  if (ruleToolName === actualToolName) return true
  // MCP server-level: `mcp__server` (or `mcp__server__*`) matches every tool
  // from that server (`mcp__server__tool`).
  if (actualToolName.startsWith('mcp__') && ruleToolName.startsWith('mcp__')) {
    const base = ruleToolName.endsWith('__*')
      ? ruleToolName.slice(0, -3)
      : ruleToolName
    return actualToolName === base || actualToolName.startsWith(`${base}__`)
  }
  return false
}

/** Whether a single parsed rule matches a tool call. */
export function permissionRuleValueMatchesTool(
  rule: ToolRuleSpec,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (!toolNameMatches(rule.toolName, toolName)) return false
  // Tool-wide rule (no content) — matches any call to this tool.
  if (rule.ruleContent === undefined) return true
  // Bash/PowerShell content rules match against the command string.
  if (rule.toolName === SHELL_TOOL_ID || rule.toolName === PWSH_TOOL_ID) {
    const command = typeof input.command === 'string' ? input.command : ''
    if (!command) return false
    return commandFitsPattern(compileCommandPattern(rule.ruleContent), command)
  }
  // File-tool content rules match the path argument against the rule's glob;
  // tools without a path arg don't match.
  if (FILE_PATH_TOOL_NAMES.has(rule.toolName)) {
    const filePath = extractFilePath(input)
    if (!filePath) return false
    return pathMatchesRule(rule.ruleContent, filePath)
  }
  // `Agent(<subagent_type>)` targets ONE sub-agent, e.g. `deny: ["Agent(Explore)"]`. Matched on the exact agent name; an Agent
  // call with no `subagent_type` runs general-purpose and matches only a rule
  // naming that. Without this the rule parsed fine and then silently never
  // fired — the same silent-no-op class as the file-path rules above.
  if (rule.toolName === SPAWN_TOOL_ID) {
    const requested =
      typeof input.subagent_type === 'string' && input.subagent_type
        ? input.subagent_type
        : GENERAL_PURPOSE_SUBAGENT_TYPE
    return requested === rule.ruleContent
  }
  // `WebFetch(domain:<host>)` matches the fetched URL's hostname exactly. Without this the rule parsed and then never
  // fired — a deny did not deny, an allow did not allow.
  if (rule.toolName === PAGE_READ_TOOL_ID) {
    const url = typeof input.url === 'string' ? input.url : ''
    if (!url) return false
    return webFetchRuleContentMatches(rule.ruleContent, url)
  }
  // Any other tool's content rule (rare) is not evaluated → no match.
  return false
}

/** First rule string in `rules` that matches the tool call, or undefined. */
function firstMatchingRule(
  rules: readonly string[] | undefined,
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (!rules) return undefined
  for (const ruleString of rules) {
    const rule = parseRuleText(ruleString)
    if (permissionRuleValueMatchesTool(rule, toolName, input)) return ruleString
  }
  return undefined
}

/**
 * Source precedence for by-source rule maps: the settings files (user → project
 * → local → flag → policy), then cliArg, command, session. The first source with
 * a matching rule wins for attribution. Deny-from-any-source still wins overall
 * (handled by the caller checking deny before allow/ask); this ordering only
 * affects which source is *named* for a matched rule.
 */
const RULE_SOURCE_PRECEDENCE: readonly (keyof RulesByOrigin)[] = [
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
  'cliArg',
  'command',
  'session',
]

/**
 * Find the first matching rule across a by-source map, returning the rule string
 * AND the source it came from (highest-precedence source first). Returns
 * undefined when no source has a matching rule. Falls back to nothing when the
 * map is empty/absent — the caller then relies on the merged `ruleLists`.
 */
function firstMatchingRuleBySource(
  bySource: RulesByOrigin | undefined,
  toolName: string,
  input: Record<string, unknown>,
): { ruleString: string; source: string } | undefined {
  if (!bySource) return undefined
  for (const source of RULE_SOURCE_PRECEDENCE) {
    const rules = bySource[source]
    if (!rules?.length) continue
    for (const ruleString of rules) {
      const rule = parseRuleText(ruleString)
      if (permissionRuleValueMatchesTool(rule, toolName, input)) {
        return { ruleString, source }
      }
    }
  }
  return undefined
}

/**
 * Ordered rule evaluation (no mode): deny > ask > allow > passthrough; an ask
 * rule out-ranks an allow rule.
 */
export function evaluatePermissionRules(params: {
  toolName: string
  input: Record<string, unknown>
  ruleLists?: RuleLists
}): RuleGateDecision {
  const { toolName, input, ruleLists } = params
  const deny = firstMatchingRule(ruleLists?.deny, toolName, input)
  if (deny) return { behavior: 'deny', ruleString: deny }
  const ask = firstMatchingRule(ruleLists?.ask, toolName, input)
  if (ask) return { behavior: 'ask', ruleString: ask }
  const allow = firstMatchingRule(ruleLists?.allow, toolName, input)
  if (allow) return { behavior: 'allow', ruleString: allow }
  return { behavior: 'passthrough' }
}

/**
 * Contract: deny rule → deny; ask rule → ask (deny under dontAsk; survives
 * bypass); allow rule → allow; bypassPermissions (or plan + bypass available)
 * → allow; acceptEdits + edit/read-only tool → allow; else passthrough, where
 * the tool's checkPermissions decides (Nexus default: allow).
 */
export function evaluateRuleGate(
  tool: { name: string; readsOnly: (input: Record<string, unknown>) => boolean },
  input: Record<string, unknown>,
  ctx: RuleGateContext | undefined,
): RuleGateDecision {
  const ruleLists = ctx?.ruleLists
  const mode = ctx?.mode ?? 'default'

  // 1. deny rule — highest precedence, immune to bypass/acceptEdits.
  //    Prefer by-source attribution; fall back to merged list.
  const denyBySrc = firstMatchingRuleBySource(ctx?.denyRuleBook, tool.name, input)
  const deny = denyBySrc?.ruleString ?? firstMatchingRule(ruleLists?.deny, tool.name, input)
  if (deny) return { behavior: 'deny', ruleString: deny, ruleSource: denyBySrc?.source }

  // 2. ask rule — BEFORE allow and before the bypass/acceptEdits
  //    short-circuits, so it survives bypass (a configured safeguard that
  //    bypass must not skip). Under `dontAsk` a would-be ask becomes
  //    a deny.
  const askBySrc = firstMatchingRuleBySource(ctx?.askRuleBook, tool.name, input)
  const ask = askBySrc?.ruleString ?? firstMatchingRule(ruleLists?.ask, tool.name, input)
  if (ask) {
    return mode === 'dontAsk'
      ? { behavior: 'deny', ruleString: ask, ruleSource: askBySrc?.source }
      : { behavior: 'ask', ruleString: ask, ruleSource: askBySrc?.source }
  }

  // 3. allow rule — an explicit grant, applied regardless of mode.
  const allowBySrc = firstMatchingRuleBySource(ctx?.allowRuleBook, tool.name, input)
  const allow = allowBySrc?.ruleString ?? firstMatchingRule(ruleLists?.allow, tool.name, input)
  if (allow) return { behavior: 'allow', ruleString: allow, ruleSource: allowBySrc?.source }

  // 4. bypass mode → allow (deny + ask + allow already decided above). Plan
  //    mode always keeps its own gate, even when it was entered from bypass.
  if (mode === 'bypassPermissions') {
    return { behavior: 'allow' }
  }

  // 5. acceptEdits → auto-allow edits + read-only tools.
  if (mode === 'acceptEdits' && (EDIT_TOOL_NAMES.has(tool.name) || tool.readsOnly(input))) {
    return { behavior: 'allow' }
  }

  // 6. passthrough — tool's own checkPermissions decides (Nexus default: allow).
  return { behavior: 'passthrough' }
}

/**
 * The rule string that "Allow" / "Always allow" should add to
 * `permissions.allow` for a given tool call, plus a short human summary for
 * the prompt. Bash/PowerShell suggest an exact-command rule (`Bash(<cmd>)`);
 * WebFetch the URL's host (`WebFetch(domain:<host>)`), so
 * allowing one site does not allow every site; other tools suggest a
 * tool-wide rule (`<ToolName>`).
 */
export function suggestAllowRule(
  toolName: string,
  input: Record<string, unknown>,
): { suggestedRule: string; summary?: string } {
  if (
    (toolName === SHELL_TOOL_ID || toolName === PWSH_TOOL_ID) &&
    typeof input.command === 'string' &&
    input.command.length > 0
  ) {
    const command = input.command
    return {
      suggestedRule: formatRuleText({ toolName, ruleContent: command }),
      summary: command,
    }
  }
  if (toolName === PAGE_READ_TOOL_ID && typeof input.url === 'string') {
    const ruleContent = webFetchRuleContent(input.url)
    if (ruleContent.startsWith('domain:') && ruleContent !== 'domain:') {
      return {
        suggestedRule: formatRuleText({ toolName, ruleContent }),
        summary: ruleContent.slice('domain:'.length),
      }
    }
  }
  return { suggestedRule: toolName }
}

/**
 * Drop the agents an `Agent(<agentType>)` DENY rule blocks, so the model never
 * sees a sub-agent it would only be refused when it tried to spawn it. Deny rules from every source
 * count; the merged `ruleLists` is the fallback when the by-source maps are
 * absent. Rules WITHOUT content (`deny: ["Agent"]`) block the whole tool and
 * are handled by the gate, not here.
 */
export function withoutBlockedAgents<T extends { name?: unknown }>(
  agents: readonly T[],
  ctx:
    | {
        ruleLists?: { deny?: readonly string[] }
        denyRuleBook?: Record<string, string[] | undefined>
      }
    | undefined,
): T[] {
  const denied = new Set<string>()
  const collect = (rules: readonly string[] | undefined) => {
    for (const ruleString of rules ?? []) {
      const rule = parseRuleText(ruleString)
      if (rule.toolName === SPAWN_TOOL_ID && rule.ruleContent !== undefined) {
        denied.add(rule.ruleContent)
      }
    }
  }
  collect(ctx?.ruleLists?.deny)
  for (const rules of Object.values(ctx?.denyRuleBook ?? {})) collect(rules)
  if (denied.size === 0) return [...agents]
  return agents.filter(
    agent => typeof agent.name !== 'string' || !denied.has(agent.name),
  )
}

// ---------------------------------------------------------------------------
// Shadowed-rule detection
// ---------------------------------------------------------------------------

/**
 * An allow rule that can never fire because a broader deny/ask rule catches the
 * same tool calls first in the decision pipeline.
 */
export type ShadowedRule = {
  /** The shadowed allow rule. */
  rule: ToolRuleSpec
  ruleString: string
  source: string
  /** Human-readable reason. */
  reason: string
  /** The broader rule that shadows it. */
  shadowedBy: ToolRuleSpec
  shadowedBySource: string
  shadowType: 'ask' | 'deny'
  /** Suggested fix. */
  fix: string
}

/** Sources that are shared/team-visible rather than the user's own. */
function isTeamVisibleOrigin(source: string): boolean {
  return (
    source === 'projectSettings' ||
    source === 'policySettings' ||
    source === 'command'
  )
}

/** Human-friendly source name for messages. */
function originLabel(source: string): string {
  switch (source) {
    case 'userSettings':
      return 'user settings'
    case 'projectSettings':
      return 'project settings'
    case 'localSettings':
      return 'local settings'
    case 'flagSettings':
      return 'flag settings'
    case 'policySettings':
      return 'policy settings'
    case 'cliArg':
      return 'CLI argument'
    case 'command':
      return 'command'
    case 'session':
      return 'this session'
    default:
      return source
  }
}

/** Flatten a by-source map into {ruleValue, source, ruleString} triples. */
function flattenRulesBySource(
  bySource: RulesByOrigin | undefined,
): Array<{ ruleValue: ToolRuleSpec; source: string; ruleString: string }> {
  if (!bySource) return []
  const out: Array<{
    ruleValue: ToolRuleSpec
    source: string
    ruleString: string
  }> = []
  for (const [source, rules] of Object.entries(bySource)) {
    for (const ruleString of rules ?? []) {
      out.push({
        ruleValue: parseRuleText(ruleString),
        source,
        ruleString,
      })
    }
  }
  return out
}

/**
 * Whether a content-bearing allow rule is shadowed by a whole-tool deny rule.
 * Only content-bearing allow rules can be
 * shadowed (a whole-tool allow is the broadest — nothing shadows it). Shadowed
 * iff a whole-tool deny rule for the same toolName exists (deny fires first).
 */
function allowHiddenByDeny(
  allow: ToolRuleSpec,
  denyRules: Array<{ ruleValue: ToolRuleSpec; source: string }>,
): { ruleValue: ToolRuleSpec; source: string } | undefined {
  // Only content-bearing allow rules can be shadowed.
  if (allow.ruleContent === undefined) return undefined
  return denyRules.find(
    d => d.ruleValue.toolName === allow.toolName && d.ruleValue.ruleContent === undefined,
  )
}

/**
 * Is a content-bearing allow rule shadowed by a whole-tool ask rule for the
 * same tool? Not when `sandboxAutoAllowEnabled` and the ask source is not
 * shared.
 */
function allowHiddenByAsk(
  allow: ToolRuleSpec,
  askRules: Array<{ ruleValue: ToolRuleSpec; source: string }>,
  options: { sandboxAutoAllowEnabled: boolean },
): { ruleValue: ToolRuleSpec; source: string } | undefined {
  if (allow.ruleContent === undefined) return undefined
  return askRules.find(a => {
    if (a.ruleValue.toolName !== allow.toolName) return false
    if (a.ruleValue.ruleContent !== undefined) return false // must be whole-tool
    // Bash sandbox exception.
    if (
      options.sandboxAutoAllowEnabled &&
      allow.toolName === SHELL_TOOL_ID &&
      !isTeamVisibleOrigin(a.source)
    ) {
      return false
    }
    return true
  })
}

/** Suggest which of the two conflicting rules to remove. */
function whichRuleToDrop(
  shadowType: 'ask' | 'deny',
  shadowing: { ruleValue: ToolRuleSpec; source: string },
  shadowed: { ruleValue: ToolRuleSpec; source: string },
): string {
  const behaviorWord = shadowType === 'deny' ? 'deny' : 'ask'
  return (
    `Remove the "${shadowing.ruleValue.toolName}" ${behaviorWord} rule from ` +
    `${originLabel(shadowing.source)}, or remove the specific allow rule from ` +
    `${originLabel(shadowed.source)}.`
  )
}

/**
 * Detect allow rules that are unreachable because a broader deny/ask rule
 * shadows them. Deny-shadow is
 * checked first (more severe); deny-shadowed rules skip ask reporting.
 */
export function findShadowedRules(
  ctx: Pick<RuleGateContext, 'allowRuleBook' | 'denyRuleBook' | 'askRuleBook'>,
  options: { sandboxAutoAllowEnabled?: boolean } = {},
): ShadowedRule[] {
  const allowRules = flattenRulesBySource(ctx.allowRuleBook)
  const denyRules = flattenRulesBySource(ctx.denyRuleBook)
  const askRules = flattenRulesBySource(ctx.askRuleBook)
  const sandboxAutoAllowEnabled = options.sandboxAutoAllowEnabled ?? false

  const unreachable: ShadowedRule[] = []
  for (const allow of allowRules) {
    // Deny-shadow first (more severe).
    const denyShadow = allowHiddenByDeny(allow.ruleValue, denyRules)
    if (denyShadow) {
      unreachable.push({
        rule: allow.ruleValue,
        ruleString: allow.ruleString,
        source: allow.source,
        reason:
          `The allow rule "${allow.ruleString}" is unreachable because the ` +
          `whole-tool deny rule "${denyShadow.ruleValue.toolName}" (from ` +
          `${originLabel(denyShadow.source)}) denies all ${allow.ruleValue.toolName} calls first.`,
        shadowedBy: denyShadow.ruleValue,
        shadowedBySource: denyShadow.source,
        shadowType: 'deny',
        fix: whichRuleToDrop('deny', denyShadow, allow),
      })
      continue // deny-shadowed rules skip ask reporting
    }
    // Ask-shadow.
    const askShadow = allowHiddenByAsk(allow.ruleValue, askRules, {
      sandboxAutoAllowEnabled,
    })
    if (askShadow) {
      unreachable.push({
        rule: allow.ruleValue,
        ruleString: allow.ruleString,
        source: allow.source,
        reason:
          `The allow rule "${allow.ruleString}" is unreachable because the ` +
          `whole-tool ask rule "${askShadow.ruleValue.toolName}" (from ` +
          `${originLabel(askShadow.source)}) prompts for all ${allow.ruleValue.toolName} calls first.`,
        shadowedBy: askShadow.ruleValue,
        shadowedBySource: askShadow.source,
        shadowType: 'ask',
        fix: whichRuleToDrop('ask', askShadow, allow),
      })
    }
  }
  return unreachable
}

// ---------------------------------------------------------------------------
// Permission request message formatting
// ---------------------------------------------------------------------------

/**
 * Generate a human-readable permission request message based on the decision
 * reason.
 */
export function approvalPromptText(
  toolName: string,
  decisionReason?: VerdictReason,
): string {
  if (!decisionReason) {
    return `The agent requested permission to use ${toolName}, which has not been granted yet.`
  }

  switch (decisionReason.type) {
    case 'rule':
      return `Permission rule '${decisionReason.rule}' from ${decisionReason.source} requires approval for ${toolName}.`

    case 'mode':
      return `Current permission mode (${decisionReason.mode}) requires approval for ${toolName}.`

    case 'workingDir':
      return decisionReason.reason ?? `Path is outside allowed working directories.`

    case 'safetyCheck':
      return decisionReason.reason ?? `Safety check requires approval for ${toolName}.`

    case 'other':
      return decisionReason.reason

    case 'asyncAgent':
      return decisionReason.reason ?? `Async agent requires approval for ${toolName}.`

    case 'classifier':
      return `Classifier requires approval for this ${toolName} command.`

    case 'hook':
      return `Hook requires approval for ${toolName}.`

    case 'subcommandResults':
      return `This ${toolName} command contains multiple operations requiring approval.`

    case 'permissionPromptTool':
      return `Tool requires approval for ${toolName}.`

    case 'sandboxOverride':
      return `Run outside of the sandbox.`

    default:
      return `The agent requested permission to use ${toolName}, which has not been granted yet.`
  }
}

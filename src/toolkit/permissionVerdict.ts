/**
 * Permission shapes shared by the tools and the permission pipeline: the rule
 * set a session runs under, the verdict a check returns, and why.
 */

/** The three answers a permission check can give. */
export type VerdictKind = 'allow' | 'deny' | 'ask'

/** The settings layer or action a rule came from. */
export type RuleOrigin =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'flagSettings'
  | 'policySettings'
  | 'cliArg'
  | 'command'
  | 'session'

/** Rule strings grouped by where they came from. */
export type RulesByOrigin = {
  [T in RuleOrigin]?: string[]
}

export type WorkspaceRootOrigin = string

/** A directory the session may work in besides its own root. */
export type ExtraWorkspaceRoot = {
  path: string
  source: WorkspaceRootOrigin
}

/** The cause recorded with a verdict. */
export type VerdictReason =
  | { type: 'rule'; rule: string; source: RuleOrigin }
  | { type: 'mode'; mode: string }
  | { type: 'subcommandResults' }
  | { type: 'permissionPromptTool' }
  | { type: 'hook'; hookName: string }
  | { type: 'asyncAgent'; reason?: string }
  | { type: 'sandboxOverride'; reason?: string }
  | { type: 'classifier'; classifier: string; reason: string }
  | { type: 'workingDir'; reason?: string }
  | { type: 'safetyCheck'; classifierApprovable?: boolean; reason?: string }
  | { type: 'other'; reason: string }

/**
 * A verdict. `passthrough` means "no opinion, let the next check decide".
 * `updatedInput` keeps its name: hook output uses the same field.
 */
export type ToolPermissionResult = {
  behavior: VerdictKind | 'passthrough'
  message?: string
  updatedInput?: unknown
  verdictReason?: VerdictReason
}

/** The function a tool call asks for permission through. */
export type PermissionDecider = (
  ...args: unknown[]
) => Promise<ToolPermissionResult | unknown> | ToolPermissionResult | unknown

/** The rules and mode a session's permission checks run under. */
export type PermissionRuleSet = {
  mode: string
  /** The mode to return to when plan mode ends. */
  modeBeforePlan?: string
  extraWorkspaceRoots: Map<string, ExtraWorkspaceRoot>
  allowRuleBook: RulesByOrigin
  denyRuleBook: RulesByOrigin
  askRuleBook: RulesByOrigin
  /** Settings turned the bypass mode off entirely. */
  bypassPermissionsModeDisabled?: boolean
  /** Allow rules held back while an automatic mode is on. */
  setAsideRiskyRules?: RulesByOrigin
  /** Never show a permission prompt; decide without asking. */
  suppressAsks?: boolean
  /** Let pending automated checks finish before a prompt is shown. */
  checksBeforeAsk?: boolean
}

/** A rule set with no rules, in the default mode. */
export function emptyPermissionRuleSet(): PermissionRuleSet {
  return {
    mode: 'default',
    extraWorkspaceRoots: new Map<string, ExtraWorkspaceRoot>(),
    allowRuleBook: {},
    denyRuleBook: {},
    askRuleBook: {},
  }
}

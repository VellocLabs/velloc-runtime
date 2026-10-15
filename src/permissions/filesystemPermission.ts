/**
 * File-tool permission pipelines (`vetFileRead`, `vetFileWrite`); the step
 * order decides which signal wins. Reads are not boundary-gated (an unmatched
 * read allows); only skills dirs get the session skill-scope allow; shell
 * tools are gated host-side by SafeCommandPolicy, not here.
 */

import type { ToolPermissionResult } from '../toolkit/permissionVerdict'
import {
  EDIT_TOOL_ID,
  READ_TOOL_ID,
  WRITE_TOOL_ID,
} from '../prompting/fileToolNames'
import { dirnameRuntimePath, resolveRuntimePath } from '../utils/runtimePaths'
import { extractFilePath, pathMatchesRuleWithRoot } from './filePathRuleMatching'
import {
  parseRuleText,
  type ToolRuleSpec,
} from './ruleText'
import type { RuleGateContext, RuleLists } from './ruleEngine'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

const NOTEBOOK_TOOL_ID = 'NotebookEdit'

/** Tools that READ a file path (Read, Glob, Grep). */
const READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  READ_TOOL_ID,
  'Glob',
  'Grep',
])

/** Tools that WRITE a file path (Write, Edit, NotebookEdit). */
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  WRITE_TOOL_ID,
  EDIT_TOOL_ID,
  NOTEBOOK_TOOL_ID,
])

/**
 * Get all path representations for permission checking.
 * Returns [original, resolved] where resolved follows symlinks. If realpath
 * is unavailable or fails, returns [original] only.
 */
async function pathVariantsToVet(
  filePath: string,
  fs: RuntimeFs | undefined,
): Promise<string[]> {
  const paths = [filePath]
  if (fs?.realpath) {
    try {
      const resolved = await fs.realpath(filePath)
      if (resolved !== filePath) {
        paths.push(resolved)
      }
    } catch {
      // realpath failed (path doesn't exist, permission denied, etc.)
      // Fall back to original path only.
    }
  }
  return paths
}

export type FilePermissionContext = {
  cwd: string
  projectRoot?: string
  /** User home dir — root for `~/…` rule patterns. */
  homeDir?: string
  extraWorkspaceRoots?: Map<string, unknown>
  mode?: string
  ruleLists?: RuleLists
  /** Per-source rule maps, so a decision can name the settings source it came from. */
  allowRuleBook?: Record<string, string[]>
  denyRuleBook?: Record<string, string[]>
  askRuleBook?: Record<string, string[]>
  /** Memory dir carve-out (agent's own state). */
  memoryDir?: string
  /** Plan file carve-out (the sole writable path in plan mode). */
  planFilePath?: string
  /** Config home dir (`~/.velloc`) — for internal path carve-outs. */
  configHome?: string
  /** Session ID — for session-scoped carve-outs (transcript, tool-details). */
  sessionId?: string
  /**
   * Per-session scratchpad dir (`<sessionDir>/scratch/`) — writable throwaway
   * area, writable without a prompt.
   */
  freeWriteDir?: string
  /**
   * Per-task workspace dirs the current turn may write to without a prompt.
   * Keyed arbitrarily; values are absolute workspace dirs.
   */
  taskWorkspaceDirs?: string[]
  /**
   * Filesystem operations for symlink resolution.
   * When present, both original and resolved paths are checked.
   */
  fs?: RuntimeFs
}

// ---------------------------------------------------------------------------
// Rule matching helpers (file-path scoped)
// ---------------------------------------------------------------------------

/** Root context for resolving rooted patterns (`~/x`, `/abs/x`, `//x`). */
type RuleRoots = { homeDir?: string; projectRoot?: string; cwd?: string }

/** First matching file-path rule from a flat list, or undefined. */
function firstMatchingPathRule(
  rules: readonly string[] | undefined,
  toolName: string,
  filePath: string,
  roots: RuleRoots,
): string | undefined {
  if (!rules) return undefined
  for (const ruleString of rules) {
    const rule = parseRuleText(ruleString)
    if (pathRuleMatchesTool(rule, toolName, filePath, roots)) return ruleString
  }
  return undefined
}

/**
 * First matching file-path rule across per-source maps, returning the rule
 * string AND the settings source it came from.
 * Sources are checked in precedence order so the most authoritative source is
 * attributed. Returns undefined when no source has a matching rule.
 */
const RULE_SOURCE_PRECEDENCE: readonly string[] = [
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
  'cliArg',
  'command',
  'session',
]

function firstMatchingPathRuleBySource(
  bySource: Record<string, string[]> | undefined,
  toolName: string,
  filePath: string,
  roots: RuleRoots,
): { ruleString: string; source: string } | undefined {
  if (!bySource) return undefined
  for (const source of RULE_SOURCE_PRECEDENCE) {
    const rules = bySource[source]
    if (!rules?.length) continue
    for (const ruleString of rules) {
      const rule = parseRuleText(ruleString)
      if (pathRuleMatchesTool(rule, toolName, filePath, roots)) {
        return { ruleString, source }
      }
    }
  }
  return undefined
}

/** Whether a parsed rule matches a file tool call at `filePath`. */
function pathRuleMatchesTool(
  rule: ToolRuleSpec,
  toolName: string,
  filePath: string,
  roots: RuleRoots,
): boolean {
  // Tool-name match: Read rules match any read tool, Edit rules match any write tool.
  const ruleApplies =
    rule.toolName === toolName ||
    (rule.toolName === READ_TOOL_ID && READ_TOOL_NAMES.has(toolName)) ||
    (rule.toolName === EDIT_TOOL_ID && WRITE_TOOL_NAMES.has(toolName))
  if (!ruleApplies) return false
  // Tool-wide rule (no content) matches any path.
  if (rule.ruleContent === undefined) return true
  // Root-aware path matching: `~/x`, `/abs/x`, `//x` resolve
  // against their root; `./x` / `x` match anywhere.
  return pathMatchesRuleWithRoot(rule.ruleContent, filePath, roots)
}

/**
 * The set of allowed working directories: the project root, the session cwd, and any additional working directories the
 * user has granted. Order is not significant — containment is an OR.
 */
export function grantedRoots(ctx: FilePermissionContext): string[] {
  return [
    ctx.projectRoot,
    ctx.cwd,
    ...(ctx.extraWorkspaceRoots
      ? [...ctx.extraWorkspaceRoots.keys()]
      : []),
  ].filter((b): b is string => typeof b === 'string' && b.length > 0)
}

/**
 * Whether `path` is contained within `workingPath`. Case-insensitive (defeats
 * `.cLaUdE`-style bypasses on case-insensitive filesystems) and traversal-aware: a `..` that escapes the
 * base is rejected even if the raw string still starts with the base prefix.
 */
export function liesUnderRoot(path: string, workingPath: string, cwd: string): boolean {
  const normWp = resolveRuntimePath(cwd, workingPath).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const normPath = resolveRuntimePath(cwd, path).replace(/\\/g, '/').toLowerCase()
  if (normPath === normWp) return true
  if (!normPath.startsWith(normWp + '/')) return false
  // Traversal guard: the relative tail must not climb back out via `..`.
  const rel = normPath.slice(normWp.length + 1)
  return !rel.split('/').includes('..')
}

/**
 * Whether `filePath` is inside any allowed working directory.
 */
export function isInWorkingDir(filePath: string, ctx: FilePermissionContext): boolean {
  return grantedRoots(ctx).some(base => liesUnderRoot(filePath, base, ctx.cwd))
}

/** Whether `filePath` is the session plan file (writable in plan mode). */
function isPlanFile(filePath: string, ctx: FilePermissionContext): boolean {
  if (!ctx.planFilePath) return false
  const resolved = resolveRuntimePath(ctx.cwd, filePath)
  const planResolved = resolveRuntimePath(ctx.cwd, ctx.planFilePath)
  return resolved.replace(/\\/g, '/').toLowerCase() === planResolved.replace(/\\/g, '/').toLowerCase()
}

/** Whether `filePath` is inside the memory dir (agent's own state). */
function isMemoryPath(filePath: string, ctx: FilePermissionContext): boolean {
  if (!ctx.memoryDir) return false
  const resolved = resolveRuntimePath(ctx.cwd, filePath)
  const normMem = ctx.memoryDir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const normTarget = resolved.replace(/\\/g, '/').toLowerCase()
  return normTarget === normMem || normTarget.startsWith(normMem + '/')
}

/**
 * Whether `filePath` is inside the per-session scratchpad dir. The scratchpad is the agent's throwaway/intermediate-file
 * area — always writable without a prompt.
 */
function inFreeWriteDir(filePath: string, ctx: FilePermissionContext): boolean {
  return underDir(resolveRuntimePath(ctx.cwd, filePath), ctx.freeWriteDir)
}

/**
 * Whether `filePath` is inside one of the current turn's per-task workspace
 * dirs. Each background/side task gets its own writable workspace so
 * concurrent tasks don't collide.
 */
function isTaskWorkspacePath(filePath: string, ctx: FilePermissionContext): boolean {
  if (!ctx.taskWorkspaceDirs?.length) return false
  const resolved = resolveRuntimePath(ctx.cwd, filePath)
  return ctx.taskWorkspaceDirs.some(ws => underDir(resolved, ws))
}

/**
 * Whether `filePath` is under a `.velloc` internal-state subdir (plans, memory,
 * sessions, worktrees, projects, shared-workspace). These are agent-writable
 * working state, exempt from the dangerous-dir block — mirrors
 * VELLOC_INTERNAL_STATE_DIRS in checkFilePathSafety. `shared-workspace` is the
 * per-type SANDBOX workspace (`<home>/.velloc/shared-workspace/<type>`) — the
 * agent's working directory for unbound agent/chat sessions.
 */
function isVellocInternalState(filePath: string, ctx: FilePermissionContext): boolean {
  const resolved = resolveRuntimePath(ctx.cwd, filePath)
  const segments = resolved.split(/[/\\]+/).filter(Boolean).map(s => s.toLowerCase())
  const idx = segments.indexOf('.velloc')
  if (idx === -1) return false
  const next = segments[idx + 1] ?? ''
  return new Set(['plans', 'memory', 'sessions', 'worktrees', 'projects', 'shared-workspace']).has(next)
}

/**
 * Write-specific internal-state check: same as isVellocInternalState but
 * EXCLUDES `shared-workspace`. The shared-workspace is the agent's working
 * directory where user files live — explicit ask/deny rules MUST apply there
 * (unlike plans/memory/sessions which are agent-owned state the agent must
 * always be able to write). Reads still use the full isVellocInternalState.
 */
function isVellocInternalStateForWrite(filePath: string, ctx: FilePermissionContext): boolean {
  const resolved = resolveRuntimePath(ctx.cwd, filePath)
  const segments = resolved.split(/[/\\]+/).filter(Boolean).map(s => s.toLowerCase())
  const idx = segments.indexOf('.velloc')
  if (idx === -1) return false
  const next = segments[idx + 1] ?? ''
  return new Set(['plans', 'memory', 'sessions', 'worktrees', 'projects', 'working']).has(next)
}

/** Normalize a path for case-insensitive, separator-agnostic comparison. */
function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** Whether `target` is inside (or equal to) `base`, case-insensitively. */
function underDir(target: string, base: string | undefined): boolean {
  if (!base) return false
  const t = normPath(target)
  const b = normPath(base)
  return t === b || t.startsWith(b + '/')
}

/**
 * Session-scoped `.velloc/skills/{name}/**` allow rule bypass (write pipeline
 * step 1.6). Checks if a session-source allow rule grants edits to a skill dir.
 * Only session rules count — a user/project rule shouldn't silently bypass the
 * safety check. The rule must not contain `..` and must end with `/**`.
 */
function isSessionSkillScopeAllowed(
  filePath: string,
  ctx: FilePermissionContext,
  roots: RuleRoots,
): boolean {
  const sessionAllowRules = ctx.allowRuleBook?.session
  if (!sessionAllowRules?.length) return false
  const resolved = resolveRuntimePath(ctx.cwd, filePath)
  for (const ruleString of sessionAllowRules) {
    const rule = parseRuleText(ruleString)
    // Must be an Edit rule with content (a path pattern).
    if (rule.toolName !== EDIT_TOOL_ID || !rule.ruleContent) continue
    const content = rule.ruleContent
    // Reject traversal and require a `/**` suffix (scoped to a subtree).
    if (content.includes('..') || !content.endsWith('/**')) continue
    // Must target a skills dir (`.velloc/skills/` or `.claude/skills/`).
    if (!content.includes('/skills/')) continue
    if (pathMatchesRuleWithRoot(content, resolved, roots)) return true
  }
  return false
}

/**
 * Security: the agent's own readable state, exempt from read ask/deny: plan
 * file, memory dir, `~/.velloc/projects/<slug>/`, teams dir, skills dirs.
 */
function isReadableInternalPath(filePath: string, ctx: FilePermissionContext): boolean {
  const resolved = resolveRuntimePath(ctx.cwd, filePath)
  // Plan file + memory + scratchpad + task workspace (also write carve-outs).
  if (
    isPlanFile(filePath, ctx) ||
    isMemoryPath(filePath, ctx) ||
    inFreeWriteDir(filePath, ctx) ||
    isTaskWorkspacePath(filePath, ctx)
  ) {
    return true
  }
  // Per-project storage: transcripts, tool-details, tasks, subagents, memory all
  // live under <configHome>/projects/<slug>/. Reading any of it is internal.
  if (ctx.configHome && underDir(resolved, `${ctx.configHome}/projects`)) return true
  // Teams coordination dir (<configHome>/teams/).
  if (ctx.configHome && underDir(resolved, `${ctx.configHome}/teams`)) return true
  // Skills dirs (user + project) — the agent reads skill definitions.
  if (ctx.homeDir && underDir(resolved, `${ctx.homeDir}/.velloc/skills`)) return true
  if (underDir(resolved, resolveRuntimePath(ctx.cwd, '.velloc/skills'))) return true
  // Any .velloc internal-state subdir (plans/memory/sessions/worktrees/projects).
  if (isVellocInternalState(filePath, ctx)) return true
  return false
}

// ---------------------------------------------------------------------------
// Multi-path helpers (symlink-aware)
// ---------------------------------------------------------------------------

/**
 * Match a rule against ANY of the given path representations. Returns the first
 * match found (by-source precedence, then flat list fallback).
 */
function matchAnyPath(
  bySource: Record<string, string[]> | undefined,
  flatList: string[] | undefined,
  toolName: string,
  paths: string[],
  roots: RuleRoots,
): { ruleString: string; source: string } | undefined {
  for (const p of paths) {
    const match =
      firstMatchingPathRuleBySource(bySource, toolName, p, roots) ??
      (() => {
        const rule = firstMatchingPathRule(flatList, toolName, p, roots)
        return rule ? { ruleString: rule, source: 'unknown' } : undefined
      })()
    if (match) return match
  }
  return undefined
}

/**
 * Match a whole-tool rule (no ruleContent) without requiring a file path.
 * Used when the tool input has no extractable path (e.g. malformed Write call).
 * Checks per-source maps first (in precedence order), then the flat list.
 */
function matchWholeToolRule(
  bySource: Record<string, string[]> | undefined,
  flatList: string[] | undefined,
  toolName: string,
): { ruleString: string; source: string } | undefined {
  // Check per-source maps in precedence order
  if (bySource) {
    for (const source of RULE_SOURCE_PRECEDENCE) {
      const rules = bySource[source]
      if (!rules?.length) continue
      for (const ruleString of rules) {
        const rule = parseRuleText(ruleString)
        // Whole-tool rule: toolName matches and no ruleContent
        const ruleApplies =
          rule.toolName === toolName ||
          (rule.toolName === READ_TOOL_ID && READ_TOOL_NAMES.has(toolName)) ||
          (rule.toolName === EDIT_TOOL_ID && WRITE_TOOL_NAMES.has(toolName))
        if (ruleApplies && rule.ruleContent === undefined) {
          return { ruleString, source }
        }
      }
    }
  }
  // Check flat list
  if (flatList) {
    for (const ruleString of flatList) {
      const rule = parseRuleText(ruleString)
      const ruleApplies =
        rule.toolName === toolName ||
        (rule.toolName === READ_TOOL_ID && READ_TOOL_NAMES.has(toolName)) ||
        (rule.toolName === EDIT_TOOL_ID && WRITE_TOOL_NAMES.has(toolName))
      if (ruleApplies && rule.ruleContent === undefined) {
        return { ruleString, source: 'unknown' }
      }
    }
  }
  return undefined
}

/**
 * Whether a path is an internal write path (plan/memory/scratchpad/task-workspace/
 * .velloc-internal-state). Used with `.every()` for symlink-aware carve-outs.
 * Uses the write-specific internal-state check that EXCLUDES shared-workspace
 * (the agent's working dir), so explicit ask/deny rules apply there.
 */
function isInternalWritePath(filePath: string, ctx: FilePermissionContext): boolean {
  return (
    isPlanFile(filePath, ctx) ||
    isMemoryPath(filePath, ctx) ||
    inFreeWriteDir(filePath, ctx) ||
    isTaskWorkspacePath(filePath, ctx) ||
    isVellocInternalStateForWrite(filePath, ctx)
  )
}

/**
 * Check write safety against ANY of the given path representations. Returns the
 * first safety reason found (a hit on any representation wins).
 */
function checkWriteSafetyAnyPath(
  toolName: string,
  paths: string[],
  ctx: FilePermissionContext,
): 'sensitive-path' | 'outside-workspace' | 'suspicious-path' | null {
  for (const p of paths) {
    const reason = checkWriteSafety(toolName, p, ctx)
    if (reason) return reason
  }
  return null
}

// ---------------------------------------------------------------------------
// vetFileWrite
// ---------------------------------------------------------------------------

/**
 * Contract: write pipeline, in order: deny rule → deny; internal carve-out
 * and session `.velloc/skills/**` → allow; safety → ask; ask rule → ask;
 * acceptEdits in the working dir → allow; allow rule → allow; else allow
 * inside the working dir, ask outside. With `ctx.fs.realpath`, a deny/safety
 * hit on ANY of the original and resolved path wins, and an allow needs ALL
 * of them. Bypass is handled by the caller.
 */
export async function vetFileWrite(
  toolName: string,
  input: Record<string, unknown>,
  ctx: FilePermissionContext,
): Promise<ToolPermissionResult> {
  const filePath = extractFilePath(input)
  if (!filePath) {
    // No file path in input — only whole-tool deny/allow rules can decide.
    // This ensures "always allow" (which adds a whole-tool rule) prevents re-prompting.
    const denyMatch = matchWholeToolRule(ctx.denyRuleBook, ctx.ruleLists?.deny, toolName)
    if (denyMatch) {
      return {
        behavior: 'deny',
        message: `Permission to use ${toolName} has been denied by rule "${denyMatch.ruleString}".`,
        verdictReason: { type: 'rule', rule: denyMatch.ruleString, source: denyMatch.source as any },
      }
    }
    const allowMatch = matchWholeToolRule(ctx.allowRuleBook, ctx.ruleLists?.allow, toolName)
    if (allowMatch) {
      return {
        behavior: 'allow',
        verdictReason: { type: 'rule', rule: allowMatch.ruleString, source: allowMatch.source as any },
      }
    }
    // No whole-tool rule matched — ask with a generic message.
    return { behavior: 'ask', message: `Permission required to use ${toolName}.` }
  }

  const roots: RuleRoots = {
    homeDir: ctx.homeDir,
    projectRoot: ctx.projectRoot,
    cwd: ctx.cwd,
  }

  // Resolve all path representations (original + symlink target).
  const pathsToCheck = await pathVariantsToVet(
    resolveRuntimePath(ctx.cwd, filePath),
    ctx.fs,
  )

  // 1. Deny rule — highest precedence, immune to bypass/acceptEdits. A deny on
  //    ANY representation wins, so a symlink cannot dodge a deny.
  const denyMatch = matchAnyPath(ctx.denyRuleBook, ctx.ruleLists?.deny, toolName, pathsToCheck, roots)
  if (denyMatch) {
    return {
      behavior: 'deny',
      message: `Permission to write ${filePath} has been denied by rule "${denyMatch.ruleString}".`,
      verdictReason: { type: 'rule', rule: denyMatch.ruleString, source: denyMatch.source as any },
    }
  }

  // 1.5. Internal carve-out: plan file + memory dir + scratchpad + per-task
  // workspace + .velloc internal-state subdirs are always writable. MUST come
  // before the dangerous-dir check (`.velloc` is a dangerous dir, but
  // plans/memory/sessions/worktrees/projects live under it). Requires ALL
  // representations to be internal (a symlink escaping to a non-internal path
  // is not carved out). The subdir list mirrors VELLOC_INTERNAL_STATE_DIRS.
  if (pathsToCheck.every(p => isInternalWritePath(p, ctx))) {
    return { behavior: 'allow' }
  }

  // 1.6. Session-scoped `.velloc/skills/{name}/**` allow rule bypass. Lets a narrow session rule grant skill edits without exposing all of
  // `.velloc/`. Only session-source rules count (a user/project rule shouldn't
  // silently bypass the safety check). Runs BEFORE the safety check.
  if (isSessionSkillScopeAllowed(filePath, ctx, roots)) {
    return { behavior: 'allow' }
  }

  // 1.7. Safety checks (dangerous files/dirs, suspicious Windows patterns).
  // MUST come before ask rules and acceptEdits: no mode or rule may skip a
  // safety prompt. A safety hit on ANY representation wins.
  // classifierApprovable: sensitive-file paths (.git/.velloc/shell
  // configs) are `true` — a future auto-mode classifier MAY approve them;
  // suspicious Windows patterns are `false` — always a hard prompt.
  const safetyReason = checkWriteSafetyAnyPath(toolName, pathsToCheck, ctx)
  if (safetyReason) {
    return {
      behavior: 'ask',
      message: `${toolName} a protected path (${filePath})`,
      // safetyCheck is bypass-immune: the mode transforms in
      // toolExecution must NOT let bypassPermissions skip this prompt. The
      // specific `reason` ('sensitive-path'/'outside-workspace'/'suspicious-path')
      // is surfaced so the UI banner can offer the right affordance (e.g.
      // "Allow this folder" for outside-workspace).
      verdictReason: {
        type: 'safetyCheck',
        reason: safetyReason,
        classifierApprovable: safetyReason !== 'suspicious-path',
      },
    }
  }

  // 2. Ask rule — explicit ask rules take precedence over allow rules.
  // An ask on ANY representation wins. This ensures that if a user has both
  // `ask: ['Write(/tmp/**)']` and `allow: ['Write']`, the ask rule still prompts.
  const askMatch = matchAnyPath(ctx.askRuleBook, ctx.ruleLists?.ask, toolName, pathsToCheck, roots)
  if (askMatch) {
    return {
      behavior: 'ask',
      message: `Permission required to write ${filePath} (rule "${askMatch.ruleString}").`,
      verdictReason: { type: 'rule', rule: askMatch.ruleString, source: askMatch.source as any },
    }
  }

  // 3. acceptEdits + working dir → allow. Requires ALL representations inside
  //    the working dir (a symlink escaping the workspace is not auto-allowed).
  if (ctx.mode === 'acceptEdits' && pathsToCheck.every(p => isInWorkingDir(p, ctx))) {
    return { behavior: 'allow' }
  }

  // 4. Allow rule — explicit grant. An allow on ANY representation grants.
  const allowMatch = matchAnyPath(ctx.allowRuleBook, ctx.ruleLists?.allow, toolName, pathsToCheck, roots)
  if (allowMatch) {
    return {
      behavior: 'allow',
      verdictReason: { type: 'rule', rule: allowMatch.ruleString, source: allowMatch.source as any },
    }
  }

  // 5. Default. Writes INSIDE the working dir are allowed without a prompt;
  //    only writes outside it prompt. Requires ALL representations inside
  //    (symlink escape → prompt).
  if (pathsToCheck.every(p => isInWorkingDir(p, ctx))) {
    return { behavior: 'allow' }
  }
  return {
    behavior: 'ask',
    message: `Permission required to write ${filePath}.`,
    // workingDir ask is bypassable (unlike safetyCheck) — bypassPermissions
    // short-circuits this in toolExecution.
    verdictReason: { type: 'workingDir' },
  }
}

// ---------------------------------------------------------------------------
// vetFileRead
// ---------------------------------------------------------------------------

/**
 * Contract: read pipeline, in order: UNC or suspicious Windows path → ask;
 * deny rule → deny; ask rule → ask; write allow, working dir, internal path,
 * read allow → allow; else allow (reads are not gated).
 */
export async function vetFileRead(
  toolName: string,
  input: Record<string, unknown>,
  ctx: FilePermissionContext,
): Promise<ToolPermissionResult> {
  const filePath = extractFilePath(input)
  if (!filePath) {
    // No path to check — allow (Glob/Grep with no explicit path).
    return { behavior: 'allow' }
  }

  const roots: RuleRoots = {
    homeDir: ctx.homeDir,
    projectRoot: ctx.projectRoot,
    cwd: ctx.cwd,
  }

  // 1. UNC path defense-in-depth.
  if (filePath.startsWith('\\\\') || filePath.startsWith('//')) {
    return {
      behavior: 'ask',
      message: `Permission required to read ${filePath} (UNC path).`,
      verdictReason: { type: 'safetyCheck' },
    }
  }

  // 2. Suspicious Windows path patterns.
  if (hasSuspiciousReadPattern(filePath)) {
    return {
      behavior: 'ask',
      message: `Permission required to read ${filePath} (suspicious path pattern).`,
      verdictReason: { type: 'safetyCheck' },
    }
  }

  // Resolve all path representations (original + symlink target).
  const pathsToCheck = await pathVariantsToVet(
    resolveRuntimePath(ctx.cwd, filePath),
    ctx.fs,
  )

  // 3. Read deny rule. A deny on ANY representation wins.
  const denyMatch = matchAnyPath(ctx.denyRuleBook, ctx.ruleLists?.deny, toolName, pathsToCheck, roots)
  if (denyMatch) {
    return {
      behavior: 'deny',
      message: `Permission to read ${filePath} has been denied by rule "${denyMatch.ruleString}".`,
      verdictReason: { type: 'rule', rule: denyMatch.ruleString, source: denyMatch.source as any },
    }
  }

  // 4. Read ask rule. An ask on ANY representation wins.
  const askMatch = matchAnyPath(ctx.askRuleBook, ctx.ruleLists?.ask, toolName, pathsToCheck, roots)
  if (askMatch) {
    return {
      behavior: 'ask',
      message: `Permission required to read ${filePath} (rule "${askMatch.ruleString}").`,
      verdictReason: { type: 'rule', rule: askMatch.ruleString, source: askMatch.source as any },
    }
  }

  // 5. Edit-implies-read: if a write allow rule covers this path, read is allowed.
  const editAllowMatch = matchAnyPath(ctx.allowRuleBook, ctx.ruleLists?.allow, EDIT_TOOL_ID, pathsToCheck, roots)
  if (editAllowMatch) {
    return {
      behavior: 'allow',
      verdictReason: { type: 'rule', rule: editAllowMatch.ruleString, source: editAllowMatch.source as any },
    }
  }

  // 6. Working dir → allow (reads in working dir always allowed). Requires ALL
  //    representations inside (a symlink escaping the workspace is not auto-allowed).
  if (pathsToCheck.every(p => isInWorkingDir(p, ctx))) {
    return { behavior: 'allow' }
  }

  // 7. Internal readable path (plan file, memory, project storage, teams,
  //    skills — see isReadableInternalPath). Requires ALL
  //    representations internal.
  if (pathsToCheck.every(p => isReadableInternalPath(p, ctx))) {
    return { behavior: 'allow' }
  }

  // 8. Read allow rule. An allow on ANY representation grants.
  const allowMatch = matchAnyPath(ctx.allowRuleBook, ctx.ruleLists?.allow, toolName, pathsToCheck, roots)
  if (allowMatch) {
    return {
      behavior: 'allow',
      verdictReason: { type: 'rule', rule: allowMatch.ruleString, source: allowMatch.source as any },
    }
  }

  // 9. Default → allow. Reads outside the working dir are not gated: in the
  //    sandbox model the agent legitimately reads beyond it.
  return { behavior: 'allow' }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Write-safety check — delegates to the existing `checkFilePathSafety` logic
 * (dangerous files/dirs, suspicious Windows patterns, workspace boundary).
 * Inlined here to avoid a circular import; mirrors the same checks.
 */
function checkWriteSafety(
  toolName: string,
  filePath: string,
  ctx: FilePermissionContext,
): 'sensitive-path' | 'suspicious-path' | 'outside-workspace' | null {
  const resolved = resolveRuntimePath(ctx.cwd, filePath)

  // Suspicious Windows patterns.
  if (hasSuspiciousReadPattern(filePath) || hasSuspiciousReadPattern(resolved)) {
    return 'suspicious-path'
  }

  // Dangerous directories (case-insensitive).
  const segments = resolved.split(/[/\\]+/).filter(Boolean)
  const DANGEROUS_DIRS = ['.git', '.vscode', '.idea', '.claude', '.velloc']
  const INTERNAL_STATE = new Set(['plans', 'memory', 'sessions', 'worktrees', 'projects', 'working', 'shared-workspace'])
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i].toLowerCase()
    if (!DANGEROUS_DIRS.includes(seg)) continue
    if (seg === '.velloc') {
      const next = (segments[i + 1] ?? '').toLowerCase()
      if (INTERNAL_STATE.has(next)) continue
    }
    return 'sensitive-path'
  }

  // Dangerous files (basename).
  const DANGEROUS_FILES = [
    '.gitconfig', '.gitmodules', '.bashrc', '.bash_profile',
    '.zshrc', '.zprofile', '.profile', '.ripgreprc', '.mcp.json', '.claude.json',
  ]
  const basename = (segments[segments.length - 1] ?? '').toLowerCase()
  if (DANGEROUS_FILES.includes(basename)) return 'sensitive-path'

  // Settings files under .velloc.
  if (
    (basename === 'settings.json' || basename === 'settings.local.json') &&
    segments.some(s => s.toLowerCase() === '.velloc')
  ) {
    return 'sensitive-path'
  }

  // Workspace boundary (bound projects only).
  // The sandbox is detected by its `shared-workspace` path SEGMENT, as
  // protectedPaths.ts does for its boundary check — a substring would exempt a
  // bound project whose path merely contains the text (`my-shared-workspace-app`).
  if (
    ctx.projectRoot &&
    !ctx.projectRoot.split(/[/\\]+/).filter(Boolean).includes('shared-workspace')
  ) {
    if (!isInWorkingDir(filePath, ctx)) {
      return 'outside-workspace'
    }
  }

  return null
}

/** Whether the host interprets Windows path syntax (same UA test as
 *  filesystemSafety.ts, inlined for the same circular-import reason). */
function isWindowsLikePlatform(): boolean {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent ?? '' : ''
  return /Windows|Win32|Win64|WOW64|WSL/i.test(ua)
}

/** Suspicious Windows path patterns (subset relevant to reads). */
function hasSuspiciousReadPattern(path: string): boolean {
  // NTFS Alternate Data Streams — a colon past the drive-letter position. Only
  // Windows/WSL read colon syntax in the kernel, so it is gated on the platform
  // (mirrors hasSuspiciousWindowsPathPattern in filesystemSafety.ts).
  if (isWindowsLikePlatform() && path.indexOf(':', 2) !== -1) return true
  if (/~\d/.test(path)) return true
  if (path.startsWith('\\\\?\\') || path.startsWith('\\\\.\\') ||
      path.startsWith('//?/') || path.startsWith('//./')) return true
  if (/[.\s]+$/.test(path)) return true
  if (/\.(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(path)) return true
  if (/(^|[/\\])\.{3,}([/\\]|$)/.test(path)) return true
  return false
}

/**
 * Generate permission suggestions for an ask result. Returns a list of suggested actions the user can take
 * to avoid re-prompting: switch to acceptEdits mode, or add the directory to
 * additionalWorkingDirectories.
 *
 * Only suggests `setMode:acceptEdits` from `default`/`plan` mode (never from
 * `auto`/`bypassPermissions` — would be a downgrade).
 */
export function proposeAllowRules(
  filePath: string,
  op: 'read' | 'write',
  ctx: FilePermissionContext,
): Array<{ type: 'setMode'; mode: string } | { type: 'addDirectories'; directories: string[] }> {
  const suggestions: Array<{ type: 'setMode'; mode: string } | { type: 'addDirectories'; directories: string[] }> = []
  const isOutsideWorkingDir = !isInWorkingDir(filePath, ctx)

  // Suggest acceptEdits only from default/plan (avoid downgrading auto/bypass).
  const shouldSuggestAcceptEdits = ctx.mode === 'default' || ctx.mode === 'plan'

  if (op === 'read' && isOutsideWorkingDir) {
    // Read outside working dir: suggest adding the parent directory.
    const dir = dirnameRuntimePath(resolveRuntimePath(ctx.cwd, filePath)).replace(/\\/g, '/')
    suggestions.push({ type: 'addDirectories', directories: [dir] })
  } else if (op === 'write') {
    // Write: suggest acceptEdits (if eligible) + addDirectories (if outside).
    if (shouldSuggestAcceptEdits) {
      suggestions.push({ type: 'setMode', mode: 'acceptEdits' })
    }
    if (isOutsideWorkingDir) {
      const dir = dirnameRuntimePath(resolveRuntimePath(ctx.cwd, filePath)).replace(/\\/g, '/')
      suggestions.push({ type: 'addDirectories', directories: [dir] })
    }
  } else if (op === 'read' && !isOutsideWorkingDir) {
    // Read inside working dir: suggest acceptEdits only (if eligible).
    if (shouldSuggestAcceptEdits) {
      suggestions.push({ type: 'setMode', mode: 'acceptEdits' })
    }
  }

  return suggestions
}

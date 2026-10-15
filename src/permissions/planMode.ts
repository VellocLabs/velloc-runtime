import type { ToolContract } from '../toolkit/toolContract'
import {
  EDIT_TOOL_ID,
  WRITE_TOOL_ID,
} from '../prompting/fileToolNames'
import { PLAN_OFF_TOOL_ID } from '../toolkit/builtin/planExit'
import { SKILL_TOOL_NAME } from '../prompting/skillToolName'
import { SUPER_EDIT_TOOL_NAME } from '../browser/runJs/runJsProtocol'
import { relativeRuntimePath, resolveRuntimePath } from '../utils/runtimePaths'
import { extractFilePath } from './filePathRuleMatching'
import { PLAN_MODE_READ_ONLY_HOSTED_TOOLS } from './hostedToolReadOnly'

export { PLAN_MODE_READ_ONLY_HOSTED_TOOLS }

// Security: plan-mode hard gate. While the mode is `plan`, `runToolUse`
// denies every tool `isToolAllowedInPlanMode` rejects (non-read-only).

// The read-only hosted tools and the shell tools are named in
// hostedToolReadOnly.ts, which a hosted tool's `isReadOnly(input)` answers
// from. The gate asks the tool, never its name: an MCP or mod tool that
// shares a hosted name is gated on what it reports for itself.

/**
 * Security: hosted browser tools that browse without acting, allowed in plan
 * mode: they change where the user looks, never page content or data. Click,
 * typing / forms / select / drag, evaluate, upload / download, close tab,
 * media control and done stay blocked.
 */
export const PLAN_MODE_BROWSING_HOSTED_TOOLS: ReadonlySet<string> = new Set([
  'BrowserNavigate',
  'BrowserSearch',
  'BrowserBack',
  'BrowserActivateTab',
  'BrowserScroll',
  'BrowserScrollToElement',
  'BrowserHover',
])

/**
 * File-write tools (hosted) that are allowed to target the session plan file
 * while planning. The plan-mode reminder and the ExitPlanMode prompt both tell
 * the model to write its plan to the plan file as it explores; without this
 * carve-out the hard gate would block that very Write/Edit.
 */
const PLAN_FILE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  WRITE_TOOL_ID, // 'Write'
  EDIT_TOOL_ID, // 'Edit'
])

/** The session plan file the model may write while plan mode is active. */
export type PlanFileTarget = {
  /** Session cwd — resolves a relative `file_path` input to absolute. */
  cwd: string
  /** Absolute path of the plan file (`planDocPath(context)`). */
  path: string
}

/**
 * Whether a Write/Edit `input` targets exactly the session plan file.
 *
 * Each session has exactly one plan file, so this is a STRICT equality on the
 * resolved absolute path rather than a match on the plan dir: a crafted
 * sibling `.md` file or a traversal path (`.../plans/../../etc`) cannot widen
 * the carve-out.
 */
function isPlanFileWrite(
  toolName: string,
  input: Record<string, unknown>,
  planFile: PlanFileTarget,
): boolean {
  if (!PLAN_FILE_WRITE_TOOLS.has(toolName)) {
    return false
  }
  const target = extractFilePath(input)
  if (!target) {
    return false
  }
  const resolved = resolveRuntimePath(planFile.cwd, target)
  return isExactPlanFilePath(resolved, planFile.path)
}

/**
 * Whether an already-resolved absolute path IS the session plan file — the
 * strict-equality core of `isPlanFileWrite`, shared with `commitOverlay`'s
 * per-op plan gate in SuperEditTool (which resolves its own paths and so
 * cannot go through the tool-name + raw-input form above).
 */
export function isExactPlanFilePath(
  canonicalPath: string,
  planFilePath: string,
): boolean {
  // `relativeRuntimePath(a, b) === '.'` iff a and b resolve to the same path —
  // it collapses `..` traversal and honors win32 case-insensitivity.
  return relativeRuntimePath(planFilePath, canonicalPath) === '.'
}

/**
 * Whether `tool` may run while plan mode is active. Read-only tools, the
 * plan-control exit hatch, and a Write/Edit to the session plan file are
 * allowed; everything else (other writes, shell, browser actions, MCP,
 * sub-agent spawns) is denied until the model exits plan mode.
 */
export function isToolAllowedInPlanMode(
  tool: Pick<ToolContract, 'name' | 'readsOnly'>,
  input: Record<string, unknown>,
  planFile?: PlanFileTarget,
): boolean {
  // ExitPlanMode flips the mode, so `isReadOnly()` is false — but it MUST stay
  // runnable in plan mode or the model can never leave. (EnterPlanMode is
  // already read-only.)
  if (tool.name === PLAN_OFF_TOOL_ID) {
    return true
  }
  // Skill loads a skill's INSTRUCTIONS into the conversation (read-only) so the
  // model can use research skills (e.g. a Jira lookup) while planning. Its two
  // direct-execution paths are gated in plan mode at the source: the embedded
  // `!`cmd`` shell is skipped (expandSkillBodyShell) and a `context:'fork'`
  // skill runs inline rather than spawning a sub-agent (SkillRunTool.call) — so a
  // skill can only drive read-only, plan-gated tool calls, never bypass the gate.
  if (tool.name === SKILL_TOOL_NAME) {
    return true
  }
  // Hosted tools answer `isReadOnly(input)` from hostedToolReadOnly.ts — the
  // read-only set, and per command for the shell tools — so no name check here.
  if (tool.readsOnly(input)) {
    return true
  }
  // Browser BROWSING (navigate/scroll/tab-focus/hover) is allowed while
  // planning — research needs the live browser. Page INTERACTION (click,
  // type, forms, JS, uploads) stays blocked; see the set's doc comment.
  if (PLAN_MODE_BROWSING_HOSTED_TOOLS.has(tool.name)) {
    return true
  }
  // The model builds its plan by writing to the session plan file as it
  // explores; allow only that exact file, never any other write target.
  if (planFile && isPlanFileWrite(tool.name, input, planFile)) {
    return true
  }
  // Security: SuperEdit is admitted wholesale: its only side effects go through
  // the `workspace` facade, and `commitOverlay` enforces plan mode on the
  // resolved path (only the session plan file may be written).
  if (tool.name === SUPER_EDIT_TOOL_NAME) {
    return true
  }
  return false
}

/** Model-facing tool_result text when a tool is blocked by the plan-mode gate. */
export function planModeRejectMessage(toolName: string): string {
  return (
    `Plan mode is active — only read-only tools and browser BROWSING ` +
    `(navigating, scrolling, reading pages) are allowed until you exit. ` +
    `"${toolName}" can modify files, run commands, or interact with pages, so ` +
    `it is blocked here. Keep exploring and designing; when your plan is ready, ` +
    `call ${PLAN_OFF_TOOL_ID} to present it for approval before making changes.`
  )
}

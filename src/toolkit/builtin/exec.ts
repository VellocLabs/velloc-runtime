/**
 * Security: `exec` runs a REGISTERED development CLI by argv; it is not a shell. The
 * argv is composed into ONE single-quoted command and dispatched through the Bash
 * tool's full permission treatment, so a shell metacharacter inside an argument is
 * data. Invariant: no arbitrary general-purpose execution or filesystem access.
 * Not registered by any template (F-21).
 */

import type { ModelReplyRow, Message } from '../../runtime/RuntimeTypes'
import type { PermissionDecider, ToolPermissionResult } from '../permissionVerdict'
import type { ToolContract, InputCheck } from '../toolContract'
import type { ToolCallContext } from '../toolCallContext'
import { declareTool, resolveToolByName } from '../toolContract'
import {
  buildFilePermissionContext,
  FILE_READ_TOOLS,
  FILE_WRITE_TOOLS,
} from '../run/toolPermissionGate'
import { nestedToolGatesOf } from '../run/toolLifecycleHooks'
import { confirmWithPermissionRequestHooks } from '../../lifecycleHooks/permissionRequestHooks'
import {
  vetFileRead,
  vetFileWrite,
} from '../../permissions/filesystemPermission'
import { evaluateRuleGate } from '../../permissions/ruleEngine'
import {
  isToolAllowedInPlanMode,
  planModeRejectMessage,
} from '../../permissions/planMode'
import {
  evaluateWriteTarget,
  describePathGuardAsk,
} from '../../permissions/protectedPaths'
import { extractFilePath } from '../../permissions/filePathRuleMatching'
import { planDocPath } from '../../utils/planFiles'
import { resolveRuntimePath } from '../../utils/runtimePaths'
import { SHELL_TOOL_ID } from '../../prompting/processToolNames'
import {
  raisesToolCall,
  runNestedToolThroughMods,
  type NestedToolOutcome,
} from '../run/toolCallThroughMods'
import type { ToolCallMods } from '../../mods/toolCallEvent'

export const EXEC_TOOL_NAME = 'Exec'

export type ExecInput = {
  tool?: string
  args?: Array<string | number>
  /** Working directory for the command (workspace-relative or absolute).
   *  Defaults to the session cwd. */
  cwd?: string
}

export type ExecOutput = string

// Monotonic counter so two concurrent same-name `ask` calls in the same
// millisecond get distinct toolUseIDs (the permission coordinator keys parked
// resolvers by approvalCallId; a collision would drop one and hang it).
let nestedConfirmSeq = 0

/** Serialize any tool result payload to a string. */
function serializeToolResultData(data: unknown): string {
  if (typeof data === 'string') return data
  if (data === undefined || data === null) return ''
  try {
    return JSON.stringify(data)
  } catch {
    return String(data)
  }
}

/**
 * Contract: runs one nested tool call in THIS runtime scope through the same
 * permission phases, in the same order, as a direct model call: plan-mode gate;
 * file pipeline, or rule gate + write target; the tool's `checkPermissions`; one
 * ask via `requestToolUseConfirm` (no surface ⇒ deny); PreToolUse/PostToolUse hooks.
 * The hosted file/shell tools' own self-gate allows all, so every phase is needed.
 * Tools with `requiresUserInteraction` are refused. `options.prepareCall` rewrites
 * the input handed to `tool.call` only after every gate and PreToolUse hook ran.
 */
export async function runNestedTool(
  name: string,
  args: unknown,
  context: ToolCallContext,
  canUseTool: PermissionDecider,
  invokingRow: Message,
  options?: {
    prepareCall?: (finalInput: Record<string, unknown>) => Record<string, unknown>
  },
): Promise<NestedToolOutcome> {
  // A mod hooking `tool.call` sees the step as it sees a direct call — the
  // hooks around the whole pipeline below (toolCallThroughMods.ts).
  const mods = context.options.mods
  if (mods?.ready) await mods.ready
  const tool = resolveToolByName(context.options.tools, name)
  if (
    tool &&
    raisesToolCall(tool) &&
    mods?.hasToolCallHooks?.() === true &&
    mods.toolCall
  ) {
    return runNestedToolThroughMods({
      mods: mods as ToolCallMods,
      tool,
      callRef: `exec-${name}-call-${++nestedConfirmSeq}`,
      args: (args && typeof args === 'object' ? args : {}) as Record<string, unknown>,
      callContext: context,
      runCore: callArgs =>
        runNestedToolCore(name, callArgs, context, canUseTool, invokingRow, options),
      serialize: serializeToolResultData,
    })
  }
  return runNestedToolCore(name, args, context, canUseTool, invokingRow, options)
}

/** `runNestedTool` beneath the mods: the phases above, then the tool. */
async function runNestedToolCore(
  name: string,
  args: unknown,
  context: ToolCallContext,
  canUseTool: PermissionDecider,
  invokingRow: Message,
  options?: {
    prepareCall?: (finalInput: Record<string, unknown>) => Record<string, unknown>
  },
): Promise<NestedToolOutcome> {
  const tool = resolveToolByName(context.options.tools, name)
  if (!tool) {
    return { ok: false, data: `Unknown tool: ${name}` }
  }
  if (tool.haltsForUser?.()) {
    return {
      ok: false,
      data: `Tool "${name}" needs interactive UI and cannot be called this way. Call it directly instead.`,
    }
  }

  const input = (args && typeof args === 'object' ? args : {}) as Record<
    string,
    unknown
  >

  if (tool.checkInput) {
    const validation = await tool.checkInput(input, context)
    if (!validation.result) {
      return { ok: false, data: `Invalid input for ${name}: ${validation.message}` }
    }
  }

  // One interactive ask (phase 4). Returns null on refusal (with the user's
  // feedback in `denialMessage`), or the possibly-updated input on allow.
  let denialMessage: string | undefined
  const askNested = async (
    askInput: Record<string, unknown>,
    message: string | undefined,
  ): Promise<Record<string, unknown> | null> => {
    // Headless / sub-agent contexts (`subagent-*` sessions install
    // requestToolUseConfirm but no UI ever mounts): give PermissionRequest
    // hooks their chance, then auto-deny — never park a prompt that would hang
    // forever. Same rule as the main pipeline (:1260).
    if (
      context.readAppState?.().permissionRules?.suppressAsks
    ) {
      const decision = await nestedToolGatesOf(context).headlessDecision(
        tool,
        askInput,
        `exec-${name}-${++nestedConfirmSeq}-${Date.now()}`,
        context,
      )
      if (decision.behavior === 'deny') {
        denialMessage = decision.message
        return null
      }
      return decision.updatedInput ?? askInput
    }
    const requestToolUseConfirm = context.requestToolUseConfirm
    if (!requestToolUseConfirm) {
      denialMessage = `Tool "${name}" requires confirmation, which is unavailable in this session.`
      return null
    }
    // PermissionRequest hooks run beside the dialog, as on the main pipeline.
    const resolution = await confirmWithPermissionRequestHooks(
      requestToolUseConfirm,
      {
        assistantMessage: invokingRow as ModelReplyRow,
        toolName: name,
        description: name,
        input: askInput,
        approvalCallId: `exec-${name}-${++nestedConfirmSeq}-${Date.now()}`,
        permissionResult: {
          behavior: 'ask',
          message,
          updatedInput: askInput,
        },
        askedAtMs: Date.now(),
      },
      context,
    )
    if (resolution.behavior !== 'allow') {
      denialMessage = resolution.feedback?.trim()
        ? resolution.feedback.trim()
        : `Permission denied for ${name}.`
      return null
    }
    return (resolution.updatedInput as Record<string, unknown>) ?? askInput
  }

  // Absent getAppState (minimal test contexts only) → no planModeContext →
  // the rule/file gates below are skipped and only the tool self-gate runs.
  // Production always carries getAppState (the main pipeline reads it
  // unguarded), so this is test tolerance, not a live hole.
  const planModeContext = context.readAppState?.().permissionRules
  const mode = planModeContext?.mode ?? 'default'
  const isBypass = mode === 'bypassPermissions'

  // Phase 1 — plan-mode hard gate.
  if (mode === 'plan') {
    let planFilePath = ''
    try {
      planFilePath = planDocPath(context)
    } catch {
      /* minimal contexts (tests) — no plan-file carve-out */
    }
    if (
      !isToolAllowedInPlanMode(tool, input, {
        cwd: context.options.cwd,
        path: planFilePath,
      })
    ) {
      return { ok: false, data: planModeRejectMessage(name) }
    }
  }

  // Phase 2 — file-tool pipeline or rule gate + path safety.
  let finalInput = input
  let runSelfGate = true
  if (
    planModeContext &&
    (FILE_READ_TOOLS.has(name) || FILE_WRITE_TOOLS.has(name))
  ) {
    const filePermCtx = buildFilePermissionContext(context, planModeContext)
    const fileDecision = FILE_WRITE_TOOLS.has(name)
      ? await vetFileWrite(name, input, filePermCtx)
      : await vetFileRead(name, input, filePermCtx)
    if (fileDecision.behavior === 'deny') {
      return {
        ok: false,
        data: fileDecision.message ?? `Permission denied for ${name}.`,
      }
    }
    if (fileDecision.behavior === 'ask') {
      // safetyCheck asks are bypass-immune, same as the main pipeline.
      const isSafetyAsk = fileDecision.verdictReason?.type === 'safetyCheck'
      if (!(isBypass && !isSafetyAsk)) {
        const allowed = await askNested(
          input,
          fileDecision.message ?? 'Permission required',
        )
        if (!allowed) return { ok: false, data: denialMessage! }
        finalInput = allowed
      }
    } else if (fileDecision.behavior === 'allow' && fileDecision.updatedInput) {
      finalInput = fileDecision.updatedInput as Record<string, unknown>
    }
    // The pipeline is the file tools' real gate (their self-gate is the
    // default allow) — matches the main pipeline, which skips the rule
    // engine + self-gate once the file pipeline resolved.
    runSelfGate = false
  } else {
    const ruleDecision = evaluateRuleGate(tool, input, planModeContext)
    if (ruleDecision.behavior === 'deny') {
      return {
        ok: false,
        data: ruleDecision.ruleString
          ? `Permission denied by rule "${ruleDecision.ruleString}".`
          : 'Permission denied by a deny rule.',
      }
    }
    if (ruleDecision.behavior === 'ask') {
      const allowed = await askNested(input, 'Permission required')
      if (!allowed) return { ok: false, data: denialMessage! }
      finalInput = allowed
    }
    // Path safety for non-file tools (e.g. a shell command aimed at .git) —
    // these asks survive bypass, same as the main pipeline.
    const fsSafety = evaluateWriteTarget(name, finalInput, {
      cwd: context.options.cwd,
      projectRoot: context.options.projectRoot,
      extraWorkspaceRoots:
        planModeContext?.extraWorkspaceRoots ?? new Map(),
      hasExplicitAllowRule:
        ruleDecision.behavior === 'allow' && Boolean(ruleDecision.ruleString),
      memoryDir: undefined,
    })
    if (fsSafety) {
      const allowed = await askNested(
        finalInput,
        describePathGuardAsk(name, fsSafety, extractFilePath(finalInput) ?? ''),
      )
      if (!allowed) return { ok: false, data: denialMessage! }
      finalInput = allowed
    }
    if (ruleDecision.behavior === 'allow') {
      // An explicit allow rule pre-empts the self-gate, as in the main pipeline.
      runSelfGate = false
    }
  }

  // Phase 3 — the tool's own self-gate (phase 4's ask when it says so).
  if (runSelfGate) {
    const permission: ToolPermissionResult = await tool.selfVerdict(
      finalInput,
      context,
    )
    if (permission.behavior === 'deny') {
      return {
        ok: false,
        data: permission.message ?? `Permission denied for ${name}.`,
      }
    }
    if (permission.behavior === 'ask') {
      const allowed = await askNested(finalInput, permission.message)
      if (!allowed) return { ok: false, data: denialMessage! }
      finalInput = allowed
    } else if ('updatedInput' in permission && permission.updatedInput) {
      finalInput = permission.updatedInput as Record<string, unknown>
    }
  }

  // PreToolUse hooks (main pipeline :1183) — after the permission decision,
  // before the call. A blocking hook stops the nested call exactly as it stops
  // a direct one, so a `Bash` matcher hook is not bypassable via exec.
  const preHook = await nestedToolGatesOf(context).preHooks(
    name,
    finalInput,
    `exec-${name}-${++nestedConfirmSeq}`,
    context,
  )
  if (preHook.blocked) {
    return { ok: false, data: `Hook blocked: ${preHook.message}` }
  }

  const callInput = options?.prepareCall ? options.prepareCall(finalInput) : finalInput
  const result = await tool.call(callInput, context, canUseTool, invokingRow)

  // PostToolUse hooks (main pipeline :1550) — observe-only (cannot undo); a
  // block or injected additionalContext is appended to the model-facing data.
  const postNote = await nestedToolGatesOf(context).postHooks(
    name,
    finalInput,
    result.data,
    `exec-${name}-post-${nestedConfirmSeq}`,
    context,
  )
  const data = serializeToolResultData(result.data)
  return { ok: true, data: postNote ? `${data}\n${postNote}` : data, raw: result.data }
}

// Security: the allowlist. Excluded on purpose: shells / interpreters, generic file
// utilities (file access goes through the read tools / `SuperEdit`), and `npx` (runs
// an arbitrary package). An entry may carry a subcommand allowlist (`npm run` runs
// arbitrary package.json shell). Widening it is a security decision. Known limit:
// git accepts argv-level options; the OS/permission layer remains the boundary.
export const EXEC_REGISTRY: Readonly<
  Record<string, { executable: string; subcommands?: readonly string[] }>
> = {
  git: { executable: 'git' },
  ninja: { executable: 'ninja' },
  autoninja: { executable: 'autoninja' },
  gn: { executable: 'gn' },
  cmake: { executable: 'cmake' },
  npm: { executable: 'npm', subcommands: ['install', 'ci', 'test'] },
  tsc: { executable: 'tsc' },
}

/** POSIX single-quote one argv element: wrap in '…', escaping embedded quotes
 *  as '\''. Any shell metacharacter inside becomes literal — so
 *  `exec('git', ['status', '; rm -rf /'])` passes '; rm -rf /' to git as one
 *  argument, never as a shell operator. */
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/** Unwrap the Bash tool's serialized result into `{ output, exitCode }`. The
 *  Bash tool returns a `{ output, exit_code }` envelope, JSON-stringified by
 *  `runNestedTool` (serializeToolResultData). Defensive: a non-envelope string
 *  (a tool shape change, or a fake in tests) is returned as the whole output
 *  with exitCode 0. */
function unwrapBashResult(data: string): { output: string; exitCode: number } {
  try {
    const parsed = JSON.parse(data) as unknown
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as { output?: unknown; exit_code?: unknown }
      if (typeof obj.output === 'string') {
        return {
          output: obj.output,
          exitCode: typeof obj.exit_code === 'number' ? obj.exit_code : 0,
        }
      }
    }
  } catch {
    /* not the JSON envelope — treat as raw output */
  }
  return { output: data, exitCode: 0 }
}

/**
 * Contract: dispatches the registered executable + single-quoted argv through the
 * Bash gate. A command that RAN resolves `{ output, exitCode }` for ANY exit code;
 * only one that could not run (unregistered, disallowed subcommand, bad argv,
 * permission-denied, hook-blocked) returns `ok:false` with the refusal text.
 */
export async function runExec(
  toolName: string,
  rawArgs: unknown,
  options: { cwd?: string } | undefined,
  context: ToolCallContext,
  canUseTool: PermissionDecider,
  invokingRow: Message,
): Promise<{ ok: boolean; data: { output: string; exitCode: number } | string }> {
  const entry = EXEC_REGISTRY[toolName]
  if (!entry) {
    return {
      ok: false,
      data: `exec: "${toolName}" is not a registered tool. Available: ${Object.keys(
        EXEC_REGISTRY,
      )
        .sort()
        .join(', ')}.`,
    }
  }
  if (!Array.isArray(rawArgs)) {
    return { ok: false, data: 'exec: args must be an array of strings.' }
  }
  const argv: string[] = []
  for (const a of rawArgs) {
    if (typeof a === 'string') argv.push(a)
    else if (typeof a === 'number' && Number.isFinite(a)) argv.push(String(a))
    else {
      return {
        ok: false,
        data: 'exec: every argument must be a string or finite number.',
      }
    }
  }
  // Subcommand allowlist (first argv element), for entries that carry one.
  if (entry.subcommands) {
    const sub = argv[0] ?? ''
    if (!entry.subcommands.includes(sub)) {
      return {
        ok: false,
        data: `exec: "${`${toolName} ${sub}`.trim()}" is not allowed. Permitted ${toolName} subcommands: ${entry.subcommands.join(
          ', ',
        )}.`,
      }
    }
  }

  const parts = [entry.executable, ...argv.map(shellQuote)]
  let command = parts.join(' ')
  // options.cwd IS model text (ExecTool.call forwards the model-supplied
  // `cwd` input verbatim). The `cd &&` prefix is safe ONLY because the
  // resolved path goes through `shellQuote` like every argv element — a
  // metacharacter in the cwd is a literal path character, never a shell
  // operator. Do not loosen that quoting (e.g. for `~` expansion) without
  // replacing it with an equivalent neutralizer. A relative cwd anchors at
  // the session cwd.
  if (options?.cwd && options.cwd.trim().length > 0) {
    const abs = resolveRuntimePath(context.options.cwd, options.cwd)
    command = `cd ${shellQuote(abs)} && ${command}`
  }

  // Dispatch through the Bash tool's full permission gate (reuses every phase).
  const res = await runNestedTool(
    SHELL_TOOL_ID,
    { command },
    context,
    canUseTool,
    invokingRow,
  )
  // The command never ran (denied / blocked / Bash unavailable) — surface the
  // reason as the refusal.
  if (!res.ok) return res
  // It ran — hand back the unwrapped output + exit status.
  return { ok: true, data: unwrapBashResult(res.data) }
}

const EXEC_DESCRIPTION = [
  'Run a registered development command by argv and see its output. Not a shell: arguments are passed literally, so metacharacters are inert, and only registered commands run.',
  '',
  `Registered: ${Object.keys(EXEC_REGISTRY).sort().join(', ')}. (npm is limited to: ${EXEC_REGISTRY.npm!.subcommands!.join(', ')}.)`,
  '',
  'A command that ran returns its output — with `[exit code N]` appended when non-zero, so check it. A command that could not run (unregistered, disallowed subcommand, denied) fails with the reason.',
  '',
  "Use exec for operations whose result you need to see: git, builds, tests, type checks, diagnostics. Shells, interpreters, and file utilities are not available — read files with the read tools and change them with `SuperEdit`.",
].join('\n')

export const ExecTool: ToolContract<ExecInput, ExecOutput> = declareTool({
  name: EXEC_TOOL_NAME,
  discoveryHint: 'run a registered development command (git, build, test) by argv',
  argsSchema: {
    type: 'object',
    properties: {
      tool: {
        type: 'string',
        description:
          'The registered command to run (see the tool description for the list).',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Argv for the command, one element per argument (e.g. [\"status\", \"--short\"]). Passed literally — no shell interpretation.",
      },
      cwd: {
        type: 'string',
        description:
          'Working directory (workspace-relative or absolute). Defaults to the session cwd.',
      },
    },
    required: ['tool'],
    additionalProperties: false,
  },
  description: async () => EXEC_DESCRIPTION,
  async checkInput(input: ExecInput): Promise<InputCheck> {
    if (typeof input.tool !== 'string' || input.tool.trim().length === 0) {
      return { result: false, message: '`tool` is required.', errorCode: 1 }
    }
    if (!EXEC_REGISTRY[input.tool]) {
      return {
        result: false,
        message: `"${input.tool}" is not a registered tool. Available: ${Object.keys(
          EXEC_REGISTRY,
        )
          .sort()
          .join(', ')}.`,
        errorCode: 2,
      }
    }
    if (input.args !== undefined && !Array.isArray(input.args)) {
      return {
        result: false,
        message: '`args` must be an array of strings.',
        errorCode: 3,
      }
    }
    return { result: true }
  },
  call: async (
    input: ExecInput,
    context: ToolCallContext,
    canUseTool: PermissionDecider,
    invokingRow: Message,
  ) => {
    const res = await runExec(
      input.tool ?? '',
      input.args ?? [],
      input.cwd ? { cwd: input.cwd } : undefined,
      context,
      canUseTool,
      invokingRow,
    )
    if (!res.ok) {
      return { data: typeof res.data === 'string' ? res.data : 'exec failed.' }
    }
    const { output, exitCode } = res.data as { output: string; exitCode: number }
    if (exitCode === 0) {
      return { data: output.trim().length > 0 ? output : '(no output)' }
    }
    const body = output.trim().length > 0 ? output.replace(/\s+$/, '') : '(no output)'
    return { data: `${body}\n[exit code ${exitCode}]` }
  },
})

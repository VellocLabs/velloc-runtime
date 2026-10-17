/**
 * Security: SuperEdit runs a model-supplied script (inline `code` or a local `path`)
 * in a per-call hardened DedicatedWorker: no network, no process, no nested worker,
 * no tool proxy; the permission-gated `workspace` facade is its only I/O. Writes are
 * recorded into an OverlayFs and applied by `commitOverlay` only when the script
 * succeeds; a thrown script leaves disk untouched (F-21).
 */

import type { ModelReplyRow, Message } from '../../runtime/RuntimeTypes'
import type { PermissionDecider } from '../permissionVerdict'
import type { ToolContract, InputCheck } from '../toolContract'
import type { ToolCallContext } from '../toolCallContext'
import { declareTool, resolveToolByName } from '../toolContract'
import { checkToolThroughMods } from '../run/toolCheckThroughMods'
import {
  buildFilePermissionContext,
} from '../run/toolPermissionGate'
import { nestedToolGatesOf } from '../run/toolLifecycleHooks'
import { confirmWithPermissionRequestHooks } from '../../lifecycleHooks/permissionRequestHooks'
import {
  vetFileRead,
  vetFileWrite,
} from '../../permissions/filesystemPermission'
import {
  isExactPlanFilePath,
  planModeRejectMessage,
} from '../../permissions/planMode'
import { planDocPath } from '../../utils/planFiles'
import { fsForContext, type RuntimeFs } from '../../utils/fs/runtimeFs'
import {
  assertUntrustedReadAllowed,
  untrustedReadDeniedMessage,
} from '../../permissions/untrustedReadBoundary'
import {
  isFsNotFoundError,
  isFsTransportFailure,
} from '../../utils/fsTransportFailure'
import { dirnameRuntimePath, resolveRuntimePath } from '../../utils/runtimePaths'
import { isRunJsAvailable, runJs, RunJsFailure } from '../../browser/runJs/RunJsBroker'
import {
  SUPER_EDIT_TOOL_NAME,
  type RunJsFsOp,
  type RunJsLogLine,
} from '../../browser/runJs/runJsProtocol'
import {
  OverlayFs,
  type Baseline,
  type CommitOp,
  type OverlayDisk,
} from '../../browser/runJs/overlayFs'
import {
  notifyRunJsFinished,
  notifyRunJsStarted,
} from '../../backgroundTasks/sideTaskSink'
import {
  READ_TOOL_ID,
  WRITE_TOOL_ID,
} from '../../prompting/fileToolNames'
import { deriveSnapshotTurnInfo } from '../../utils/turnDiffs'

export type SuperEditInput = {
  code?: string
  path?: string
  /** Data values exposed to the script as its `inputs` object. The separation
   *  is the point: `code` is LOGIC and is parsed as JavaScript; `inputs` is
   *  DATA and travels to the worker by structured clone, handed to the script
   *  as a runtime value — so file content, find/replace blocks, and other
   *  large text land verbatim no matter what backticks / quotes / backslashes
   *  / `${}` they contain. This kills the recurring failure mode of models
   *  embedding documents inside JS string literals and tripping the parser
   *  ("Unexpected identifier", "Invalid or unexpected token"). */
  inputs?: Record<string, unknown>
  /** Brief user-facing description of what this run will do (shown on the
   *  tool-call card). Not passed to the script. */
  description?: string
  /** Execution timeout in SECONDS (1–600, default 30). The clock PAUSES while
   *  the script is blocked on a `workspace` filesystem call — so a permission
   *  prompt the user has not answered yet never trips it (see RunJsBroker's
   *  pause-during-nested-call). */
  timeoutSec?: number
}

export type SuperEditOutput = string

const DEFAULT_TIMEOUT_SEC = 30
const MIN_TIMEOUT_SEC = 1
const MAX_TIMEOUT_SEC = 600

// Monotonic counter so two concurrent same-name `ask` calls in the same
// millisecond get distinct toolUseIDs (the permission coordinator keys parked
// resolvers by approvalCallId; a collision would drop one and hang it).
let nestedConfirmSeq = 0

/** Clamp `timeoutSec` (seconds) to [1, 600] and return the broker's timeout in
 *  MILLISECONDS. Absent/invalid → the 30s default. */
function clampTimeoutMs(seconds: unknown): number {
  const s =
    typeof seconds === 'number' && Number.isFinite(seconds)
      ? seconds
      : DEFAULT_TIMEOUT_SEC
  return Math.max(MIN_TIMEOUT_SEC, Math.min(MAX_TIMEOUT_SEC, Math.floor(s))) * 1000
}

/** Strict-mode tool calls (`inputJSONSchemaStrict` below) send every declared
 *  property, so an unset optional field arrives as explicit `null` rather
 *  than being omitted — the schema marks those fields `type: [..., "null"]`
 *  for exactly this reason. Treat `null` the same as "not provided" at the
 *  single boundary both `validateInput` and `call` go through, so the rest
 *  of this file keeps its plain `?:` optionality checks (`!== undefined`)
 *  correct for both strict and non-strict callers. */
function normalizeInput(input: SuperEditInput): SuperEditInput {
  return {
    code: input.code ?? undefined,
    path: input.path ?? undefined,
    inputs: input.inputs ?? undefined,
    description: input.description ?? undefined,
    timeoutSec: input.timeoutSec ?? undefined,
  }
}

async function checkInput(
  rawInput: SuperEditInput,
  _context: ToolCallContext,
): Promise<InputCheck> {
  const input = normalizeInput(rawInput)
  const hasCode = typeof input.code === 'string' && input.code.length > 0
  const hasPath = typeof input.path === 'string' && input.path.trim().length > 0
  if (!hasCode && !hasPath) {
    return {
      result: false,
      message: 'Provide either `code` (inline JavaScript) or `path` (a file to run).',
      errorCode: 1,
    }
  }
  if (hasCode && hasPath) {
    return {
      result: false,
      message: 'Provide only one of `code` or `path`, not both.',
      errorCode: 2,
    }
  }
  if (
    input.timeoutSec !== undefined &&
    (typeof input.timeoutSec !== 'number' || !Number.isFinite(input.timeoutSec))
  ) {
    return {
      result: false,
      message: '`timeoutSec` must be a number when provided.',
      errorCode: 3,
    }
  }
  if (
    input.inputs !== undefined &&
    (typeof input.inputs !== 'object' ||
      input.inputs === null ||
      Array.isArray(input.inputs))
  ) {
    return {
      result: false,
      message:
        '`inputs` must be a plain object mapping names to data values ' +
        '(e.g. {"content": "..."}) when provided.',
      errorCode: 4,
    }
  }
  return { result: true }
}

/** DOMException-named error for the `workspace` facade — the broker carries
 *  `.name` across the pipe and the facade rethrows it platform-shaped. */
function fsError(name: string, message: string): Error {
  const err = new Error(message)
  err.name = name
  return err
}

const WORKSPACE_READ_OPS: ReadonlySet<RunJsFsOp> = new Set([
  'stat',
  'readdir',
  'readFile',
])

function normSlash(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

// The whole run resolves its fs through `fsForContext(context)` — THIS
// session's fs (see toolkit/toolContract.ts), the module slot only for minimal/test contexts
// — so a sibling runtime's boot/teardown clobbering the shared slot — leaving
// it on a DISPOSED bridge transport ("Runtime scope was disposed.") — can no
// longer fail this session's read/commit or masquerade as a disk conflict.

/** Thrown out of `currentDiskState` when the commit-time re-stat failed with
 *  a DISCRIMINATED transient error (the host's EACCES/EBUSY/EUNKNOWN wire
 *  codes) — the path's true state could not be verified, which is neither
 *  "absent" nor "changed": the caller converts it to the `unverifiable`
 *  outcome. */
class FsStatFailedError extends Error {
  constructor(
    readonly path: string,
    readonly cause_: unknown,
  ) {
    super(cause_ instanceof Error ? cause_.message : String(cause_))
    this.name = 'FsStatFailedError'
  }
}

/** Thrown out of `currentDiskState` when the commit-time re-stat failed at the
 *  transport layer — the caller converts it to an honest `unavailable`
 *  outcome instead of a conflict verdict. */
class FsUnavailableError extends Error {
  constructor(
    readonly path: string,
    readonly cause_: unknown,
  ) {
    super(cause_ instanceof Error ? cause_.message : String(cause_))
    this.name = 'FsUnavailableError'
  }
}

/** Adapt the full `RuntimeFs` to the read-only surface the overlay reads
 *  through (misses, baselines, move enumeration). Commit EXECUTION uses the
 *  full fs directly — the overlay never writes. */
function overlayDiskFromFs(fs: RuntimeFs): OverlayDisk {
  return {
    stat: path => fs.stat(path),
    readFileBytes: path => fs.readFileBytes(path),
    readdir: path => fs.readdir(path),
  }
}

/** Resolved, containment-checked absolute paths for one facade primitive, plus
 *  the gate flavour. Shared by the script phase (which gates reads and records
 *  mutations) and the commit phase (which gates + executes mutations). */
type ResolvedFsPaths = {
  resolved: string
  /** The move destination, absolute; null for every non-move op. */
  resolvedNew: string | null
  isRead: boolean
  gateToolName: string
}

/**
 * Absolute normalized paths for `path`/`root` (and a move's `newPath`/`newRoot`).
 * Security: each must stay inside its handle and a move's destination outside its
 * source; defense-in-depth, as the permission pipeline gates the absolute path.
 */
function resolveFsPaths(
  op: RunJsFsOp,
  payload: Record<string, unknown>,
  context: ToolCallContext,
): ResolvedFsPaths {
  const rel = typeof payload.path === 'string' ? payload.path : ''
  const root =
    typeof payload.root === 'string' && payload.root.length > 0
      ? payload.root
      : context.options.cwd
  const rootNorm = normSlash(root)
  const resolved = normSlash(resolveRuntimePath(root, rel))
  if (resolved !== rootNorm && !resolved.startsWith(`${rootNorm}/`)) {
    throw fsError('NotAllowedError', 'Path escapes its directory handle.')
  }

  let resolvedNew: string | null = null
  if (op === 'move') {
    const relNew = typeof payload.newPath === 'string' ? payload.newPath : ''
    const rootNew =
      typeof payload.newRoot === 'string' && payload.newRoot.length > 0
        ? payload.newRoot
        : context.options.cwd
    const rootNewNorm = normSlash(rootNew)
    resolvedNew = normSlash(resolveRuntimePath(rootNew, relNew))
    if (resolvedNew !== rootNewNorm && !resolvedNew.startsWith(`${rootNewNorm}/`)) {
      throw fsError('NotAllowedError', 'Path escapes its directory handle.')
    }
    // Both sides are ABSOLUTE here, so a destination inside the source is
    // decidable even when the worker-side pre-check (fileHelpers.move) could
    // not compare the two spellings.
    if (resolvedNew === resolved || resolvedNew.startsWith(`${resolved}/`)) {
      throw fsError('InvalidModificationError', 'Cannot move a path into itself.')
    }
  }

  const isRead = WORKSPACE_READ_OPS.has(op)
  return {
    resolved,
    resolvedNew,
    isRead,
    gateToolName: isRead ? READ_TOOL_ID : WRITE_TOOL_ID,
  }
}

/**
 * Security: plan-mode gate for ONE write path. Only a `writeFile` to exactly the
 * plan file and a `mkdir` of exactly its parent pass; any other mutation is blocked.
 */
function enforcePlanModeWrite(
  op: RunJsFsOp,
  resolved: string,
  context: ToolCallContext,
  gateToolName: string,
): void {
  const planModeContext = context.readAppState?.().permissionRules
  if (!planModeContext || planModeContext.mode !== 'plan') return
  const planFilePath = planDocPath(context)
  const isPlanFileOp =
    (op === 'writeFile' && isExactPlanFilePath(resolved, planFilePath)) ||
    (op === 'mkdir' &&
      isExactPlanFilePath(resolved, dirnameRuntimePath(planFilePath)))
  if (!isPlanFileOp) {
    throw fsError('NotAllowedError', planModeRejectMessage(gateToolName))
  }
}

/**
 * Run the filesystem permission pipeline for ONE resolved path — the same
 * `checkRead/WritePermissionForTool` a hosted Read/Write uses. Throws
 * `NotAllowedError` on a deny or an unanswered/declined ask. Absent
 * `getAppState` (minimal test contexts) → no gate beyond the caller's
 * containment assert, matching the main pipeline's unguarded read.
 */
async function gatePermission(
  gated: string,
  isRead: boolean,
  gateToolName: string,
  op: RunJsFsOp,
  context: ToolCallContext,
  invokingRow: Message,
): Promise<void> {
  const planModeContext = context.readAppState?.().permissionRules
  if (!planModeContext) return

  const filePermCtx = buildFilePermissionContext(context, planModeContext)
  const decision = isRead
    ? await vetFileRead(gateToolName, { file_path: gated }, filePermCtx)
    : await vetFileWrite(gateToolName, { file_path: gated }, filePermCtx)

  let behavior = decision.behavior
  let message = decision.message
  let isSafetyAsk = decision.verdictReason?.type === 'safetyCheck'
  // A mod hooking `tool.check` decides this path as it decides a direct
  // Read / Write call of it: the step is that tool's call, nested. A
  // path-safety ask stands whatever it answers (checkToolThroughMods). Not
  // for `stat`, the internal existence probe the PreToolUse layer skips too.
  const mods = context.options.mods
  if (op !== 'stat' && mods?.toolCheck && mods.hasToolCheckHooks?.() === true) {
    const input = { file_path: gated }
    const settled = await checkToolThroughMods({
      mods,
      tool: resolveToolByName(context.options.tools, gateToolName) ?? ({ name: gateToolName } as ToolContract),
      input,
      verdict:
        behavior === 'deny'
          ? { decision: 'deny', message: message ?? 'Permission denied.' }
          : behavior === 'ask'
            ? {
                decision: 'ask',
                requestedInput: input,
                ...(message !== undefined ? { message } : {}),
                safety: isSafetyAsk,
                resume: { stage: 'hook', ruleSet: undefined as never },
              }
            : { decision: 'allow', updatedInput: input, permissionResult: undefined },
      callRef: `runjs-workspace-${op}-check-${++nestedConfirmSeq}`,
      agentId: context.agentId ?? mods.agentId,
      signal: context.cancelSource.signal,
      context: context.modCallContext,
    })
    behavior = settled.decision
    if (settled.decision === 'deny') message = settled.message
    if (settled.decision === 'ask') {
      message = settled.message
      isSafetyAsk = settled.safety
    }
  }

  if (behavior === 'deny') {
    throw fsError('NotAllowedError', message ?? 'Permission denied.')
  }
  if (behavior !== 'ask') return

  const isBypass = planModeContext.mode === 'bypassPermissions'
  if (isBypass && !isSafetyAsk) return

  // Headless / sub-agent: PermissionRequest hooks get their chance, then
  // auto-deny — never park a prompt no UI can answer (as ExecTool's nested
  // executor does).
  if (planModeContext.suppressAsks) {
    const headless = await nestedToolGatesOf(context).headlessDecision(
      { name: gateToolName },
      { file_path: gated },
      `runjs-workspace-${op}-${++nestedConfirmSeq}`,
      context,
    )
    if (headless.behavior === 'deny') {
      throw fsError('NotAllowedError', headless.message)
    }
    return
  }

  const requestToolUseConfirm = context.requestToolUseConfirm
  if (!requestToolUseConfirm) {
    throw fsError(
      'NotAllowedError',
      `Permission required for ${gated}, and no confirmation surface exists in this session.`,
    )
  }
  // Surface the specific path-safety reason so the banner can offer the right
  // affordance (e.g. an "Allow this folder" button for outside-workspace),
  // same derivation as the main pipeline.
  const pathSafetyReason =
    isSafetyAsk && decision.verdictReason?.type === 'safetyCheck'
      ? (decision.verdictReason.reason as
          | 'sensitive-path'
          | 'outside-workspace'
          | 'suspicious-path'
          | undefined)
      : undefined
  const directory =
    pathSafetyReason === 'outside-workspace' ? dirnameRuntimePath(gated) : undefined
  // PermissionRequest hooks run beside the dialog, as on the main pipeline.
  const resolution = await confirmWithPermissionRequestHooks(
    requestToolUseConfirm,
    {
      assistantMessage: invokingRow as ModelReplyRow,
      toolName: gateToolName,
      description: `workspace ${op}`,
      input: { file_path: gated },
      approvalCallId: `runjs-workspace-${op}-${++nestedConfirmSeq}-${Date.now()}`,
      permissionResult: {
        behavior: 'ask',
        message,
        updatedInput: { file_path: gated },
        reason: pathSafetyReason,
        directory,
      },
      askedAtMs: Date.now(),
    },
    context,
  )
  if (resolution.behavior !== 'allow') {
    throw fsError(
      'NotAllowedError',
      resolution.feedback?.trim()
        ? resolution.feedback.trim()
        : `Permission denied for ${gated}.`,
    )
  }
}

/**
 * Fire the blocking PreToolUse hook layer for ONE path, keyed on the gate tool
 * (Read/Write) — a `Write` matcher hook is not bypassable via `workspace`.
 * SKIPPED for `stat`, which is only ever an internal existence probe during
 * handle resolution (gating it would fire a Read hook on every getFileHandle).
 * Throws `NotAllowedError` when a hook blocks.
 */
async function gateHook(
  gated: string,
  gateToolName: string,
  op: RunJsFsOp,
  context: ToolCallContext,
): Promise<void> {
  if (op === 'stat') return
  const preHook = await nestedToolGatesOf(context).preHooks(
    gateToolName,
    { file_path: gated },
    `runjs-workspace-${op}-${++nestedConfirmSeq}`,
    context,
  )
  if (preHook.blocked) {
    throw fsError('NotAllowedError', `Hook blocked: ${preHook.message}`)
  }
}

// ── script phase: reads served from the overlay, mutations recorded ──────────

/**
 * One `workspace` primitive DURING the script. Reads are permission-gated (and
 * hook-gated, except `stat`) and served from the overlay; mutations are only
 * recorded. A `move` without native `fs.rename` throws `NotSupportedError`.
 */
export async function handleScriptFsOp(
  overlay: OverlayFs,
  op: RunJsFsOp,
  payload: Record<string, unknown>,
  context: ToolCallContext,
  invokingRow: Message,
): Promise<unknown> {
  const { resolved, resolvedNew, isRead, gateToolName } = resolveFsPaths(
    op,
    payload,
    context,
  )

  // Untrusted-provider read boundary — the second (and last) chokepoint. Every
  // facade primitive resolves its paths here, reads and mutations alike, so
  // one check covers both the script phase and the commit that replays it.
  //
  // A DENIAL, not an ask. There is no user-approval path for a session on a
  // relay: the prompt would be raised by text the untrusted model wrote, which
  // makes "the user approved it" a thing that model can arrange.
  if (context.options.untrustedReadRoot) {
    for (const candidate of [resolved, resolvedNew]) {
      if (!candidate) continue
      const verdict = await assertUntrustedReadAllowed(
        candidate,
        context,
        fsForContext(context),
      )
      if (!verdict.ok) {
        throw fsError(
          'NotAllowedError',
          `${verdict.reason}. This session may only access files under ${context.options.untrustedReadRoot}.`,
        )
      }
    }
  }

  if (isRead) {
    await gatePermission(resolved, true, gateToolName, op, context, invokingRow)
    await gateHook(resolved, gateToolName, op, context)
    switch (op) {
      case 'stat':
        return overlay.statForScript(resolved)
      case 'readdir':
        return overlay.readdirForScript(resolved)
      case 'readFile':
        return overlay.readFileForScript(resolved)
    }
  }

  // Mutation: record only. No permission gate, no snapshot, no disk write here.
  switch (op) {
    case 'writeFile': {
      const bytes =
        payload.bytes instanceof Uint8Array ? payload.bytes : new Uint8Array(0)
      await overlay.recordWrite(resolved, bytes)
      return null
    }
    case 'mkdir':
      await overlay.recordMkdir(resolved)
      return null
    case 'remove':
      await overlay.recordRemove(resolved)
      return null
    case 'move': {
      if (!fsForContext(context).rename) {
        // Older host / non-native fs impl: surface the same signal an old host
        // does, so fileHelpers.move falls back to copy+delete (recorded as
        // ordinary writeFile/remove primitives).
        throw fsError('NotSupportedError', 'Native move is not supported by this host.')
      }
      await overlay.recordMove(resolved, resolvedNew!)
      return null
    }
    default:
      throw fsError('NotSupportedError', `Unknown workspace op: ${String(op)}`)
  }
}

// ── commit phase: gate the touched set, conflict-check, execute ──────────────

/** Disk state of a path for the conflict check: only a not-found failure is absent
 *  (`null`); a transport failure throws `FsUnavailableError`; a transient stat
 *  failure throws `FsStatFailedError`. An older host's ambiguous wording is absent. */
async function currentDiskState(
  fs: RuntimeFs,
  path: string,
): Promise<Baseline> {
  try {
    const st = await fs.stat(path)
    return {
      kind: st.isDirectory() ? 'dir' : 'file',
      size: st.size,
      mtimeMs: st.mtimeMs ?? 0,
    }
  } catch (err) {
    if (isFsTransportFailure(err)) throw new FsUnavailableError(path, err)
    if (isFsNotFoundError(err)) return null
    throw new FsStatFailedError(path, err)
  }
}

/** True when a touched path's disk state diverged from its first-touch
 *  baseline: appeared, vanished, changed kind, or (for a file) changed size or
 *  mtime. Two directories are NOT a conflict on internal churn — only on the
 *  directory itself disappearing or turning into a file. */
function isConflict(baseline: Baseline, current: Baseline): boolean {
  if (baseline === null) return current !== null
  if (current === null) return true
  if (baseline.kind !== current.kind) return true
  if (baseline.kind === 'file') {
    return baseline.size !== current.size || baseline.mtimeMs !== current.mtimeMs
  }
  return false
}

/** Capture the before-image for one committed mutation (SafeCode snapshots).
 *  `mkdir` records nothing (an empty created dir surviving a revert is the
 *  documented limitation). A capture failure THROWS — "mutated but
 *  unsnapshotted" is the one state the safety net refuses to create. */
async function captureSnapshotForOp(
  opEntry: CommitOp,
  context: ToolCallContext,
  fs: RuntimeFs,
): Promise<void> {
  const recorder = context.options.fileSnapshotRecorder
  if (!recorder) return
  const turn = deriveSnapshotTurnInfo(context.messages ?? [])
  const trackRemovalOrMutation = async (path: string): Promise<void> => {
    let isDirectory = false
    try {
      isDirectory = (await fs.stat(path)).isDirectory()
    } catch (err) {
      // A dead transport is not "absent" — rethrow so the commit reports
      // `unavailable` instead of misattributing it downstream.
      if (isFsTransportFailure(err)) throw err
      // A discriminated transient failure (EACCES/EBUSY/…) is not "absent"
      // either: swallowing it made a directory remove record a FILE-shaped
      // snapshot (a skipped placeholder — no per-file blobs) and the tree
      // then deleted unrecoverably. Rethrow;
      // only genuine not-found falls through to "the op below throws".
      if (!isFsNotFoundError(err)) throw err
    }
    if (isDirectory) await recorder.trackBeforeDirectoryRemoval(path, turn)
    else await recorder.trackBeforeMutation(path, turn)
  }
  try {
    switch (opEntry.op) {
      case 'writeFile':
        await recorder.trackBeforeMutation(opEntry.path, turn)
        break
      case 'remove':
        await trackRemovalOrMutation(opEntry.path)
        break
      case 'move':
        await trackRemovalOrMutation(opEntry.from)
        // The destination is created (or overwritten): record it so revert can
        // undo it. A moved DIRECTORY reappearing at the destination shares
        // mkdir's limitation — the dir itself survives a revert; its file
        // contents are restored at the source by the tree snapshot above.
        await recorder.trackBeforeMutation(opEntry.to, turn)
        break
      case 'mkdir':
        break
    }
  } catch (err) {
    // Preserve a transport failure's IDENTITY: rewrapping it as
    // OperationError would depend on the message surviving verbatim for the
    // execute-phase `isFsTransportFailure` check to classify the outcome as
    // `unavailable` rather than a misleading `partial`.
    if (isFsTransportFailure(err)) throw err
    throw fsError('OperationError', err instanceof Error ? err.message : String(err))
  }
}

/** Apply one recorded mutation to real disk. `writeFile` and `move` create the
 *  destination's missing parent directories (native recursive `mkdir`, as
 *  the write helpers do), since a deferred deep write never triggered the
 *  helper's own retry against the overlay. */
async function executeOpOnDisk(
  opEntry: CommitOp,
  fs: RuntimeFs,
): Promise<void> {
  switch (opEntry.op) {
    case 'writeFile': {
      try {
        await fs.writeFile(opEntry.path, opEntry.bytes)
      } catch (writeErr) {
        // Likely a missing parent → create it and retry once. If the parent
        // creation OR the retry fails, the original write error is the real
        // cause (the failure was NOT a missing parent) — surface it, not the
        // misleading mkdir/retry error. EXCEPT a transport death in the
        // fallback: infrastructure-failure identity must not be
        // overwritten by the earlier business error, or the outcome
        // misclassifies as `partial` instead of `unavailable`.
        try {
          await fs.mkdir(dirnameRuntimePath(opEntry.path))
          await fs.writeFile(opEntry.path, opEntry.bytes)
        } catch (fallbackErr) {
          if (isFsTransportFailure(fallbackErr)) throw fallbackErr
          throw writeErr
        }
      }
      return
    }
    case 'mkdir':
      await fs.mkdir(opEntry.path)
      return
    case 'remove': {
      let isDirectory = false
      try {
        isDirectory = (await fs.stat(opEntry.path)).isDirectory()
      } catch {
        // fall through — unlink/rm will surface the real failure
      }
      if (isDirectory) await fs.rm(opEntry.path, { recursive: true })
      else await fs.unlink(opEntry.path)
      return
    }
    case 'move': {
      const rename = fs.rename?.bind(fs)
      if (!rename) {
        // A move op is only ever recorded when rename existed at script time;
        // if it has vanished, fail this op honestly rather than silently skip.
        throw fsError('OperationError', 'Native move is not available at commit time.')
      }
      try {
        await rename(opEntry.from, opEntry.to)
      } catch (renameErr) {
        if (renameErr instanceof Error && renameErr.name === 'AlreadyExistsError') {
          throw renameErr
        }
        // Likely a missing destination parent → create it and retry once
        // (as fileHelpers.move's native fast path does). If that fails, the
        // original rename error was the real cause — surface it, not the mkdir
        // error. Same transport-identity carve-out as writeFile above.
        try {
          await fs.mkdir(dirnameRuntimePath(opEntry.to))
          await rename(opEntry.from, opEntry.to)
        } catch (fallbackErr) {
          if (isFsTransportFailure(fallbackErr)) throw fallbackErr
          throw renameErr
        }
      }
      return
    }
  }
}

/** The outcome of committing a script's recorded changes. */
export type CommitOutcome =
  | { status: 'ok'; committed: string[] }
  | { status: 'noop' }
  | { status: 'conflict'; paths: string[] }
  | { status: 'denied'; message: string; path: string }
  | { status: 'partial'; committed: string[]; failedPath: string; message: string }
  /** The session's filesystem bridge failed at the TRANSPORT layer (disposed
   *  runtime scope). `attempted: false` = the failure hit a gate/conflict
   *  check before any execute op was ISSUED, so the tree is certainly
   *  untouched. `attempted: true` = the failing request had already been
   *  emitted to the host, whose write/remove may have completed with only
   *  the response dropped (`AgentWorkerBridgeTransport.cancelGeneration`
   *  sweeps in-flight requests; there is no host-side cancel) — the headline
   *  must not claim the tree is untouched. */
  | { status: 'unavailable'; path: string; message: string; attempted: boolean }
  /** The commit re-stat failed with a DISCRIMINATED transient error (the
   *  host's EACCES/EBUSY/EUNKNOWN wire codes): the path's state could not be
   *  verified, so neither "absent" nor "changed on disk" would be honest.
   *  Nothing was written. */
  | { status: 'unverifiable'; path: string; message: string }

/**
 * Contract: apply a successful script's ops transactionally. 1) gate each touched
 * path once (any denial aborts, nothing written); 2) conflict-check against the
 * first-touch baselines (any change aborts); 3) replay the ops verbatim with
 * snapshots. Only a real disk failure interrupts, reported as partial.
 */
export async function commitOverlay(
  overlay: OverlayFs,
  context: ToolCallContext,
  invokingRow: Message,
): Promise<CommitOutcome> {
  if (!overlay.hasChanges()) return { status: 'noop' }
  const plan = overlay.getCommitPlan()
  const fs = fsForContext(context)

  // 1. Gate the distinct touched paths (one gate per path; op-aware plan mode).
  const granted = new Set<string>()
  for (const opEntry of plan.ops) {
    const paths = opEntry.op === 'move' ? [opEntry.from, opEntry.to] : [opEntry.path]
    for (const path of paths) {
      try {
        enforcePlanModeWrite(opEntry.op, path, context, WRITE_TOOL_ID)
        if (!granted.has(path)) {
          await gatePermission(path, false, WRITE_TOOL_ID, opEntry.op, context, invokingRow)
          await gateHook(path, WRITE_TOOL_ID, opEntry.op, context)
          granted.add(path)
        }
      } catch (err) {
        // A transport death during the gate itself (a PreToolUse hook or a
        // permission round-trip over the same bridge) is NOT a denial — the
        // model would read "denied" as user refusal and abandon the edit.
        // Nothing has been issued to the host at this point.
        if (isFsTransportFailure(err)) {
          return {
            status: 'unavailable',
            path,
            message: err instanceof Error ? err.message : String(err),
            attempted: false,
          }
        }
        return {
          status: 'denied',
          message: err instanceof Error ? err.message : String(err),
          path,
        }
      }
    }
  }

  // 2. Conflict check — every TOUCHED path (read or mutated), right before
  //    writing anything. Reads are included so a run whose output was derived
  //    from an input file that changed on disk mid-run is refused rather than
  //    committing stale-derived content.
  const conflicts: string[] = []
  // A transient re-stat failure must NOT end the scan: returning mid-loop would discard conflicts already
  // found on earlier paths — and 'conflict' is the conservative verdict
  // ("re-read then retry" is safe under both hypotheses, "retry the same
  // call" is only safe under one), so conflicts always win the outcome.
  let unverifiable: FsStatFailedError | null = null
  for (const { path, baseline } of overlay.getTouchedBaselines()) {
    let current: Baseline
    try {
      current = await currentDiskState(fs, path)
    } catch (err) {
      if (err instanceof FsUnavailableError) {
        // Dead transport, not a changed file — every remaining re-stat would
        // die on the same pipe, so ending the scan here loses nothing.
        // Report it as such so the model retries instead of hunting for
        // concurrent edits that never happened.
        return {
          status: 'unavailable',
          path: err.path,
          message: err.message,
          attempted: false,
        }
      }
      if (err instanceof FsStatFailedError) {
        // Discriminated transient failure (permission/lock/I/O) — the path's
        // state is UNKNOWN, which is neither "absent" nor "changed on disk".
        // Remember the first one and keep scanning: the bridge is alive, and
        // a real conflict on a later path must not be masked.
        unverifiable ??= err
        continue
      }
      throw err
    }
    if (isConflict(baseline, current)) conflicts.push(path)
  }
  if (conflicts.length > 0) return { status: 'conflict', paths: conflicts }
  if (unverifiable) {
    return {
      status: 'unverifiable',
      path: unverifiable.path,
      message: unverifiable.message,
    }
  }

  // 3. Execute verbatim, with snapshots. Only disk failure can interrupt now.
  const committed: string[] = []
  for (const opEntry of plan.ops) {
    if (context.cancelSource?.signal.aborted) {
      return {
        status: 'partial',
        committed,
        failedPath: commitOpPath(opEntry),
        message: 'Interrupted.',
      }
    }
    // Distinguishes a snapshot-phase failure (the target mutation was never
    // issued — the certain "nothing was written" headline applies) from an
    // execute-phase one (the request may have been emitted; hedge).
    let mutationIssued = false
    try {
      await captureSnapshotForOp(opEntry, context, fs)
      mutationIssued = true
      await executeOpOnDisk(opEntry, fs)
      committed.push(commitOpLabel(opEntry))
    } catch (err) {
      // A transport-dead failure before ANY op landed is the same honest
      // "bridge unavailable, retry" story as a failed conflict re-stat. Once
      // something HAS landed it must stay a `partial` — the model needs the
      // list of what reached disk, whatever the failure mechanism.
      if (committed.length === 0 && isFsTransportFailure(err)) {
        return {
          status: 'unavailable',
          path: commitOpPath(opEntry),
          message: err instanceof Error ? err.message : String(err),
          attempted: mutationIssued,
        }
      }
      return {
        status: 'partial',
        committed,
        failedPath: commitOpPath(opEntry),
        message: err instanceof Error ? err.message : String(err),
      }
    }
  }
  return { status: 'ok', committed: [...granted] }
}

function commitOpPath(opEntry: CommitOp): string {
  return opEntry.op === 'move' ? opEntry.to : opEntry.path
}

function commitOpLabel(opEntry: CommitOp): string {
  return opEntry.op === 'move'
    ? `move ${opEntry.from} → ${opEntry.to}`
    : `${opEntry.op} ${opEntry.path}`
}

/** The model-facing headline for a commit that did not fully apply. */
function commitFailureHeadline(outcome: CommitOutcome): string {
  switch (outcome.status) {
    case 'conflict':
      return (
        `SuperEdit did not save: ${outcome.paths.length} file(s) changed on disk ` +
        `while the script was running, so NONE of its changes were applied.\n` +
        outcome.paths.map(p => `  - ${p}`).join('\n') +
        `\nRe-read the changed file(s) and run SuperEdit again.`
      )
    case 'denied':
      return (
        `SuperEdit did not save: ${outcome.message} (${outcome.path}). ` +
        `No changes were applied.`
      )
    case 'partial':
      return (
        `SuperEdit failed partway through writing changes at ${outcome.failedPath}: ` +
        `${outcome.message}.\n` +
        (outcome.committed.length > 0
          ? `Applied before the failure:\n${outcome.committed.map(p => `  - ${p}`).join('\n')}`
          : 'No changes were applied before the failure.')
      )
    case 'unverifiable':
      return (
        `SuperEdit could not save: the state of ${outcome.path} could not ` +
        `be verified before writing (${outcome.message}). Nothing was ` +
        `written. This is a transient filesystem condition (permissions, a ` +
        `lock, or an I/O error); no concurrent edit was detected on the ` +
        `paths that could be checked, but ${outcome.path} itself was not ` +
        `checked. Resolve the condition or wait, re-read ${outcome.path} if ` +
        `its content matters, then retry the SuperEdit call.`
      )
    case 'unavailable':
      return (
        `SuperEdit could not save: this session's filesystem bridge is ` +
        `unavailable (${outcome.message}; first failing path ${outcome.path}). ` +
        (outcome.attempted
          ? `No changes are CONFIRMED written — the operation at ` +
            `${outcome.path} may or may not have reached disk before the ` +
            `transport died. The failure is the fs transport, not a ` +
            `concurrent edit. Re-read the affected file(s) if their current ` +
            `state matters, then retry the SuperEdit call; `
          : `No files were written — the failure is the session's fs ` +
            `transport, not a concurrent edit, so there is nothing to ` +
            `re-read. Retry the same SuperEdit call; `) +
        `if it keeps failing, fall back to another editing tool.`
      )
    default:
      return 'SuperEdit did not save.'
  }
}

/** Characters of a ONE-LINE script quoted back to the model. Wide enough to
 *  carry a whole statement, narrow enough that a long one-line script cannot
 *  flood the tool result with source the model already wrote. Multi-line
 *  scripts are quoted whole and never consult this. */
const SOURCE_SNIPPET_MAX = 120

/** Characters of that window placed BEFORE the failing column. V8 reports the
 *  column of the failing token — the `split` of `inputs.body.split(...)` — so a
 *  window that STARTED at the column would cut off the receiver the error is
 *  actually about. */
const SOURCE_SNIPPET_LEAD = 40

/**
 * The location block for a failed run: coordinates plus the quoted source. Only a
 * one-line script past `SOURCE_SNIPPET_MAX` is windowed around the column.
 */
export function formatScriptLocation(
  code: string,
  location: { line: number; column: number },
): string {
  const head = `(script line ${location.line}:${location.column})`
  const raw = code.split('\n')[location.line - 1]
  if (raw === undefined) return head
  const src = raw.replace(/\r$/, '')
  // Trailing newlines do not make a one-line script a two-line one. Checked on
  // `code`, not on the line: a long line 1 of a MULTI-line script is still the
  // model's own layout, and `line` locates it.
  const oneLineScript = !code.replace(/(\r?\n)+$/, '').includes('\n')
  if (!oneLineScript || src.length <= SOURCE_SNIPPET_MAX) {
    return `${head}\n> ${src}`
  }
  // Clamped into the line: V8 can report a column one past the end, and an
  // empty window would be worse than a slightly shifted one. The label reports
  // where the window ACTUALLY starts, not the raw column.
  const errorAt = Math.min(Math.max(location.column - 1, 0), src.length - 1)
  const start = Math.max(errorAt - SOURCE_SNIPPET_LEAD, 0)
  const snippet = src.slice(start, start + SOURCE_SNIPPET_MAX)
  const cut = start + snippet.length < src.length ? '\u2026' : ''
  return `${head}\n\nSource from column ${start + 1}:\n> ${snippet}${cut}`
}

function renderShellResult(result: string | null, logs: RunJsLogLine[]): string {
  const parts: string[] = []
  if (result !== null) {
    parts.push(result)
  }
  if (logs.length > 0) {
    const rendered = logs
      .map(line => `[${line.level}] ${line.text}`)
      .join('\n')
    parts.push(`--- console (${logs.length}) ---\n${rendered}`)
  }
  return parts.length > 0 ? parts.join('\n\n') : '(SuperEdit completed with no output)'
}

/**
 * The tool CALL id of this SuperEdit invocation, which becomes the `local_js` task
 * id; '' when unresolved (the run still executes, just not as a task).
 */
/** Value equality for two `inputs` objects (stringify; a throw degrades to reference). */
function sameInputsValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  try {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  } catch {
    return false
  }
}

function findSuperEditToolCallId(invokingRow: Message, input: SuperEditInput): string {
  const content = (invokingRow as ModelReplyRow)?.message?.content
  if (!Array.isArray(content)) return ''
  // Pass 1: collect the SuperEdit parts. The overwhelmingly common single-call
  // message resolves here without comparing anything — in particular without
  // stringifying a potentially large `inputs` payload.
  const runJsParts: Array<{ id: string; args: SuperEditInput | undefined }> = []
  for (const part of content) {
    const rec =
      part && typeof part === 'object'
        ? (part as Record<string, unknown>)
        : null
    if (!rec) continue
    const name = typeof rec.name === 'string' ? rec.name : rec.toolName
    if (name !== SUPER_EDIT_TOOL_NAME) continue
    const id = typeof rec.id === 'string' ? rec.id : rec.toolCallId
    if (typeof id !== 'string' || id.length === 0) continue
    runJsParts.push({ id, args: (rec.args ?? rec.input) as SuperEditInput | undefined })
  }
  if (runJsParts.length === 1) return runJsParts[0]!.id
  // Pass 2 (multi-call message only): match on every arg field. `inputs`
  // participates because the code/data split makes IDENTICAL generic code
  // (and often no description) the expected shape across two same-message
  // calls — without it both would resolve to one id and clobber each other's
  // drawer task. The `inputs` deep-compare is the LAST clause so it runs only
  // when the cheap scalar fields already agree; first match wins. Both sides
  // come from the same JSON parse, so stringify equality is stable here.
  for (const { id, args } of runJsParts) {
    if (
      args &&
      args.code === input.code &&
      args.path === input.path &&
      args.description === input.description &&
      args.timeoutSec === input.timeoutSec &&
      sameInputsValue(args.inputs, input.inputs)
    ) {
      return id
    }
  }
  return runJsParts[0]?.id || ''
}

/** Guidance for a script that did not PARSE: names `inputs` (the usual cause is a
 *  document pasted into a JS string literal) and admits an ordinary typo. */
function parseFailureGuidance(input: SuperEditInput): string {
  const usedInputs = Object.keys(input.inputs ?? {}).length > 0
  const move =
    'Move that text into `inputs` and read it back as `inputs.<name>` — an ' +
    '`inputs` value is runtime data, never parsed as JavaScript, so quotes, ' +
    'backticks, backslashes and `${...}` inside it cannot break the script.'
  const fallback =
    ' If the script embeds no such text, this is an ordinary syntax error — ' +
    'fix it and retry.'
  if (usedInputs) {
    return (
      'The script did not parse. Any text still embedded in the script as a ' +
      'string literal is the likely cause. ' +
      move +
      fallback
    )
  }
  return (
    'The script did not parse, and this call sent no `inputs`. If the script ' +
    'embeds file content, multiline text, or a find/replace block, that is ' +
    'the likely cause. ' +
    move +
    ' Example: { "inputs": { "body": "..." }, "code": "await ' +
    'writeTextFile(path, inputs.body)" }.' +
    fallback
  )
}

async function call(
  rawInput: SuperEditInput,
  context: ToolCallContext,
  _canUseTool: PermissionDecider,
  invokingRow: Message,
): Promise<{ data: SuperEditOutput; isError?: boolean }> {
  const input = normalizeInput(rawInput)
  if (!isRunJsAvailable()) {
    return {
      data: 'SuperEdit is unavailable: no execution worker is attached (the app UI must be open).',
      isError: true,
    }
  }

  // Surface this run as a `local_js` (Super Edit worker) background task so the
  // conversation card can be a compact jump link and the script source + result
  // load lazily in the drawer detail. Keyed by the tool call id. Best-effort:
  // outside the SharedWorker manager (mock host / tests) the sink is a no-op.
  const callId = findSuperEditToolCallId(invokingRow, rawInput)
  const startedAt = Date.now()
  const spawnerSessionId = context.options.sessionId
  const inlineCode = typeof input.code === 'string' && input.code.length > 0
  const emitFinish = (
    status: 'success' | 'error' | 'stopped',
    resultText: string,
  ): void => {
    if (!callId) return
    notifyRunJsFinished({ callId, status, resultText, finishedAt: Date.now() })
  }
  const emitStart = (code: string): void => {
    if (!callId) return
    notifyRunJsStarted({
      callId,
      spawnerSessionId,
      description: input.description,
      code,
      path: input.path,
      // The data payload the code/data split moves OUT of `code` — without
      // this the drawer would show a one-line generic script and the written
      // content would be reviewable nowhere in the product.
      inputs: input.inputs,
      timeoutSec: input.timeoutSec,
      inlineCode,
      startedAt,
    })
  }

  let code = input.code
  if (!code && input.path) {
    const fullPath = resolveRuntimePath(context.options.cwd, input.path)
    // The script FILE is a read like any other: an untrusted child may run a
    // script only from inside its read root. Its output, its parse/runtime
    // error text (which quotes the source) and found/not-found would
    // otherwise disclose any file on the disk. Checked before the read, and
    // the check failing is a denial too — fail closed.
    let denied: string | null = null
    try {
      const verdict = await assertUntrustedReadAllowed(
        fullPath,
        context,
        fsForContext(context),
      )
      if (!verdict.ok) {
        denied = untrustedReadDeniedMessage(
          verdict,
          context.options.untrustedReadRoot,
        )
      }
    } catch (err) {
      denied = untrustedReadDeniedMessage(
        {
          reason: `the script path could not be checked (${
            err instanceof Error ? err.message : String(err)
          })`,
        },
        context.options.untrustedReadRoot,
      )
    }
    if (denied !== null) {
      emitStart('')
      emitFinish('error', denied)
      return { data: denied, isError: true }
    }
    try {
      code = await fsForContext(context).readFile(fullPath, { encoding: 'utf-8' })
    } catch (err) {
      // A transport-dead read is not a bad path — say so, or the model
      // "fixes" a path that was never wrong.
      const message = isFsTransportFailure(err)
        ? `SuperEdit could not run: this session's filesystem bridge is ` +
          `unavailable (${err instanceof Error ? err.message : String(err)}). ` +
          `This is not a problem with ${input.path}. Retry the same call; ` +
          `if it keeps failing, fall back to another editing tool.`
        : `SuperEdit could not read ${input.path}: ${
            err instanceof Error ? err.message : String(err)
          }`
      // Register + finish so the failure is inspectable in the drawer.
      emitStart('')
      emitFinish('error', message)
      return { data: message, isError: true }
    }
  }
  if (!code) {
    return { data: 'SuperEdit: no code to run.', isError: true }
  }

  emitStart(code)

  const cwdSegments = normSlash(context.options.cwd).split('/')
  const workspaceName = cwdSegments[cwdSegments.length - 1] || 'workspace'

  // Everything the script mutates is buffered here; disk stays pristine until
  // `commitOverlay` succeeds. A thrown script discards the overlay unapplied.
  const overlay = new OverlayFs(overlayDiskFromFs(fsForContext(context)))

  try {
    const { result, logs } = await runJs({
      code,
      timeoutMs: clampTimeoutMs(input.timeoutSec),
      workspaceName,
      // Normalized HERE so the documented "`inputs` is {} when omitted"
      // contract holds at the tool boundary, not as a downstream courtesy
      // (the worker still defaults defensively for older callers).
      inputs: input.inputs ?? {},
      signal: context.cancelSource?.signal,
      onFsCall: (op, payload) =>
        handleScriptFsOp(overlay, op, payload, context, invokingRow),
    })

    // The script completed — NOTHING has touched disk yet. Commit the
    // buffered changes.
    const outcome = await commitOverlay(overlay, context, invokingRow)
    if (outcome.status === 'ok' || outcome.status === 'noop') {
      const data = renderShellResult(result, logs)
      emitFinish('success', data)
      return { data }
    }
    // If the commit did not finish because the turn was ABORTED (a Stop during
    // the commit-phase permission prompt or mid-execute), propagate the
    // interrupt rather than recording a completed error result — same contract
    // as the script-phase catch below (commitOverlay downgrades an abort to a
    // `partial`/`denied` outcome, so the check has to live here, not only in
    // the catch).
    if (context.cancelSource?.signal.aborted) {
      emitFinish('stopped', 'SuperEdit was interrupted.')
      throw new Error('SuperEdit was interrupted.')
    }
    // Commit refused (conflict / permission / hook) or failed partway. Surface
    // it as an ERROR result that still carries the script's console output, so
    // the model sees how far it got and exactly why the save did not land.
    const headline = commitFailureHeadline(outcome)
    const body = result !== null ? `${headline}\n\n${result}` : headline
    const data = renderShellResult(body, logs)
    emitFinish('error', data)
    return { data, isError: true }
  } catch (err) {
    // Propagate an interrupt so the turn unwinds as aborted rather than
    // recording a completed tool result (PageReadTool rethrows AbortError the
    // same way). The overlay is discarded unapplied — no partial edit on disk.
    if (context.cancelSource?.signal.aborted) {
      emitFinish('stopped', 'SuperEdit was interrupted.')
      throw err
    }
    // Other broker rejections (script throw, timeout, worker error) surface as
    // an ERROR result — WITH the console lines streamed before the failure, so
    // the model can see how far its script got. Because writes were deferred,
    // the throw rolled everything back: disk is exactly as the run found it.
    const message = err instanceof Error ? err.message : String(err)
    const logs = err instanceof RunJsFailure ? err.logs : []
    // A transport death DURING the script (the overlay's reads/baselines ride
    // the same bridge) reaches here as a script throw. Framing it as
    // "SuperEdit error … (script line N)" sends the model rewriting a script
    // that was never wrong — give it the same honest bridge-down story the
    // commit phase reports. Script-phase writes were only buffered, so
    // "nothing was written" is exact here.
    if (isFsTransportFailure(err)) {
      const data = renderShellResult(
        `SuperEdit could not run: this session's filesystem bridge is ` +
          `unavailable (${message}). The script did not complete and no ` +
          `files were changed (script writes are buffered until commit) — ` +
          `this is not a script or path problem. Retry the same SuperEdit ` +
          `call; if it keeps failing, fall back to another editing tool.`,
        logs,
      )
      emitFinish('error', data)
      return { data, isError: true }
    }
    // Script-relative location (adjusted worker-side) + the source it points
    // at, quoted from the code we still hold — so the model fixes the line
    // instead of guessing where its script died. The location gets its OWN
    // line: helper messages carry a path and a cause and run long, and a
    // coordinate appended after all of that is a coordinate nobody reads.
    // Absent (older path, timeout, worker crash, unparseable stack) → the
    // plain message, as before.
    const location = err instanceof RunJsFailure ? err.location : undefined
    const headline = location
      ? `SuperEdit error: ${message}\n${formatScriptLocation(code, location)}`
      : `SuperEdit error: ${message}`
    // A script that never parsed is the ONE failure the code/data split exists
    // to prevent, and the engine's message for it names a token, never the
    // fix. Gated on the worker's parse-phase flag, NOT on the error name: a
    // SyntaxError thrown while the script RUNS (`JSON.parse` on bad data, an
    // unbalanced `new RegExp`) is a runtime throw `inputs` would not have
    // prevented, and is left exactly as it was.
    const guidance =
      err instanceof RunJsFailure && err.scriptParseFailed
        ? `\n\n${parseFailureGuidance(input)}`
        : ''
    const data = renderShellResult(`${headline}${guidance}`, logs)
    emitFinish('error', data)
    return { data, isError: true }
  }
}

// The script API is documented only here, the wire description; the `code`/`path`
// schema fields stay one-liners pointing back to it.
export const SUPER_EDIT_TOOL_DESCRIPTION = [
  'Make programmable workspace changes using JavaScript in a restricted worker.',
  '',
  'Use it for precise or multi-file edits, file creation, deletion, moves, and other known workspace changes. It may read files to compute edits, but cannot run commands, scripts, or external programs. Use search/read tools first when you still need to explore.',
  '',
  'The script is an async function body: `await` and `return` work, `console.*` is captured, and the return value is reported. Provide source with `code` or a local script file with `path`. Errors include script location and source context when available.',
  '',
  'KEEP CODE AND DATA SEPARATE: put file content, multiline text, find/replace blocks, and other large strings in `inputs`, then read them as `inputs.<name>`. `inputs` values are runtime data, not JavaScript source, so quotes, backticks, backslashes, and `${...}` cannot break parsing. Do not reconstruct large data inside `code`; small control literals are fine.',
  '',
  'Example: { "inputs": { "path": "README.md", "find": "old text...", "replace": "new text..." }, "code": "await replaceTextFile(inputs.path, inputs.find, inputs.replace)" }',
  '',
  'Workspace mutations are BUFFERED until the script succeeds. If the script throws or permission/conflict checks fail, nothing is written. If files changed externally during the run, the save is rejected. A commit-time filesystem failure may still leave a partial commit; SuperEdit reports what landed.',
  '',
  '```ts',
  `// Preferred helpers for normal file I/O. Relative and absolute paths are
// supported; '/' and '\\' work as separators; '..' is rejected.
// Writes create missing parent directories.
function readTextFile(path: string): Promise<string>
function writeTextFile(path: string, text: string): Promise<void>

// Literal-text edit — prefer over read → replace → write. \`find\` and
// \`replace\` are literal text, never patterns. Matches exactly, with a
// conservative LF↔CRLF fallback for consistently formatted files; fallback
// replacements keep the file's line endings. Requires exactly one match
// unless { all: true }; throws NotFoundError or AmbiguousMatchError
// otherwise. Returns the replacement count.
function replaceTextFile(path: string, find: string, replace: string, options?: { all?: boolean }): Promise<number>

// Binary or non-UTF-8 file access.
function readFileBytes(path: string): Promise<Uint8Array>
function writeFileBytes(path: string, bytes: Uint8Array | ArrayBuffer | ArrayBufferView): Promise<void>

// Move or rename a file or directory; throws AlreadyExistsError rather
// than overwriting an existing destination.
function move(path: string, newPath: string): Promise<void>

// Runtime data supplied through this call's \`inputs\` field ({} when omitted).
const inputs: Record<string, unknown>

// File System Access API for advanced operations not covered above,
// such as listing, deletion, and streams.
const workspace: FileSystemDirectoryHandle

// Open an absolute directory directly; access remains permission-gated.
function getDirectory(absPath: string): Promise<FileSystemDirectoryHandle>`,
  '```',
  '',
  'Text helpers require valid UTF-8 (EncodingError otherwise) and do not normalize newlines, whitespace, Unicode, or BOMs; use the byte helpers for other encodings.',
  '',
  'All workspace access uses the same permission checks as Read/Write tools.',
  '',
  'Prefer SuperEdit when several known operations can be composed mechanically in one run. If you need to inspect a result before deciding what to do next, use a direct tool instead.',
  '',
  'Environment: ECMAScript and Worker APIs only — no DOM, Node.js, shell, interpreters, network, process execution, persistent storage, importScripts, or nested Workers. These workspace-backed APIs are the only I/O. `SuperEdit` cannot call itself.',
].join('\n')

export const SuperEditTool: ToolContract<SuperEditInput, SuperEditOutput> = declareTool({
  name: SUPER_EDIT_TOOL_NAME,
  discoveryHint: 'make programmable multi-file workspace edits with a scripted editor',
  argsSchema: {
    type: 'object',
    properties: {
      // The API these two run against is documented ONCE, in the tool
      // description (SUPER_EDIT_TOOL_DESCRIPTION) — repeating it here is how the
      // two copies drift apart.
      code: {
        type: 'string',
        description:
          'JavaScript to execute, using the script API given in this tool’s ' +
          'description. Provide this OR `path`.',
      },
      path: {
        type: 'string',
        description:
          'Path to a local JavaScript file to run instead of inline `code` ' +
          '(workspace-relative or absolute). Provide this OR `code`.',
      },
      inputs: {
        type: 'object',
        description:
          'Data values the script reads as `inputs.<name>`. Put file ' +
          'content, multiline text, and find/replace strings HERE — they ' +
          'are handed to the script as runtime values, never parsed as ' +
          'JavaScript, so no JavaScript string escaping or double-escaping ' +
          'is needed. Keep `code` for logic.',
      },
      description: {
        type: 'string',
        description: 'Brief user-facing description of what this run will do.',
      },
      timeoutSec: {
        type: 'number',
        minimum: MIN_TIMEOUT_SEC,
        maximum: MAX_TIMEOUT_SEC,
        default: DEFAULT_TIMEOUT_SEC,
        description:
          'Execution timeout in seconds. The clock pauses while the script is ' +
          'blocked on a filesystem call, so a permission prompt awaiting an ' +
          'answer never trips it.',
      },
    },
    // `inputs` is REQUIRED, and it is the only field that is. Not because a
    // script must carry data — `{}` is valid and is exactly what an omitted
    // one normalized to — but because an OPTIONAL field is one a model can
    // decline to think about. The code/data split only pays off if the data
    // channel is considered on every call, and a required field is considered
    // during GENERATION, where the tool description is only ever read.
    // `code`/`path` stay out: their either-or rule is not expressible in JSON
    // Schema `required`, and `validateInput` owns it.
    required: ['inputs'],
    additionalProperties: false,
  },
  // Two audiences, one function (the Tool contract has a single `description`):
  //   - the MODEL — the serializer calls this with EMPTY input, so it gets the
  //     full API contract (the only SuperEdit prose that reaches the wire);
  //   - the PERMISSION DIALOG — `toolExecution.ts` calls it with the REAL
  //     input, so a call that supplied `description` labels itself with that
  //     one-line summary instead of the whole contract.
  description: async (input: SuperEditInput) =>
    input.description?.trim() || SUPER_EDIT_TOOL_DESCRIPTION,
  checkInput: checkInput,
  call,
})

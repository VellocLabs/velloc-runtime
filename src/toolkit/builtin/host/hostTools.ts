// The host tools as tool contracts: each runtime definition
// (toolkit/builtin/host) wrapped into a `ToolContract` whose call shapes the
// arguments (pathArgs.ts, shellArgs.ts), dispatches through the bridge's
// `callTool`, and renders the host's data into what the model reads
// (resultText.ts). The shell tools' always-background middle layer and the
// Read / Edit bookkeeping live here too.
import {
  declareTool,
  type AgentToolMeta,
  type ToolContract,
  type ToolCallStepUpdate,
  type ToolArgsJsonShape,
} from '../../toolContract'
import { type ToolCallContext } from '../../toolCallContext'
import type {
  BrowserHostedToolExecutionContext,
  HostedToolDefinition,
} from '../../../browser/bridge/browserBridgeProtocol'
import type { PageFingerprint } from '../../../engine/loop/agentLoopState'
import type { RuntimeConfig } from '../../../runtime/interfaces/RuntimeConfig'
import { SHELL_TOOL_ID } from '../../../prompting/processToolNames'
import { isHostedToolReadOnly } from '../../../permissions/hostedToolReadOnly'
import {
  HOST_DISPLAY_COMMAND,
  HOST_RESULT_ACKNOWLEDGED,
  HOST_SUPER_SHELL_TASK_ID,
  getBackgroundShellSpawner,
  waitForShellSpawnerKnown,
  notifyBackgroundShellLaunched,
} from '../../run/backgroundShellSink'
import { getSubAgentController } from '../../../team/subAgentController'
import { mintTaskHandle } from '../../../backgroundTasks/taskId'
import { EDIT_TOOL_ID, READ_TOOL_ID, WRITE_TOOL_ID } from '../../../prompting/fileToolNames'
import { getLiveCwd, interceptBashCd, type BashCommandArgs } from '../glic/bashCwdInterceptor'
import { nativizeForHost } from '../../../utils/hostPathForm'
import { resolveRuntimePath } from '../../../utils/runtimePaths'
import { fsForContext } from '../../../utils/fs/runtimeFs'
import { deriveSnapshotTurnInfo } from '../../../utils/turnDiffs'
import {
  beginShellMutationProbe,
  holdShellMutationProbe,
  type ShellMutationProbe,
} from '../../../sessions/fileSnapshots/shellMutationProbe'
import {
  applyReadContextWindow,
  applyWorktreeIsolation,
  coerceReadRangeArgsForHost,
  normalizeCwdArgForHost,
  normalizeFsPathArgsForHost,
  stripNonPdfReadPagesArg,
  untrustedReadRefusal,
} from './pathArgs'
import {
  PWSH_TOOL_ID,
  SHELL_DEFAULT_TIMEOUT_MS,
  SHELL_NO_TIMEOUT_CAP_SENTINEL_MS,
  buildBackgroundShellRunningResult,
  buildForegroundShellResult,
  getBackgroundShellOutputPath,
  resolveExplicitBackgroundShellArgs,
  resolveForcedBackgroundShellArgs,
  shellSleepGuard,
} from './shellArgs'
import {
  maybeBuildPostCompactReadStub,
  maybeMemoryFreshnessNote,
  recordHostedReadState,
} from './readState'
import { buildHostEditDiff } from './editDiff'
import { renderHostResult } from './resultText'

type HostedToolInput = Record<string, unknown>
const BASH_OUTPUT_TOOL_NAME = 'BashOutput'

/**
 * `agentMeta` from a host tool result `{ data, agent_meta? }` (wire contract with
 * `tools_adapter.cc`: action_hashes, page_fingerprint, post_url,
 * post_focus_target_id, terminates_sequence). `undefined` when absent.
 */
function extractAgentMeta(rawResult: unknown): AgentToolMeta | undefined {
  if (!rawResult || typeof rawResult !== 'object') return undefined
  const meta = (rawResult as { agent_meta?: unknown }).agent_meta
  if (!meta || typeof meta !== 'object') return undefined
  const m = meta as Record<string, unknown>

  const out: AgentToolMeta = {}
  if (Array.isArray(m.action_hashes)) {
    const hashes = m.action_hashes.filter(
      (h): h is string => typeof h === 'string' && h.length > 0,
    )
    if (hashes.length > 0) out.actionHashes = hashes
  }
  if (m.page_fingerprint && typeof m.page_fingerprint === 'object') {
    const fp = m.page_fingerprint as Record<string, unknown>
    if (
      typeof fp.url === 'string' &&
      typeof fp.interactive_count === 'number' &&
      typeof fp.dom_hash === 'string'
    ) {
      const fingerprint: PageFingerprint = {
        url: fp.url,
        interactiveCount: fp.interactive_count,
        domHash: fp.dom_hash,
      }
      out.pageFingerprint = fingerprint
    }
  }
  if (typeof m.post_url === 'string') out.postUrl = m.post_url
  if (m.post_focus_target_id === null || typeof m.post_focus_target_id === 'string') {
    out.postFocusTargetId = m.post_focus_target_id as string | null
  }
  if (typeof m.terminates_sequence === 'boolean') {
    out.terminatesSequence = m.terminates_sequence
  }

  return Object.keys(out).length > 0 ? out : undefined
}

function unwrapData(rawResult: unknown): unknown {
  // Older C++ builds return the observation directly; newer builds wrap
  // it in `{ data, agent_meta }`. Detect by presence of `agent_meta`.
  if (
    rawResult &&
    typeof rawResult === 'object' &&
    'agent_meta' in (rawResult as Record<string, unknown>)
  ) {
    const wrapped = rawResult as { data?: unknown; agent_meta?: unknown }
    return wrapped.data ?? rawResult
  }
  return rawResult
}

/**
 * Shell write capture for one Bash / PowerShell call (F-6): a probe over the
 * files the command line names, or null when the session has no snapshot
 * recorder or the call carries no command. Resolves relative paths against
 * the call's own `cwd` when it has one, else the session's live shell cwd.
 * Never throws.
 */
async function beginShellProbeForCall(args: {
  isShellTool: boolean
  toolName: string
  command: unknown
  cwdArg: unknown
  context: ToolCallContext
}): Promise<ShellMutationProbe | null> {
  const recorder = args.context.options.fileSnapshotRecorder
  if (!args.isShellTool || !recorder || typeof args.command !== 'string') return null
  try {
    const sessionCwd = getLiveCwd(args.context)
    const cwd =
      typeof args.cwdArg === 'string' && args.cwdArg.length > 0
        ? resolveRuntimePath(sessionCwd, args.cwdArg)
        : sessionCwd
    return await beginShellMutationProbe({
      recorder,
      fs: fsForContext(args.context),
      turn: deriveSnapshotTurnInfo(args.context.messages ?? []),
      command: args.command,
      shell: args.toolName === PWSH_TOOL_ID ? 'powershell' : 'bash',
      cwd,
      homeDir: args.context.options.homeDir,
    })
  } catch {
    return null
  }
}

function buildHostToolExecutionContext(
  context: ToolCallContext,
): BrowserHostedToolExecutionContext {
  const modelId = context.options.mainLoopModel

  return {
    sessionId: context.options.sessionId || undefined,
    providerId: context.options.mainLoopProviderId,
    modelId: modelId && modelId !== 'inherit' ? modelId : undefined,
  }
}

export type BuildHostToolsOptions = {
  /**
   * Optional `RuntimeConfig` used for tool-side env-var lookups (e.g.
   * `HOME` for `~` expansion in the bash-`cd` interceptor). When
   * omitted, env-var-dependent interceptors degrade gracefully — the
   * bash tool still works, it just can't expand `~` in `cd` targets.
   */
  runtimeConfig?: RuntimeConfig
}

function buildHostTool(
  definition: HostedToolDefinition,
  options: BuildHostToolsOptions = {},
): ToolContract<HostedToolInput, unknown> {
  return declareTool({
    name: definition.name,
    // Forward the skill bucket from the C++ manifest (per-tool `skill`
    // field). The deferral layer (toolkit/run/deferredTools.ts)
    // hides this tool's schema when its owning skill is `deferred` and
    // not yet activated — the `browser` skill gates the Browser* family
    // this way. Absent → always loaded. This replaces the earlier
    // name-prefix heuristic now that skill membership is authoritative.
    ...(definition.skill ? { skill: definition.skill } : {}),
    aliases: definition.aliases,
    discoveryHint:
      definition.searchHint ??
      definition.name.replaceAll('_', ' '),
    argsSchema: definition.parameters as ToolArgsJsonShape,
    // Forward the optional strict-mode schema if the native side
    // shipped one. `serializeToolsForModel` picks between the two
    // based on the active model's catalog flag.
    ...(definition.parametersStrict
      ? {
          inputJSONSchemaStrict:
            definition.parametersStrict as ToolArgsJsonShape,
        }
      : {}),
    // Forward optional canonical example calls (Anthropic
    // `input_examples`). The bridge surfaces these only on Anthropic
    // requests; other providers ignore.
    ...(definition.inputExamples && definition.inputExamples.length > 0
      ? { inputExamples: definition.inputExamples }
      : {}),
    description: async () => definition.description,
    // Sleep guard (spec 2-6-4 / 2-7-4): block standalone/leading
    // `sleep N` (Bash) or `Start-Sleep N` / `sleep N` (PowerShell) (N≥2)
    // unless explicitly backgrounded. The model should use
    // `run_in_background: true` or the Sleep tool instead.
    ...(definition.name === SHELL_TOOL_ID ||
    definition.name === PWSH_TOOL_ID
      ? {
          checkInput: async (input: HostedToolInput) =>
            shellSleepGuard(definition.name, input),
        }
      : {}),
    // Dispatch directly to the C++-side `browser.<name>` action via
    // the bridge. The C++ `ToolsAdapter` routes by name into the
    // matching `BrowserTool::<name>` method, runs the actor proto,
    // builds the observation, and returns the JSON to the LLM. No
    // JS-side proto building / observation parsing — that all moved
    // to native (see browser_tool.{h,cc}).
    call: async (
      input,
      context,
      _canUseTool,
      _parentMessage,
      onProgress?: ToolCallStepUpdate,
    ) => {
      // A pure `cd <path>` is handled JS-side so it persists across Bash calls;
      // compound and non-cd commands fall through to the host.
      if (definition.name === SHELL_TOOL_ID && options.runtimeConfig) {
        const cdResult = await interceptBashCd(
          input as BashCommandArgs,
          context,
          options.runtimeConfig,
        )
        if (cdResult.kind === 'cd') {
          return { data: { output: cdResult.resultText, exit_code: 0 } }
        }
        if (cdResult.kind === 'error') {
          return {
            data: { output: cdResult.resultText, exit_code: 1 },
          }
        }
        // 'passthrough' — fall through to the regular dispatch.
      }

      const browser = context.platformCapabilities.browser
      if (!browser?.callTool) {
        throw new Error(
          `${definition.name}: 'browser' capability is unavailable on ` +
            `this runtime — hosted tools cannot be dispatched.`,
        )
      }
      // Worktree isolation re-anchors a worktree fork's host calls to its own
      // checkout; `cwd` and fs path args are then normalized to host-native form.
      // With a manager present, a model Bash/PowerShell call is forced to
      // `run_in_background` and the tail below blocks up to its timeout to look
      // foreground; without one the model's args are left as they are.
      const isShellTool =
        definition.name === SHELL_TOOL_ID ||
        definition.name === PWSH_TOOL_ID
      // The worker's background-shell registry (B3): with a manager present it
      // STARTS every background command itself, as a persistent host child
      // (`shell.spawn` + `persist`), instead of the host's Bash tool spawning
      // it into a C++ registry. A manager on a host that does not serve the
      // persistent-shell primitives (an older binary) has no background shells
      // at all: the command runs in the foreground on the host, exactly as
      // without a controller, and is never reported as a task.
      const shellSpawner = isShellTool ? getBackgroundShellSpawner() : null
      // Right after a reload or a port swap the host is not known yet, and
      // canSpawn() reads false for that moment only: wait for the answer
      // rather than run a background command (a dev server) in the
      // foreground until its timeout.
      if (shellSpawner && !shellSpawner.canSpawn() && shellSpawner.isKnown) {
        await waitForShellSpawnerKnown(shellSpawner, context.cancelSource?.signal)
      }
      const hostOnlyShell = !!shellSpawner && !shellSpawner.canSpawn()
      const shellController =
        isShellTool && !hostOnlyShell ? getSubAgentController() : null
      const modelWantsBackground =
        ((input ?? {}) as Record<string, unknown>).run_in_background === true
      const useForegroundMiddleLayer =
        isShellTool && !!shellController && !modelWantsBackground
      // `resolveForcedBackgroundShellArgs` owns the forced-background timeouts.
      // Security: HOST_DISPLAY_COMMAND, HOST_RESULT_ACKNOWLEDGED and
      // HOST_SUPER_SHELL_TASK_ID are in-process-only Symbol keys; model JSON can
      // never carry a Symbol, so a direct call cannot spoof them. Split off before
      // anything reaches the host.
      const {
        [HOST_DISPLAY_COMMAND]: displayCommandArg,
        [HOST_RESULT_ACKNOWLEDGED]: resultAcknowledgedArg,
        [HOST_SUPER_SHELL_TASK_ID]: superShellTaskIdArg,
        ...inputWithoutDisplay
      } = ((input ?? {}) as Record<string | symbol, unknown>)
      const displayCommand =
        isShellTool && typeof displayCommandArg === 'string' && displayCommandArg.length > 0
          ? displayCommandArg
          : undefined
      const resultAcknowledged = isShellTool && resultAcknowledgedArg === true
      const superShellTaskId =
        isShellTool && typeof superShellTaskIdArg === 'string' && superShellTaskIdArg.length > 0
          ? superShellTaskIdArg
          : undefined
      let effectiveInput: unknown =
        displayCommandArg === undefined &&
        resultAcknowledgedArg === undefined &&
        superShellTaskIdArg === undefined
          ? input
          : inputWithoutDisplay
      let foregroundBudgetMs = SHELL_DEFAULT_TIMEOUT_MS
      if (hostOnlyShell) {
        // No worker registry to own a background child: run it in the foreground.
        const { run_in_background: _droppedBackground, ...foreground } =
          (effectiveInput ?? {}) as Record<string, unknown>
        effectiveInput = foreground
      } else if (useForegroundMiddleLayer) {
        const resolved = resolveForcedBackgroundShellArgs(effectiveInput)
        effectiveInput = resolved.effectiveInput
        foregroundBudgetMs = resolved.foregroundBudgetMs
      } else if (isShellTool && shellController && modelWantsBackground) {
        // The model explicitly backgrounded this command. An explicit
        // background has no kill deadline for ANY command (a leading
        // `sleep`/`Start-Sleep` included — see resolveExplicitBackgroundShellArgs),
        // so rewrite `timeout` to the no-timeout-cap sentinel — otherwise C++
        // applies the 120s default as a hard kill.
        effectiveInput = resolveExplicitBackgroundShellArgs(
          effectiveInput,
        ).effectiveInput
      }

      const hostRef = context.options.cwd
      const callArgs = coerceReadRangeArgsForHost(
        definition.name,
        stripNonPdfReadPagesArg(
          definition.name,
          applyReadContextWindow(
            definition.name,
            normalizeFsPathArgsForHost(
              definition.name,
              normalizeCwdArgForHost(
                applyWorktreeIsolation(definition.name, effectiveInput, context),
                hostRef,
              ),
              hostRef,
            ),
            context,
          ),
        ),
      )
      // The untrusted-provider read boundary, on the final host paths.
      const refusal = await untrustedReadRefusal(
        definition.name,
        callArgs as Record<string, unknown>,
        context,
      )
      if (refusal !== undefined) return { data: refusal }
      if (definition.name === READ_TOOL_ID) {
        const restoredStub = await maybeBuildPostCompactReadStub(
          context,
          callArgs as Record<string, unknown>,
        )
        if (restoredStub) return { data: restoredStub }
      }

      let progressCounter = 0
      // Shell write capture (F-6): snapshot the files the command line names
      // as write targets before it runs; the unchanged ones are discarded
      // once it has finished (held by task id for a background command).
      const shellProbe = await beginShellProbeForCall({
        isShellTool,
        toolName: definition.name,
        command: displayCommand ?? (callArgs as Record<string, unknown>).command,
        cwdArg: (callArgs as Record<string, unknown>).cwd,
        context,
      })
      // A background command the worker's registry owns: start it here as a
      // persistent host child whose log is the task's output file, and carry
      // on below exactly as for a host `{ shell_id, status: 'running' }` ack.
      // The public task id is minted first because it names that log
      // (`<taskId>.output`) — which is also how a restarted worker
      // finds the child's owner again.
      let workerShell: { taskId: string; outputFilePath: string } | null = null
      let rawResult: unknown
      try {
      if (
        shellSpawner &&
        shellController &&
        (effectiveInput as Record<string, unknown> | undefined)?.run_in_background === true
      ) {
        const args = callArgs as Record<string, unknown>
        const taskId = mintTaskHandle('local_bash')
        const outputFilePath = getBackgroundShellOutputPath(context, taskId)
        const { shellId } = await shellSpawner.spawn({
          tool: definition.name === PWSH_TOOL_ID ? 'PowerShell' : 'Bash',
          command: typeof args.command === 'string' ? args.command : '',
          // The C++ tool ran an unset cwd in the session's: the live one, which
          // a `cd` (bashCwdInterceptor) may have moved past the snapshot.
          cwd:
            typeof args.cwd === 'string' && args.cwd.length > 0
              ? args.cwd
              : nativizeForHost(getLiveCwd(context), hostRef),
          logPath: outputFilePath,
        })
        workerShell = { taskId, outputFilePath }
        rawResult = { shell_id: shellId, status: 'running' }
      } else {
        rawResult = await browser.callTool({
          name: definition.name,
          args: callArgs,
          executionContext: buildHostToolExecutionContext(context),
          onProgress: onProgress
            ? progress => {
                onProgress({
                  toolUseID: `${definition.name}-progress-${progressCounter++}`,
                  data: progress,
                })
              }
            : undefined,
        })
      }
      } catch (err) {
        // The command may have run before the failure: keep what changed.
        await shellProbe?.settle()
        throw err
      }
      let shellProbeHeld = false
      const agentMeta = extractAgentMeta(rawResult)
      // The host answers with data; the sentences the model reads are the
      // runtime's (resultText.ts).
      let data = renderHostResult(definition.name, unwrapData(rawResult))
      // A background shell result carries a `shell_id`: surface it as a `local_bash`
      // background task. A host-only shell is never a task (nothing in the worker
      // watches it).
      if (
        !hostOnlyShell &&
        (definition.name === SHELL_TOOL_ID ||
          definition.name === PWSH_TOOL_ID)
      ) {
        const args = input as Record<string, unknown>
        const shellId =
          data && typeof data === 'object'
            ? (data as { shell_id?: unknown }).shell_id
            : undefined
        const status =
          data && typeof data === 'object'
            ? (data as { status?: unknown }).status
            : undefined
        if (
          status === 'running' &&
          typeof shellId === 'string' &&
          shellId.length > 0
        ) {
          const outputFilePath =
            workerShell?.outputFilePath ??
            getBackgroundShellOutputPath(context, shellId)
          const command =
            displayCommand !== undefined
              ? displayCommand
              : typeof args.command === 'string'
              ? args.command
              : definition.name === PWSH_TOOL_ID
                ? '(powershell)'
                : '(bash)'
          // Mint the prefixed PUBLIC task id (`b…`) here — the one place with
          // the shell_id in hand — and hand it to the manager (which indexes
          // `taskId → shell_id`). The model/drawer/TaskOutput/TaskStop all speak
          // this taskId; the native shell_id stays the internal bridge handle.
          const taskId = workerShell?.taskId ?? mintTaskHandle('local_bash')
          // Capture the invoke parameters for the detail view. `effectiveInput`
          // is the args actually dispatched to C++, so its `timeout` is the real
          // host kill-ceiling. Both background paths are now uncapped (the
          // no-timeout-cap sentinel): a forced/auto detach AND an explicit
          // `run_in_background: true`. The only finite cap left is a leading
          // `sleep`/`Start-Sleep` on the forced path, which keeps its timeout.
          const effTimeout = (effectiveInput as Record<string, unknown> | undefined)
            ?.timeout
          // The no-cap sentinel isn't a real duration — surface it as "no limit"
          // rather than a bogus ~24-day figure.
          const unbounded = effTimeout === SHELL_NO_TIMEOUT_CAP_SENTINEL_MS
          const cwdArg = (callArgs as Record<string, unknown>).cwd
          const descArg = (input as Record<string, unknown> | undefined)?.description
          notifyBackgroundShellLaunched({
            taskId,
            shellId,
            spoolPath: outputFilePath,
            command,
            spawnerSessionId: context.options.sessionId || undefined,
            params: {
              timeoutMs:
                !unbounded &&
                typeof effTimeout === 'number' &&
                Number.isFinite(effTimeout)
                  ? effTimeout
                  : undefined,
              unbounded: unbounded || undefined,
              backgroundMode: useForegroundMiddleLayer ? 'auto' : 'explicit',
              cwd:
                typeof cwdArg === 'string' && cwdArg.length > 0 ? cwdArg : hostRef,
              description:
                typeof descArg === 'string' && descArg.length > 0
                  ? descArg
                  : undefined,
            },
            ...(resultAcknowledged ? { resultAcknowledged: true } : {}),
            ...(superShellTaskId ? { superShellTaskId } : {}),
            // A finite timeout on a worker-started child is a KILL the
            // registry enforces (the host's persistent spawn has no timeout).
            ...(workerShell &&
            !unbounded &&
            typeof effTimeout === 'number' &&
            Number.isFinite(effTimeout)
              ? { killAfterMs: effTimeout }
              : {}),
          })
          if (useForegroundMiddleLayer && shellController) {
            // Foreground middle layer: block up to the budget so a quick command
            // looks foreground. Branch on the snapshot STATUS at return time (not
            // "did the timer fire") so a command finishing at the boundary is
            // returned inline. `context.abortController.signal` → a user Stop
            // while waiting kills the shell (waitForBackgroundShellSnapshot's
            // onAbort → stopBackgroundShell), the foreground-interrupt.
            const snap = await shellController.waitForCompletion(
              taskId,
              foregroundBudgetMs,
              context.cancelSource?.signal,
            )
            if (snap && snap.status !== 'running') {
              // Completed within budget → deliver inline AND acknowledge, so the
              // manager suppresses the duplicate `<task-notification>` turn
              // (the model is seeing the result right now).
              shellController.acknowledgeResult?.(taskId)
              data = buildForegroundShellResult(snap, taskId)
            } else {
              if (shellProbe) {
                holdShellMutationProbe(taskId, shellProbe)
                shellProbeHeld = true
              }
              // Still running → it's already a background task; hand off. The
              // completion delivery is idle-gated (maybeFlushBackgroundShell
              // Results defers while streaming/inflight), so it CANNOT race this
              // turn's "moved to the background" result — it flushes only after
              // the turn ends. Not acknowledged → delivered exactly once, later.
              data = buildBackgroundShellRunningResult(taskId, outputFilePath, true)
            }
          } else {
            // Model asked for background explicitly (or no manager present):
            // fire-and-forget, return the running ack immediately.
            if (shellProbe) {
              holdShellMutationProbe(taskId, shellProbe)
              shellProbeHeld = true
            }
            const message =
              data && typeof data === 'object'
                ? (data as { message?: unknown }).message
                : undefined
            data = buildBackgroundShellRunningResult(
              taskId,
              outputFilePath,
              typeof message === 'string' &&
                message.includes('moved to the background'),
            )
          }
        }
      }
      if (shellProbe && !shellProbeHeld) await shellProbe.settle()
      // Conditional-rules trigger: a successful Read adds its path to
      // `nestedMemoryAttachmentTriggers`. Record the read file path so the query
      // loop can inject any `.velloc/rules` / `.claude/rules` whose `paths:`
      // glob matches it. Records on success only; the host-normalized path is
      // what `getConditionalRulesForPath` matches against the rule globs.
      if (definition.name === READ_TOOL_ID) {
        const fp = (callArgs as { file_path?: unknown }).file_path
        if (typeof fp === 'string' && fp.length > 0) {
          context.nestedMemoryCues?.add(fp)
          context.recentReadPaths?.add(fp)
          await recordHostedReadState(
            context,
            fp,
            callArgs as Record<string, unknown>,
            data,
          )
          // Memory staleness caveat (`staleMemoryReminder` for files in
          // the memory directory). Prepended AFTER
          // recordHostedReadState so the cached read state holds the file's
          // real content, not the note.
          if (typeof data === 'string' && data.length > 0) {
            const freshness = await maybeMemoryFreshnessNote(context, fp)
            if (freshness) data = freshness + data
          }
        }
      }
      // Edit/Write: split the host's enriched `{ message, original_file }`
      // result into the model-facing prose (`data`) and a UI-only file-relative
      // diff (`uiEditDiff`). See buildHostEditDiff for why original_file never
      // leaves this function.
      if (
        definition.name === EDIT_TOOL_ID ||
        definition.name === WRITE_TOOL_ID
      ) {
        const enriched = buildHostEditDiff(definition.name, callArgs, data)
        if (enriched) {
          return agentMeta
            ? {
                data: enriched.modelData,
                uiEditDiff: enriched.editDiff,
                agentMeta,
              }
            : { data: enriched.modelData, uiEditDiff: enriched.editDiff }
        }
      }
      return agentMeta ? { data, agentMeta } : { data }
    },
    readsOnly: input => isHostedToolReadOnly(definition.name, definition.readOnly, input),
    parallelSafe: () => definition.concurrencySafe === true,
  })
}

export function buildHostTools(
  definitions: readonly HostedToolDefinition[],
  options: BuildHostToolsOptions = {},
): readonly ToolContract[] {
  // `BashOutput` is dropped from the model surface: background-shell output is
  // read via the kind-agnostic `TaskOutput` tool (one tool for both
  // `local_bash` and `local_agent`). The C++ definition still ships in the host
  // manifest, so filter it out here rather than let it become a model tool.
  // Back-compat: a stray `BashOutput` call resolves to `TaskOutput`
  // via that tool's `aliases`.
  return definitions
    .filter(definition => definition.name !== BASH_OUTPUT_TOOL_NAME)
    .map(definition => buildHostTool(definition, options))
}

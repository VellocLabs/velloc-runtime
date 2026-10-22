/**
 * Pure assembly of the wire snapshot (`AgentRuntimeWorkerSnapshot`) from a narrow
 * `WorkerSnapshotSources` view; new snapshot fields belong here.
 */
import type { BrowserLlmCatalog } from '../bridge/browserBridgeProtocol'
import type { AutoCompactChoice } from '../../context/compaction/windowSettings'
import type { AgentRuntimeState } from '../runtime/AgentRuntimeState'
import { renderPartsEnglish, key } from '../../input/systemMessageParts'
import type { CommandDescribeInput } from '../../mods/describeEvents'
import type {
  AgentRuntimeWorkerSnapshot,
  AutoCompactView,
  InjectMessageView,
  SessionMcpServerView,
  SlashCommandSummary,
} from './workerProtocol'
import type { PendingApproval } from '../../runtime/RuntimeTypes'
import type { LiveServerLink } from '../../mcp/types'
import { summarizeMcpTools, type McpToolSummary } from '../../mcp/toolSummary'
import {
  mcpServerOrigin,
  mcpServerTransport,
  type McpServerOriginSources,
} from '../../mcp/serverOrigin'
import {
  buildLoadedSkillSummaries,
  buildSlashCommandSummaries,
} from './slashCommandSummaries'
import type { SessionDisplayView } from './sessionDisplayState'

/**
 * Provisional boot info: while `runtime` is null and this is set, every snapshot carries
 * `uiReady: true` plus these fields.
 */
export type ProvisionalBootSources = {
  sessionId: string
  cwd: string
  projectRoot: string
  usedSandboxProjectRoot: boolean
  hostMode: string | undefined
  messageCount: number
  /** The model, mode, auto-compact and plan-approval fields a built runtime
   *  would report; absent until the display state resolves. */
  display?: SessionDisplayView
}

// Summaries per tool list; the pool replaces a server's `tools` array, never
// edits it, so a list's summaries are built once.
const toolSummaries = new WeakMap<readonly LiveServerLink['tools'][number][], McpToolSummary[]>()

function cachedToolSummaries(tools: LiveServerLink['tools']): McpToolSummary[] {
  let summaries = toolSummaries.get(tools)
  if (!summaries) {
    summaries = summarizeMcpTools(tools)
    toolSummaries.set(tools, summaries)
  }
  return summaries
}

/** Settled servers only (a connecting or closed one is left out), sorted by
 *  name so the list does not reorder as connects finish. Each carries its
 *  origin when `origins` is given, its transport, its tools (count and
 *  summaries) while connected and its error while failed. */
export function sessionMcpServerViews(
  servers: ReadonlyArray<
    Pick<LiveServerLink, 'name' | 'status'> &
      Partial<Pick<LiveServerLink, 'config' | 'nativeConfig' | 'nativeServerId' | 'tools' | 'instructions' | 'error'>>
  >,
  origins?: McpServerOriginSources,
  /** When set, a connected plugin server outside it is left out: it joined
   *  on a plugin reload, and its tools are not in the session's list. */
  offered?: ReadonlySet<string>,
): SessionMcpServerView[] {
  const views: SessionMcpServerView[] = []
  for (const server of servers) {
    if (server.status !== 'connected' && server.status !== 'failed') continue
    const view: SessionMcpServerView = { name: server.name, status: server.status }
    if (origins) view.origin = mcpServerOrigin(server, origins)
    if (server.status === 'connected' && offered && !offered.has(server.name) && view.origin?.kind === 'plugin') continue
    const transport = mcpServerTransport(server)
    if (transport) view.transport = transport
    if (server.status === 'connected' && server.tools) {
      view.toolCount = server.tools.length
      view.tools = cachedToolSummaries(server.tools)
    }
    if (server.status === 'connected' && server.instructions) view.instructions = server.instructions
    if (server.status === 'failed' && server.error) view.error = server.error
    views.push(view)
  }
  return views.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** The read-only view of worker + controller state the snapshot needs. */
export type WorkerSnapshotSources = {
  runtime: AgentRuntimeState | null
  /** Set only while `runtime` is null mid-build; see ProvisionalBootSources. */
  provisional?: ProvisionalBootSources | null
  projectBranch: string | undefined
  modelCatalog: BrowserLlmCatalog | null
  skipDangerousModePermissionPrompt: boolean
  lastTerminalReason: string | undefined
  lastTerminalTimestamp: number | undefined
  isBusy: boolean
  isStopping: boolean
  pendingBridgeRequestIds: string[]
  /** Parked inject messages (plain Enter while busy). Optional so callers
   *  that predate the field keep building snapshots. */
  injectMessages?: InjectMessageView[]
  /** Parked next-message strip entries (Ctrl/Cmd+Enter while busy). */
  nextMessages?: string[]
  /** The last composer save of the auto-compact window failed. */
  autoCompactSaveError?: string
}

/**
 * `command.describe` (F-25): the mods' view of the picker's list, overlaid
 * on the summaries — a description, a hint, a `hidden` tag. The runtime
 * answers from its cache and republishes the snapshot once the answers it
 * dispatched now have landed, so the first list shows the commands as
 * declared. A built-in's description is handed to the hooks as its English
 * rendering; a rewritten one is shown as text.
 */
function describeSlashCommands(
  runtime: AgentRuntimeState | null | undefined,
  summaries: SlashCommandSummary[],
): SlashCommandSummary[] {
  const describe = runtime?.engine.describeCommands
  if (!describe) return summaries
  let inputs: Array<CommandDescribeInput> = []
  const build = (): CommandDescribeInput[] => (inputs = summaries.map(summary => ({
    command: summary.name,
    description:
      summary.description ??
      (summary.blurbKey ? renderPartsEnglish([key(summary.blurbKey)]) : ''),
    ...(summary.argumentHint !== undefined ? { argumentHint: summary.argumentHint } : {}),
    isHidden: summary.hidden === true,
    immediate: false,
    provider: { plugin: 'engine', tier: 'core' as const },
  })))
  // The inputs (an English rendering per built-in) are built only when a
  // hook reads them: this runs on every snapshot build.
  const answers = describe.call(runtime.engine, build)
  if (answers.size === 0) return summaries
  return summaries.map(summary => {
    const answer = answers.get(summary.name)
    if (!answer) return summary
    const declared = inputs.find(input => input.command === summary.name)!
    const rewritten = answer.description !== declared.description
    return {
      ...summary,
      ...(rewritten ? { description: answer.description, blurbKey: undefined } : {}),
      ...(answer.argumentHint !== undefined ? { argumentHint: answer.argumentHint } : {}),
      ...(answer.isHidden ? { hidden: true } : summary.hidden ? { hidden: answer.isHidden } : {}),
    }
  })
}

export function pickAutoCompactView(
  choice: AutoCompactChoice,
  canSave: boolean,
  saveError: string | undefined,
): AutoCompactView {
  const source = choice.windowSource
  return {
    enabled: choice.enabled,
    ...(choice.windowTokens !== undefined ? { windowTokens: choice.windowTokens } : {}),
    // `/autocompact` and the composer handle write the user file; a window
    // from any other file outranks or overrides it.
    ...(source && source !== 'userSettings' ? { lockedBy: source } : {}),
    canSave,
    ...(saveError ? { saveError } : {}),
  }
}

export function buildWorkerSnapshot(
  src: WorkerSnapshotSources,
): AgentRuntimeWorkerSnapshot {
  const { runtime, modelCatalog } = src
  // Provisional applies only while the runtime hasn't been installed —
  // once it exists, every field below reads from the real build.
  const provisional = runtime ? null : src.provisional ?? null
  const display = provisional?.display
  const activeModelId = runtime
    ? runtime.engine.getCurrentModel()
    : display?.activeModelId
  const currentProviderId = runtime
    ? runtime.engine.getCurrentProviderId()
    : display?.currentProviderId
  const currentThinkingTier = runtime
    ? runtime.engine.getCurrentThinkingTier?.()
    : display?.currentThinkingTier
  const autoCompactWindows = runtime
    ? runtime.autoCompactWindows
    : display?.autoCompactWindows
  const runtimeWithAppState = runtime as
    | { getAppState?: () => { approvalQueue?: PendingApproval[] } }
    | null
  const appState = runtimeWithAppState?.getAppState?.()
  const currentSelection =
    currentProviderId && activeModelId && activeModelId !== 'inherit'
      ? {
          providerId: currentProviderId,
          modelId: activeModelId,
          ...(currentThinkingTier
            ? { thinkingTier: currentThinkingTier }
            : {}),
        }
      : undefined

  // Host capability proxy for the project-folder feature: `ui.pickProjectFolder`
  // is a chromium-host bridge action shipped alongside this feature, so only
  // the real `nexus` host can open a native folder dialog. Mock/dev (`browser`
  // mode) hosts lack it — they keep the sandbox silently (no chip, no modal).
  const hostModeValue = runtime ? runtime.options.hostMode : provisional?.hostMode
  const canPickProjectFolder = hostModeValue === 'nexus'

  return {
    initialized: runtime !== null,
    ...(provisional ? { uiReady: true } : {}),
    sessionId: runtime ? runtime.engine.boundSessionId() : provisional?.sessionId,
    cwd: runtime ? runtime.options.cwd : provisional?.cwd,
    projectRoot: runtime
      ? runtime.options.projectRoot
      : provisional?.projectRoot,
    projectBranch: src.projectBranch,
    // Gate for the composer's project-folder chip + dropdown — true whenever
    // the host can pick a folder, regardless of whether one is bound yet (so
    // the chip stays visible after binding, when `needsProjectFolder` is
    // false). Always false for mock/dev hosts.
    canPickProjectFolder,
    // Force the project-folder picker only when BOTH hold: the code session
    // fell back to the sandbox (`usedSandboxProjectRoot`) AND the host can
    // actually open a native folder dialog. Mock/dev hosts therefore keep
    // the sandbox untrapped instead of showing a modal whose action fails.
    needsProjectFolder:
      canPickProjectFolder &&
      (runtime
        ? runtime.usedSandboxProjectRoot
        : provisional?.usedSandboxProjectRoot === true),
    currentProviderId,
    activeModelId,
    currentThinkingTier,
    currentSelection,
    // The user's auto-compact switch + window for the active model, from the
    // last settings read (each trigger attempt and `/autocompact` re-read).
    // (Optional chain: test doubles of the runtime may not carry a reader.)
    autoCompact: autoCompactWindows
      ? pickAutoCompactView(
          autoCompactWindows.current(activeModelId, currentProviderId),
          autoCompactWindows.canSave,
          src.autoCompactSaveError,
        )
      : undefined,
    currentPermissionMode: runtime
      ? runtime.engine.getCurrentPermissionMode?.()
      : display?.permissionMode,
    bypassPermissionsModeDisabled: runtime
      ? runtime.getAppState?.().permissionRules
          ?.bypassPermissionsModeDisabled === true
      : display?.bypassPermissionsModeDisabled === true,
    modelCatalog,
    availableModels: getAvailableModels(runtime, modelCatalog, activeModelId),
    toolNames: runtime?.tools.map(tool => tool.name) ?? [],
    // Built-in set depends on host mode: nexus drops `/tabs` (the tabs
    // capability is absent in the chromium-runtime / non-multi-tab host).
    // Match the resolution `BrowserSystemInitEmitter` uses so the picker and
    // the dispatcher agree. Merge/dedup rules live in the pure helper
    // (unit-tested in slash-command-picker.test.ts).
    commandNames: describeSlashCommands(
      runtime,
      buildSlashCommandSummaries({
        isNexusHost: hostModeValue === 'nexus',
        commands: runtime?.options.commands ?? [],
        // The slot's mods' registered commands (F-25 `$.command.register`).
        modCommands: runtime?.engine.listModCommands?.() ?? [],
      }),
    ),
    loadedSkills: buildLoadedSkillSummaries(runtime?.options.commands ?? []),
    ...(runtime?.sessionMcpPool
      ? {
          mcpServers: sessionMcpServerViews(
            runtime.sessionMcpPool.listServers(),
            runtime.sessionMcpOrigins,
            runtime.sessionMcpServersOffered,
          ),
        }
      : {}),
    messageCount: runtime
      ? runtime.engine.transcriptRows().length ?? 0
      : provisional?.messageCount ?? 0,
    isBusy: src.isBusy,
    isStopping: src.isStopping,
    pendingBridgeRequestIds: src.pendingBridgeRequestIds,
    // Optional-call the new accessors so test-doubles that don't
    // stub them (browser-runtime-worker.test.ts builds minimal engine
    // shapes) still get a valid snapshot — the snapshot fields are
    // already optional, undefined just means "engine doesn't surface
    // the value." Real production engines always implement them.
    runtimeMaxTurns: runtime?.engine.getCurrentMaxTurns?.(),
    // Tool calls halted by an `ask` permission rule, awaiting a user
    // decision (gap #2, Phase C). Drives the permission banner.
    pendingPermissions: runtime?.engine.getPendingPermissions?.(),
    // ExitPlanMode calls halted for the user's plan approval (Phase 1 plan
    // handshake). Drives the plan-approval banner.
    pendingPlanApproval: runtime
      ? runtime.engine.getPendingPlanApproval?.()
      : display?.pendingPlanApproval,
    // requiresUserInteraction tools (e.g. AskUserQuestion) halted for the
    // user's response. Drives the session-list "needs your response" dot via
    // the durable snapshot path (mirrors pendingPlanApproval).
    pendingUserInteraction: runtime?.engine.getPendingUserInteraction?.(),
    // Queue of interactive confirmations. The current turn stays
    // busy while a queue item is present; the UI resolves it through
    // worker.resolveToolUseConfirm instead of submitting a new user turn.
    approvalQueue: appState?.approvalQueue,
    // Bypass-warning acknowledgment (F-13) — suppresses the dialog on
    // switch into bypassPermissions once accepted.
    skipDangerousModePermissionPrompt: src.skipDangerousModePermissionPrompt,
    // Terminal state from last query loop completion, enabling detection of
    // interrupted vs cleanly finished conversations on resume.
    lastTerminalReason: src.lastTerminalReason,
    lastTerminalTimestamp: src.lastTerminalTimestamp,
    // Parked mid-turn input is runtime state: every attached page restores
    // its pending bubbles / next-message strip from here.
    ...(src.injectMessages ? { injectMessages: src.injectMessages } : {}),
    ...(src.nextMessages ? { nextMessages: src.nextMessages } : {}),
  }
}

function getAvailableModels(
  runtime: AgentRuntimeState | null,
  modelCatalog: BrowserLlmCatalog | null,
  activeModelId?: string,
): string[] {
  const models = new Set<string>()
  const configuredModel = runtime?.options.userSpecifiedModel
  const fallbackModel = runtime?.options.fallbackModel

  for (const provider of modelCatalog?.providers ?? []) {
    if (!provider.enabled) {
      continue
    }

    for (const model of provider.models) {
      if (model.enabled) {
        models.add(model.id)
      }
    }
  }

  if (configuredModel) {
    models.add(configuredModel)
  }
  if (fallbackModel) {
    models.add(fallbackModel)
  }
  if (activeModelId) {
    models.add(activeModelId)
  }

  return Array.from(models)
}

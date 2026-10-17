import { ConversationEngine } from '../../engine/conversationEngine'
import { assembleTurnDependencies } from '../../engine/turn/turnDependencies'
import { type TraceLoggerEntry } from '../../engine/turn/modelTrace'
import { getToolsForHostManifestOrPreset } from '../../toolkit/toolRegistry'
import { BrowserHostBridge } from '../bridge/BrowserHostBridge'
import type { BrowserBridgeTransport } from '../bridge/browserBridgeProtocol'
import { BrowserRuntimeConfig } from '../../config/BrowserRuntimeConfig'
import {
  loadLocalPromptCommands,
  partitionSkillsForSession,
} from '../../skillLibrary/skillDiscovery'
import { BrowserPromptContextProvider } from '../../engine/systemPromptSources'
import { buildProfilePromptBlock } from '../context/buildProfilePromptBlock'
import { buildTeammatePromptAddendum } from '../../team/teammateBrief'
import { resolveOutputStyleSection } from '../../prompting/responseStyles'
import { SHELL_TOOL_ID } from '../../prompting/processToolNames'
import {
  applyPermissionRulesBySource,
  type PermissionSettingsBySource,
} from '../../permissions/seedPermissionContext'
import { findShadowedRules } from '../../permissions/ruleEngine'
import { BrowserUserInputPipeline } from '../../input/submitUserInput'
import {
  NEXUS_SLASH_COMMANDS,
  resolveSupportedSlashCommands,
} from '../../input/slashCommandCatalog'
import { BrowserSystemInitEmitter } from '../init/BrowserSystemInitEmitter'
import { DEFAULT_TEMPLATE_TYPE } from '../worker/workerProtocol'
import {
  BrowserConversationStore,
  setConversationStore,
} from '../../sessions/sessionStore'
import {
  installProcessFs,
  type RuntimeFs,
} from '../../utils/fs/runtimeFs'
import { seedAppStateFromSettings } from '../bridge/adapter/featuresBridgeAdapter'
import { setProductNameOverride } from '../../branding/productName'
import { applyPersistedInternalUser } from '../../utils/internalUser'
import {
  readLayer,
  loadEffectiveSettings,
  loadPermissionSettingsBySource,
  readUserLayer,
  wipeSettingsMemos,
  resolveSettingsHomeDir,
} from '../../settings/settingsStore'
import { MERGE_SOURCE_ORDER } from '../../settings/settingsStore'
import {
  UNTRUSTED_CHILD_MEMORY_SETTINGS,
  resolveMemorySettings,
} from '../../memory/resolveMemorySettings'
import { setSessionModelSettingsSnapshot } from '../../models/tierSettingsSnapshot'
import type { ResolvedMemorySettings } from '../../memory/memoryPaths'
import { checkNotesDir } from '../../memory/memoryPaths'
import { createBrowserFsOperations } from '../../utils/BrowserFsOperations'
import { openNexusSettings } from '../webview/nexusBridgeActions'
import type { NexusSettingsSection } from '../bridge/browserBridgeProtocol'
import type {
  BrowserRuntimeOptions,
  BrowserRuntimeState,
} from './AgentRuntimeState'
import {
  createBrowserReadFileCache,
  createInitialBrowserAppState,
} from './AgentRuntimeState'
import { collectQueuedAttachmentMessages } from '../../messages/contextAttachments'
import { resolveRuntimeCwd } from '../../utils/resolveRuntimeCwd'
import {
  projectRootIsSandbox,
  resolveProjectRoot,
} from '../../utils/resolveProjectRoot'
import {
  getConversationSessionDirectoryPath,
  isForcedFolderTemplateType,
  projectsHome,
} from '../../utils/conversationStoragePaths'
import { resolveHomeDirViaBridge } from '../../utils/resolveHomeDirViaBridge'
import {
  createFsSidechainTranscriptStore,
  setActiveSidechainStore,
  type SidechainTranscriptStore,
} from '../../utils/sidechainTranscripts'
import { createBrowserToolMicrocompact } from '../../context/compaction/browserObservationTrim'
import {
  applyTemplateToolAllowlist,
  getTemplate,
  resolveDeferrableSkills,
  templateAllowsMcp,
  templateWantsFileSnapshots,
  unresolvedSkillIds,
  templateWantsWorkspaceDiffTool,
} from '../../prompting/templateRegistry'
import { SessionSnapshotStore } from '../../sessions/fileSnapshots/snapshotStore'
import { FileSnapshotRecorder } from '../../sessions/fileSnapshots/snapshotRecorder'
import { WorkspaceDiffTool } from '../../toolkit/builtin/workspaceDiff'
import { isPluginTemplateId } from '../../mods/ui/uiManifest'
import { runtimeProviderGate } from '../../pluginHost/providerGate'
import { registerMemoryExtractor } from '../../memory/extract/extractionRunner'
import { registerMemoryConsolidator } from '../../memory/consolidate/consolidationRunner'
import { registerDeferrableSkills } from '../../toolkit/run/deferredTools'
import { isToolGroup } from '../../toolkit/builtin/toolGroups'
import { filterSubAgentTools } from '../../agents/subAgentToolScope'
import { A2UI_SKILL_NAME, A2UI_TOOL_NAMES } from '../../toolkit/builtin/a2ui/a2uiToolNames'
import { registerSkillCatalog } from '../../toolkit/run/skillCatalogs'
import type { HostedSkillDefinition } from '../bridge/protocol/manifest'
import type { ChromiumPromptCommand } from '../../runtime/CommandTypes'
import type { ContentBlockParam, Message } from '../../runtime/RuntimeTypes'
import {
  createBrowserAutoCompact,
  performCompaction,
} from '../../context/compaction/autoTrigger'
import {
  createAutoCompactWindowSettings,
  type AutoCompactWindowSettings,
} from '../../context/compaction/windowSettings'
import {
  buildMCPToolsFromPool,
  buildMcpResourceToolsFromPool,
  buildMCPSkillCommands,
  acquireSessionMCPPool,
  createWorkerMcpOperations,
  mcpServerSkillNamesFromPool,
} from '../../mcp'
import { getMcpHost, hostServesWorkerMcp } from '../../mcp/mcpHost'
import { createNativePrimitives } from '../bridge/nativePrimitives'
import { loadLocalAgents } from '../../agents/agentRegistry'
import { withBuiltInAgents } from '../../agents/builtInAgents'
import { loadPluginContributions, pluginMcpServer } from '../../pluginHost'
import { storePluginSecrets } from '../../pluginHost/pluginMcpUserConfig'
import { traceLine } from '../../utils/debugLog'
import { isModSlot, selectModModules } from '../../mods/modSlot'
import { createModIdleUnload, type ModIdleUnload } from '../../mods/modIdleUnload'
import { modConfigWrite, pluginConfigRows } from '../../mods/modConfig'
import { readSessionRepo } from '../../mods/sessionRepo'
import { PLUGIN_NOTIFICATION_TYPE } from '../../mods/modNotify'
import { fileModBuildStore } from '../../mods/modBuildStore'
import { renderPartsEnglish, key } from '../../input/systemMessageParts'
import {
  BUILTIN_SLASH_COMMAND_DESCRIPTION_KEYS,
  type BrowserSlashCommand,
} from '../../input/slashCommandCatalog'
import { RUNTIME_DIR_NAME } from '../../branding/runtimeDir'
import { joinRuntimePath } from '../../utils/runtimePaths'
import { NEXUS_INTERFACE_VERSION } from '../bridge/protocol/interfaceVersion.gen'
import { getBuildTime } from '../../branding/buildInfo'
import {
  linkModChild,
  modSlotToolsFor,
  onModSlotToolsChanged,
  publishModSlotTools,
  modRoster,
  modsForAgentLoop,
  noteModSlotChanged,
  noteModUiEvent,
  registerModSlot,
  undoWhenScopeEnds,
  watchModRoster,
  type AgentLoopMods,
} from '../../mods/modSlotRegistry'
import { registerSessionWorkingDir } from '../../models/drivers/sessionWorkingDirs'
import { createBridgeBackedFetch } from '../../pluginHost/bridgeBackedFetch'
import { loadEffectiveEnabledPlugins } from '../../pluginHost/enabledStore'
import { registerPluginHooks } from '../../pluginHost/registerPluginHooks'
import { describePluginError } from '../../pluginHost/pluginModel'
import { removeSessionHooksBySkillRoot } from '../../lifecycleHooks/sessionScopedHooks'
import { registerSettingsHooks } from '../../lifecycleHooks/registerSettingsHooks'
import {
  A2UI_CATALOG_HOLDER,
  A2UI_HOSTED_SKILL,
  A2UI_SYSTEM_PROMPT_CATALOG,
} from '../../toolkit/builtin/a2ui/a2uiSkill'
import {
  BROWSER_CATALOG_HOLDER,
  BROWSER_SKILL_NAME,
  BROWSER_SYSTEM_PROMPT_CATALOG,
  isBrowserToolName,
} from '../../toolkit/builtin/glic/browserSkillCatalog'
import {
  AGENT_TEAMS_HOSTED_SKILL,
  AGENT_TEAMS_SKILL_NAME,
} from '../../toolkit/builtin/team/agentTeamsSkill'
import {
  SAFE_CODE_TEMPLATE_TYPE,
  withTeammateSharedTaskTools,
} from '../../toolkit/builtin/team/teammateTaskTools'
import { setHostPrimitives } from '../../models/drivers/driverRegistry'
import { agentLoopExtensions } from '../../engine/extensionSeam'

function parseEnabledPluginsEnv(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  const names = value
    .split(',')
    .map(name => name.trim())
    .filter(name => name.length > 0)
  return names.length > 0 ? names : undefined
}

export type CreateBrowserRuntimeOptions = BrowserRuntimeOptions & {
  bridgeTransport: BrowserBridgeTransport
  traceLogger?: (entry: TraceLoggerEntry) => void
  /**
   * Boot-welcome milestones from inside the runtime build, fired as each step starts: `connectingTools`
   * before the MCP pool connect, `restoring` before the transcript read. Primary boot session only; best-effort.
   */
  onBootStage?: (stage: 'connectingTools' | 'restoring') => void
  /**
   * Fired ONCE after the persisted transcript is read, before MCP connect and engine construction, so
   * the page can render early; submits stay parked until `worker.ready`. Not for a background fork.
   * Synchronous; must not throw.
   */
  onUiReady?: (info: {
    sessionId: string
    cwd: string
    projectRoot: string
    usedSandboxProjectRoot: boolean
    hostMode: string | undefined
    messages: Message[]
    /**
     * This build's own store. The worker stamps transcript lines from it;
     * the process-global slot may already name another session's.
     */
    conversationStore?: BrowserConversationStore
    /** This build's file-snapshot recorder; the turn-diff history reads it. */
    fileSnapshotRecorder?: FileSnapshotRecorder
    /** This build's filesystem; the display state reads the plan file with it. */
    installedFs?: RuntimeFs
    /** The auto-compact reader the built runtime exposes; not yet loaded. */
    autoCompactWindows?: AutoCompactWindowSettings
    /** The per-source permission settings the build seeds its rules from. */
    permissionSettings?: Promise<PermissionSettingsBySource>
  }) => void
  /**
   * Mid-turn task-notification drain.
   * Called by the session's main query loop between tool rounds; returns this
   * session's pending background-task `<task-notification>` batch (removed
   * from the delivery queue) or null. `includeLater` is true when the round
   * just ran Sleep, which also admits sub-agent completions. Unset → results
   * arrive only as the idle re-activation turn.
   */
  drainTaskNotifications?: (
    sessionId: string,
    opts: { includeLater: boolean },
  ) => { prompt: string; enqueuedAt: number } | null
  /**
   * Mid-turn team-mailbox drain: the frames queued for this session (it is a
   * teammate, or a lead), removed and marked read as they are returned.
   * Called between tool rounds next to the notification drain. Unset →
   * frames arrive only as turns.
   */
  drainTeamMessages?: (
    sessionId: string,
  ) => Array<{ prompt: string; enqueuedAt: number }>
  /**
   * Aborts when the runtime scope this build belongs to is disposed (the
   * worker's `RuntimeScope.abortController`). Published on
   * `ToolUseContext.options.runtimeScopeSignal` so work that outlives its tool
   * call can stop with the scope. See toolkit/toolContract.ts.
   */
  runtimeScopeSignal?: AbortSignal
  /**
   * Mid-turn user input drain: take this session's parked inject messages
   * (plain Enter while busy), removing them from the worker's queue. Called
   * by the main query loop between tool rounds, next to the notification
   * drain. Unset → inject messages only land as the next turn.
   */
  drainInjectMessages?: () => Array<{
    uuid: string
    prompt: string | Array<ContentBlockParam>
    enqueuedAt: number
  }>
  /**
   * Peek (never take) whether `drainInjectMessages` has anything parked.
   * Published on `ToolUseContext.options.hasPendingInjectMessages` so the
   * Sleep tool can end early when the user sends a message. See toolkit/toolContract.ts.
   */
  hasPendingInjectMessages?: () => boolean
  /**
   * A plugin's `$.prompt.submit` (F-25): queue the prompt the chain let
   * in as a turn of its own, run once the session is idle. The worker's turn
   * controller owns the queue. Unset (a headless or sub-agent build) → the
   * noun is refused by name.
   */
  enqueuePluginTurn?: (turn: import('../../mods/promptNouns').PluginPromptTurn) => void
  /**
   * Every session reloads its plugins (the worker host's fan-out): after
   * `$.config.set` stored a plugin's option. Unset → this session's engine
   * alone reloads.
   */
  reloadPluginsOnAllSessions?: () => void
  /**
   * The session draws a prompt box on a page (F-25): `$.prompt.read` /
   * `.fill` / `.suggest` ask it over `mods/ui/<sessionId>`. Unset (a headless
   * or sub-agent build) → answered as headless: the empty box, `no_composer`.
   */
  drawsComposer?: boolean
}

// Convert a host-supplied skill (C++ *.skill.json, fetched via
// catalog.listSkills) into a model-invocable Skill command. The
// `instructions` become the skill body injected on Skill('<name>');
// `permittedTools` carries the derived membership for surfacing. This is
// how the C++ `browser` skill becomes invocable in the JS Skill tool, for
// every provider.
function hostedSkillToCommand(
  skill: HostedSkillDefinition,
): ChromiumPromptCommand {
  return {
    type: 'prompt',
    name: skill.name,
    description: skill.description,
    content: skill.instructions,
    path: `<hosted-skill>/${skill.name}`,
    loadedFrom: 'bundled',
    source: 'bundled',
    permittedTools: skill.toolNames,
  }
}

/**
 * Apply a sub-agent's tool scope to the fully-built tool set via `filterSubAgentTools`, which also strips
 * the plan tools. For the MAIN session (`isSubAgent` false) a strict no-op: it owns plan mode.
 */
function applySubAgentToolScope<T extends { name: string; aliases?: string[] }>(
  tools: T[],
  allow: string[] | undefined,
  disallow: string[] | undefined,
  isSubAgent: boolean,
): T[] {
  if (!isSubAgent) {
    return tools
  }
  return filterSubAgentTools(tools, allow, disallow)
}

export async function createBrowserRuntime(
  options: CreateBrowserRuntimeOptions,
): Promise<BrowserRuntimeState> {
  const hostMode = options.hostMode ?? 'browser'
  // Per-session agent template. Default 'agent' = the full-autonomy set
  // (file/shell + planning + sub-agents; browser/UI/teams deferred) — what the
  // single 'chat' template used to be, so default sessions are unchanged. Other
  // types ('chat' light, 'code') narrow the set; selected via the
  // `?templateType=` guest URL param. The frontmatter contributes the tool
  // preset, the `tools` allowlist (group-expanded), and `deferredTools`.
  const templateType = options.templateType ?? DEFAULT_TEMPLATE_TYPE
  // A plugin's type (`<plugin>:<key>`, F-25): registered from the plugin in
  // effect that offers it, or the session does not start.
  let pluginTemplateOwner: string | undefined
  if (isPluginTemplateId(templateType)) {
    const { openPluginTemplate } = await import('../../mods/ui/pluginTemplateSession')
    pluginTemplateOwner = (await openPluginTemplate(templateType)).owner
  }
  const sessionTemplate = getTemplate(templateType)
  // Precedence: explicit option → host-mode default. (With a host manifest the
  // preset is moot — getToolsForHostManifest ignores it — so this only bites the
  // mock-host / manifest-less path, where 'default' and 'nexus' yield the same
  // tool set anyway. A template no longer carries a preset.)
  const effectiveToolPreset =
    options.toolPreset ?? (hostMode === 'nexus' ? 'nexus' : 'default')
  const supportedSlashCommands = resolveSupportedSlashCommands(
    options.hostManifest && options.hostManifest.commandNames.length > 0
      ? options.hostManifest.commandNames
      : hostMode === 'nexus'
        ? NEXUS_SLASH_COMMANDS
        : undefined,
  )

  const runtimeConfig = new BrowserRuntimeConfig({
    env: options.env,
    runtimeName: options.runtimeName,
    locale: options.locale,
    timezone: options.timezone,
    userAgent: options.userAgent,
  })

  // Resolve the working directory once (real path, NFC) via the host's `fs.cwd`; every consumer sees
  // the same absolute path. Throws if the host cannot produce one.
  const hostCwd = await resolveRuntimeCwd({
    initialCwd: options.cwd,
    bridgeTransport: options.bridgeTransport,
    runtimeConfig,
  })

  // Generate the sessionId now if the caller didn't supply one — both
  // the per-session project root and the conversation store key off it,
  // so they need to agree on the same value.
  const resolvedSessionId = options.sessionId ?? runtimeConfig.createUUID()

  // Filesystem installed early (anchored at the host cwd) so the projectRoot resolver can mkdir.
  // What THIS runtime installs is recorded and reported via `getRuntimeGlobals`, not re-read from the shared slot.
  let installedFs: RuntimeFs
  if (options.fsImplementation) {
    installedFs = options.fsImplementation
    installProcessFs(options.fsImplementation)
  } else {
    const browserFs = createBrowserFsOperations({
      transport: options.bridgeTransport,
      createRequestId: () => runtimeConfig.createUUID(),
      initialCwd: hostCwd,
    })
    installedFs = browserFs
    installProcessFs(browserFs)
  }

  // Project root: `options.projectRoot` when valid, else the shared `~/.velloc/shared-workspace/`;
  // created on disk. The home dir MUST come from the host bridge (the worker env is empty in production).
  // With neither, the session refuses to start rather than work under the browser's own folder.
  const homeDir =
    (await resolveHomeDirViaBridge(options.bridgeTransport)) ?? undefined
  const resolvedProjectRoot = await resolveProjectRoot({
    projectRoot: options.projectRoot,
    homeDir,
    // Drives the per-type `~/.velloc/shared-workspace/<type>/` default for
    // unbound non-`code` sessions (no-op when `options.projectRoot` is set).
    templateType,
    fs: installedFs,
  })

  // `cwd === projectRoot` at startup, except `cwdOverride` (worktree-isolated sub-agent), validated
  // through `checkNotesDir`'s security checks (absolute, non-root, no UNC / NUL) with the trailing
  // separator stripped; invalid → `cwd === projectRoot`.
  const validatedCwdOverride = checkNotesDir(options.cwdOverride, {
    expandTilde: false,
  })
  const cwdOverride = validatedCwdOverride
    ? validatedCwdOverride.replace(/[\\/]+$/, '')
    : undefined
  const resolvedCwd = cwdOverride ?? resolvedProjectRoot

  // The settings home for the runtime's boot reads (marketplace/feature/agent
  // overlays, the MCP pool loader): the worker-env HOME/USERPROFILE (empty in
  // production), else the bridge-resolved `homeDir` (`fs.userHome`, the root the
  // WebUI settings pages write to). Throws when neither resolves; callers skip.
  const settingsHome = (): string => {
    try {
      return resolveSettingsHomeDir(runtimeConfig)
    } catch (e) {
      if (homeDir) return homeDir
      throw e
    }
  }

  // A forced-folder session (`code`/`safe_code`) whose `projectRoot` override is
  // absent/invalid fell back to the shared sandbox workspace — it is NOT bound
  // to a real project folder. The UI surfaces this (snapshot `needsProjectFolder`,
  // AND-ed with host capability in `getSnapshot`) to force the project-folder
  // picker. Only the forced-folder types are gated; `agent`/`chat` are happy in
  // the sandbox. Computed here, where the RAW override is still visible — once
  // resolved, `options.projectRoot` always points at a valid path (sandbox or
  // bound) and the distinction is lost.
  const usedSandboxProjectRoot =
    isForcedFolderTemplateType(templateType) &&
    projectRootIsSandbox(options.projectRoot)

  // WebFetch resolves its deps from its tool-use context at call() time (this runtime's scoped
  // `network`, and `projectRoot` for artifacts), never from a module-global slot.

  const resolvedOptions = {
    ...options,
    cwd: resolvedCwd,
    projectRoot: resolvedProjectRoot,
    // User-settings home for worker-side settings writes (permission grants,
    // agent-model mirror). Undefined with no home: user-scope writes are then
    // refused, never anchored at the cwd.
    settingsHomeDir: (() => {
      try {
        return settingsHome()
      } catch {
        return undefined
      }
    })(),
    sessionId: resolvedSessionId,
  }

  // A provider mod that declared the `cwd` need reads this session's directory
  // from the request's context (models/drivers/sessionWorkingDirs.ts). Keyed
  // by the top-level session: a teammate's requests carry its lead's id.
  if (!options.spawnerSessionId) {
    undoWhenScopeEnds(registerSessionWorkingDir(resolvedSessionId, resolvedCwd), options.runtimeScopeSignal)
  }

  const hostBridge = new BrowserHostBridge({
    transport: resolvedOptions.bridgeTransport,
    runtimeConfig,
    hostMode,
    hostManifest: resolvedOptions.hostManifest,
  })
  // The model transport serves a provider whose spec needs an additive host
  // primitive (an OAuth provider's `{{oauth:…}}`) only when this host's
  // manifest lists it (models/drivers/driverRegistry.ts).
  if (resolvedOptions.hostManifest) {
    setHostPrimitives(resolvedOptions.hostManifest.primitives ?? [])
  }

  // Sidechain store for sub-agent transcripts, anchored beside the session transcript when the backend
  // is fs-backed; forks read it off their tool-use context. No base path → forks run unpersisted.
  const sidechainBasePath =
    resolvedOptions.conversationStorageBackend?.getBasePath?.()
  // Kept on the runtime state so `getRuntimeGlobals` reports the
  // store THIS runtime installed — null when fs-less (no persistence).
  let installedSidechainStore: SidechainTranscriptStore | null = null
  if (sidechainBasePath) {
    installedSidechainStore = createFsSidechainTranscriptStore({
      fs: installedFs,
      basePath: sidechainBasePath,
    })
    setActiveSidechainStore(installedSidechainStore)
  }

  // Memory extraction (fire-and-forget at end of turn), with the same sidechain store. Off under
  // `e2eTrace` unless `e2eEnableExtractMemories`; production sets neither.
  if (
    !runtimeConfig.flagOn('e2eTrace') ||
    runtimeConfig.flagOn('e2eEnableExtractMemories')
  ) {
    registerMemoryExtractor({
      runtimeConfig,
      sidechainStore: installedSidechainStore ?? undefined,
    })
  }

  // Background memory consolidation, gated by time + session count + lock; the same e2e suppression
  // (re-enabled by `e2eEnablePeriodicTidy`). No base path → the session-count gate makes it inert.
  if (
    !runtimeConfig.flagOn('e2eTrace') ||
    runtimeConfig.flagOn('e2eEnablePeriodicTidy')
  ) {
    const backend = resolvedOptions.conversationStorageBackend
    // e2e-only threshold overrides so the dedicated periodic-tidy spec can fire the
    // consolidation fork in a single turn without seeding 24h + 5 sessions.
    // Production guest URLs never set these query params → config is undefined →
    // the hardcoded MIN_HOURS/MIN_SESSIONS defaults apply.
    const numEnv = (name: string): number | undefined => {
      const v = runtimeConfig.getEnv(name)
      if (v === undefined) return undefined
      const n = Number(v)
      return Number.isFinite(n) ? n : undefined
    }
    const minSessionsOverride = numEnv('e2ePeriodicTidyMinSessions')
    const minHoursOverride = numEnv('e2ePeriodicTidyMinHours')
    const periodicTidyConfig =
      minSessionsOverride !== undefined || minHoursOverride !== undefined
        ? {
            ...(minSessionsOverride !== undefined
              ? { minSessions: minSessionsOverride }
              : {}),
            ...(minHoursOverride !== undefined
              ? { minHours: minHoursOverride }
              : {}),
          }
        : undefined
    registerMemoryConsolidator({
      runtimeConfig,
      sidechainStore: installedSidechainStore ?? undefined,
      listSessions: backend?.listSessions
        ? () => backend.listSessions!()
        : undefined,
      historyFolder: sidechainBasePath,
      config: periodicTidyConfig,
    })
  }

  // Progressive tool disclosure is PER-SKILL now (no master switch): each
  // deferrable skill has its own switch = user override (Deferred Tools
  // settings, read from env below after the MCP pool resolves) ?? declared
  // default. Registered with `registerDeferrableSkills` + applied with
  // `setSkillDeferralOverrides` further down. See
  // `toolkit/run/deferredTools.ts`.

  const conversationStore = new BrowserConversationStore({
    runtimeConfig,
    sessionId: resolvedOptions.sessionId,
    storageBackend: resolvedOptions.conversationStorageBackend,
    restoredSessionId: resolvedOptions.restoredSessionId,
  })
  setConversationStore(conversationStore)
  if (pluginTemplateOwner !== undefined) {
    const { checkTemplateOwner } = await import('../../mods/ui/pluginTemplateSession')
    const recorded = (await conversationStore.getSessionMetadata())?.templateOwner
    checkTemplateOwner(templateType, recorded, pluginTemplateOwner)
    if (recorded === undefined) await conversationStore.updateSessionMetadata({ templateOwner: pluginTemplateOwner })
  }

  // File-snapshot recorder (`fileSnapshots: true` templates) in the session dir. Main interactive
  // runtime only (the store is single-writer); no storage path ⇒ no recorder and no WorkspaceDiff.
  const fileSnapshotRecorder =
    templateWantsFileSnapshots(sessionTemplate?.config) &&
    typeof options.sessionStoragePath === 'string' &&
    options.sessionStoragePath.length > 0 &&
    options.isSubAgent !== true &&
    options.bridgeTransport
      ? new FileSnapshotRecorder({
          store: new SessionSnapshotStore({
            transport: options.bridgeTransport,
            fs: installedFs,
            sessionDir: getConversationSessionDirectoryPath(
              options.sessionStoragePath,
              resolvedOptions.sessionId,
            ),
            createRequestId: () => runtimeConfig.createUUID(),
          }),
          fs: installedFs,
          // Never capture the session-storage tree itself (our own blobs/DB
          // would recurse; sibling sessions' transcripts aren't workspace).
          excludeRoots: [options.sessionStoragePath],
        })
      : undefined
  // Read the persisted transcript early for `onUiReady`; reused later as `initialMessages`. Skipped
  // for a background fork and when `onUiReady` is not wired.
  const earlySeedMessages = (
    options as { forkSeedMessages?: Message[] }
  ).forkSeedMessages
  let earlyRecordedMessages: Message[] | null = null
  // The user's auto-compact switch and windows (settings.json /
  // `/autocompact`). One reader per runtime: the trigger, the slash command
  // and the composer snapshot all resolve through it.
  let readerOptions: { projectRoot: string } = resolvedOptions
  const autoCompactWindows = createAutoCompactWindowSettings({
    homeDir: resolvedOptions.settingsHomeDir ?? null,
    projectRoot: () => readerOptions.projectRoot,
    fs: () => installedFs,
  })
  // One read of the permission settings, shared by the display state and the
  // rule seeding below. Unreadable settings seed nothing.
  const permissionSettings: Promise<PermissionSettingsBySource> = (async () =>
    loadPermissionSettingsBySource(
      { homeDir: settingsHome(), projectRoot: resolvedProjectRoot },
      installedFs,
    ))().catch(() => [])
  if (options.onUiReady && !earlySeedMessages) {
    earlyRecordedMessages = [...(await conversationStore.getRecordedMessages())]
    options.onUiReady({
      sessionId: resolvedOptions.sessionId,
      cwd: resolvedCwd,
      projectRoot: resolvedProjectRoot,
      usedSandboxProjectRoot,
      hostMode,
      messages: earlyRecordedMessages,
      conversationStore,
      fileSnapshotRecorder,
      installedFs,
      autoCompactWindows,
      permissionSettings,
    })
  }

  const promptContextProvider = new BrowserPromptContextProvider({
    hostBridge,
    runtimeConfig,
  })

  // Local plugins only (no remote marketplaces), loaded before the input pipeline. The enabled set is
  // the union of user-scope and project-scope `enabled-plugins.json` once one exists, else the option / env allowlist.
  const persistedEnabledPlugins = await loadEffectiveEnabledPlugins({
    cwd: resolvedProjectRoot,
    fs: installedFs,
    homeDir,
  })
  const enabledPlugins =
    persistedEnabledPlugins
    ?? resolvedOptions.enabledPlugins
    ?? parseEnabledPluginsEnv(runtimeConfig.getEnv('NEXUS_ENABLED_PLUGINS'))
  // Also load the marketplace install registry +
  // settings.json's `enabledPlugins` map so marketplace-installed
  // plugins (under `~/.velloc/plugins/cache/...`) are discovered
  // alongside legacy directory-walk plugins. Failure here is
  // non-fatal — marketplace state simply isn't loaded for this
  // session and the legacy plugin path keeps working.
  let installRegistry: import('../../pluginHost/registryFormats').InstalledPluginsFile
    | undefined
  let enabledPluginIdentifiers: Record<string, boolean> | undefined
  try {
    const homeDir = settingsHome()
    const fs = installedFs
    const installState = await import('../../pluginHost/loadPlugins')
      .then(m => m.loadMarketplaceInstallState({ homeDir }, installedFs))
    installRegistry = installState.installRegistry
    const enabledPluginsModule = await import(
      '../../pluginHost/enabledPlugins'
    )
    enabledPluginIdentifiers = await enabledPluginsModule.getEnabledPluginsMap(
      { homeDir }, fs,
    )
  } catch (e) {
    console.warn(
      `[createBrowserRuntime] marketplace plugin discovery skipped: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  // Anchored at the project folder, not cwd (`cwdOverride` for a worktree-
  // isolated sub-agent): a project's plugins live in, and are switched by,
  // `<projectRoot>/.velloc/` — the same root `/plugins install` writes and
  // Settings lists.
  // Each plugin's `userConfig` values: settings.json `pluginConfigs`,
  // read once here and again on every plugin reload.
  const readPluginConfigs = async (): Promise<Record<string, { options?: Record<string, unknown> }>> => {
    try {
      const { getPluginConfigsMap } = await import('../../pluginHost/pluginConfigs')
      return await getPluginConfigsMap({ homeDir: settingsHome() }, installedFs)
    } catch (e) {
      console.warn(`[mods] plugin options skipped: ${e instanceof Error ? e.message : String(e)}`)
      return {}
    }
  }
  // The keys stored for the plugins' own providers (`${provider_key.KEY}`),
  // read alongside the options.
  const readProviderKeys = async (): Promise<Record<string, { apiKey?: string; modOwner?: string }>> => {
    try {
      const { getPluginProviderKeys } = await import('../../pluginHost/pluginConfigs')
      return await getPluginProviderKeys({ homeDir: settingsHome() }, installedFs)
    } catch (e) {
      console.warn(`[plugins] provider keys skipped: ${e instanceof Error ? e.message : String(e)}`)
      return {}
    }
  }
  // The options and provider keys as the plugins' MCP servers were resolved
  // with them, for `$.mcp.connect` to resolve them alike.
  let mcpPluginConfigs = await readPluginConfigs()
  let mcpProviderKeys = await readProviderKeys()
  // A sensitive option reaches a server as a stored secret: written before
  // the pool launches the servers, and again on every plugin reload.
  const storeMcpSecrets = async (contributions: typeof pluginContributions): Promise<void> => {
    const { writes, pluginIds } = contributions.mcpSecrets
    if (!hostBridge.supportsBridgeCapability('secrets')) {
      if (writes.length > 0) console.warn('[plugins] this browser stores no secrets; servers taking a sensitive option will not start')
      return
    }
    await storePluginSecrets(writes, pluginIds, hostBridge.primitives.secrets, message => console.warn(message))
  }
  const pluginContributions = await loadPluginContributions({
    cwd: resolvedProjectRoot,
    fs: installedFs,
    runtimeConfig,
    // Bridge-resolved home — without it the user-scope root
    // (`~/.velloc/plugins/`) resolves to null and is never scanned.
    homeDir,
    enabledPlugins,
    installRegistry,
    enabledPluginIdentifiers,
    pluginConfigs: mcpPluginConfigs,
    providerKeys: mcpProviderKeys,
    requirements: runtimeProviderGate(),
    ...(options.locale !== undefined ? { locale: options.locale } : {}),
  })
  for (const pluginError of pluginContributions.errors) {
    console.warn(`[plugins] ${describePluginError(pluginError)}`)
  }
  await storeMcpSecrets(pluginContributions)
  const pluginLoadResult = {
    enabled: pluginContributions.plugins,
    disabled: pluginContributions.disabled,
    errors: pluginContributions.errors,
  }

  const userInputPipeline = new BrowserUserInputPipeline({
    hostBridge,
    runtimeConfig,
    supportedSlashCommands,
    pluginLoadResult,
    // `/plugins enable <name>` of a folder copied in after this session
    // loaded: the same discovery as boot and reload, read off the disk now.
    rescanPlugins: async () => {
      const [loader, enabledStore] = await Promise.all([
        import('../../pluginHost/loadPlugins'),
        import('../../pluginHost/enabledPlugins'),
      ])
      const pathCtx = { homeDir: settingsHome() }
      const [installState, enabledIds, allowlist] = await Promise.all([
        loader.loadMarketplaceInstallState(pathCtx, installedFs).catch(() => undefined),
        enabledStore.getEnabledPluginsMap(pathCtx, installedFs).catch(() => undefined),
        loadEffectiveEnabledPlugins({ cwd: resolvedProjectRoot, fs: installedFs, homeDir }),
      ])
      return loader.gatherPlugins({
        cwd: resolvedProjectRoot,
        runtimeConfig,
        homeDir,
        fs: installedFs,
        enabledPlugins: allowlist ?? enabledPlugins,
        installRegistry: installState?.installRegistry,
        enabledPluginIdentifiers: enabledIds,
      })
    },
    // `/plugin` + `/marketplace` resolve `~/.velloc/...` paths; the worker env
    // HOME/USERPROFILE is empty in production (the env-based resolver throws),
    // so thread the bridge-resolved settings home (falls back to cwd).
    settingsHomeDir: resolvedOptions.settingsHomeDir,
    // `/marketplace` + `/plugin install` fetch GitHub tarballs. A direct
    // `globalThis.fetch` from the SharedWorker is CSP-blocked ("Failed to
    // fetch" on codeload.github.com); route through the bridge-backed fetch
    // (C++ URLLoaderFactory) when a transport exists — same as the WebUI
    // Plugins page (`pluginsBridgeAdapter`). Falls back to globalThis.fetch in
    // mock-host / test contexts with no transport.
    marketplaceFetch: options.bridgeTransport
      ? createBridgeBackedFetch({
          transport: options.bridgeTransport,
          createRequestId: () => runtimeConfig.createUUID(),
        })
      : undefined,
  })

  const systemInitEmitter = new BrowserSystemInitEmitter({
    hostBridge,
    supportedSlashCommands,
  })

  const localAgents = await loadLocalAgents({
    cwd: resolvedCwd,
    fs: installedFs,
    runtimeConfig,
    homeDir,
    pluginAgentDirs: pluginContributions.pluginAgentDirs,
  })

  let appState = createInitialBrowserAppState()
  // Seed `enabledFeatures` from user settings BEFORE the command list is assembled (feature-gated
  // skills read it there). Failure is non-fatal: features fall back to their defaults.
  try {
    const homeDir = settingsHome()
    await seedAppStateFromSettings(
      updater => {
        appState = updater(appState)
      },
      { homeDir, fs: installedFs },
    )
  } catch (e) {
    console.warn(
      `[createBrowserRuntime] feature settings seed skipped: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  // Names the `session-types` gate dropped. They join the template
  // allowlist's `deniedNames` below so `/name` and `Skill(name)` explain
  // "not available in this session type" instead of reporting a typo.
  const sessionTypeDeniedNames: string[] = []
  const localCommands =
    resolvedOptions.commands ??
    (await loadLocalPromptCommands({
      cwd: resolvedCwd,
      fs: installedFs,
      runtimeConfig,
      homeDir,
      pluginSkillDirs: pluginContributions.pluginSkillDirs,
      onSessionTypeDenied: name => sessionTypeDeniedNames.push(name),
      templateConfig: sessionTemplate?.config,
      // The settings-seeded WorkingState — bundled-skill `isEnabled` callbacks
      // read the user's feature toggles from settings.json, falling back to
      // each feature's registry `default` where the file says nothing.
      // Reloads pass the live `appState` at the reload-time call below.
      appState,
      // Session-type gate for bundled skills carrying a `type:`
      // whitelist. A skill registered with `type: 'agent'` is dropped
      // from a `'chat'`/`'code'` session's command list.
      // Untyped skills are unaffected.
      templateType,
    }))

  // Host-supplied skills (C++ *.skill.json via catalog.listSkills) join
  // the filesystem skills as model-invocable Skill commands. The full
  // `commands` list is assembled after the MCP pool resolves (below) so
  // each connected MCP server can contribute its own `Skill('mcp__<x>')`
  // command.
  const hostedSkills: HostedSkillDefinition[] = [
    ...(resolvedOptions.hostManifest?.hostedSkills ?? []),
    // A2UI: a JS-defined deferrable skill (no C++ manifest entry). Deferred by
    // default because the `chat` template lists it in `deferredTools`;
    // toggleable + activatable via Skill('a2ui') / ToolSearch.
    A2UI_HOSTED_SKILL,
    // Agent-teams: a JS-defined deferrable skill; deferred by default via the
    // `chat` template's `deferredTools` (agent teams stay experimental),
    // unlocked via Skill('agent-teams').
    AGENT_TEAMS_HOSTED_SKILL,
  ]
  // NOTE: `baseTools` is built AFTER the deferrable-skill registration
  // below, because tool `isEnabled()` (e.g. ToolSearch = isAnySkillDeferred)
  // is evaluated at list-construction time and must see the registry.

  // Settings-configured MCP servers run in the worker over the host's primitives when served,
  // else the browser-transport-only pool. Security: only servers settings.json names may reach
  // loopback / the LAN (`allowPrivateNetwork`); a plugin's server may not.
  const userConfiguredMcpServerIds = new Set<string>()
  const sessionMcpHost = {
    transport: resolvedOptions.bridgeTransport,
    manifest: resolvedOptions.hostManifest,
  }
  const nativeMcpBridge = hostServesWorkerMcp(resolvedOptions.hostManifest)
    ? createWorkerMcpOperations({
        resolveHost: () => {
          const host = getMcpHost()
          if (!host) return sessionMcpHost
          return { transport: host.transport, manifest: host.manifest ?? sessionMcpHost.manifest }
        },
        createRequestId: () => runtimeConfig.createUUID(),
        allowPrivateNetwork: serverId => userConfiguredMcpServerIds.has(serverId),
      })
    : undefined
  // The MCP pool reads its settings server list from
  // `~/.velloc/settings.json` (mcp.servers section); each server's full
  // config travels inline through `connect()`. MCP pool settings source —
  // same bridge-`homeDir` fallback as the boot overlays (see
  // `settingsHome`); `null` → only the plugin stdio servers.
  const settingsHomeDir: string | null = (() => {
    try {
      return settingsHome()
    } catch {
      return null
    }
  })()
  const mergePluginNativeMcpServers = (
    settingsEntries: typeof pluginContributions.nativeMcpServers,
  ) => {
    const taken = new Set(settingsEntries.map(entry => entry.id))
    const pluginEntries: typeof pluginContributions.nativeMcpServers = []
    for (const entry of pluginContributions.nativeMcpServers) {
      if (taken.has(entry.id)) {
        console.warn(
          `[mcp] Plugin native server "${entry.id}" skipped — a native server with that name is already configured.`,
        )
        continue
      }
      taken.add(entry.id)
      pluginEntries.push(entry)
    }
    return [...settingsEntries, ...pluginEntries]
  }
  const loadNativeMcpServers = async () => {
    if (!settingsHomeDir) return mergePluginNativeMcpServers([])
    try {
      // This callback's contract is "re-read the LATEST disk state"
      // (see MCPPoolOptions.loadNativeServers): the pool-refresh
      // paths exist for servers added since the worker last read
      // settings.json — including writes from OUTSIDE this worker
      // (a file edit, a CLI). The settings cache only invalidates
      // on in-process writes, so drop it first or the re-read
      // returns the frozen first-boot list and the refresh is a
      // silent no-op.
      wipeSettingsMemos()
      const { settings } = await readUserLayer(
        settingsHomeDir,
        installedFs,
      )
      const settingsServers = settings.mcp?.servers ?? {}
      userConfiguredMcpServerIds.clear()
      for (const id of Object.keys(settingsServers)) userConfiguredMcpServerIds.add(id)
      const settingsEntries = Object.entries(settingsServers).map(([id, raw]) => ({
        id,
        config: {
          transport: raw.transport,
          command: raw.command,
          args: raw.args,
          env: raw.env,
          url: raw.url,
          headers: raw.headers,
          cwd: raw.cwd,
        },
      }))
      return mergePluginNativeMcpServers(settingsEntries)
    } catch (e) {
      console.warn(
        `[mcp] failed to load servers from settings.json: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
      return mergePluginNativeMcpServers([])
    }
  }
  // Boot-welcome milestone: entering the MCP-server connect — the longest
  // single step of the runtime build when servers are configured (spawn +
  // handshake per server). Fired BEFORE the await so the footer moves the
  // moment the wait starts.
  options.onBootStage?.('connectingTools')
  // One pool per top-level session: a sub-agent or fork names its spawner
  // (`modParentSessionId`), a teammate its lead (`spawnerSessionId`).
  const mcpParentSessionId =
    (resolvedOptions as { modParentSessionId?: string }).modParentSessionId ??
    ((resolvedOptions as { isTeammate?: boolean }).isTeammate === true
      ? (resolvedOptions as { spawnerSessionId?: string }).spawnerSessionId
      : undefined)
  const mcpLease = await acquireSessionMCPPool({
    sessionId: resolvedSessionId,
    parentSessionId: mcpParentSessionId,
    cwd: resolvedCwd,
    fs: installedFs,
    extraServers: pluginContributions.mcpServers,
    nativeBridge: nativeMcpBridge,
    loadNativeServers: loadNativeMcpServers,
  })
  undoWhenScopeEnds(mcpLease.release, options.runtimeScopeSignal)
  const mcpPool = mcpLease.pool
  // Deferrable skills: the template's `deferredTools` decides which defer by default; MCP servers defer
  // by default. Security: a `noExecution` type takes nothing from the MCP pool, structurally, since
  // MCP tools bypass the template allowlist and a stdio server spawns OS processes.
  const allowsMcp = templateAllowsMcp(sessionTemplate?.config)
  const mcpServerSkills = allowsMcp ? mcpServerSkillNamesFromPool(mcpPool) : []
  const deferrableSkills = resolveDeferrableSkills(
    mcpServerSkills,
    sessionTemplate?.config,
  )
  // Registered under THIS runtime's key (RuntimeConfig identity): the
  // SharedWorker realm hosts every session's runtime, and per-turn gate reads
  // resolve by the caller context's `options.runtimeConfig` — so a sibling
  // session created later cannot replace this session's deferral config
  // (the old module-global registry was last-writer-wins). The keyless slot
  // is also updated, which the synchronous `isEnabled()` evaluation in
  // `getToolsForHostManifestOrPreset` below relies on (no await between here
  // and there — a sibling cannot interleave).
  registerDeferrableSkills(deferrableSkills, runtimeConfig)
  // JS skill catalogs, emitted only while the skill's tools are visible; registration order is
  // emission order. Browser gates by predicate: its tools are published by the host.
  registerSkillCatalog({
    skillName: BROWSER_SKILL_NAME,
    toolNames: [],
    matchesToolName: isBrowserToolName,
    holderName: BROWSER_CATALOG_HOLDER,
    content: BROWSER_SYSTEM_PROMPT_CATALOG,
  })
  // a2ui has no C++ tool-catalog section and never had one — it was the first
  // skill on this seam.
  registerSkillCatalog({
    skillName: A2UI_SKILL_NAME,
    toolNames: A2UI_TOOL_NAMES,
    holderName: A2UI_CATALOG_HOLDER,
    content: A2UI_SYSTEM_PROMPT_CATALOG,
  })
  // Deferral is TEMPLATE-ONLY now: `resolveDeferrableSkills` (above) derives the
  // deferred units SOLELY from the session template's `deferredTools`. The old
  // per-skill `defer<Skill>` guest-URL override (deferBrowser / deferA2ui /
  // deferAgentTeams / deferMcp) is GONE — template.md is the single entry, and
  // any group or skill is deferred (listed in `deferredTools`) or loaded
  // (listed in `tools:`) there.

  // The guest sends finished prompt sections and full tool definitions; the host resolves nothing.
  // Catalog prose follows the deferral-aware visible tool set.

  // Build the base tool list NOW — after the deferrable-skill registry +
  // overrides are set — because `getToolsForHostManifestOrPreset` filters by
  // each tool's `isEnabled()`, and ToolSearch's gate (`isAnySkillDeferred`)
  // must observe the populated registry (else ToolSearch is wrongly dropped).
  const discoveredTools = getToolsForHostManifestOrPreset(
    resolvedOptions.hostManifest,
    effectiveToolPreset,
    { runtimeConfig },
  )
  // The template `tools:` allowlist narrows to the eager-visible tools (absent ⇒ full set). Also
  // kept: tools of deferred skills, of deferred groups, and of skills loaded via `tools:`; the
  // deferral gate hides deferred and sealed ones. Same resolved unit set as the registry.
  const deferrableSkillNames = new Set(deferrableSkills.map(s => s.name))
  const deferredGroupToolNames = new Set<string>()
  for (const unit of deferrableSkills) {
    if (unit.toolNames) for (const t of unit.toolNames) deferredGroupToolNames.add(t)
  }
  const loadedSkillNames = new Set(
    (sessionTemplate?.config.tools ?? []).filter(n => !isToolGroup(n)),
  )
  const keptSkillNames = new Set([...deferrableSkillNames, ...loadedSkillNames])
  const allowlistedTools = applyTemplateToolAllowlist(
    discoveredTools,
    sessionTemplate?.config,
    tool =>
      (typeof tool.skill === 'string' && keptSkillNames.has(tool.skill)) ||
      deferredGroupToolNames.has(tool.name),
  )
  // A TEAMMATE takes part in the team's shared task list whatever its type —
  // an untrusted child runs `safe_code`, whose allowlist (no `agent-teams`)
  // would drop TaskCreate / TaskUpdate / TaskList, and with them the one
  // coordination surface every teammate has (claim, complete, check for
  // the next). These three are registry operations: no filesystem, no
  // execution, no network, so they widen nothing the boundary closes. What
  // is NOT added is SendMessage / Shutdown / SpawnTeammate — the untrusted
  // child's only channel upward stays the end-of-turn report (F-20).
  const isTeammateRuntime =
    (resolvedOptions as { isTeammate?: boolean }).isTeammate === true
  const baseTools = isTeammateRuntime
    ? withTeammateSharedTaskTools(allowlistedTools, discoveredTools)
    : allowlistedTools
  // Assemble the model-invocable Skill commands: filesystem skills,
  // C++ hosted skills, and one `Skill('mcp__<server>')` per connected
  // MCP server (the named alternative to ToolSearch for bringing a whole
  // server's tools online).
  // (`noExecution` — see the mcpServerSkills note above — takes none of them.)
  const allCommands = [
    ...localCommands,
    ...hostedSkills.map(hostedSkillToCommand),
    ...(allowsMcp ? buildMCPSkillCommands(mcpPool) : []),
  ]
  // Per-type `skills:` allowlist on the one registry every skill surface reads, so a denied skill is
  // absent; `deniedNames` only feeds error text. Recomputed on a `/plugins` reload.
  const applySkillAllowlist = <T extends { name: string; source: string }>(
    list: readonly T[],
  ) => partitionSkillsForSession(sessionTemplate?.config, list, sessionTypeDeniedNames)
  const { allowed: commands, deniedNames: deniedSkillNames } =
    applySkillAllowlist(allCommands)
  // Stage two of the allowlist validation: a well-formed id that names no
  // skill this session loaded. Reported, never silently dropped — but not
  // fatal, because a `project:`/`user:` skill lives in the workspace and its
  // absence is a property of where the session opened, not of the template.
  const reportUnresolvedSkills = (loaded: readonly { name: string; source: string }[]) => {
    const unresolvedSkills = unresolvedSkillIds(sessionTemplate?.config, loaded)
    if (unresolvedSkills.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[createAgentRuntime] template "${templateType}" allows skills that are ` +
          `not loaded in this session: ${unresolvedSkills.join(', ')}. They grant ` +
          'nothing; remove them from `skills:` or install the skill.',
      )
    }
  }
  reportUnresolvedSkills(allCommands)
  // Per-agent tool scope for a background sub-agent. Applied here,
  // AFTER dynamic C++/MCP tools are in the set, because a read-only agent's
  // denylist (Explore/Plan) targets exactly those post-boot tools. No-op for a
  // normal session (the fields are unset).
  const subAgentScope = options as {
    subAgentAllowTools?: string[]
    subAgentDisallowTools?: string[]
    isSubAgent?: boolean
    forkExactTools?: boolean
    forkSeedMessages?: Message[]
  }
  // MCP tools and `WorkspaceDiff` land PAST `applyTemplateToolAllowlist`. WorkspaceDiff only for a
  // snapshot session without a shell (`templateWantsWorkspaceDiffTool`).
  const snapshotTools =
    fileSnapshotRecorder &&
    templateWantsWorkspaceDiffTool(sessionTemplate?.config)
      ? [WorkspaceDiffTool]
      : []
  const allTools = allowsMcp
    ? [
        ...baseTools,
        ...snapshotTools,
        ...buildMCPToolsFromPool(mcpPool),
        ...buildMcpResourceToolsFromPool(mcpPool),
      ]
    : [...baseTools, ...snapshotTools]
  // A background FORK keeps the parent's EXACT tool pool (no sub-agent strip),
  // so its serialized tools array stays aligned with the parent's for prompt-
  // cache reuse; a named/general-purpose sub-agent gets the scoped set.
  const tools = subAgentScope.forkExactTools
    ? allTools
    : applySubAgentToolScope(
        allTools,
        subAgentScope.subAgentAllowTools,
        subAgentScope.subAgentDisallowTools,
        subAgentScope.isSubAgent === true,
      )
  const readFileCache = createBrowserReadFileCache()
  // A background FORK seeds the parent's conversation here as the engine's
  // initial messages so it continues the parent's context (the QueryEngine
  // first-turn hydration preserves a not-yet-persisted seed — see the
  // `hydratedMessages.length > 0` guard in submitMessage). Otherwise the worker
  // rehydrates from its own persisted transcript (empty on a fresh sub-agent).
  // Boot-welcome milestone: MCP settled; now restoring the active session's
  // persisted transcript (and the engine build that follows).
  options.onBootStage?.('restoring')
  // Reuse the UI-ready split's early read when it ran — the store hasn't
  // been written since (see the hoist above), and re-reading here would
  // just repeat the fs round-trip.
  const initialMessages = subAgentScope.forkSeedMessages
    ? [...subAgentScope.forkSeedMessages]
    : earlyRecordedMessages ??
      [...(await conversationStore.getRecordedMessages())]
  // The deferred-skill gate is re-derived from the transcript per turn, so there is no init-time seed
  // of `appState.activeSkills`; except a TEAMMATE pre-activates `agent-teams` for turn 1.
  const isTeammateSession =
    (resolvedOptions as { isTeammate?: boolean }).isTeammate === true
  if (isTeammateSession) {
    appState = { ...appState, activeSkills: [AGENT_TEAMS_SKILL_NAME] }
  }

  const coreState = {
    autoCompactWindows,
    options: {
      ...resolvedOptions,
      hostMode,
      toolPreset: effectiveToolPreset,
      commands,
      // The built-in agents (Explore / Plan / general-purpose) are always
      // available; user/project/plugin agents are layered on top and win on
      // name collision (so a custom "Explore" overrides the built-in). An
      // explicit `options.agents` from the caller takes precedence over
      // filesystem discovery. See agents/builtInAgents.ts.
      agents: withBuiltInAgents(resolvedOptions.agents ?? localAgents),
    },
    usedSandboxProjectRoot,
    runtimeConfig,
    hostBridge,
    conversationStore,
    installedFs,
    installedSidechainStore,
    sessionMcpPool: allowsMcp ? mcpPool : undefined,
    sessionMcpOrigins: allowsMcp
      ? { settingsIds: userConfiguredMcpServerIds, pluginServers: pluginContributions.mcpServerPlugins }
      : undefined,
    promptContextProvider,
    userInputPipeline,
    systemInitEmitter,
    queryRuntimeDeps: options.queryRuntimeDeps ?? assembleTurnDependencies(
      runtimeConfig,
      {
        microcompact: createBrowserToolMicrocompact(
          options.hostManifest?.compactableToolNames,
        ),
        // Forward the per-engine `messageCompaction` override so the
        // autocompact closure sees the same thresholds the QueryEngine
        // does. Without this, autocompact construction binds the
        // hard-coded defaults (25 steps / 40K chars) and any override
        // passed via `BrowserRuntimeOptions.agentLoopSettings` is
        // silently ignored — that's the bug the e2e compaction test
        // surfaced.
        autocompact: createBrowserAutoCompact(
          options.bridgeTransport,
          runtimeConfig,
          options.agentLoopSettings?.messageCompaction,
          autoCompactWindows,
        ),
        autoCompactWindows,
        // User-triggered `/compact [instructions]`. Bypasses the
        // step-cadence and char-floor gates that `autocompact` runs
        // (those gates are for the per-turn auto-trigger, not the
        // user's explicit ask). Shares `performCompaction` with the
        // auto path so the wire shape and summary format stay
        // identical.
        forceCompact: async ({ messages, mainLoopModel, customInstructions, providerId }) => {
          return performCompaction({
            messages,
            bridgeTransport: options.bridgeTransport,
            runtimeConfig,
            mainLoopModel,
            providerId,
            trigger: 'manual',
            customInstructions,
            requester: {
              sessionId: resolvedSessionId,
              spawnerSessionId: (resolvedOptions as { spawnerSessionId?: string }).spawnerSessionId,
            },
          })
        },
        async saveStrippedResults(strippedResults) {
          for (const [toolCallId, compactContent] of strippedResults) {
            await conversationStore.promoteToolCallDetailToOrigin(toolCallId, compactContent)
          }
        },
      },
      {
        bridgeTransport: options.bridgeTransport,
        runtimeConfig,
        traceLogger: options.traceLogger,
        queuedAttachmentProvider: params =>
          collectQueuedAttachmentMessages({
            messages: params.messages,
            toolUseContext: params.toolUseContext,
            runtimeConfig,
            assistantMessages: params.assistantMessages,
            querySource: params.querySource,
            sessionId: resolvedOptions.sessionId,
            drainTaskNotifications: options.drainTaskNotifications,
            drainTeamMessages: options.drainTeamMessages,
            drainInjectMessages: options.drainInjectMessages,
          }),
      },
    ),
    tools,
    readFileCache,
    initialMessages,
    getAppState: () => appState,
    setAppState: (updater: (prev: typeof appState) => typeof appState) => {
      appState = updater(appState)
    },
    fileSnapshotRecorder,
  }
  readerOptions = coreState.options

  // Register enabled-plugin hooks into the session hook store. Command /
  // prompt / http / agent hook types each run through the executor's runner
  // for that type (see registerPluginHooks).
  registerPluginHooks({
    setAppState: coreState.setAppState,
    sessionId: resolvedOptions.sessionId,
    plugins: pluginContributions.plugins,
  })

  // Register settings.json hooks into the session hook store so a
  // "from now on, whenever X, do Y" hook written to ~/.velloc/settings.json
  // (via the `update-config` skill) actually fires. Non-fatal — a missing
  // file / bad hook leaves the registry untouched, same graceful
  // degradation as the plugin-hook and feature-seed steps around it.
  try {
    await registerSettingsHooks({
      setAppState: coreState.setAppState,
      sessionId: resolvedOptions.sessionId,
      homeDir: settingsHome(),
      fs: installedFs,
    })
  } catch (e) {
    console.warn(
      `[createBrowserRuntime] settings.json hooks load skipped: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  // Track the active plugin paths so a live reload can drop their hooks
  // before registering the new set.
  let activePluginPaths = pluginContributions.plugins.map(plugin => plugin.path)

  // Live reload for `/plugins enable|disable`: re-run discovery with the new
  // allowlist, re-register hooks, refresh the `/plugins` snapshot, and return
  // the new command / agent / plugin-summary sets for the engine to swap in.
  // MCP server changes are deferred to the next session (the tools array and
  // pool are not rebuilt here).
  const onReloadPlugins = async (requestedEnabledPlugins?: string[]) => {
    // No list (a Settings write, `$.config.set`): the enabled files as they
    // are NOW, by the same rule as boot. Folder names — never the loaded
    // plugins' manifest names, which need not match their folders.
    const nextEnabledPlugins =
      requestedEnabledPlugins
      ?? (await loadEffectiveEnabledPlugins({ cwd: resolvedProjectRoot, fs: installedFs, homeDir }))
      ?? enabledPlugins
    // Re-resolve the marketplace registry + enabled-id map on
    // every reload. Mirrors the boot-time path above so a user toggling
    // a plugin via /plugin enable|disable AND /plugins enable|disable
    // in the same reload both see fresh state. Failure is non-fatal —
    // legacy reloads keep working.
    let reloadInstallRegistry:
      | import('../../pluginHost/registryFormats').InstalledPluginsFile
      | undefined
    let reloadEnabledIds: Record<string, boolean> | undefined
    try {
      const homeDir = settingsHome()
      const fs = installedFs
      const installState = await import('../../pluginHost/loadPlugins')
        .then(m => m.loadMarketplaceInstallState({ homeDir }, installedFs))
      reloadInstallRegistry = installState.installRegistry
      const enabledPluginsModule = await import(
        '../../pluginHost/enabledPlugins'
      )
      reloadEnabledIds = await enabledPluginsModule.getEnabledPluginsMap(
        { homeDir }, fs,
      )
    } catch (e) {
      console.warn(
        `[onReloadPlugins] marketplace plugin reload skipped: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    mcpPluginConfigs = await readPluginConfigs()
    mcpProviderKeys = await readProviderKeys()
    const reloadContributions = await loadPluginContributions({
      cwd: resolvedProjectRoot,
      fs: installedFs,
      runtimeConfig,
      homeDir,
      enabledPlugins: nextEnabledPlugins,
      installRegistry: reloadInstallRegistry,
      enabledPluginIdentifiers: reloadEnabledIds,
      pluginConfigs: mcpPluginConfigs,
      providerKeys: mcpProviderKeys,
      requirements: runtimeProviderGate(),
      ...(options.locale !== undefined ? { locale: options.locale } : {}),
    })
    for (const pluginError of reloadContributions.errors) {
      console.warn(`[plugins] ${describePluginError(pluginError)}`)
    }
    await storeMcpSecrets(reloadContributions)
    sessionTypeDeniedNames.length = 0
    const reloadedCommands =
      resolvedOptions.commands
      ?? (await loadLocalPromptCommands({
        cwd: resolvedCwd,
        fs: installedFs,
        runtimeConfig,
        homeDir,
        pluginSkillDirs: reloadContributions.pluginSkillDirs,
        onSessionTypeDenied: name => sessionTypeDeniedNames.push(name),
        templateConfig: sessionTemplate?.config,
        // Live WorkingState — bundled-skill `isEnabled` callbacks gate on
        // the current feature toggles from the settings file.
        appState,
        // Session-type stays constant for the lifetime of the runtime —
        // forward the same value the initial load used so a `/plugins`
        // reload doesn't accidentally widen the bundled-skill set.
        templateType,
      }))
    const reloadedAgents = withBuiltInAgents(
      resolvedOptions.agents
      ?? (await loadLocalAgents({
        cwd: resolvedCwd,
        fs: installedFs,
        runtimeConfig,
        homeDir,
        pluginAgentDirs: reloadContributions.pluginAgentDirs,
      })),
    )
    // Swap hooks: drop the previously-active plugins' hooks, then register
    // the new set.
    for (const path of activePluginPaths) {
      removeSessionHooksBySkillRoot(
        coreState.setAppState,
        resolvedOptions.sessionId,
        path,
      )
    }
    registerPluginHooks({
      setAppState: coreState.setAppState,
      sessionId: resolvedOptions.sessionId,
      plugins: reloadContributions.plugins,
    })
    activePluginPaths = reloadContributions.plugins.map(plugin => plugin.path)
    // The mods follow the plugin set (F-25). Never fatal to the reload.
    try {
      await reconcileMods(reloadContributions.plugins)
    } catch (error) {
      console.warn(`[mods] reload: ${error instanceof Error ? error.message : String(error)}`)
    }
    // Provider mods are global, not this session's: the realm's host scans
    // the person's plugins again (a no-op until the manager's boot ran).
    void import('../../mods/provider/providerModBoot').then(m => m.reloadProviderMods())
    // Refresh the read-only `/plugins` snapshot.
    userInputPipeline.updatePluginLoadResult({
      enabled: reloadContributions.plugins,
      disabled: reloadContributions.disabled,
      errors: reloadContributions.errors,
    })
    // Swap the runtime options too (`getSlashCommands` reads them). The allowlist and the denied
    // names apply to the reloaded list as well.
    const { allowed: allowedReloaded, deniedNames: deniedReloaded } =
      applySkillAllowlist(reloadedCommands)
    reportUnresolvedSkills(reloadedCommands)
    coreState.options.commands = allowedReloaded
    coreState.options.agents = reloadedAgents
    return {
      commands: allowedReloaded,
      deniedSkillNames: deniedReloaded,
      agents: reloadedAgents,
      plugins: reloadContributions.plugins.map(plugin => ({
        name: plugin.name,
        description: plugin.manifest.description,
      })),
    }
  }

  // APPEND the user-context block from the settings `profile` to the system prompt (additive, unlike
  // `customSystemPrompt`). Read once before the engine is built; a read failure is non-fatal.
  let effectiveAppendSystemPrompt = coreState.options.appendSystemPrompt
  try {
    // First adopter of the settings source hierarchy (gap #3): merge
    // user/project/local so a project's `.velloc/settings.json` can contribute
    // profile / output-style / permission rules. With only a user file present
    // this is identical to the old single-source `readUserLayer`.
    const { settings } = await loadEffectiveSettings(
      { homeDir: settingsHome(), projectRoot: coreState.options.projectRoot },
      installedFs,
    )
    const profileBlock = buildProfilePromptBlock(settings.profile)
    if (profileBlock) {
      effectiveAppendSystemPrompt = effectiveAppendSystemPrompt
        ? `${effectiveAppendSystemPrompt}\n\n${profileBlock}`
        : profileBlock
    }
    // Reply style: prepend the active style's `# Reply style:` block (before
    // the profile block) so the persona frames the rest of the addendum. Read
    // from the same settings.json; default / unknown style → no block.
    const outputStyleBlock = resolveOutputStyleSection(settings.outputStyle)
    if (outputStyleBlock) {
      effectiveAppendSystemPrompt = effectiveAppendSystemPrompt
        ? `${outputStyleBlock}\n\n${effectiveAppendSystemPrompt}`
        : outputStyleBlock
    }
    // Seed permission rules per settings source, the default mode, `additionalWorkingDirectories`
    // and the `disableBypassPermissionsMode` killswitch BEFORE the engine starts. No block → allow-all.
    const permissionsBySource = await permissionSettings
    if (permissionsBySource.some(entry => entry.permissions)) {
      coreState.setAppState(prev => ({
        ...prev,
        permissionRules: applyPermissionRulesBySource(
          prev.permissionRules,
          permissionsBySource,
        ),
      }))
      // Shadowed-rule warning (spec 5-5-8 — also listed in the
      // /permissions panel). With ask out-ranking allow (the rule order), an
      // allow rule under a broader ask/deny rule can never fire — the classic
      // case being "Always allow" persisting a rule that a configured
      // whole-tool `ask` keeps shadowing, so the prompt returns every session.
      // Diagnostics only; never fatal.
      try {
        for (const shadowed of findShadowedRules(
          coreState.getAppState().permissionRules,
        )) {
          console.warn(`[permissions] ${shadowed.reason} ${shadowed.fix}`)
        }
      } catch {
        /* diagnostics only */
      }
    }
  } catch {
    /* keep the caller's appendSystemPrompt — non-fatal, same as the agent overlay */
  }

  // Security: a sub-agent or headless session has no interactive surface, so every would-be
  // permission ask becomes a denial; `runToolUse` reads this flag at each ask site.
  const isHeadlessSession =
    (options as { isHeadless?: boolean }).isHeadless === true
  if (options.isSubAgent === true || isHeadlessSession) {
    coreState.setAppState(prev => ({
      ...prev,
      permissionRules: {
        ...prev.permissionRules,
        suppressAsks: true,
      },
    }))
  }

  // Resolve the user's `memory` settings (Settings → Memory, for
  // `autoMemoryEnabled` / `autoMemoryDirectory`). Toggles come from the merged
  // effective settings; `directory` from TRUSTED sources only (projectSettings
  // excluded for security). Threaded into the engine so the memory gates
  // (`buildMemorySystemPrompt`, recall, the extract fork) consult it. Non-fatal: a
  // read failure yields an empty snapshot (env vars + the on-by-default
  // behaviour then decide).
  let resolvedMemory: ResolvedMemorySettings = {}
  try {
    resolvedMemory = await resolveMemorySettings(
      { homeDir: settingsHome(), projectRoot: coreState.options.projectRoot },
      installedFs,
    )
  } catch {
    /* non-fatal — empty snapshot; env + default decide */
  }
  // A TEAMMATE appends the teammate addendum to its type's prompt. Trust is read off the resolved
  // TEMPLATE (the signal that decides the tool set); the read boundary is only a fallback.
  if (isTeammateSession) {
    const teammateAddendum = buildTeammatePromptAddendum({
      teammateName:
        (resolvedOptions as { teammateName?: string }).teammateName ?? '',
      untrusted:
        templateType === SAFE_CODE_TEMPLATE_TYPE ||
        Boolean(
          (resolvedOptions as { untrustedReadRoot?: string }).untrustedReadRoot,
        ),
      ...(coreState.options.cwd ? { cwd: coreState.options.cwd } : {}),
      // The ENFORCED boundary, so the addendum names the real root rather
      // than the cwd that usually equals it — they diverge when the lead
      // prepared no directory and the boundary fell back to the project.
      ...((resolvedOptions as { untrustedReadRoot?: string }).untrustedReadRoot
        ? {
            readRoot: (resolvedOptions as { untrustedReadRoot?: string })
              .untrustedReadRoot as string,
          }
        : {}),
    })
    effectiveAppendSystemPrompt = effectiveAppendSystemPrompt
      ? `${effectiveAppendSystemPrompt}

${teammateAddendum}`
      : teammateAddendum
  }
  // A child on an untrusted provider gets NO memory, whatever the user set.
  // The runtime reads `MEMORY.md` on the model's behalf when it assembles the
  // prompt, and that read passes through neither boundary chokepoint — so
  // left on, the user's auto-memory (and on a non-git project, the project's)
  // would go to the relay on the first request. The instruction-file
  // hierarchy is scoped to the read root for the same reason
  // (`gatherInstructionDocs`' `readRoot`).
  if ((resolvedOptions as { untrustedReadRoot?: string }).untrustedReadRoot) {
    resolvedMemory = { ...UNTRUSTED_CHILD_MEMORY_SETTINGS }
  }

  // Sub-session model routing (Settings → Session models): seed this realm's
  // snapshot so the pure tier helpers in engine/contextWindow.ts (the dictionary +
  // router) see the user's settings — the seam's contract is "no caller
  // changes", hence a realm snapshot instead of threading. Live updates land
  // via `QueryEngine.applySessionModelSettings` (worker.applyRuntimeSettings).
  // Non-fatal: on failure the helpers keep the built-in ladder/census.
  // `mods.headless` rides the same read (F-25 debt 7).
  let headlessMods = false
  try {
    const { settings } = await loadEffectiveSettings(
      { homeDir: settingsHome(), projectRoot: coreState.options.projectRoot },
      installedFs,
    )
    setSessionModelSettingsSnapshot({
      modelTiers: settings.modelTiers,
      sessionModelPolicy: settings.sessionModelPolicy,
    })
    headlessMods = settings.mods?.headless === true
  } catch {
    /* non-fatal — built-in ladder/census apply */
  }
  // The end-of-turn extract fork is opt-in via `autoExtractEnabled` (default
  // off). The `e2eEnableExtractMemories` harness flag exists precisely to
  // exercise that fork in the single-turn extract-memories e2e spec, so it
  // implies extract-on. Inert in production (the flag is never set there).
  if (
    coreState.runtimeConfig.flagOn('e2eEnableExtractMemories') &&
    resolvedMemory.autoExtractEnabled === undefined
  ) {
    resolvedMemory = { ...resolvedMemory, autoExtractEnabled: true }
  }

  const mainSessionMaxTurns = options.isSubAgent === true
    ? coreState.options.maxTurns
    : 10000

  // Mods: one mod runtime per session slot (top-level or teammate); `selectModModules` decides, and a
  // sub-agent or headless run gets none. Imported lazily, only when an enabled plugin has a hooks module.
  const modSlotFacts = {
    isSubAgent: options.isSubAgent === true,
    isHeadless: isHeadlessSession,
    headlessMods,
    isTeammate: isTeammateSession,
    teammateName: (resolvedOptions as { teammateName?: string }).teammateName,
  }
  // settings.json `enabledPlugins`: a built-in's `<name>@builtin` entry
  // switches it over its default — read on every select, so the Settings
  // toggle's reload applies it.
  const readEnabledPlugins = async (): Promise<Record<string, boolean>> => {
    try {
      const { getEnabledPluginsMap } = await import('../../pluginHost/enabledPlugins')
      return await getEnabledPluginsMap({ homeDir: settingsHome() }, installedFs)
    } catch (e) {
      console.warn(`[mods] enabled plugins skipped: ${e instanceof Error ? e.message : String(e)}`)
      return {}
    }
  }
  // The product's built-ins, registered once per runtime realm before
  // the first slot selects its modules.
  await import('../../mods/bundledBuiltinMods').then(m => m.registerBundledBuiltinMods())
  const modModules = selectModModules(modSlotFacts, pluginContributions.plugins, await readPluginConfigs(), await readEnabledPlugins())
  /** The enabled plugins as the slot's mods were last selected from:
   *  `$.mcp.connect` reads the calling plugin's manifest servers off them. */
  let modPlugins = pluginContributions.plugins
  let mods: import('../../mods/ModRuntime').ModRuntime | undefined
  /** Undo of the slot's registry entry; replaced when the runtime is. */
  let unregisterModSlot: (() => void) | undefined
  let engineForMods: ConversationEngine | undefined
  const modEngine = (what: string): ConversationEngine => {
    if (!engineForMods) {
      const error = new Error(`${what} is not available yet: the session is still starting`)
      error.name = 'NotSupportedError'
      throw error
    }
    return engineForMods
  }
  const modToolHost = () => modEngine('$.tool').modTools
  /**
   * `$.tool.register` / `$.agent.register` made before the engine binds (e.g. at `session.start`),
   * applied in order when it binds.
   */
  const earlyRegistrations: Array<{ kind: 'tool' | 'agent'; plugin: string; apply: (engine: ConversationEngine) => void }> = []
  const registerOnEngine = (
    kind: 'tool' | 'agent',
    plugin: string,
    apply: (engine: ConversationEngine) => string,
    fullName: string,
    report: (line: string) => void,
  ): string => {
    if (engineForMods) return apply(engineForMods)
    earlyRegistrations.push({
      kind,
      plugin,
      apply: engine => {
        try {
          apply(engine)
        } catch (error) {
          report(`${plugin}: $.${kind}.register(${fullName}) failed when the session bound: ${error instanceof Error ? error.message : String(error)}`)
        }
      },
    })
    return fullName
  }
  const forgetOnEngine = (kind: 'tool' | 'agent', plugin: string, forget: (engine: ConversationEngine) => void): void => {
    for (let i = earlyRegistrations.length - 1; i >= 0; i -= 1) {
      const entry = earlyRegistrations[i]!
      if (entry.kind === kind && entry.plugin === plugin) earlyRegistrations.splice(i, 1)
    }
    if (engineForMods) forget(engineForMods)
  }
  /** The slot's `$.state`: memory alone, as long as the slot. Every runtime
   *  the slot builds shares it, so the idle unload's reload keeps it. */
  let slotModState: import('../../mods/modState').ModStateStore | undefined
  /**
   * Build the slot's mod runtime for `modules` — at boot when an enabled
   * plugin carries a hooks module, or LATER, when `/plugins enable` (or the
   * Settings toggle) gives a session that had none its first one.
   * `selectModModules` stays the one predicate; this is its consequence.
   */
  const buildModRuntime = async (
    modules: ReturnType<typeof selectModModules>,
  ): Promise<import('../../mods/ModRuntime').ModRuntime> => {
    const [
      { ModRuntime },
      { openInstance, KERNEL_SPAWN_ACK_TIMEOUT_MS },
      { MOD_WORKER_KIND },
      { SANDBOX_READY_TIMEOUT_MS },
      { ModStateStore },
      { fileModStore },
      { ensureDirRecursive },
      { compileModModule, loadTypeScript },
      { scanModuleUses },
      { fileModFs },
      { isBuiltinModPath, readBuiltinMod },
      { hostModProcess },
      { hostModHttp },
      { modToolFullName },
      { modAgentFullName },
      { poolModMcp },
      { createWindowAudioPlayer },
    ] = await Promise.all([
      import('../../mods/ModRuntime'),
      import('../workerKernel/IsolatedWorkerKernel'),
      import('../../mods/modTypes'),
      import('../workerKernel/SandboxedWorkerHost'),
      import('../../mods/modState'),
      import('../../mods/modStore'),
      import('../../pluginHost/writeExtracted'),
      import('../../mods/modCompiler'),
      import('../../mods/modScan'),
      import('../../mods/modFs'),
      import('../../mods/builtinMods'),
      import('../../mods/modProcess'),
      import('../../mods/modHttp'),
      import('../../mods/modRegisteredTools'),
      import('../../mods/modAgents'),
      import('../../mods/modMcp'),
      import('../workerKernel/windowAudio'),
    ])
    const reportMods = (line: string) => {
      // A mod that did not load, a hook that failed, a worker that died:
      // the debug log, and the console of whoever is developing the mod.
      traceLine(`[mods] ${line}`, { level: 'warn' })
      console.warn(`[mods] ${line}`)
    }
    slotModState ??= new ModStateStore()
    // `$.store`: `~/.velloc/mods/<plugin>/store.json`. No resolvable home —
    // an in-memory store, which the runtime supplies by default.
    const modsDir = (() => {
      try {
        return joinRuntimePath(settingsHome(), RUNTIME_DIR_NAME, 'mods')
      } catch {
        return undefined
      }
    })()
    const modStoreFs = {
      readFile: (path: string, o: { encoding: string }) => installedFs.readFile(path, o),
      writeFile: (path: string, data: string, o?: { encoding?: string }) =>
        installedFs.writeFile(path, data, o),
      ensureDir: (dir: string) => ensureDirRecursive(installedFs, dir),
    }
    // What each module's last load produced (`modBuildStore.ts`):
    // `~/.velloc/mods/.builds/`, one file per module, replaced at each load —
    // an unchanged module is not read, compiled or scanned again.
    const modBuilds = modsDir
      ? fileModBuildStore(installedFs, modsDir, { ensureDir: dir => ensureDirRecursive(installedFs, dir) })
      : undefined
    // Declared before the runtime so its `dispose` can call it: the registry
    // entry goes with the runtime, not only with the scope's abort.
    let unregisterSlot: (() => void) | undefined
    const modRuntime = new ModRuntime({
      modules,
      // `$.plugin.locale` / `session.start`'s `locale`: the page's language.
      ...(options.locale !== undefined ? { locale: options.locale } : {}),
      onDisposed: () => unregisterSlot?.(),
      // A TypeScript / TSX module, or one that imports: compiled to one
      // module from its graph, read through the session's fs, within the
      // plugin's folder alone.
      compile: ref =>
        compileModModule({
          entry: ref.path,
          root: ref.root ?? ref.path.replace(/[\\/][^\\/]*[\\/][^\\/]*$/, ''),
          fs: {
            readFile: (path, o) => installedFs.readFile(path, o).then(String),
          },
        }).then(result => ({ source: result.source, files: result.files, uses: result.uses })),
      ...(modBuilds ? { builds: modBuilds } : {}),
      // The scan for a plain module the compiler never sees: the same
      // parser, over its one file.
      scan: (ref, source) => loadTypeScript().then(ts => scanModuleUses(ts, [{ path: ref.path, text: source }])),
      // The dev loop: the module's files are stat'ed at turn end through
      // the fs bridge; a changed one reloads the module.
      // A built-in's text is the registry's: never on disk, never polled.
      statModule: path => (isBuiltinModPath(path) ? Promise.resolve(undefined) : installedFs.stat(path).then(stat => stat.mtimeMs)),
      stateStore: slotModState,
      readModule: async path => {
        if (isBuiltinModPath(path)) {
          const text = readBuiltinMod(path)
          if (text === undefined) throw new Error(`no built-in mod serves ${path}`)
          return text
        }
        return String(await installedFs.readFile(path, { encoding: 'utf-8' }))
      },
      // Each module gets a worker of its own from the isolated-worker kernel:
      // spawned by the sandboxed frame, opaque origin, `default-src 'none'`.
      // A mod is spawned while the session boots, when the spawner frame may
      // not have committed yet: the spawn waits on the control port for it,
      // so the acknowledgement is given the frame's own deadline on top.
      openWorker: plugin =>
        openInstance({
          kind: MOD_WORKER_KIND,
          init: { plugin },
          label: `mod ${plugin}`,
          // DevTools lists it as `nexus-mod: <plugin>`.
          name: plugin,
          spawnAckTimeoutMs: SANDBOX_READY_TIMEOUT_MS + KERNEL_SPAWN_ACK_TIMEOUT_MS,
        }),
      session: {
        id: () => resolvedSessionId,
        cwd: () => resolvedCwd,
        root: () => resolvedProjectRoot,
        // `$.session.model` / `.turns`: the engine's, bound late like `tools`.
        model: () => modEngine('$.session.model').getCurrentModel(),
        turns: () => modEngine('$.session.turns').countUserTurns(),
        // "The version of the engine the session runs on": Velloc's runtime
        // has no upstream release number, so `base` is absent — "the version is
        // not spelled as a release" — and a mod reads `velloc/` to know.
        version: () => ({
          version: `velloc/${NEXUS_INTERFACE_VERSION}`,
          ...(getBuildTime() ? { builtAt: getBuildTime() } : {}),
        }),
        repo: () => readSessionRepo(installedFs, resolvedCwd),
        // `$.fs`: the session's fs bridge, trusted as a settings
        // command hook is, under the untrusted-session read
        // boundary when this session has one.
        fs: fileModFs(installedFs, {
          cwd: resolvedCwd,
          ...(homeDir ? { homeDir } : {}),
          ...((resolvedOptions as { untrustedReadRoot?: string }).untrustedReadRoot
            ? { readRoot: (resolvedOptions as { untrustedReadRoot?: string }).untrustedReadRoot as string }
            : {}),
          ...(typeof options.sessionStoragePath === 'string' && options.sessionStoragePath.length > 0
            ? { sessionStoragePath: options.sessionStoragePath }
            : {}),
        }),
        // `$.process.run`: the hosted Bash tool with its hook fields,
        // the route a settings `command` hook takes (`hookCommandRunner.ts`):
        // trusted as that hook is. A host without the
        // `browser` capability (a mock host) cannot run commands: absent.
        ...(hostBridge.supportsBridgeCapability('browser')
          ? {
              process: hostModProcess(
                async ({ command, shell, stdin, env, timeoutMs, cwd }) => {
                  const raw = (await hostBridge.browser.callTool({
                    name: SHELL_TOOL_ID,
                    args: {
                      command,
                      hook_shell: shell,
                      hook_stdin: stdin,
                      hook_env: Object.keys(env).length > 0 ? JSON.stringify(env) : '',
                      timeout: timeoutMs,
                      // The host's session cwd may not be pushed yet.
                      ...(cwd ? { cwd } : {}),
                    },
                    executionContext: { sessionId: resolvedSessionId },
                  })) as { output?: unknown; exit_code?: unknown; data?: { output?: unknown; exit_code?: unknown } } | undefined
                  const body = raw?.data && typeof raw.data === 'object' ? raw.data : raw
                  return {
                    output: typeof body?.output === 'string' ? body.output : '',
                    exitCode: typeof body?.exit_code === 'number' ? body.exit_code : 0,
                  }
                },
                {
                  cwd: resolvedCwd,
                  // `$.process.spawn` (4c): a streaming child through
                  // `shell.spawn`'s shell form. Its output events arrive at
                  // any time, and a session's scoped transport forwards
                  // events only while the session has a request in flight —
                  // so the child is spawned on the runtime's host port, as
                  // the MCP stdio servers are (`mcp/mcpHost.ts`); the session
                  // transport is the fallback where there is no manager.
                  // The mods' unload kills it (`ModInstance.dispose`).
                  ...(hostBridge.supportsBridgeCapability('shell')
                    ? {
                        spawnStream: (spec, handlers) => {
                          const host = getMcpHost()
                          const primitives = host
                            ? createNativePrimitives({
                                transport: host.transport,
                                createRequestId: () => runtimeConfig.createUUID(),
                                manifest: host.manifest ?? resolvedOptions.hostManifest,
                              })
                            : hostBridge.primitives
                          return primitives.shell.spawnShellStream(spec, handlers)
                        },
                      }
                    : {}),
                },
              ),
            }
          : {}),
        // `$.http.fetch`: the bridge's `network.httpRequest`, under the
        // C++ egress policy (publicly routable hosts only) and the user's
        // WebFetch deny rules, read when the call is made. No prompt.
        // Not gated on the manifest: the host registers
        // `network` on every port without advertising it (WebFetch's route
        // too); a binary older than `httpRequest` rejects the call by name.
        ...(hostBridge.network.httpRequest
          ? {
              http: hostModHttp({
                request: (request, o) => hostBridge.network.httpRequest!(request, o),
                denyRules: () => coreState.getAppState().permissionRules.denyRuleBook,
              }),
            }
          : {}),
        // `$.config` (plan item 7): the enabled plugins' `userConfig` rows,
        // built as the `/config` listing builds them, over settings.json
        // `pluginConfigs`; a write stores the option under the plugin's id
        // and every session's plugins reload with it — as the Settings
        // form's save does. Nothing stored → no reload and no write.
        ...(settingsHomeDir
          ? {
              config: {
                rows: async () => pluginConfigRows(modPlugins, await readPluginConfigs()),
                write: modConfigWrite({
                  store: async (row, value) => {
                    const { setPluginOption } = await import('../../pluginHost/pluginConfigs')
                    return setPluginOption({ homeDir: settingsHomeDir }, installedFs, row.pluginId, row.field, value)
                  },
                  reload: () =>
                    options.reloadPluginsOnAllSessions
                      ? options.reloadPluginsOnAllSessions()
                      : engineForMods?.refreshPluginSet(),
                  report: reportMods,
                }),
              },
            }
          : {}),
        // `$.settings.read`: Velloc reads ONE settings.json (the user's); the
        // merge and the `user` source are the same object, the other sources
        // are empty.
        settings: async ({ source }) => {
          if (source !== undefined && source !== 'user') return {}
          if (!settingsHomeDir) return {}
          const { settings } = await readUserLayer(settingsHomeDir, installedFs)
          return settings
        },
        ...(modsDir
          ? { store: (plugin: string) => fileModStore(modsDir, plugin, modStoreFs, { report: reportMods }) }
          : {}),
        // `$.tool`: served by the engine, which is built just below. A hook
        // may run before it is (`session.start`): a registration then waits
        // for it (`registerOnEngine`); the other calls say "not yet".
        // `$.model`: the engine's completions, bound late like `tools`.
        // `$.agent`: the engine's agent types and subagents, bound late.
        agents: {
          register: (spec, plugin) =>
            registerOnEngine('agent', plugin, engine => engine.modAgents.register(spec, plugin), modAgentFullName(plugin, spec.name), reportMods),
          forget: plugin => forgetOnEngine('agent', plugin, engine => engine.modAgents.forget(plugin)),
          list: () => modEngine('$.agent').modAgents.list(),
          // `$.ui.view`'s lookup: no agent to find before the engine binds.
          viewTarget: agentId => engineForMods?.modAgents.viewTarget?.(agentId),
          spawn: (args, raise) => modEngine('$.agent').modAgents.spawn(args, raise),
        },
        // `$.prompt.submit`: `prompt.submit` raised by the slot's mod
        // runtime with the caller's context, core the worker's turn queue;
        // `$.prompt.compose`: the engine's render, bound late like `tools`.
        prompt: {
          submit: (args, raise) => {
            const enqueue = options.enqueuePluginTurn
            if (!mods || !enqueue) {
              const error = new Error('$.prompt.submit is not available: this session queues no turns from plugins')
              error.name = 'NotSupportedError'
              return Promise.reject(error)
            }
            return mods.pluginSubmit(args, enqueue, raise)
          },
          compose: (args, raise) => modEngine('$.prompt.compose').modPrompt.compose(args, raise),
        },
        // `$.session.messages` / `.usage`: the engine's transcript,
        // bound late like `tools`.
        transcript: {
          rows: () => modEngine('$.session.messages').modTranscript.rows(),
          agentRows: agentId => modEngine('$.session.messages').modTranscript.agentRows(agentId),
          usage: () => modEngine('$.session.usage').modTranscript.usage(),
          breakdown: args => modEngine('$.session.usage').modTranscript.breakdown(args),
        },
        // `$.session.compact` / `.send` / `.append`: the engine raises
        // each event with the caller's context; bound late like `tools`.
        conversation: {
          compact: (args, raise) => modEngine('$.session.compact').modConversation.compact(args, raise),
          send: (args, raise) => modEngine('$.session.send').modConversation.send(args, raise),
          append: (args, raise) => modEngine('$.session.append').modConversation.append(args, raise),
        },
        // `$.mcp`: the process's MCP pool, trusted (F-25) —
        // no permission prompt. A type that takes no MCP (`safe_code`) takes
        // none here either: absent, so the noun is refused by name.
        ...(allowsMcp
          ? {
              mcp: poolModMcp({
                pool: () => mcpPool,
                manifestServer: (plugin, key) => {
                  const owner = modPlugins.find(candidate => candidate.name === plugin)
                  return owner
                    ? pluginMcpServer(owner, key, { getEnv: name => runtimeConfig.getEnv(name), configs: mcpPluginConfigs, providers: mcpProviderKeys })
                    : undefined
                },
              }),
            }
          : {}),
        completions: {
          complete: (request, options) => modEngine('$.model').modModel.complete(request, options),
          fork: (request, options) => modEngine('$.model').modModel.fork(request, options),
          fastModel: () => modEngine('$.model').modModel.fastModel(),
        },
        tools: {
          list: () => modToolHost().list(),
          call: (input, raise) => modToolHost().call(input, raise),
          check: (input, raise) => modToolHost().check(input, raise),
          register: (spec, plugin) =>
            registerOnEngine('tool', plugin, engine => engine.modTools.register!(spec, plugin), modToolFullName(plugin, spec.name), reportMods),
          forget: plugin => forgetOnEngine('tool', plugin, engine => engine.modTools.forget?.(plugin)),
        },
        // `$.turn.abort`: the engine's running turn, bound late like `tools`.
        turn: {
          abort: turnId => modEngine('$.turn.abort').abortTurn(turnId),
        },
        // `$.ui.notify`: the session's `Notification` hooks; "unbound or
        // exiting, none" run.
        notifications: {
          runHooks: async (notice, context) => {
            await engineForMods?.runNotificationHooks({
              message: notice.message,
              title: notice.title,
              notificationType: PLUGIN_NOTIFICATION_TYPE,
              raisedBy: context,
            })
          },
        },
      },
      report: reportMods,
      // What became of each module is runtime STATE the UI reads
      // (`mods/state`): the slot registry fans the change out to the hub.
      onStatusChanged: () => noteModSlotChanged(resolvedSessionId),
      // A registered command changes the picker's list, which rides the
      // worker snapshot: the same fan-out republishes it.
      onCommandsChanged: () => noteModSlotChanged(resolvedSessionId),
      // A mod's status line, notice or toast: `mods/ui/<sessionId>`, through
      // the same registry.
      onUiChanged: event => noteModUiEvent(resolvedSessionId, event),
      // `$.prompt.read` / `.fill` / `.suggest`: the page's box, the
      // interactive session's alone.
      ...(options.drawsComposer ? { drawsComposer: true } : {}),
      // `$.ui.copy`'s first path: the OS clipboard from the browser process,
      // which needs no focus and no gesture. A failure (an older host's
      // NOT_IMPLEMENTED included) leaves the copy to the page's paths.
      ...(hostBridge.supportsBridgeCapability('ui')
        ? {
            clipboard: {
              write: (text: string) =>
                hostBridge.ui.writeClipboard({ text }).then(
                  result => result?.ok === true,
                  () => false,
                ),
            },
          }
        : {}),
      // `$.audio`: played by the newest Velloc window of the kernel's pool.
      audio: createWindowAudioPlayer(),
      // `$.command.list`: the engine's own commands as the picker lists them
      // — built-ins (their English description) and the user-invocable skills.
      engineCommands: () => [
        ...supportedSlashCommands.map(name => ({
          name,
          description: renderPartsEnglish([
            key(BUILTIN_SLASH_COMMAND_DESCRIPTION_KEYS[name as BrowserSlashCommand] ?? 'slash.builtin.help'),
          ]),
          source: 'builtin' as const,
        })),
        ...(coreState.options.commands ?? [])
          .filter(command => command.type === 'prompt' && command.userCallable !== false)
          .map(command => ({
            name: command.name,
            description: command.description ?? '',
            source: (command.source === 'plugin' ? 'plugin' : 'user') as 'plugin' | 'user',
            ...(command.source === 'plugin' && command.loadedFrom ? {} : {}),
          })),
      ],
    })
    // Announce the slot, so the loops this session starts (sub-agents,
    // teammates) raise their tool calls here (mods/modSlotRegistry.ts).
    unregisterSlot = registerModSlot(
      resolvedSessionId,
      Object.assign(modRuntime, { uiState: () => modRuntime.uiSnapshot() }),
    )
    unregisterModSlot = unregisterSlot
    undoWhenScopeEnds(unregisterSlot, options.runtimeScopeSignal)
    // The slot is gone when its runtime scope is: `session.end` for the mods
    // (bounded — it cannot hold the teardown), then leave the chain and close
    // the workers.
    if (options.runtimeScopeSignal?.aborted) modRuntime.dispose()
    else {
      options.runtimeScopeSignal?.addEventListener('abort', () => {
        void modRuntime.end('other')
      })
    }
    return modRuntime
  }
  if (modModules.length > 0) mods = await buildModRuntime(modModules)
  /**
   * Reconcile the slot's mods after a plugin reload: unload removed modules, load added ones with
   * their own `session.start`. Serialized, or concurrent reloads orphan a runtime.
   */
  let reconcilingMods: Promise<void> = Promise.resolve()
  const reconcileMods = (plugins: typeof pluginContributions.plugins): Promise<void> => {
    const run = reconcilingMods.then(() => reconcileModsNow(plugins))
    reconcilingMods = run.catch(() => undefined)
    return run
  }
  const reconcileModsNow = async (plugins: typeof pluginContributions.plugins): Promise<void> => {
    modPlugins = plugins
    // Unloaded while idle: a plugin reload keeps the slot empty until a
    // client comes back (or a message arrives) and loads them again.
    const next = modIdle?.isUnloaded()
      ? []
      : selectModModules(modSlotFacts, plugins, await readPluginConfigs(), await readEnabledPlugins())
    if (mods) {
      if (next.length > 0) {
        await mods.reconcile(next)
        return
      }
      const ending = mods
      mods = undefined
      unregisterModSlot?.()
      unregisterModSlot = undefined
      engineForMods?.setMods(undefined)
      await ending.end('other')
      return
    }
    if (next.length === 0) return
    mods = await buildModRuntime(next)
    engineForMods?.setMods(mods)
  }
  /**
   * The idle unload (mods/modIdleUnload.ts): a session no client has attached
   * to for a while and that never ran in this process gives its mods back;
   * an attach or a submitted message loads them again. Every slot that may
   * carry mods has one, whether or not it has any now — a plugin enabled
   * later is held to the same rule. Not a headless run: no client ever
   * attaches to one, and it runs at once.
   */
  const modIdle: ModIdleUnload | undefined = isModSlot(modSlotFacts) && !isHeadlessSession
    ? createModIdleUnload({
        rosterSize: () => modRoster(resolvedSessionId).length,
        watchRoster: watcher => watchModRoster(resolvedSessionId, watcher),
        isBusy: () => mods?.isBusy() ?? false,
        unload: () => reconcileMods(modPlugins),
        load: () => reconcileMods(modPlugins),
      })
    : undefined
  if (modIdle) undoWhenScopeEnds(() => modIdle.dispose(), options.runtimeScopeSignal)

  // A loop UNDER a slot — a sub-agent; a teammate only while it has no
  // runtime of its own (no module selected) — has no mod runtime, but its tool
  // calls are the slot's `tool.call` events, carrying its id as `agentId`.
  // Resolved at each call: with no slot above it (or none any more) its tools
  // run exactly as without mods. A sub-agent of a teammate finds the
  // teammate's own slot first.
  const modParentSessionId =
    (resolvedOptions as { modParentSessionId?: string }).modParentSessionId ??
    (isTeammateSession
      ? (resolvedOptions as { spawnerSessionId?: string }).spawnerSessionId
      : undefined)
  let agentLoopMods: AgentLoopMods | undefined
  if (!mods && modParentSessionId && !isHeadlessSession) {
    const unlink = linkModChild(resolvedSessionId, modParentSessionId)
    undoWhenScopeEnds(unlink, options.runtimeScopeSignal)
    agentLoopMods = modsForAgentLoop(
      resolvedSessionId,
      // "For a subagent or a teammate, the id `$.agent.list()` gives it": a
      // sub-agent's sidechain id, a teammate's session id.
      resolvedSessionId.startsWith('subagent-')
        ? resolvedSessionId.slice('subagent-'.length)
        : resolvedSessionId,
    )
  }

  const engine = new ConversationEngine({
    cwd: coreState.options.cwd,
    projectRoot: coreState.options.projectRoot!,
    // Bridge-resolved home (worker env has no HOME). Drives the
    // home-anchored memory layout: a bound project's memory lands at
    // `<configHome>/projects/<slug>/memory/`, not inside the user's repo.
    homeDir,
    memorySettings: resolvedMemory,
    tools: coreState.tools,
    commands: coreState.options.commands ?? [],
    mcpClients: (coreState.options.mcpClients ?? []) as [],
    agents: (coreState.options.agents ?? []) as [],
    plugins: pluginContributions.plugins.map(plugin => ({
      name: plugin.name,
      description: plugin.manifest.description,
    })),
    onReloadPlugins,
    ...(mods
      ? { mods }
      : agentLoopMods
        ? {
            // The parent slot's tool and model-request seams, raised with
            // this loop's `agentId`; prompts enter as given.
            mods: agentLoopExtensions(agentLoopMods, agentLoopMods.agentId),
          }
        : {}),
    // The tools this session's mods register, for the loops under it.
    onModToolsChanged: registered => publishModSlotTools(resolvedSessionId, registered),
    // `/mcp` jumps to the host MCP settings page via the `ui.openNexusSettings`
    // bridge action (declared in api/declarations/ui/openNexusSettings.api.json).
    // The worker transport reaches `ui.*` routes (same path the session-state
    // broadcasts use); the host handler is profile-scoped, so it opens the
    // settings surface in the active window regardless of caller connection.
    onOpenSettings: async (section: string) => {
      await openNexusSettings(
        options.bridgeTransport,
        (section as NexusSettingsSection) || 'models',
      )
    },
    decidePermission:
      coreState.options.canUseTool ??
      (async () => ({
        behavior: 'allow',
      })),
    requestToolUseConfirm: coreState.options.requestToolUseConfirm,
    readAppState: coreState.getAppState,
    writeAppState: coreState.setAppState,
    seedTranscript: coreState.initialMessages,
    fileReadSeed: coreState.readFileCache,
    promptOverride: coreState.options.customSystemPrompt,
    promptSuffix: effectiveAppendSystemPrompt,
    // Per-session agent template (resolved once at the top of this fn so the
    // prompt skeleton + tool config come from the SAME template). Defaults to
    // 'chat' — byte-identical to the legacy path.
    templateType,
    // Messaging only — the denied skills are already absent from `commands`.
    deniedSkillNames,
    userSpecifiedProviderId: coreState.options.userSpecifiedProviderId,
    // Teammate identity — the team tools' "which list / which sender am I".
    // Named explicitly because this options object is an allowlist, not a
    // spread: without these three a real teammate's tool context carried
    // none of them, so its task list resolved to a private empty one and the
    // untrusted-write confinement never fired.
    teamName: (resolvedOptions as { teamName?: string }).teamName,
    peerName: (resolvedOptions as { teammateName?: string }).teammateName,
    spawnerSessionId: (resolvedOptions as { spawnerSessionId?: string })
      .spawnerSessionId,
    // Untrusted-provider read boundary + the storage tree it excludes. Both
    // ride the init payload; `undefined` on every session that is not a child
    // on an untrusted provider, which is what makes the boundary a no-op
    // everywhere else.
    untrustedReadRoot: (
      resolvedOptions as { untrustedReadRoot?: string }
    ).untrustedReadRoot,
    // The root of the whole session-storage tree, NOT this session's own
    // directory: the boundary excludes it so an untrusted child cannot read
    // sibling sessions' transcripts (its own dir alone would exclude nothing
    // that matters). Derived from homeDir, since `options.sessionStoragePath`
    // is the session's base and for a teammate is nested deeper still.
    // `settingsHomeDir` is the already-caught resolution: `settingsHome()`
    // THROWS when no home resolves, which failed the whole build here instead
    // of taking the fallback below.
    sessionStoragePath: settingsHomeDir
      ? projectsHome(settingsHomeDir)
      : typeof options.sessionStoragePath === 'string'
        ? options.sessionStoragePath
        : undefined,
    // ...and THIS session's own routed base, which is what the per-session
    // paths (scratch/, tasks/, supershell/) must hang off: for a teammate or a
    // background sub-agent it is nested under the parent and cannot be
    // re-derived from `projectRoot` (`resolveSessionStorageBase`).
    sessionStorageBase:
      typeof options.sessionStoragePath === 'string' &&
      options.sessionStoragePath.length > 0
        ? options.sessionStoragePath
        : undefined,
    pickedModel: coreState.options.userSpecifiedModel,
    userSpecifiedThinkingTier: coreState.options.userSpecifiedThinkingTier,
    backupModel: coreState.options.fallbackModel,
    maxTurns: mainSessionMaxTurns,
    spendCapUsd: coreState.options.maxBudgetUsd,
    taskBudget: coreState.options.taskBudget,
    agentLoopSettings: coreState.options.agentLoopSettings,
    platformCapabilities: coreState.hostBridge,
    queryRuntimeDeps: coreState.queryRuntimeDeps,
    promptContextProvider: coreState.promptContextProvider,
    conversationStore: coreState.conversationStore,
    userInputPipeline: coreState.userInputPipeline,
    systemInitEmitter: coreState.systemInitEmitter,
    runtimeConfig: coreState.runtimeConfig,
    isSubAgent: options.isSubAgent === true,
    fileSnapshotRecorder: coreState.fileSnapshotRecorder,
    // THIS runtime's own fs — the same instance installed into the shared
    // module slot above. Context-published so tools that must survive a
    // sibling runtime clobbering/disposing that slot (SuperEdit's commit)
    // resolve the scope-correct implementation.
    fsOperations: coreState.installedFs,
    // ...and the sidechain store built over that fs, for the same reason:
    // fork call sites (SpawnAgentTool, forked skills, agent hooks) must not read
    // the realm-shared active-store slot.
    sidechainStore: coreState.installedSidechainStore,
    runtimeScopeSignal: options.runtimeScopeSignal,
    hasPendingInjectMessages: options.hasPendingInjectMessages,
  })
  engineForMods = engine
  for (const entry of earlyRegistrations.splice(0)) entry.apply(engine)
  undoWhenScopeEnds(() => publishModSlotTools(resolvedSessionId, []), options.runtimeScopeSignal)
  // A loop under a slot lists the tools the slot's mods registered, scoped
  // as its own tools are (none for a type that takes no MCP tools); its call
  // of one is the slot's `tool.call` (F-25).
  if (agentLoopMods && allowsMcp) {
    const inheritSlotTools = () => {
      const registered = [...modSlotToolsFor(resolvedSessionId)]
      engine.inheritModTools(
        subAgentScope.forkExactTools
          ? registered
          : applySubAgentToolScope(
              registered,
              subAgentScope.subAgentAllowTools,
              subAgentScope.subAgentDisallowTools,
              subAgentScope.isSubAgent === true,
            ),
      )
    }
    inheritSlotTools()
    undoWhenScopeEnds(onModSlotToolsChanged(inheritSlotTools), options.runtimeScopeSignal)
  }
  if (modIdle) {
    engine.setOnSubmit(() => {
      const arriving = modIdle.noteRan()
      if (arriving) engine.waitForMods(arriving)
    })
  }

  // Main UI sessions use a fixed high max-turn cap (10000) so they never
  // practically run out of steps. Sub-agents keep their explicit caps (e.g.
  // SpawnAgentTool foreground forks at 25 turns) so runaway background work remains
  // bounded. For backward compatibility, an old persisted `agent.maxTurns`
  // override is still applied to sub-agent runtimes only.
  //
  // Failure is non-fatal — if settings.json is missing, malformed, or
  // the file read errors out, the engine keeps the constructor values.
  try {
    const homeDir = settingsHome()
    const { settings } = await readUserLayer(homeDir, installedFs)
    const agent = settings.agent
    // Restore the persisted `/debug name` product-name override. Module
    // state in this realm is lost on worker restart; settings.json is the
    // source of truth (absent key ⇒ build brand), so assign unconditionally
    // rather than only-when-present — a cleared key must also clear a stale
    // in-memory override.
    setProductNameOverride(agent?.productNameOverride)
    // Internal-user mode (`/debug internal`) is EXTERNAL unless settings.json
    // says otherwise. Applied only when the persisted value CHANGED since the
    // last boot applied it: every runtime boot (each background sub-agent
    // included) runs this, and an unconditional assign reverted an unsaved
    // `/debug internal` flip at the next agent spawn.
    applyPersistedInternalUser(agent?.internalUser === true)
    if (options.isSubAgent === true && agent && agent.maxTurns !== undefined) {
      engine.applyRuntimeSettings({ maxTurns: agent.maxTurns })
    }
  } catch (e) {
    console.warn(
      `[createBrowserRuntime] agent settings overlay skipped: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  // The composer's "until auto-compact" figure reads the reader without I/O;
  // load it before the runtime is handed out so the first snapshot already
  // reflects settings.json, not the model's own window.
  await autoCompactWindows.load()

  return {
    ...coreState,
    engine,
  }
}

// --- Compat aliases (PR 1A: AgentRuntime naming migration) ---

/** @deprecated Use createAgentRuntime. */
export const createAgentRuntime = createBrowserRuntime

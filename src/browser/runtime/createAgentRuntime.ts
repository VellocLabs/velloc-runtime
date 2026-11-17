import { ConversationEngine } from '../../engine/conversationEngine'
import { getToolsForHostManifestOrPreset } from '../../toolkit/toolRegistry'
import { BrowserHostBridge } from '../bridge/BrowserHostBridge'
import { BrowserRuntimeConfig } from '../../config/BrowserRuntimeConfig'
import {
  loadLocalPromptCommands,
  partitionSkillsForSession,
} from '../../skillLibrary/skillDiscovery'
import { BrowserPromptContextProvider } from '../../engine/systemPromptSources'
import { buildTeammatePromptAddendum } from '../../team/teammateBrief'
import { subAgentLoopId } from '../../team/subAgentController'
import type { PermissionSettingsBySource } from '../../permissions/seedPermissionContext'
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
import {
  readLayer,
  loadPermissionSettingsBySource,
  resolveSettingsHomeDir,
} from '../../settings/settingsStore'
import { MERGE_SOURCE_ORDER } from '../../settings/settingsStore'
import {
  UNTRUSTED_CHILD_MEMORY_SETTINGS,
  resolveMemorySettings,
} from '../../memory/resolveMemorySettings'
import type { ResolvedMemorySettings } from '../../memory/memoryPaths'
import { checkNotesDir } from '../../memory/memoryPaths'
import { createBrowserFsOperations } from '../../utils/BrowserFsOperations'
import { openNexusSettings } from '../webview/nexusBridgeActions'
import type { NexusSettingsSection } from '../bridge/browserBridgeProtocol'
import type { BrowserRuntimeState } from './AgentRuntimeState'
import {
  createBrowserReadFileCache,
  createInitialBrowserAppState,
} from './AgentRuntimeState'
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
import {
  applyTemplateToolAllowlist,
  getTemplate,
  resolveDeferrableSkills,
  templateListedToolNames,
  templateWantsFileSnapshots,
  unresolvedAgentNames,
  unresolvedSkillIds,
  templateWantsWorkspaceDiffTool,
} from '../../prompting/templateRegistry'
import { SessionSnapshotStore } from '../../sessions/fileSnapshots/snapshotStore'
import { FileSnapshotRecorder } from '../../sessions/fileSnapshots/snapshotRecorder'
import { WorkspaceDiffTool } from '../../toolkit/builtin/workspaceDiff'
import { isPluginTemplateId } from '../../mods/ui/uiManifest'
import type { AppTemplate } from '../../mods/ui/contributionsHost'
import { runtimeProviderGate } from '../../pluginHost/providerGate'
import { registerDeferrableSkills } from '../../toolkit/run/deferredTools'
import { isToolGroup } from '../../toolkit/builtin/toolGroups'
import { filterSubAgentTools } from '../../agents/subAgentToolScope'
import { registerSkillCatalog } from '../../toolkit/run/skillCatalogs'
import type { HostedSkillDefinition } from '../bridge/protocol/manifest'
import type { ChromiumPromptCommand } from '../../runtime/CommandTypes'
import type { Message } from '../../runtime/RuntimeTypes'
import {
  createAutoCompactWindowSettings,
} from '../../context/compaction/windowSettings'
import {
  isMcpSessionTool,
  mcpServerInstructionsFromPool,
  mcpServerFailuresFromPool,
  mcpSessionOffering,
  builtinMcpOffering,
  registerBundledBuiltinMcpServers,
  withBuiltinMcpOffering,
  type McpSessionOffering,
} from '../../mcp'
import { modToolsInScope } from '../../mcp/sessionMcpScope'
import { getMcpHost } from '../../mcp/mcpHost'
import { createNativePrimitives } from '../bridge/nativePrimitives'
import { loadLocalAgents } from '../../agents/agentRegistry'
import { withBuiltInAgents } from '../../agents/builtInAgents'
import { loadPluginContributions } from '../../pluginHost'
import { storePluginSecrets } from '../../pluginHost/pluginMcpUserConfig'
import { openSessionMcpPool } from './sessionMcpPool'
import { openSessionModSlot } from './sessionModSlot'
import { createPluginReload } from './sessionPluginReload'
import { registerSessionMemoryJobs } from './sessionMemoryJobs'
import { loadMarketplaceDiscovery, rescanSessionPlugins } from './sessionPluginDiscovery'
import {
  applyAgentSettingsOverlay,
  buildSettingsPromptSuffix,
  seedSessionModelSettings,
} from './sessionSettingsOverlays'
import { assembleSessionTurnDependencies } from './sessionTurnDependencies'
import type { CreateBrowserRuntimeOptions } from './createAgentRuntimeOptions'
import { dirnameRuntimePath } from '../../utils/runtimePaths'
import {
  linkModChild,
  modSlotToolsFor,
  onModSlotToolsChanged,
  publishModSlotTools,
  modsForAgentLoop,
  takeDevModFaults,
  undoWhenScopeEnds,
  type AgentLoopMods,
} from '../../mods/modSlotRegistry'
import { modFaultsAttachmentOf } from '../../mods/modFault'
import { registerSessionWorkingDir } from '../../models/drivers/sessionWorkingDirs'
import { createBridgeBackedFetch } from '../../pluginHost/bridgeBackedFetch'
import { loadEffectiveEnabledPlugins } from '../../pluginHost/enabledStore'
import { registerPluginHooks } from '../../pluginHost/registerPluginHooks'
import { describePluginError } from '../../pluginHost/pluginModel'
import { registerSettingsHooks } from '../../lifecycleHooks/registerSettingsHooks'
import { A2UI_HOSTED_SKILL } from '../../toolkit/builtin/a2ui/a2uiSkill'
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

/** The project's session-storage dir: a sub-agent's path is `<project>/<parent>/subagents`. */
function sessionStorageRootOf(sessionStoragePath: string, isSubAgent: boolean): string {
  return isSubAgent
    ? dirnameRuntimePath(dirnameRuntimePath(sessionStoragePath))
    : sessionStoragePath
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
  let pluginRequiresProjectFolder = false
  let pluginApp: AppTemplate | undefined
  if (isPluginTemplateId(templateType)) {
    const { openPluginTemplate } = await import('../../mods/ui/pluginTemplateSession')
    const opened = await openPluginTemplate(templateType)
    pluginTemplateOwner = opened.owner
    pluginRequiresProjectFolder = opened.requiresProjectFolder
    pluginApp = opened.app
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
  // This session's dev-folder mod failures, handed to the model once (F-25).
  const takeModFaults = () => modFaultsAttachmentOf(takeDevModFaults(resolvedSessionId))

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
  // An app session works in its own seeded folder, whatever folder it was given (F-40).
  const appSession = pluginApp
    ? await (await import('../../mods/app/appSession')).openAppFolder({ fs: installedFs, homeDir, app: pluginApp })
    : undefined
  // An app's agent run (F-40) is headless: it has no surface, and keeps only the app-run tools.
  const appAgentRun = (options as { appAgentRun?: string }).appAgentRun
  const appSurfaceModule = appSession && options.isSubAgent !== true && !appAgentRun ? await import('../../mods/app/appSurfaceHost') : undefined
  // A superseded build registers nothing: its host would take the session's entry from the newer one.
  const appSurface = appSurfaceModule && appSession && options.runtimeScopeSignal?.aborted !== true
    ? appSurfaceModule.createAppSurfaceHost({ fs: installedFs, app: appSession, sessionId: resolvedSessionId, ...(options.locale !== undefined ? { locale: options.locale } : {}) })
    : undefined
  if (appSurface) undoWhenScopeEnds(() => appSurface.dispose(), options.runtimeScopeSignal)
  void appSurface?.start().catch(error => console.warn('[mods/app] board read failed', error))
  const resolvedProjectRoot = await resolveProjectRoot({
    projectRoot: appSession?.folder ?? options.projectRoot,
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

  // A forced-folder session (`code`/`safe_code`, or a plugin type declared
  // `projectFolder: "required"`) with an absent/invalid `projectRoot` override
  // fell back to the shared sandbox workspace — NOT bound to a real folder. The
  // UI surfaces this (snapshot `needsProjectFolder`, AND-ed with host
  // capability in `getSnapshot`) to force the folder picker; `agent`/`chat` are
  // happy in the sandbox. Computed here, where the RAW override is still
  // visible — once resolved, `options.projectRoot` always points at a valid
  // path (sandbox or bound) and the distinction is lost.
  const requiresProjectFolder =
    isForcedFolderTemplateType(templateType) || pluginRequiresProjectFolder
  const usedSandboxProjectRoot =
    requiresProjectFolder && projectRootIsSandbox(options.projectRoot)

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

  // Memory extraction and background consolidation, with the same sidechain store.
  registerSessionMemoryJobs({
    runtimeConfig,
    installedSidechainStore,
    backend: resolvedOptions.conversationStorageBackend,
    sidechainBasePath,
  })

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

  // File-snapshot recorder (`fileSnapshots: true` templates) in the session dir; one writer per
  // store. A background sub-agent records into its own nested dir (F-6). No storage path ⇒ no
  // recorder and no WorkspaceDiff.
  const fileSnapshotRecorder =
    templateWantsFileSnapshots(sessionTemplate?.config) &&
    typeof options.sessionStoragePath === 'string' &&
    options.sessionStoragePath.length > 0 &&
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
          excludeRoots: [sessionStorageRootOf(options.sessionStoragePath, options.isSubAgent === true)],
          workspaceRoots: [resolvedProjectRoot, resolvedCwd],
          hostCwd: resolvedCwd,
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
  // Marketplace-installed plugins are discovered beside the directory-walk ones; non-fatal.
  const { installRegistry, enabledPluginIdentifiers } = await loadMarketplaceDiscovery(settingsHome, installedFs)
  // Anchored at the project folder, not cwd (`cwdOverride` for a worktree-
  // isolated sub-agent): a project's plugins live in, and are switched by,
  // `<projectRoot>/.velloc/` — the same root `/plugins install` writes and
  // Settings lists.
  // Each plugin's `userConfig` values: settings.json `pluginConfigs`,
  // read once here and again on every plugin reload.
  // Whether the last read found the settings file: only then may storing
  // drop the plugin secrets the load no longer resolves.
  let mcpOptionsFromFile = false
  const readPluginConfigs = async (): Promise<Record<string, { options?: Record<string, unknown> }>> => {
    try {
      const { getPluginConfigsMap, userSettingsReadFromFile } = await import('../../pluginHost/pluginConfigs')
      mcpOptionsFromFile = await userSettingsReadFromFile({ homeDir: settingsHome() }, installedFs)
      return await getPluginConfigsMap({ homeDir: settingsHome() }, installedFs)
    } catch (e) {
      mcpOptionsFromFile = false
      console.warn(`[mods] plugin options skipped: ${e instanceof Error ? e.message : String(e)}`)
      return {}
    }
  }
  // The keys stored for the plugins' own providers (`${provider_key.KEY}`),
  // read alongside the options.
  const readProviderKeys = async (): Promise<import('../../pluginHost/pluginMcpUserConfig').PluginProviderKeysMap> => {
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
  // the pool launches the servers, and again on every plugin reload. Returns
  // the names whose value changed since this runtime last stored them.
  const storedMcpSecretValues = new Map<string, string>()
  const storeMcpSecrets = async (contributions: typeof pluginContributions): Promise<Set<string>> => {
    const { writes, pluginIds } = contributions.mcpSecrets
    const changed = new Set<string>()
    for (const write of writes) {
      const before = storedMcpSecretValues.get(write.name)
      if (before !== undefined && before !== write.value) changed.add(write.name)
    }
    storedMcpSecretValues.clear()
    for (const write of writes) storedMcpSecretValues.set(write.name, write.value)
    if (!hostBridge.supportsBridgeCapability('secrets')) {
      if (writes.length > 0) console.warn('[plugins] this browser stores no secrets; servers taking a sensitive option will not start')
      return changed
    }
    await storePluginSecrets(writes, pluginIds, hostBridge.primitives.secrets, message => console.warn(message), {
      prune: mcpOptionsFromFile,
    })
    return changed
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

  const takeChildReports = options.takeChildReports
  const userInputPipeline = new BrowserUserInputPipeline({
    hostBridge,
    runtimeConfig,
    takeModFaults,
    ...(takeChildReports
      ? { takeChildReports: (opts: { autoContinuation: boolean }) => takeChildReports(resolvedSessionId, opts) }
      : {}),
    supportedSlashCommands,
    pluginLoadResult,
    // `/plugins enable <name>`: the boot discovery again, read off the disk now.
    rescanPlugins: () => rescanSessionPlugins({
      settingsHome,
      installedFs,
      resolvedProjectRoot,
      runtimeConfig,
      homeDir,
      enabledPlugins,
    }),
    // `/plugin` + `/marketplace` resolve `~/.velloc/...` paths; the worker env
    // HOME/USERPROFILE is empty in production (the env-based resolver throws),
    // so thread the bridge-resolved settings home; undefined with no home.
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

  const {
    settingsHomeDir,
    mcpScope,
    allowsMcp,
    mcpLease,
    mcpPool,
    mcpOrigins,
    setPluginNativeServers,
  } = await openSessionMcpPool({
    settingsHome,
    appAgentRun,
    templateType,
    sessionTemplate,
    resolvedOptions,
    runtimeConfig,
    pluginContributions,
    options,
    resolvedSessionId,
    resolvedCwd,
    installedFs,
  })
  // The session's MCP offering (F-10): the pool's connected servers as tool contracts, deferral
  // units, Skill commands and the set of servers offered. Read again after a plugin reload.
  // Built-in servers (F-10) run in this loop and start nothing, so a type that takes nothing from
  // the pool still gets them. A fork keeps its parent's list; its calls are refused by the tools.
  registerBundledBuiltinMcpServers()
  const builtinOffering = builtinMcpOffering({
    templateType,
    nested:
      (options.isSubAgent === true || (resolvedOptions as { isTeammate?: boolean }).isTeammate === true) &&
      (options as { forkExactTools?: boolean }).forkExactTools !== true,
    headless: (options as { isHeadless?: boolean }).isHeadless === true,
  })
  const readMcpOffering = (): McpSessionOffering =>
    withBuiltinMcpOffering(
      allowsMcp ? mcpSessionOffering(mcpPool) : { tools: [], skillNames: [], commands: [], servers: new Set() },
      builtinOffering,
    )
  let mcpOffering = readMcpOffering()
  // Deferrable skills: the template's `deferredTools` decides which defer by default; MCP servers defer
  // by default.
  const deferrableSkills = resolveDeferrableSkills(
    mcpOffering.skillNames,
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
  const listedToolNames = templateListedToolNames(sessionTemplate?.config)
  registerDeferrableSkills(deferrableSkills, runtimeConfig, listedToolNames)
  // JS skill catalogs, emitted only while the skill's tools are visible; registration order is
  // emission order. Browser gates by predicate: its tools are published by the host.
  registerSkillCatalog({
    skillName: BROWSER_SKILL_NAME,
    toolNames: [],
    matchesToolName: isBrowserToolName,
    holderName: BROWSER_CATALOG_HOLDER,
    content: BROWSER_SYSTEM_PROMPT_CATALOG,
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
    ...mcpOffering.commands,
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
  // The same stage for `agents:`: a listed name no agent of the roster bears.
  const reportUnresolvedAgents = (roster: readonly { name?: unknown }[]) => {
    const unresolved = unresolvedAgentNames(sessionTemplate?.config, roster)
    if (unresolved.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[createAgentRuntime] template "${templateType}" offers agents that are ` +
          `not loaded in this session: ${unresolved.join(', ')}. They grant ` +
          'nothing; remove them from `agents:` or install the agent.',
      )
    }
  }
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
  // The servers whose tools this runtime's list holds. A plugin reload re-reads the pool
  // (`refreshMcpOffering`), so a server a plugin brings or takes mid-session follows.
  const mcpServersOffered = new Set(mcpOffering.servers)
  // An app session builds its entry file with BuildApp, past the template's allowlist.
  const appTools = appSurface ? [appSurface.tool] : []
  const allTools = [...baseTools, ...snapshotTools, ...appTools, ...mcpOffering.tools]
  // After a plugin reload: the engine's MCP tools, the deferral units, the Skill commands and the
  // offered set follow the pool, so the prompt, the tool list and the server views agree.
  const refreshMcpOffering = (): McpSessionOffering => {
    mcpOffering = readMcpOffering()
    registerDeferrableSkills(
      resolveDeferrableSkills(mcpOffering.skillNames, sessionTemplate?.config),
      runtimeConfig,
      listedToolNames,
    )
    mcpServersOffered.clear()
    for (const name of mcpOffering.servers) mcpServersOffered.add(name)
    engine.replaceTools(isMcpSessionTool, mcpOffering.tools)
    return mcpOffering
  }
  // A stdio server `$.mcp.connect` launched mid-session (F-25): the offering and the
  // `mcp__<server>` Skill commands follow the pool, as after a plugin reload.
  const offerLaunchedMcpServer = (): void => {
    const previous = new Set(mcpOffering.commands.map(command => command.name))
    refreshMcpOffering()
    const kept = (coreState.options.commands ?? []).filter(command => !previous.has(command.name))
    coreState.options.commands = applySkillAllowlist([...kept, ...mcpOffering.commands]).allowed
  }
  // A server that waited for a sign-in connects with one (F-10): its tools join this session.
  if (mcpLease) undoWhenScopeEnds(mcpPool.onServersAuthorized(offerLaunchedMcpServer), options.runtimeScopeSignal)
  // A background FORK keeps the parent's EXACT tool pool (no sub-agent strip),
  // so its serialized tools array stays aligned with the parent's for prompt-
  // cache reuse; a named/general-purpose sub-agent gets the scoped set.
  const scopedTools = subAgentScope.forkExactTools
    ? allTools
    : applySubAgentToolScope(
        allTools,
        subAgentScope.subAgentAllowTools,
        subAgentScope.subAgentDisallowTools,
        subAgentScope.isSubAgent === true,
      )
  const tools = appAgentRun ? (await import('../../mods/app/appRunTools')).appRunTools(scopedTools) : scopedTools
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

  const sessionAgents = withBuiltInAgents(resolvedOptions.agents ?? localAgents)
  reportUnresolvedAgents(sessionAgents)
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
      agents: sessionAgents,
    },
    requiresProjectFolder,
    usedSandboxProjectRoot,
    ...(appSession ? { appSession } : {}),
    runtimeConfig,
    hostBridge,
    conversationStore,
    installedFs,
    installedSidechainStore,
    sessionMcpPool: allowsMcp ? mcpPool : undefined,
    sessionMcpOrigins: allowsMcp ? mcpOrigins : undefined,
    sessionMcpServersOffered: allowsMcp ? mcpServersOffered : undefined,
    promptContextProvider,
    userInputPipeline,
    systemInitEmitter,
    queryRuntimeDeps: options.queryRuntimeDeps ?? assembleSessionTurnDependencies({
      resolvedOptions,
      runtimeConfig,
      autoCompactWindows,
      conversationStore,
      appSurface,
      takeModFaults,
    }),
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

  const onReloadPlugins = createPluginReload({
    options,
    resolvedOptions,
    resolvedProjectRoot,
    resolvedCwd,
    resolvedSessionId,
    installedFs,
    homeDir,
    runtimeConfig,
    settingsHome,
    enabledPlugins,
    templateType,
    sessionTemplate,
    sessionTypeDeniedNames,
    coreState,
    userInputPipeline,
    mcpLease,
    mcpScope,
    mcpPool,
    mcpOrigins,
    setPluginNativeServers,
    refreshMcpOffering,
    storeMcpSecrets,
    refreshPluginConfigs: async () => {
      mcpPluginConfigs = await readPluginConfigs()
      mcpProviderKeys = await readProviderKeys()
      return { pluginConfigs: mcpPluginConfigs, providerKeys: mcpProviderKeys }
    },
    currentAppState: () => appState,
    hostedCommands: () => hostedSkills.map(hostedSkillToCommand),
    mcpCommands: () => mcpOffering.commands,
    applySkillAllowlist,
    reportUnresolvedSkills,
    reportUnresolvedAgents,
    reconcileMods: plugins => reconcileMods(plugins),
    activePluginPaths: pluginContributions.plugins.map(plugin => plugin.path),
  })

  // APPEND the user-context block from the settings `profile` to the system prompt (additive, unlike
  // `customSystemPrompt`). Read once before the engine is built; a read failure is non-fatal.
  let effectiveAppendSystemPrompt = await buildSettingsPromptSuffix({
    coreState,
    settingsHome,
    installedFs,
    permissionSettings,
  })
  if (appSurface) effectiveAppendSystemPrompt = [effectiveAppendSystemPrompt, appSurface.promptBlock].filter(Boolean).join('\n\n')

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

  // Sub-session model routing snapshot; `mods.headless` rides the same read (F-25).
  const headlessMods = await seedSessionModelSettings({ coreState, settingsHome, installedFs })
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

  // A main UI session never practically runs out of steps; a sub-agent keeps its explicit cap so
  // runaway background work stays bounded (a persisted `agent.maxTurns` may override it below).
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
  const modSlot = await openSessionModSlot({
    options,
    appSurface,
    resolvedOptions,
    resolvedSessionId,
    resolvedCwd,
    resolvedProjectRoot,
    templateType,
    homeDir,
    settingsHomeDir,
    settingsHome,
    runtimeConfig,
    hostBridge,
    coreState,
    supportedSlashCommands,
    allowsMcp,
    mcpPool,
    mcpOrigins,
    offerLaunchedMcpServer,
    readPluginConfigs,
    installedFs,
    modSlotFacts,
    isHeadlessSession,
    pluginContributions,
    currentMemory: () => resolvedMemory,
    currentMcpPluginConfigs: () => mcpPluginConfigs,
    currentMcpProviderKeys: () => mcpProviderKeys,
  })
  const { modIdle, reconcileMods } = modSlot

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
  if (!modSlot.mods && modParentSessionId && !isHeadlessSession) {
    const unlink = linkModChild(resolvedSessionId, modParentSessionId)
    undoWhenScopeEnds(unlink, options.runtimeScopeSignal)
    agentLoopMods = modsForAgentLoop(
      resolvedSessionId,
      // A sub-agent's loop id (`$.ui.view` takes it beside the task id), a
      // teammate's session id.
      subAgentLoopId(resolvedSessionId),
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
    mcpServerInstructions: () =>
      mcpServerInstructionsFromPool(mcpPool).filter(entry => mcpServersOffered.has(entry.name)),
    mcpServerFailures: () => (allowsMcp ? mcpServerFailuresFromPool(mcpPool) : []),
    agents: (coreState.options.agents ?? []) as [],
    plugins: pluginContributions.plugins.map(plugin => ({
      name: plugin.name,
      description: plugin.manifest.description,
    })),
    onReloadPlugins,
    ...(modSlot.afterTurnUpkeep ? { afterTurnUpkeep: modSlot.afterTurnUpkeep } : {}),
    ...(modSlot.mods
      ? { mods: modSlot.mods }
      : agentLoopMods
        ? {
            // The parent slot's tool and model-request seams, raised with
            // this loop's `agentId`; prompts enter as given.
            mods: agentLoopExtensions(agentLoopMods, agentLoopMods.agentId),
          }
        : {}),
    // The tools this session's mods register, for the loops under it.
    onModToolsChanged: registered => publishModSlotTools(resolvedSessionId, registered, modSlot.ownSlot),
    // Security: registered tools outside the type's MCP scope are not listed (F-25).
    modToolScope: mcpScope,
    // The sub-agent types the Agent tool offers, when the type names them.
    ...(Array.isArray(sessionTemplate?.config.agents) ? { agentAllowlist: sessionTemplate.config.agents } : {}),
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
    reviewRuntime: { sessionLevel: () => coreState.options.userSpecifiedThinkingTier, spawnArgv: (spec, handlers) => {
      const host = getMcpHost()
      const primitives = host ? createNativePrimitives({ transport: host.transport,
        createRequestId: () => coreState.runtimeConfig.createUUID(), manifest: host.manifest ?? resolvedOptions.hostManifest,
      }) : coreState.hostBridge.primitives
      return primitives.shell.spawnArgvStream(spec, handlers)
    }, httpRequest: coreState.hostBridge.network.httpRequest,
      platformSecret: async origin => {
        const secrets = await coreState.hostBridge.primitives.secrets.listNames('mcp')
        const matching = secrets.filter(secret => secret.origin === origin)
        return matching.length === 1 ? { name: matching[0]!.name, origin } : undefined
      },
      atomicWrite: async (path, content) => {
        const response = await options.bridgeTransport.request({ id: crypto.randomUUID(), route: { namespace: 'nexus', capability: 'fs', action: 'writeFile' }, payload: { path, content: new TextEncoder().encode(content), atomic: true } })
        if (!response.ok) throw new Error(response.error.code)
      }, promptContextProvider: coreState.promptContextProvider },
    // ...and the sidechain store built over that fs, for the same reason:
    // fork call sites (SpawnAgentTool, forked skills, agent hooks) must not read
    // the realm-shared active-store slot.
    sidechainStore: coreState.installedSidechainStore,
    runtimeScopeSignal: options.runtimeScopeSignal,
    hasPendingInjectMessages: options.hasPendingInjectMessages,
  })
  modSlot.bindEngine(engine)
  // A loop under a slot lists the tools the slot's mods registered, scoped
  // as its own tools are (none for a type that takes no MCP tools, its
  // owner's for a plugin-scoped type); its call of one is the slot's
  // `tool.call` (F-25).
  if (agentLoopMods && allowsMcp) {
    const inheritSlotTools = () => {
      const registered = modToolsInScope(modSlotToolsFor(resolvedSessionId), mcpScope)
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

  await applyAgentSettingsOverlay({ settingsHome, installedFs, options, engine })

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

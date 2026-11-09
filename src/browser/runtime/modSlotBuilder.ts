import { SHELL_TOOL_ID } from '../../prompting/processToolNames'
import { readUserLayer } from '../../settings/settingsStore'
import { isMemoryEnabled, resolveMemoryDir } from '../../memory/memoryPaths'
import { getScratchpadDirectoryPath, resolveSessionStorageBase } from '../../utils/conversationStoragePaths'
import { pluginTasksForSession } from '../../mods/modTasks'
import { getMcpHost } from '../../mcp/mcpHost'
import { createNativePrimitives } from '../bridge/nativePrimitives'
import { pluginMcpServer } from '../../pluginHost'
import { traceLine } from '../../utils/debugLog'
import { modConfigWrite, pluginConfigRows } from '../../mods/modConfig'
import { readSessionRepo } from '../../mods/sessionRepo'
import { PLUGIN_NOTIFICATION_TYPE } from '../../mods/modNotify'
import { fileModBuildStore } from '../../mods/modBuildStore'
import { renderPartsEnglish, key } from '../../input/systemMessageParts'
import { BUILTIN_SLASH_COMMAND_DESCRIPTION_KEYS, type BrowserSlashCommand } from '../../input/slashCommandCatalog'
import { RUNTIME_DIR_NAME } from '../../branding/runtimeDir'
import { joinRuntimePath } from '../../utils/runtimePaths'
import { NEXUS_INTERFACE_VERSION } from '../bridge/protocol/interfaceVersion.gen'
import { getBuildTime } from '../../branding/buildInfo'
import { noteModSlotChanged, noteModUiEvent, registerModSlot, undoWhenScopeEnds } from '../../mods/modSlotRegistry'
import type { BrowserRuntimeConfig } from '../../config/BrowserRuntimeConfig'
import type { BrowserHostBridge } from '../bridge/BrowserHostBridge'
import type { ConversationEngine } from '../../engine/conversationEngine'
import type { MCPPool } from '../../mcp/pool'
import type { McpServerOriginSources } from '../../mcp/serverOrigin'
import type { ResolvedMemorySettings } from '../../memory/memoryPaths'
import type { ModRuntime } from '../../mods/ModRuntime'
import type { ModStateStore } from '../../mods/modState'
import type { ModSlot } from '../../mods/modSlotRegistry'
import type { selectModModules } from '../../mods/modSlot'
import type { PluginContributions } from '../../pluginHost'
import type { PluginProviderKeysMap } from '../../pluginHost/pluginMcpUserConfig'
import type { WorkingState } from '../../runtime/RuntimeTypes'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import type { CreateBrowserRuntimeOptions } from './createAgentRuntime'

/**
 * Contract: what one session's runtime lends the slot's mod runtime (F-25).
 * Fixed at boot: the session's identity, folders, config, bridge, MCP pool
 * and the engine-binding helpers. Read when called: the session fs, memory
 * settings, plugin set, engine, current mod runtime and MCP plugin configs.
 * Written by the builder: the slot's shared `$.state`, its announced slot
 * and the registry undo, which the session's reload and teardown read back.
 */
export interface ModSlotHost {
  readonly options: CreateBrowserRuntimeOptions
  /** An app session's board (F-40): told of every `$.fs` write. */
  readonly appSurface?: Pick<import('../../mods/app/appSurfaceHost').AppSurfaceHost, 'noteWrite'>
  readonly resolvedOptions: CreateBrowserRuntimeOptions & { untrustedReadRoot?: string }
  readonly resolvedSessionId: string
  readonly resolvedCwd: string
  readonly resolvedProjectRoot: string
  readonly templateType: string
  readonly homeDir: string | undefined
  readonly settingsHomeDir: string | null
  settingsHome(): string
  readonly runtimeConfig: BrowserRuntimeConfig
  readonly hostBridge: BrowserHostBridge
  readonly coreState: {
    readonly options: { readonly cwd?: string; readonly projectRoot?: string; readonly commands?: CreateBrowserRuntimeOptions['commands'] }
    getAppState(): WorkingState
  }
  readonly supportedSlashCommands: readonly string[]
  readonly allowsMcp: boolean
  readonly mcpPool: MCPPool
  readonly mcpOrigins: McpServerOriginSources
  offerLaunchedMcpServer(): void
  readPluginConfigs(): Promise<Record<string, { options?: Record<string, unknown> }>>
  modEngine(what: string): ConversationEngine
  modToolHost(): ConversationEngine['modTools']
  registerOnEngine(
    kind: 'tool' | 'agent',
    plugin: string,
    apply: (engine: ConversationEngine) => string,
    fullName: string,
    report: (line: string) => void,
  ): string
  forgetOnEngine(kind: 'tool' | 'agent', plugin: string, forget: (engine: ConversationEngine) => void): void
  readonly installedFs: RuntimeFs
  readonly resolvedMemory: ResolvedMemorySettings
  readonly modPlugins: PluginContributions['plugins']
  readonly engineForMods: ConversationEngine | undefined
  readonly mods: ModRuntime | undefined
  readonly mcpPluginConfigs: Record<string, { options?: Record<string, unknown> }>
  readonly mcpProviderKeys: PluginProviderKeysMap
  slotModState: ModStateStore | undefined
  ownSlot: ModSlot | undefined
  unregisterModSlot: (() => void) | undefined
}

/**
 * Build the slot's mod runtime for `modules`, at boot or when a plugin enable
 * gives the session its first module. Registers the slot and ties its end to
 * the session's runtime scope.
 */
export async function buildSlotModRuntime(
  slot: ModSlotHost,
  modules: ReturnType<typeof selectModModules>,
): Promise<ModRuntime> {
  // Narrowed once: the `$.config` and `$.settings` closures below read it.
  const { settingsHomeDir } = slot
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
  slot.slotModState ??= new ModStateStore()
  // `$.store`: `~/.velloc/mods/<plugin>/store.json`. No resolvable home —
  // an in-memory store, which the runtime supplies by default.
  const modsDir = (() => {
    try {
      return joinRuntimePath(slot.settingsHome(), RUNTIME_DIR_NAME, 'mods')
    } catch {
      return undefined
    }
  })()
  const modStoreFs = {
    readFile: (path: string, o: { encoding: string }) => slot.installedFs.readFile(path, o),
    writeFile: (path: string, data: string, o?: { encoding?: string }) =>
      slot.installedFs.writeFile(path, data, o),
    ensureDir: (dir: string) => ensureDirRecursive(slot.installedFs, dir),
  }
  // What each module's last load produced (`modBuildStore.ts`):
  // `~/.velloc/mods/.builds/`, one file per module, replaced at each load —
  // an unchanged module is not read, compiled or scanned again.
  const modBuilds = modsDir
    ? fileModBuildStore(slot.installedFs, modsDir, { ensureDir: dir => ensureDirRecursive(slot.installedFs, dir) })
    : undefined
  // Declared before the runtime so its `dispose` can call it: the registry
  // entry goes with the runtime, not only with the scope's abort.
  let unregisterSlot: (() => void) | undefined
  const modRuntime = new ModRuntime({
    modules,
    // `$.plugin.locale` / `session.start`'s `locale`: the page's language.
    ...(slot.options.locale !== undefined ? { locale: slot.options.locale } : {}),
    onDisposed: () => unregisterSlot?.(),
    // A TypeScript / TSX module, or one that imports: compiled to one
    // module from its graph, read through the session's fs, within the
    // plugin's folder alone.
    compile: (ref, source) =>
      compileModModule({
        entry: ref.path,
        entrySource: source,
        root: ref.root ?? ref.path.replace(/[\\/][^\\/]*[\\/][^\\/]*$/, ''),
        fs: {
          readFile: (path, o) => slot.installedFs.readFile(path, o).then(String),
        },
      }).then(result => ({ source: result.source, files: result.files, uses: result.uses })),
    ...(modBuilds ? { builds: modBuilds } : {}),
    // The scan for a plain module the compiler never sees: the same
    // parser, over its one file.
    scan: (ref, source) => loadTypeScript().then(ts => scanModuleUses(ts, [{ path: ref.path, text: source }])),
    // The dev loop: the module's files are stat'ed at turn end through
    // the fs bridge; a changed one reloads the module.
    // A built-in's text is the registry's: never on disk, never polled.
    statModule: path => (isBuiltinModPath(path) ? Promise.resolve(undefined) : slot.installedFs.stat(path).then(stat => stat.mtimeMs)),
    stateStore: slot.slotModState,
    readModule: async path => {
      if (isBuiltinModPath(path)) {
        const text = readBuiltinMod(path)
        if (text === undefined) throw new Error(`no built-in mod serves ${path}`)
        return text
      }
      return String(await slot.installedFs.readFile(path, { encoding: 'utf-8' }))
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
      id: () => slot.resolvedSessionId,
      cwd: () => slot.resolvedCwd,
      root: () => slot.resolvedProjectRoot,
      type: () => slot.templateType,
      // The directory the engine's memory section names, resolved the same way.
      memoryDir: () =>
        isMemoryEnabled(slot.runtimeConfig, slot.resolvedMemory)
          ? resolveMemoryDir(slot.coreState.options.cwd ?? slot.resolvedCwd, slot.runtimeConfig, slot.installedFs, {
              projectRoot: slot.coreState.options.projectRoot,
              homeDir: slot.homeDir,
              memorySettings: slot.resolvedMemory,
            })
          : Promise.resolve(null),
      // The directory the engine's scratchpad section names.
      scratchpadDir: () => {
        const base = resolveSessionStorageBase({
          storageBase: typeof slot.options.sessionStoragePath === 'string' && slot.options.sessionStoragePath.length > 0 ? slot.options.sessionStoragePath : undefined,
          homeDir: slot.homeDir,
          projectRoot: slot.coreState.options.projectRoot,
        })
        return base ? getScratchpadDirectoryPath(base, slot.resolvedSessionId) : null
      },
      // `$.session.model` / `.turns`: the engine's, bound late like `tools`.
      model: () => slot.modEngine('$.session.model').getCurrentModel(),
      turns: () => slot.modEngine('$.session.turns').countUserTurns(),
      // "The version of the engine the session runs on": Velloc's runtime
      // has no upstream release number, so `base` is absent — "the version is
      // not spelled as a release" — and a mod reads `velloc/` to know.
      version: () => ({
        version: `velloc/${NEXUS_INTERFACE_VERSION}`,
        ...(getBuildTime() ? { builtAt: getBuildTime() } : {}),
      }),
      repo: () => readSessionRepo(slot.installedFs, slot.resolvedCwd),
      // `$.fs`: the session's fs bridge, trusted as a settings
      // command hook is, under the untrusted-session read
      // boundary when this session has one.
      fs: fileModFs(slot.installedFs, {
        cwd: slot.resolvedCwd,
        ...(slot.appSurface ? { onWrite: (path: string) => slot.appSurface?.noteWrite(path) } : {}),
        ...(slot.homeDir ? { homeDir: slot.homeDir } : {}),
        ...(slot.resolvedOptions.untrustedReadRoot
          ? { readRoot: slot.resolvedOptions.untrustedReadRoot }
          : {}),
        ...(typeof slot.options.sessionStoragePath === 'string' && slot.options.sessionStoragePath.length > 0
          ? { sessionStoragePath: slot.options.sessionStoragePath }
          : {}),
      }),
      // `$.process.run`: the hosted Bash tool with its hook fields,
      // the route a settings `command` hook takes (`hookCommandRunner.ts`):
      // trusted as that hook is. A host without the
      // `browser` capability (a mock host) cannot run commands: absent.
      ...(slot.hostBridge.supportsBridgeCapability('browser')
        ? {
            process: hostModProcess(
              async ({ command, shell, stdin, env, timeoutMs, cwd }) => {
                const raw = (await slot.hostBridge.browser.callTool({
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
                  executionContext: { sessionId: slot.resolvedSessionId },
                })) as { output?: unknown; exit_code?: unknown; data?: { output?: unknown; exit_code?: unknown } } | undefined
                const body = raw?.data && typeof raw.data === 'object' ? raw.data : raw
                return {
                  output: typeof body?.output === 'string' ? body.output : '',
                  exitCode: typeof body?.exit_code === 'number' ? body.exit_code : 0,
                }
              },
              {
                cwd: slot.resolvedCwd,
                // `$.process.spawn`: a streaming child through
                // `shell.spawn`'s shell form. Its output events arrive at
                // any time, and a session's scoped transport forwards
                // events only while the session has a request in flight —
                // so the child is spawned on the runtime's host port, as
                // the MCP stdio servers are (`mcp/mcpHost.ts`); the session
                // transport is the fallback where there is no manager.
                // The mods' unload kills it (`ModInstance.dispose`).
                ...(slot.hostBridge.supportsBridgeCapability('shell')
                  ? {
                      spawnStream: (spec, handlers) => {
                        const host = getMcpHost()
                        const primitives = host
                          ? createNativePrimitives({
                              transport: host.transport,
                              createRequestId: () => slot.runtimeConfig.createUUID(),
                              manifest: host.manifest ?? slot.resolvedOptions.hostManifest,
                            })
                          : slot.hostBridge.primitives
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
      ...(slot.hostBridge.network.httpRequest
        ? {
            http: hostModHttp({
              request: (request, o) => slot.hostBridge.network.httpRequest!(request, o),
              denyRules: () => slot.coreState.getAppState().permissionRules.denyRuleBook,
            }),
          }
        : {}),
      // `$.config`: the enabled plugins' `userConfig` rows,
      // built as the `/config` listing builds them, over settings.json
      // `pluginConfigs`; a write stores the option under the plugin's id
      // and every session's plugins reload with it — as the Settings
      // form's save does. Nothing stored → no reload and no write.
      ...(settingsHomeDir
        ? {
            config: {
              rows: async () => pluginConfigRows(slot.modPlugins, await slot.readPluginConfigs()),
              write: modConfigWrite({
                store: async (row, value) => {
                  const { setPluginOption } = await import('../../pluginHost/pluginConfigs')
                  return setPluginOption({ homeDir: settingsHomeDir }, slot.installedFs, row.pluginId, row.field, value)
                },
                reload: () =>
                  slot.options.reloadPluginsOnAllSessions
                    ? slot.options.reloadPluginsOnAllSessions()
                    : slot.engineForMods?.refreshPluginSet(),
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
        const { settings } = await readUserLayer(settingsHomeDir, slot.installedFs)
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
          slot.registerOnEngine('agent', plugin, engine => engine.modAgents.register(spec, plugin), modAgentFullName(plugin, spec.name), reportMods),
        forget: plugin => slot.forgetOnEngine('agent', plugin, engine => engine.modAgents.forget(plugin)),
        list: () => slot.modEngine('$.agent').modAgents.list(),
        // `$.ui.view`'s lookup: no agent to find before the engine binds.
        viewTarget: agentId => slot.engineForMods?.modAgents.viewTarget?.(agentId),
        spawn: (args, raise) => slot.modEngine('$.agent').modAgents.spawn(args, raise),
        wait: (agentId, options) => slot.modEngine('$.agent').modAgents.wait(agentId, options),
      },
      // `$.task`: the session's plugin tasks, kept by the session manager.
      tasks: pluginTasksForSession(slot.resolvedSessionId),
      // `$.prompt.submit`: `prompt.submit` raised by the slot's mod
      // runtime with the caller's context, core the worker's turn queue;
      // `$.prompt.compose`: the engine's render, bound late like `tools`.
      prompt: {
        submit: (args, raise) => {
          const enqueue = slot.options.enqueuePluginTurn
          if (!slot.mods || !enqueue) {
            const error = new Error('$.prompt.submit is not available: this session queues no turns from plugins')
            error.name = 'NotSupportedError'
            return Promise.reject(error)
          }
          return slot.mods.pluginSubmit(args, enqueue, raise)
        },
        compose: (args, raise) => slot.modEngine('$.prompt.compose').modPrompt.compose(args, raise),
      },
      // `$.session.messages` / `.usage`: the engine's transcript,
      // bound late like `tools`.
      transcript: {
        rows: () => slot.modEngine('$.session.messages').modTranscript.rows(),
        agentRows: agentId => slot.modEngine('$.session.messages').modTranscript.agentRows(agentId),
        usage: () => slot.modEngine('$.session.usage').modTranscript.usage(),
        breakdown: args => slot.modEngine('$.session.usage').modTranscript.breakdown(args),
      },
      // `$.session.compact` / `.send` / `.append`: the engine raises
      // each event with the caller's context; bound late like `tools`.
      conversation: {
        compact: (args, raise) => slot.modEngine('$.session.compact').modConversation.compact(args, raise),
        send: (args, raise) => slot.modEngine('$.session.send').modConversation.send(args, raise),
        append: (args, raise) => slot.modEngine('$.session.append').modConversation.append(args, raise),
      },
      // `$.mcp`: the process's MCP pool, trusted (F-25) —
      // no permission prompt. A type that takes no MCP (`safe_code`) takes
      // none here either: absent, so the noun is refused by name.
      ...(slot.allowsMcp
        ? {
            mcp: poolModMcp({
              pool: () => slot.mcpPool,
              manifestServer: (plugin, key) => {
                const owner = slot.modPlugins.find(candidate => candidate.name === plugin)
                return owner
                  ? pluginMcpServer(owner, key, { getEnv: name => slot.runtimeConfig.getEnv(name), configs: slot.mcpPluginConfigs, providers: slot.mcpProviderKeys })
                  : undefined
              },
              onNativeLaunched: () => slot.offerLaunchedMcpServer(),
              origins: () => slot.mcpOrigins,
            }),
          }
        : {}),
      completions: {
        complete: (request, options) => slot.modEngine('$.model').modModel.complete(request, options),
        fork: (request, options) => slot.modEngine('$.model').modModel.fork(request, options),
        fastModel: () => slot.modEngine('$.model').modModel.fastModel(),
      },
      tools: {
        list: () => slot.modToolHost().list(),
        call: (input, raise) => slot.modToolHost().call(input, raise),
        check: (input, raise) => slot.modToolHost().check(input, raise),
        register: (spec, plugin) =>
          slot.registerOnEngine('tool', plugin, engine => engine.modTools.register!(spec, plugin), modToolFullName(plugin, spec.name), reportMods),
        forget: plugin => slot.forgetOnEngine('tool', plugin, engine => engine.modTools.forget?.(plugin)),
      },
      // `$.turn.abort`: the engine's running turn, bound late like `tools`.
      turn: {
        abort: turnId => slot.modEngine('$.turn.abort').abortTurn(turnId),
      },
      // `$.ui.notify`: the session's `Notification` hooks; "unbound or
      // exiting, none" run.
      notifications: {
        runHooks: async (notice, context) => {
          await slot.engineForMods?.runNotificationHooks({
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
    onStatusChanged: () => noteModSlotChanged(slot.resolvedSessionId),
    // A registered command changes the picker's list, which rides the
    // worker snapshot: the same fan-out republishes it.
    onCommandsChanged: () => noteModSlotChanged(slot.resolvedSessionId),
    // A mod's status line, notice or toast: `mods/ui/<sessionId>`, through
    // the same registry.
    onUiChanged: event => noteModUiEvent(slot.resolvedSessionId, event),
    // `$.prompt.read` / `.fill` / `.suggest`: the page's box, the
    // interactive session's alone.
    ...(slot.options.drawsComposer ? { drawsComposer: true } : {}),
    // `$.ui.copy`'s first path: the OS clipboard from the browser process,
    // which needs no focus and no gesture. A failure (an older host's
    // NOT_IMPLEMENTED included) leaves the copy to the page's paths.
    ...(slot.hostBridge.supportsBridgeCapability('ui')
      ? {
          clipboard: {
            write: (text: string) =>
              slot.hostBridge.ui.writeClipboard({ text }).then(
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
      ...slot.supportedSlashCommands.map(name => ({
        name,
        description: renderPartsEnglish([
          key(BUILTIN_SLASH_COMMAND_DESCRIPTION_KEYS[name as BrowserSlashCommand] ?? 'slash.builtin.help'),
        ]),
        source: 'builtin' as const,
      })),
      ...(slot.coreState.options.commands ?? [])
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
  slot.ownSlot = Object.assign(modRuntime, { uiState: () => modRuntime.uiSnapshot() })
  unregisterSlot = registerModSlot(slot.resolvedSessionId, slot.ownSlot)
  slot.unregisterModSlot = unregisterSlot
  undoWhenScopeEnds(unregisterSlot, slot.options.runtimeScopeSignal)
  // The slot is gone when its runtime scope is: `session.end` for the mods
  // (bounded — it cannot hold the teardown), then leave the chain and close
  // the workers.
  if (slot.options.runtimeScopeSignal?.aborted) modRuntime.dispose()
  else {
    slot.options.runtimeScopeSignal?.addEventListener('abort', () => {
      void modRuntime.end('other')
    })
  }
  return modRuntime
}

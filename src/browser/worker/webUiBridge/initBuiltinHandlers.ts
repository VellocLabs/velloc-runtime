/**
 * Built-in WebUI bridge capability registrations, run lazily on the first WebUI port attach;
 * idempotent. Handlers MUST return a `BrowserBridgeResponse`; throws surface as `webui_handler_error`.
 */

import { handleAgentBridgeRequest } from '../../bridge/adapter/agentBridgeAdapter'
import { handleProfileBridgeRequest } from '../../bridge/adapter/profileBridgeAdapter'
import { handleMemoryBridgeRequest } from '../../bridge/adapter/memoryBridgeAdapter'
import { handleSessionModelsBridgeRequest } from '../../bridge/adapter/sessionModelsBridgeAdapter'
import { handleFeaturesBridgeRequest } from '../../bridge/adapter/featuresBridgeAdapter'
import { handleMcpSettingsBridgeRequest } from '../../bridge/adapter/mcpSettingsBridgeAdapter'
import { handlePluginsBridgeRequest } from '../../bridge/adapter/pluginsBridgeAdapter'
import { listPluginMcpServers } from '../../../pluginHost/pluginMcpServerList'
import { handleSkillsBridgeRequest } from '../../bridge/adapter/skillsBridgeAdapter'
import {
  handleProvidersBridgeRequest,
  makeBridgeSecretSealer,
  type ProvidersAdapterContext,
} from '../../bridge/adapter/providersBridgeAdapter'
import { handleSessionImportBridgeRequest } from '../../bridge/adapter/sessionImportBridgeAdapter'
import { installStockSkills } from '../../../skillLibrary/builtin/catalog'
import { listSessionMCPPools } from '../../../mcp/sessionPools'
import { getMcpHost, hostServesWorkerMcp } from '../../../mcp/mcpHost'
import { createWorkerMcpOperations } from '../../../mcp/workerServers'
import { createNativePrimitives } from '../../bridge/nativePrimitives'
import { getRoutineRegistry } from '../../../routines/RoutineRegistry'
import { reconcileNightlyTidyCron } from '../../../routines/nightlyTidyCron'
import {
  type MemoryMaintenanceMode,
  joinPath,
  checkNotesDir,
} from '../../../memory/memoryPaths'
import {
  getNexusWorkspaceDir,
  projectsHome,
} from '../../../utils/conversationStoragePaths'
import { readUserLayer } from '../../../settings/settingsStore'
import type { NexusProviderConfig } from '../../../settings/settingsTypes'
import { setCustomProviderRecords } from '../../../config/customProviderRegistry'
import { NEXUS_MODEL_CONFIG } from '../../../config/nexusModelConfig'
import { serializeNexusModelConfig } from '../../../config/nexusModelConfigWire'
import {
  dismissRemovedNotice,
  fetchFreshModelIds,
  staleEntryIds,
  setRuntimeProviderConfigs,
  verifyRuntimeProvider,
  withRuntimeProviderBaseUrls,
  type RuntimeProvidersHost,
} from '../../../models/drivers/runtimeProviders'
import { NEXUS_DIR_NAME } from '../../../settings/settingSources'
import { providerModelFamilies } from '../../../models/drivers/modelFamilies'
import { withConcreteDefaultModels } from '../../../models/drivers/modelEntryCatalog'
import { getActiveSessionManager } from '../SharedWorkerSessionManager'
import { discoverInstructionFiles } from '../../../memory/instructionFiles'
import type { BrowserBridgeTransport } from '../../bridge/protocol/core'
import { createBridgeRoute } from '../../bridge/protocol/core'
import { wireError, type WireError } from '../../runtimeProtocol'
import { resolveHomeDirViaBridgeBounded } from '../../../utils/resolveHomeDirViaBridge'
import { withProviderUserAgents } from '../../../config/providerUserAgent'
import { withProviderSecretMirror } from '../../../config/providerSecrets'
import { refreshBrokerProviderBaseUrls } from '../brokerProviderView'
import {
  registerWebUiBridgeHandler,
  type WebUiBridgeContext,
} from './registry'

let initialized = false

/** Max time the providers adapter awaits `publishProviderConfigs` reaching the
 *  C++ broker before it broadcasts `providers.changed`. Normally the request
 *  resolves in a few ms (the broker's SetProviderConfigs is synchronous); this
 *  only bounds the pathological slow/hung-host case so a provider save can't
 *  stall. On timeout we proceed to broadcast anyway (the focus / new-session
 *  refresh paths still recover). */
const PUBLISH_TO_BROKER_TIMEOUT_MS = 3_000

/**
 * The settings root (features are user-scoped, `~/.velloc/settings.json`): `ctx.homeDir`, else the host's
 * `fs.userHome`. Only a found home is cached; with none the request is refused (`host_unavailable`) and the
 * next one asks again. Never the host's `fs.cwd`.
 */
let cachedSettingsRoot: string | null = null
/** Coalesces concurrent first-time callers (a settings page opens several capabilities at once). */
let inFlightResolution: Promise<string> | null = null
let settingsRootGeneration = 0

/** Bound on the `fs.userHome` ask, well inside the WebUI client's own request timeout. */
const SETTINGS_ROOT_BRIDGE_TIMEOUT_MS = 5_000

function noSettingsRoot(reason: string): WireError {
  return wireError('host_unavailable', `user home unknown (${reason}); refusing to anchor .velloc settings`)
}

async function resolveSettingsRoot(
  ctx: WebUiBridgeContext,
  directBridge: BrowserBridgeTransport | null,
): Promise<string> {
  if (ctx.homeDir && ctx.homeDir.length > 0) {
    return ctx.homeDir
  }
  if (cachedSettingsRoot !== null) {
    return cachedSettingsRoot
  }
  if (inFlightResolution !== null) {
    return inFlightResolution
  }
  if (!directBridge) {
    throw noSettingsRoot('no host bridge')
  }

  const generation = settingsRootGeneration
  let resolution: Promise<string>
  resolution = doResolveSettingsRoot(ctx, directBridge, generation).finally(() => {
    if (inFlightResolution === resolution) {
      inFlightResolution = null
    }
  })
  inFlightResolution = resolution
  return resolution
}

async function doResolveSettingsRoot(
  ctx: WebUiBridgeContext,
  directBridge: BrowserBridgeTransport,
  generation: number,
): Promise<string> {
  const { home, timedOut } = await resolveHomeDirViaBridgeBounded(
    directBridge,
    SETTINGS_ROOT_BRIDGE_TIMEOUT_MS,
  )
  if (generation !== settingsRootGeneration) {
    return resolveSettingsRoot(ctx, ctx.directBridge)
  }
  if (!home) {
    const reason = timedOut
      ? `fs.userHome did not answer within ${SETTINGS_ROOT_BRIDGE_TIMEOUT_MS}ms`
      : 'fs.userHome named no home'
    console.warn(`[resolveSettingsRoot] ${reason}`)
    throw noSettingsRoot(reason)
  }
  cachedSettingsRoot = home
  return home
}

export function invalidateWebUiSettingsRoot(): void {
  settingsRootGeneration += 1
  cachedSettingsRoot = null
  inFlightResolution = null
}

/** Test-only: wipe the settings-root cache between cases. */
export function __resetSettingsRootCacheForTests(): void {
  invalidateWebUiSettingsRoot()
}

export function initBuiltinWebUiBridgeHandlers(): void {
  if (initialized) return
  initialized = true

  // Populate the bundled-skills + features registries. `installStockSkills`
  // registers each bundled skill, which (via `default:`) auto-registers a
  // corresponding feature with id `bundled-skills.<name>` — so this one
  // call drives BOTH the skill list AND the features catalog the WebUI
  // settings page consumes. Idempotent.
  installStockSkills()

  // ---- features --------------------------------------------------------
  registerWebUiBridgeHandler('features', async (request, ctx: WebUiBridgeContext) => {
    const settingsRoot = await resolveSettingsRoot(ctx, ctx.directBridge)
    return handleFeaturesBridgeRequest(request, {
      homeDir: settingsRoot,
      fs: ctx.fs,
      // Live WorkingState updates are not wired from this surface: each new session reads the file at
      // boot, so a toggle takes effect on the next session.
      setAppState: () => {
        /* no-op for now; see comment above */
      },
    })
  })

  // ---- agent ----------------------------------------------------------
  // Persists the `agent` section of `~/.velloc/settings.json`. Each `setField` broadcasts
  // `agent.changed` and pushes `worker.applyRuntimeSettings` to every session (`maxTurns` next turn).
  // JS owns log/trace/maxTurns; the C++ pref owns `model`.
  registerWebUiBridgeHandler('agent', async (request, ctx) => {
    const settingsRoot = await resolveSettingsRoot(ctx, ctx.directBridge)
    return handleAgentBridgeRequest(request, {
      homeDir: settingsRoot,
      fs: ctx.fs,
      broadcastChanged: payload => {
        // Push event — action name lives outside the action map
        // (consumers subscribe by route + action). Cast bypasses the
        // exhaustiveness check; same pattern push events use for
        // every other capability.
        ctx.broadcastEvent(
          {
            namespace: 'nexus',
            capability: 'agent',
            action: 'changed',
          } as never,
          payload as unknown as Record<string, unknown>,
        )
        // Live engine overlay: hand the runtime-applicable fields to
        // every session worker. The engine reads only the keys it
        // recognises so passing the whole values dict (incl. `log` /
        // `trace`, which the engine ignores) is harmless. Optional
        // chain handles test contexts that don't wire the fan-out.
        ctx.applyAgentSettingsToAllSessions?.(
          payload.values as unknown as Record<string, unknown>,
        )
      },
    })
  })

  // ---- profile --------------------------------------------------------
  // Persists the `profile` section (display identity only) and broadcasts `profile.changed`. Reaches
  // the prompt via `appendSystemPrompt` at the next session's boot.
  registerWebUiBridgeHandler('profile', async (request, ctx) => {
    const settingsRoot = await resolveSettingsRoot(ctx, ctx.directBridge)
    return handleProfileBridgeRequest(request, {
      homeDir: settingsRoot,
      fs: ctx.fs,
      broadcastChanged: payload => {
        // Push event — action name lives outside the action map
        // (consumers subscribe by route + action). Cast bypasses the
        // exhaustiveness check; same pattern every other capability's
        // push events use.
        ctx.broadcastEvent(
          {
            namespace: 'nexus',
            capability: 'profile',
            action: 'changed',
          } as never,
          payload as unknown as Record<string, unknown>,
        )
      },
    })
  })

  // ---- memory ---------------------------------------------------------
  // Persists the auto-memory toggles (`autoMemoryDirectory` is refused), broadcasts `memory.changed`
  // and fans the toggles to every running session under `memorySettings`.
  registerWebUiBridgeHandler('memory', async (request, ctx) => {
    const settingsRoot = await resolveSettingsRoot(ctx, ctx.directBridge)
    return handleMemoryBridgeRequest(request, {
      homeDir: settingsRoot,
      fs: ctx.fs,
      // Enumerate EVERY memory dir for list/clear. Memory is per-project, so a
      // global settings page that resolved one dir (the focused session's) was
      // misleading — and for an unbound session it fell through to the bogus
      // `~/.velloc/memory` fallback. Instead, surface them all: the custom
      // override (if set), every existing `~/.velloc/projects/<slug>/memory/`,
      // and the legacy bare-sandbox dir. The adapter drops any that don't exist
      // on disk. Deduped on the trailing-separator-normalized path.
      listMemoryDirs: async () => {
        const out: Array<{ label: string; dir: string }> = []
        const seen = new Set<string>()
        const add = (label: string, dir: string) => {
          const key = dir.replace(/[\\/]+$/, '')
          if (seen.has(key)) return
          seen.add(key)
          out.push({ label, dir })
        }
        try {
          const { settings } = await readUserLayer(settingsRoot, ctx.fs)
          const override = checkNotesDir(settings.autoMemoryDirectory, {
            expandTilde: true,
            homeDir: settingsRoot,
          })
          if (override) add('Custom directory', override)
        } catch {
          /* no settings / bad override — skip the custom entry */
        }
        try {
          const projectsDir = projectsHome(settingsRoot)
          for (const entry of await ctx.fs.readdir(projectsDir)) {
            if (!entry.isDirectory()) continue
            add(entry.name, joinPath(projectsDir, entry.name, 'memory'))
          }
        } catch {
          /* projects dir missing — nothing to enumerate */
        }
        // Legacy bare-sandbox memory (pre-uniform-layout): surfaced read-only so
        // any pre-existing data isn't hidden after the carve-out removal.
        add('Sandbox', joinPath(getNexusWorkspaceDir(settingsRoot), 'memory'))
        return out
      },
      // List the user-authored instruction files (read-only) for the
      // "Instruction files" section: walk the instruction-file tiers from the projectRoot
      // of the session the asking client shows, then stat each for its size.
      listInstructionFiles: async sessionId => {
        try {
          const projectRoot = sessionId
            ? getActiveSessionManager()?.getSessionProjectRoot(sessionId)
            : undefined
          const found = await discoverInstructionFiles({
            cwd: projectRoot ?? settingsRoot,
            projectRoot,
            homeDir: settingsRoot,
            fs: ctx.fs,
          })
          const out = []
          for (const f of found) {
            let bytes = 0
            try {
              const s = await ctx.fs.stat(f.path)
              bytes = s.size ?? 0
            } catch {
              /* keep bytes = 0 */
            }
            out.push({ path: f.path, tier: f.tier, bytes })
          }
          return out
        } catch {
          return []
        }
      },
      broadcastChanged: payload => {
        // Push event — action name lives outside the action map
        // (consumers subscribe by route + action). Cast bypasses the
        // exhaustiveness check; same pattern every other capability uses.
        ctx.broadcastEvent(
          {
            namespace: 'nexus',
            capability: 'memory',
            action: 'changed',
          } as never,
          payload as unknown as Record<string, unknown>,
        )
        // Live engine overlay: hand the memory values to every session
        // worker, namespaced under `memorySettings` so the engine's
        // `applyRuntimeSettings` (which clamps `maxTurns`) ignores them and
        // only `applyMemorySettings` consumes them. The engine reads the
        // toggles and `memoryMaintenance`; the values carry no directory.
        ctx.applyAgentSettingsToAllSessions?.({
          memorySettings: payload.values,
        } as unknown as Record<string, unknown>)
        // daily-log: reconcile the nightly /tidy-memory cron against the new mode.
        // Manager scope only — getRoutineRegistry() is null in per-session
        // workers. Best-effort: a reconcile failure must not block the write.
        const registry = getRoutineRegistry()
        if (registry) {
          void reconcileNightlyTidyCron({
            registry,
            mode: (payload.values as { memoryMaintenance?: MemoryMaintenanceMode })
              .memoryMaintenance,
          }).catch(() => {})
        }
      },
    })
  })

  // ---- sessionModels --------------------------------------------------
  // Persists the session-model routing sections, broadcasts `sessionModels.changed` and fans them to
  // every running session under `sessionModelSettings`.
  registerWebUiBridgeHandler('sessionModels', async (request, ctx) => {
    const settingsRoot = await resolveSettingsRoot(ctx, ctx.directBridge)
    return handleSessionModelsBridgeRequest(request, {
      homeDir: settingsRoot,
      fs: ctx.fs,
      broadcastChanged: payload => {
        // Push event — action name lives outside the action map (consumers
        // subscribe by route + action). Cast bypasses the exhaustiveness
        // check; same pattern every other capability uses.
        ctx.broadcastEvent(
          {
            namespace: 'nexus',
            capability: 'sessionModels',
            action: 'changed',
          } as never,
          payload as unknown as Record<string, unknown>,
        )
        ctx.applyAgentSettingsToAllSessions?.({
          sessionModelSettings: payload.values,
        } as unknown as Record<string, unknown>)
      },
    })
  })

  // ---- mcpSettings ----------------------------------------------------
  // Persists the `mcp` section, broadcasts `mcpSettings.changed` and has the MCPPool reconcile its native
  // servers (serialised). Security: an http server's credential headers move into the host `secrets`
  // store on upsert; `testConnect` uses the runtime's host port.
  registerWebUiBridgeHandler('mcpSettings', async (request, ctx) => {
    const settingsRoot = await resolveSettingsRoot(ctx, ctx.directBridge)
    const mcpHost = getMcpHost()
    const createRequestId = () =>
      `mcp-settings-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`
    const primitives = mcpHost
      ? createNativePrimitives({
          transport: mcpHost.transport,
          createRequestId,
          manifest: mcpHost.manifest,
        })
      : null
    return handleMcpSettingsBridgeRequest(request, {
      homeDir: settingsRoot,
      fs: ctx.fs,
      secrets: primitives?.secrets,
      listPluginServers: () => listPluginMcpServers({ homeDir: settingsRoot, fs: ctx.fs }),
      testConnect:
        mcpHost && hostServesWorkerMcp(mcpHost.manifest)
          ? config =>
              createWorkerMcpOperations({
                resolveHost: getMcpHost,
                createRequestId,
              }).testConnect(config)
          : undefined,
      broadcastChanged: payload => {
        // The action map declares request/response actions only.
        // Push events ride on the same transport but their action
        // names live outside the action map (consumers subscribe by
        // route + action name). Cast to bypass the action-name
        // exhaustiveness check — same pattern push events would use
        // for any other capability.
        ctx.broadcastEvent(
          {
            namespace: 'nexus',
            capability: 'mcpSettings',
            action: 'changed',
          } as never,
          payload as unknown as Record<string, unknown>,
        )
        // Every session's pool re-reads settings.json through the
        // loadNativeServers callback its runtime wired, and reconciles
        // `add` / `remove` against its live connections. Best-effort —
        // never block the bridge response on it.
        for (const pool of listSessionMCPPools()) {
          void pool.refreshNativeServers().catch(err => {
            console.warn(
              '[webUiBridge] mcpSettings.changed → pool refresh failed:',
              err instanceof Error ? err.message : err,
            )
          })
        }
      },
    })
  })

  // ---- plugins --------------------------------------------------------
  // Plugin install surface for the WebUI Plugins page, on the same on-disk state as the slash
  // commands. Downloads go through `network.httpGet` via `directBridge` (the worker's CSP blocks fetch).
  registerWebUiBridgeHandler('plugins', async (request, ctx) => {
    const settingsRoot = await resolveSettingsRoot(ctx, ctx.directBridge)
    return handlePluginsBridgeRequest(request, {
      homeDir: settingsRoot,
      fs: ctx.fs,
      directBridge: ctx.directBridge,
      // Hot-reload every active session on enable/disable (no
      // restart). Optional chain handles test contexts without a session
      // fan-out — the enabled map is still written for the next boot.
      reloadPluginsOnAllSessions: () => ctx.reloadPluginsOnAllSessions?.(),
    })
  })

  // ---- skills ---------------------------------------------------------
  // Remote Agent-Skill install into `~/.velloc/skills/<name>/` (where the
  // runtime skills loader reads user skills). Like `plugins`, downloads
  // route through `directBridge` → `network.httpGet` (C++ — bypasses the
  // SharedWorker's CSP block on `raw.githubusercontent.com`). Backs the
  // Skills marketplace folded into the settings Features page.
  registerWebUiBridgeHandler('skills', async (request, ctx) => {
    const settingsRoot = await resolveSettingsRoot(ctx, ctx.directBridge)
    return handleSkillsBridgeRequest(request, {
      homeDir: settingsRoot,
      fs: ctx.fs,
      directBridge: ctx.directBridge,
      // Same fan-out the plugins handler uses: `loadLocalPromptCommands`
      // re-reads `~/.velloc/skills/` on reload, so an installed/uninstalled
      // marketplace skill becomes visible without a new session.
      reloadSkills: () => ctx.reloadPluginsOnAllSessions?.(),
    })
  })

  // ---- sessionImport --------------------------------------------------
  // Import sessions from another agent product's transcripts under the user home. I/O only: fs over
  // `directBridge`, conversion in a window-owned Worker, written via `writeSessionBundle`.
  registerWebUiBridgeHandler('sessionImport', async (request, ctx) => {
    const homeDir = await resolveSettingsRoot(ctx, ctx.directBridge)
    const manager = getActiveSessionManager()
    return handleSessionImportBridgeRequest(request, {
      homeDir,
      fs: ctx.fs,
      directBridge: ctx.directBridge,
      writer: manager,
    })
  })

  // ---- providers ------------------------------------------------------
  // Persists the `providers` section (LLM provider configs) and broadcasts `providers.changed`; live-probe
  // routes stay on the C++ side.
  registerWebUiBridgeHandler('providers', async (request, ctx) => {
    const settingsRoot = await resolveSettingsRoot(ctx, ctx.directBridge)
    return handleProvidersBridgeRequest(request, providersAdapterContext(ctx, settingsRoot))
  })

  // ---- future capabilities go here ------------------------------------
  // registerWebUiBridgeHandler('models', ...)
  // registerWebUiBridgeHandler('sessions', ...)
  // etc.
}

/**
 * The `providers` adapter's context over one WebUI bridge context — shared by
 * the `providers` handler and the runtime-provider host below, so a
 * runtime-side write (a reconciled model list) takes the same path as a
 * settings-page save: settings.json, the host publish, `providers.changed`.
 */
function providersAdapterContext(
  ctx: WebUiBridgeContext,
  settingsRoot: string,
): ProvidersAdapterContext {
  return {
    homeDir: settingsRoot,
    fs: ctx.fs,
    // Keep the custom-provider registry in step with the file. Runs before
    // the broker publish + the WebUI broadcast, so the catalog the shell
    // re-fetches on `providers.changed` already carries a just-created
    // custom provider (and a just-deleted one is already gone).
    onConfigsChanged: configs => {
      setCustomProviderRecords(configs)
      setRuntimeProviderConfigs(configs)
    },
    broadcastChanged: payload => {
      ctx.broadcastEvent(
        {
          namespace: 'nexus',
          capability: 'providers',
          action: 'changed',
        } as never,
        payload as unknown as Record<string, unknown>,
      )
    },
    // Push the effective configs to the C++ broker so it reconfigures
    // its providers from settings.json (the cred path that makes a
    // ModelsSection save reach LLM calls). Best-effort: a stale host
    // without the `model.publishProviderConfigs` route just keeps using
    // its `nexus.provider_configs` pref cache.
    publishToBroker: ctx.directBridge
      ? async payload => {
          // Awaited by the providers adapter BEFORE it broadcasts
          // `providers.changed`, so the WebUI's catalog refresh sees the
          // broker already reconfigured. Bound the wait (race a timer) so a
          // slow/hung host can't stall the save; the request resolves in a
          // few ms normally.
          await Promise.race([
            ctx.directBridge!
              .request({
                id: `pub-providers-${crypto.randomUUID()}`,
                route: createBridgeRoute('model', 'publishProviderConfigs'),
                payload: {
                  ...payload,
                  configs: withConcreteDefaultModels(
                    withRuntimeProviderBaseUrls(
                      withProviderSecretMirror(withProviderUserAgents(payload.configs)),
                    ),
                  ),
                },
              })
              .catch(() => {})
              // The broker now holds the merged config; re-read its base
              // URLs so a PDF mention resolves against the endpoint the
              // host really uses (`resolveDocumentInputMode`).
              .then(() =>
                refreshBrokerProviderBaseUrls(
                  ctx.directBridge!,
                  `list-providers-${crypto.randomUUID()}`,
                ),
              ),
            new Promise<void>(resolve =>
              setTimeout(resolve, PUBLISH_TO_BROKER_TIMEOUT_MS),
            ),
          ])
        }
      : undefined,
    // Runtime-only providers (OpenRouter, the Vercel AI Gateway) are probed
    // here, in the runtime: the host's providerAuth.verify has no such
    // provider. The probe sends the STORED key, host-substituted.
    verifyRuntimeProvider: ctx.directBridge
      ? id => verifyRuntimeProvider(ctx.directBridge!, id)
      : undefined,
    // Any provider's model families, for the settings page's "Add models".
    modelFamilies: ctx.directBridge
      ? (id, force) => providerModelFamilies(ctx.directBridge!, id, { force })
      : undefined,
    // …and never let a stale page copy write back an entry just delisted.
    staleEntryIds,
    dismissRemovedNotice,
    // A provider mod's options reload every session's plugins, as the
    // Plugins page's option write does.
    reloadPluginsOnAllSessions: () => ctx.reloadPluginsOnAllSessions?.(),
    // Any provider's current listing, for the home page's model counts.
    freshModelIds: ctx.directBridge
      ? id => fetchFreshModelIds(ctx.directBridge!, id)
      : undefined,
    // Seal api keys with the OS keystore before they reach settings.json.
    // Not bounded like the publish above: sealing is a synchronous DPAPI /
    // Keychain call on the host and its failure must be SEEN (the adapter
    // then keeps the key as entered and logs), never silently skipped.
    encryptSecret: ctx.directBridge
      ? makeBridgeSecretSealer(
          req => ctx.directBridge!.request(req),
          () => `seal-secret-${crypto.randomUUID()}`,
        )
      : undefined,
  }
}

/**
 * What `models/drivers/runtimeProviders.ts` needs from the runtime:
 * provider-config writes through the `providers` write path, and its listing
 * cache under `~/.velloc/cache/provider-models/`. The runtime hub installs it
 * over its own WebUI bridge context (`configureRuntimeProviders`).
 */
export function createRuntimeProvidersHost(ctx: WebUiBridgeContext): RuntimeProvidersHost {
  const cacheDir = async (): Promise<string> => {
    const root = await resolveSettingsRoot(ctx, ctx.directBridge)
    return joinPath(root, NEXUS_DIR_NAME, 'cache', 'provider-models')
  }
  return {
    async writeProviderConfig(providerId, config) {
      const settingsRoot = await resolveSettingsRoot(ctx, ctx.directBridge)
      const response = await handleProvidersBridgeRequest(
        {
          id: `runtime-provider-${crypto.randomUUID()}`,
          route: createBridgeRoute('providers', 'upsert'),
          payload: { id: providerId, config },
        } as never,
        providersAdapterContext(ctx, settingsRoot),
      )
      if (!response.ok) throw new Error(response.error.message)
    },
    async readCache(providerId) {
      try {
        return await ctx.fs.readFile(joinPath(await cacheDir(), `${providerId}.json`), {
          encoding: 'utf-8',
        })
      } catch {
        return undefined
      }
    },
    // A provider mod was added or removed: the host learns the catalog's new
    // entries, then every open surface is told (it refreshes on hearing).
    async republishCatalog() {
      if (!ctx.directBridge) return
      await ctx.directBridge.request({
        id: `pub-catalog-${crypto.randomUUID()}`,
        route: createBridgeRoute('model', 'publishCatalog'),
        payload: { catalog: serializeNexusModelConfig(NEXUS_MODEL_CONFIG) },
      })
    },
    async broadcastProvidersChanged(extra) {
      const settingsRoot = await resolveSettingsRoot(ctx, ctx.directBridge)
      const adapter = providersAdapterContext(ctx, settingsRoot)
      const response = await handleProvidersBridgeRequest(
        {
          id: `runtime-provider-${crypto.randomUUID()}`,
          route: createBridgeRoute('providers', 'list'),
          payload: {},
        } as never,
        adapter,
      )
      if (!response.ok) throw new Error(response.error.message)
      const { configs, activeProviderId, order } = response.result as {
        configs: Record<string, NexusProviderConfig>
        activeProviderId?: string
        order: string[]
      }
      adapter.broadcastChanged?.({ configs, activeProviderId, order, ...(extra ?? {}) })
    },
    async writeCache(providerId, text) {
      const dir = await cacheDir()
      const root = await resolveSettingsRoot(ctx, ctx.directBridge)
      // mkdir is not recursive on every fs facade: create each level.
      for (const level of [
        joinPath(root, NEXUS_DIR_NAME),
        joinPath(root, NEXUS_DIR_NAME, 'cache'),
        dir,
      ]) {
        try {
          await ctx.fs.mkdir(level)
        } catch {
          // Exists already; writeFile reports a real failure.
        }
      }
      await ctx.fs.writeFile(joinPath(dir, `${providerId}.json`), text, { encoding: 'utf-8' })
    },
  }
}

/** Test-only: drop the idempotence flag so the next call re-registers,
 *  and clear the cached settings root + in-flight resolution so the
 *  next call re-resolves from scratch. */
export function __resetBuiltinWebUiBridgeHandlersForTests(): void {
  initialized = false
  cachedSettingsRoot = null
  inFlightResolution = null
}

/**
 * RuntimeHub — the registry, broker and connection hub wired together, the handlers' `RuntimeContext`,
 * and the `bridge.attachRuntimePort` entry. Shares one event path with `WebUiBridgeHub`, so a write
 * through either entry reaches clients of both (P-3).
 */
import type {
  BrowserBridgeRequest,
  BrowserBridgeRoute,
} from '../bridge/protocol/core'
import type { DirectPortBridgeTransport } from '../bridge/DirectPortBridgeTransport'
import type { WebUiBridgeContext } from '../worker/webUiBridge/registry'
import {
  getWebUiBridgeHandler,
} from '../worker/webUiBridge/registry'
import {
  createRuntimeProvidersHost,
  initBuiltinWebUiBridgeHandlers,
} from '../worker/webUiBridge/initBuiltinHandlers'
import { configureRuntimeProviders } from '../../models/drivers/runtimeProviders'
import { lendProviderHostSources } from '../../mods/provider/providerHostSources'
import { createBrowserFsOperations } from '../../utils/BrowserFsOperations'
import { processFs } from '../../utils/fs/runtimeFs'
import { traceLine } from '../../utils/debugLog'
import { buildKeyFromBuildTime } from '../../branding/buildInfo'
import { buildEntryUrl } from './buildEntry'
import {
  NOTIFICATIONS_TOPIC,
  topic,
  type ByeCode,
  type NotificationKind,
  type RuntimeNotification,
  SCOPE_MODES,
  type Scope,
  type ScopeMode,
  type TopicId,
  type WelcomeFrame,
} from '../runtimeProtocol'
import { createMessagePortTransport, type FrameTransport } from '../runtimeTransport'
import { CapabilityRegistry, scopeAllows } from './CapabilityRegistry'
import { ConnectionHub, type AttachOptions, type ConnectionHandle } from './ConnectionHub'
import { createPairingTable } from './pairingTable'
import { createRelayDialer, type RelayDialer } from './relayDialer'
import {
  createRemoteAccessDriver,
  type RemoteAccessDriver,
} from './remoteAccessDriver'
import { createPairingPersistence, type PairingPersistence } from './pairingPersistence'
import { createSharingPairing, type SharingPairing } from './sharingPairing'
import {
  REMOTE_STATE_TOPIC,
  registerRemoteCapability,
  remoteStateTopicProvider,
  type RemoteState,
} from './remoteCapability'
import { hostProxySpecs } from './hostProxyTable'
import {
  LEGACY_WEBUI_CAPABILITIES,
  isLegacyWebUiCapability,
  registerLegacyWebUiCapabilities,
} from './legacyWebUiCapabilities'
import { TopicBroker } from './TopicBroker'
import { registerWorkspaceCapability, type WorkspaceStateStore } from './workspaceCapability'
import { registerProviderUpdatesCapability } from './providerUpdatesCapability'
import { registerPluginUpdatesCapability } from './pluginUpdatesCapability'
import { resolveHostHome } from './hostFs'
import { currentTemplateChannel } from '../../branding/updateChannels'
import { registerCatalogCapability } from './catalogCapability'
import { registerAppUpdateCapability } from './appUpdateCapability'
import { registerRenderCacheCapability } from './renderCacheCapability'
import { registerProviderLoginCapability } from './providerLoginCapability'
import { registerProviderUsageCapability } from './providerUsageCapability'
import { getProviderCredentials } from '../../mods/provider/login/credentialDeps'
import { registerModsCapability } from './modsCapability'
import { modSlotsClientGone } from '../../mods/modSlotRegistry'
import { knownProjectRoots, type SessionProjectRoot } from './knownProjects'
import { PresenceTable, registerPresenceCapability, type PresenceChange } from './presence'
import {
  SHELL_EVENT_OF,
  ShellStateTable,
  registerShellCapability,
  shellTopicProvider,
} from './shellCapability'
import type {
  ConnectionInfo,
  HostBridge,
  PublishOptions,
  RuntimeContext,
  TopicProvider,
} from './types'

export type RuntimeHubHost = {
  /** Read lazily — the direct bridge may connect after construction. */
  getDirectBridgeTransport(): DirectPortBridgeTransport | null
  /** Bridge request-id factory, shared with the Manager's own direct-bridge calls. */
  createBridgeRequestId(): string
  applyAgentSettingsToAllSessions(config: Record<string, unknown>): void
  reloadPluginsOnAllSessions(): void
  /** Reload every session's mods whose module text changed (F-25). */
  reloadModsOnAllSessions?(): void
  /** Submit to a session the runtime holds; false when it holds none. */
  submitToSession?(sessionId: string, payload: Record<string, unknown>): boolean
  /** What `welcome.server.runtimeVersion` reports. */
  runtimeVersion: string
  /** A client started (or stopped) viewing a session — `presence.setViewing`, or its connection went away. */
  onPresenceChanged?(change: PresenceChange): void
  /**
   * Every session's bound folder the runtime holds, live and persisted — the
   * session half of the known-project set (`knownProjects.ts`). Absent: only
   * the workspace index is known.
   */
  sessionProjectRoots?(): readonly SessionProjectRoot[]
  /**
   * The desktop panel that owns a session (the window that opened it), or
   * undefined for a session the runtime does not hold. Stamped on the
   * session's notifications so exactly one window asks the host for a toast.
   */
  panelOfSession?(sessionId: string): string | undefined
  /**
   * The user's home, from the same source sessions use. The hub settles it
   * before serving a request; null (no host answer yet) is asked again on the
   * next one. Absent: only an attaching panel port can tell the hub its home.
   */
  resolveHomeDir?(): Promise<string | null>
}

/**
 * `notifications`: delta-only, and any client may hear them — a notification is
 * the runtime asking for the user's attention, and every client renders it its
 * own way (R5: no reverse call). Nothing to catch up on, so no snapshot. A
 * connection bound to a list of sessions hears only the ones about those
 * sessions — a turn-end carries the session's title — and none that names no
 * session at all.
 */
export const notificationsTopicProvider: TopicProvider = {
  matches: (id: TopicId) => id === NOTIFICATIONS_TOPIC,
  authorize: () => true,
  // eslint-disable-next-line require-yield
  async *snapshot() {
    /* a notification is a moment, not a state */
  },
  project: (_id, conn, evt) => {
    if (conn.scope.sessions === 'all') return evt.payload
    const sessionId = (evt.payload as { sessionId?: unknown } | null)?.sessionId
    return typeof sessionId === 'string' && conn.scope.sessions.includes(sessionId) ? evt.payload : undefined
  },
}

/**
 * Security: `settings/<cap>` topics are delta-only and take the LEAST scope any of the capability's
 * actions requires, computed from the scope ladder.
 */
const SETTINGS_TOPIC_SCOPES = new Map<string, ScopeMode>(
  Object.entries(LEGACY_WEBUI_CAPABILITIES).map(([cap, acts]) => {
    const scopes = Object.values(acts as Record<string, ScopeMode>)
    const least = SCOPE_MODES.find(mode => scopes.some(s => scopeAllows(mode, s))) ?? 'full'
    return [cap, least]
  }),
)

/** The scope a connection needs to subscribe to `settings/<cap>`. Unknown → `full`. */
export function settingsTopicScope(cap: string): ScopeMode {
  return SETTINGS_TOPIC_SCOPES.get(cap) ?? 'full'
}

const settingsTopicProvider: TopicProvider = {
  matches: (id: TopicId) => id.startsWith('settings/'),
  authorize: (id, conn) =>
    scopeAllows(conn.scope.mode, settingsTopicScope(id.slice('settings/'.length))),
  // eslint-disable-next-line require-yield
  async *snapshot() {
    /* delta-only: the broker sends the empty baseline snapshot */
  },
}

function hostBridgeOver(transport: DirectPortBridgeTransport, createId: () => string): HostBridge {
  return {
    request: async (route, payload) => {
      const response = await transport.request({
        id: createId(),
        route,
        payload,
      } as BrowserBridgeRequest)
      return response.ok
        ? { ok: true, result: response.result }
        : { ok: false, error: response.error }
    },
  }
}

export class RuntimeHub {
  readonly registry = new CapabilityRegistry()
  readonly broker = new TopicBroker({ log: message => traceLine(message, { level: 'info' }) })
  readonly connections: ConnectionHub
  readonly context: RuntimeContext
  /** The user's workspace index (`workspace` capability + topic), owned here, one per runtime. */
  readonly workspace: WorkspaceStateStore
  /** Which session each connection is viewing (`presence` capability). Replaces the single "current session". */
  readonly presence: PresenceTable
  /** Per-panel window chrome (`shell` capability): layout, boot progress, build info. */
  readonly shell = new ShellStateTable()
  /** Remote-access pairings. In-memory, but mirrored to the host's pref
   *  store by `pairingPersistence` so a link survives a restart. */
  readonly pairings = createPairingTable()
  /** The relay dialer: the runtime's outbound leg to a relay. */
  readonly relay: RelayDialer
  /** The remote-access driver: manifest-gated host remoteAccess calls. */
  readonly remoteAccess: RemoteAccessDriver
  /** Pairing persistence: rehydrate on boot, write back on mutation. */
  readonly pairingPersistence: PairingPersistence
  /**
   * The sharing-pairing coordinator: the ONE owner of "exactly one long-lived
   * manager pairing while remote access is enabled". Gated on the driver's
   * first getStatus AND the persistence rehydrate having landed — see
   * `sharingPairing.ts` for why both matter.
   */
  readonly sharing: SharingPairing
  private relayErrorText: string | undefined
  private readonly pluginUpdates: { dispose(): void }
  /** The ISO build stamp of the page that started this runtime (first-writer-wins). */
  private _bootBuild: string | null = null
  /** The in-flight `host.resolveHomeDir`, shared by every request waiting on it. */
  private homeProbe: Promise<void> | null = null

  constructor(private readonly host: RuntimeHubHost) {
    this.presence = new PresenceTable(change => host.onPresenceChanged?.(change))
    const transport = host.getDirectBridgeTransport()
    const webUiBridge: WebUiBridgeContext = {
      homeDir: '',
      fs: this.fsOver(transport),
      directBridge: transport,
      // A settings adapter's `*.changed`: straight to `settings/<cap>`. It used
      // to travel through `WebUiBridgeHub`, which fanned it to attached WebUI
      // ports and called back here to publish; there are no such ports left.
      broadcastEvent: (route, payload) => this.publishLegacyBroadcast(route, payload),
      applyAgentSettingsToAllSessions: config => host.applyAgentSettingsToAllSessions(config),
      reloadPluginsOnAllSessions: () => host.reloadPluginsOnAllSessions(),
    }
    // Runtime-only providers (OpenRouter, the Vercel AI Gateway) write their
    // reconciled model lists through the same `providers` path a settings
    // save takes, and keep their listing cache on this context's fs. The
    // context is read per call, so a replaced transport is picked up.
    const providersHost = createRuntimeProvidersHost(webUiBridge)
    configureRuntimeProviders(providersHost)
    // …and so does a provider module's `$.provider.setSecrets` (sealed host-side).
    lendProviderHostSources({ writeProviderConfig: (id, config) => providersHost.writeProviderConfig(id, config) })
    this.context = {
      fs: webUiBridge.fs,
      host: transport ? hostBridgeOver(transport, () => host.createBridgeRequestId()) : null,
      homeDir: '',
      publish: (id, payload, opts) => this.broker.publish(id, payload, opts),
      connections: () => this.connections.list(),
      webUiBridge,
    }
    this.connections = new ConnectionHub({
      registry: this.registry,
      broker: this.broker,
      context: this.context,
      runtimeVersion: host.runtimeVersion,
      bootstrap: () => this.bootstrap(),
      beforeRequest: () => this.ensureHomeDir(),
      onConnectionClosed: info => {
        this.presence.remove(info.connectionId)
        // Its mod drawings and their handles go with it (F-25).
        modSlotsClientGone(info.connectionId)
        // F-24: the device left the connected-device list. Only a websocket
        // connection is ON that list, so a panel port closing republishes
        // nothing anyone can see — but it is also not worth a second hook.
        if (info.transport === 'websocket') this.publishRemoteState()
      },
      onConnectionOpened: info => {
        if (info.transport === 'websocket') this.publishRemoteState()
      },
      onHelloBuild: hello => this.noteHelloBuild(hello),
      pairings: this.pairings,
      log: message => traceLine(message, { level: 'info' }),
    })

    this.broker.registerProvider(settingsTopicProvider)
    this.broker.registerProvider(notificationsTopicProvider)
    this.broker.registerProvider(shellTopicProvider(this.shell))
    registerShellCapability(this.registry, this.broker, this.shell)
    registerLegacyWebUiCapabilities(this.registry, {
      primeLegacyHandlers: () => initBuiltinWebUiBridgeHandlers(),
      getHandler: cap => getWebUiBridgeHandler(cap),
      knownProjectRoots: sessionScope => this.knownProjectRoots(sessionScope),
    })
    for (const spec of hostProxySpecs()) this.registry.registerHostProxy(spec)
    registerPresenceCapability(this.registry, this.presence)
    this.workspace = registerWorkspaceCapability(this.registry, this.broker, {
      context: () => this.context,
      sessionProjectRoots: () => host.sessionProjectRoots?.() ?? [],
    })
    // Mods (F-25): what became of every session's hooks modules, as the
    // `mods/state` topic and `mods.list`; a refused or dead one is also a
    // notification, so the person who installed it is told.
    registerModsCapability(this.registry, this.broker, {
      notify: notification => this.notify(notification, 'modState'),
      reloadAll: () => host.reloadModsOnAllSessions?.(),
      submit: (sessionId, payload) => host.submitToSession?.(sessionId, payload) === true,
      // A plugin's `userConfig` values: written to settings.json, then
      // every session reloads its plugins, so its mods load again with them.
      setOptions: async (plugin, options, keep) => {
        const { setPluginOptions } = await import('../../pluginHost/pluginConfigs')
        await setPluginOptions({ homeDir: this.context.homeDir }, this.context.fs, plugin, options, keep)
        host.reloadPluginsOnAllSessions()
      },
    })
    // Provider usage / credit balance for the composer and the settings page:
    // fetched here (the runtime makes host calls), published on
    // `providers/usage`, refreshed on a client's `providerUsage.refresh`.
    registerProviderUsageCapability(
      this.registry,
      this.broker,
      () => this.context.webUiBridge.directBridge,
    )
    // Provider mod updates (PM-9b): the update service's status on
    // `plugins/providerUpdates`, and the check / consent / decline / rollback /
    // baseline actions - all `full`: they switch which code serves a model
    // provider, so no remote client reaches them.
    registerProviderUpdatesCapability(this.registry, this.broker)
    // Marketplace plugin updates (F-14): `plugins/updates` and the
    // check / update / rollback / setAutoUpdate actions, all `full`; the
    // background schedule installs only while `pluginAutoUpdate` is on.
    // The built-in marketplace job runs here too: downloaded on the first
    // boot, reconciled on every boot, checked daily (F-14).
    this.pluginUpdates = registerPluginUpdatesCapability(this.registry, this.broker, {
      context: () => ({
        fs: this.context.webUiBridge.fs,
        directBridge: this.context.webUiBridge.directBridge,
      }),
      resolveHome: () => resolveHostHome(this.context),
      reloadPluginsOnAllSessions: () => host.reloadPluginsOnAllSessions(),
      builtinMarketplace: { channel: currentTemplateChannel },
    })
    // Model data (F-28): the catalog status on `catalog/status` and the
    // `catalog.refresh` action (`manager`); the service comes from the seam in
    // `catalog/modelCatalogHolder.ts`.
    registerCatalogCapability(this.registry, this.broker)
    // Client auto-update (F-30): `appUpdate/status` (`observe`) and
    // `appUpdate.relaunch` (`full`); the service comes from `appUpdate/appUpdateHolder.ts`.
    registerAppUpdateCapability(this.registry, this.broker)
    // Render-cache purge (P-3): `renderCache/status` (`observe`) and
    // `renderCache.purgeNow` (`manager`); `presence.reportActivity` re-arms the idle purge.
    registerRenderCacheCapability(this.registry, this.broker, this.presence)
    // Provider sign-in (PM-7): the dialog is the `providers/login` topic, the
    // person's answers are `providerLogin.*` actions (`manager`).
    registerProviderLoginCapability(this.registry, this.broker, getProviderCredentials())

    // Remote access: the dialer + its capability + the remote/state
    // topic. The dialer dials OUT only (the runtime never listens); every leg
    // a relay hands it becomes a hub connection via attachTransport.
    this.relay = createRelayDialer({
      createSocket: url => new WebSocket(url),
      attachTransport: transport => { this.attachTransport(transport) },
      getEntryPath: () => this.bootBuildEntryPath(),
      onState: (_state, error) => {
        this.relayErrorText = error
        this.publishRemoteState()
      },
    })
    // The remote-access driver. It calls the host's `remoteAccess`
    // capability (manifest-gated — setRemoteAccessSupported arms it), steers
    // the dialer to match the listener, and feeds `remote/state.access`.
    this.remoteAccess = createRemoteAccessDriver({
      host: () => this.context.host,
      subscribeEvents: handler =>
        this.host.getDirectBridgeTransport()?.subscribeEvents?.(handler) ?? (() => {}),
      dialer: this.relay,
      publishState: () => this.publishRemoteState(),
      // Landing #1 of the sharing-pairing gate: `access().enabled` is only
      // truthful once a status has been applied.
      onStatusApplied: () => {
        this.sharing.noteStatusLanded()
        this.sharing.ensure(this.remoteAccess.access().enabled)
      },
    })
    // Pairing persistence — rehydrate the table from the
    // host's pref store on boot, write it back after every mutation, so a
    // minted link survives a restart. Same manifest gate as the driver.
    this.pairingPersistence = createPairingPersistence({
      host: () => this.context.host,
      pairings: this.pairings,
      publishState: () => this.publishRemoteState(),
      // Landing #2 of the sharing-pairing gate: minting before the host's
      // stored rows are back duplicates the pairing it is about to return.
      onRehydrated: () => {
        this.sharing.noteRehydrateLanded()
        this.sharing.ensure(this.remoteAccess.access().enabled)
      },
    })
    this.sharing = createSharingPairing({
      pairings: this.pairings,
      now: () => Date.now(),
      persist: () => this.pairingPersistence.persist(),
      publishState: () => this.publishRemoteState(),
    })
    registerRemoteCapability(this.registry, {
      pairings: this.pairings,
      revokePairing: pairId => this.connections.revokePairing(pairId),
      dialer: this.relay,
      relayError: () => this.relayErrorText,
      publishState: () => this.publishRemoteState(),
      remoteAccess: this.remoteAccess,
      entryPath: () => this.bootBuildEntryPath(),
      persistPairings: () => this.pairingPersistence.persist(),
      sharing: this.sharing,
    })
    this.broker.registerProvider(remoteStateTopicProvider(() => ({
      relay: this.relay.state,
      ...(this.relay.state === 'error' && this.relayErrorText ? { relayError: this.relayErrorText } : {}),
      pairings: this.pairings.list(),
      access: this.remoteAccess.access(),
      connections: this.remoteDeviceRows(),
    })))
    if (transport) void this.ensureHomeDir()
  }

  /**
   * The manifest gate for `remoteAccess`: the Manager calls this once
   * it has the host manifest. `true` arms the driver (ONE initial getStatus +
   * the onStatusChanged subscription); `false` disarms it so ZERO host calls
   * are made — the no-interface-version-bump rule.
   */
  setRemoteAccessSupported(supported: boolean): void {
    // Arming both is all this does. The sharing pairing is NOT ensured here:
    // the ensure needs `access().enabled` and the host's stored rows, and both
    // arrive asynchronously from the two calls below — so it runs from their
    // landings (`onStatusApplied` / `onRehydrated`) instead. Doing it inline
    // read the pre-boot `enabled:false` and never fired at all; had it fired,
    // it would have minted against an empty table.
    this.remoteAccess.setSupported(supported)
    this.pairingPersistence.setSupported(supported)
  }

  /**
   * The folders a connection with this session scope may name below `full`
   * (`knownProjects.ts`). A workspace index that cannot be read leaves only
   * the sessions' folders known — it narrows, never widens.
   */
  async knownProjectRoots(sessionScope: Scope['sessions']): Promise<string[]> {
    const workspace = await this.workspace.current().catch(() => null)
    return knownProjectRoots({ workspace, sessions: this.host.sessionProjectRoots?.() ?? [] }, sessionScope)
  }

  /** `bridge.attachRuntimePort`: one `ClientConnection` over the transferred port. */
  attachPort(port: MessagePort, homeDir: string, panelId?: string): void {
    // Upgrade-only: never overwrite a known homeDir with an empty one.
    if (homeDir && !this.context.homeDir) this.setHomeDir(homeDir)
    this.attachTransport(createMessagePortTransport(port), {
      ...(panelId !== undefined ? { panelId } : {}),
    })
  }

  /**
   * Attach any transport — the entry the relay dialer uses for a remote leg
   * each `open` on the control socket becomes a leg socket attached
   * here. Thin wrapper so the dialer never touches ConnectionHub directly.
   */
  attachTransport(transport: FrameTransport, attachOptions: AttachOptions = {}): ConnectionHandle {
    return this.connections.attach(transport, attachOptions)
  }

  /**
   * The immutable entry path this runtime reports (e.g. \`/v3/b/<key>/\`), from
   * the boot build + the worker's own href — the PATH half of
   * \`runtime.getBuildEntry\`. Null on dev (no version path) or unknown build.
   */
  private bootBuildEntryPath(): string | null {
    const workerHref =
      (globalThis as { location?: { href?: string } }).location?.href ?? ''
    const url = buildEntryUrl(workerHref, this._bootBuild)
    if (!url) return null
    try {
      return new URL(url).pathname
    } catch {
      return null
    }
  }

  /**
   * Connected devices (websocket connections only) for the Remote access page (F-24). `userAgent` is
   * the client's own claim: shown, never trusted. No peer IP: only the C++ listener sees it.
   */
  private remoteDeviceRows(): RemoteState['connections'] {
    return this.connections
      .list()
      .filter(info => info.transport === 'websocket')
      .map(info => ({
        connectionId: info.connectionId,
        clientId: info.clientId,
        kind: info.kind,
        scope: info.scope.mode,
        connectedAt: info.connectedAt,
        ...(info.userAgent !== undefined ? { userAgent: info.userAgent } : {}),
      }))
  }

  /** Publish the current \`remote/state\` (relay + secret-less pairings). */
  publishRemoteState(): void {
    const state: RemoteState = {
      relay: this.relay.state,
      ...(this.relay.state === 'error' && this.relayErrorText ? { relayError: this.relayErrorText } : {}),
      pairings: this.pairings.list(),
      access: this.remoteAccess.access(),
      connections: this.remoteDeviceRows(),
    }
    this.broker.publish(REMOTE_STATE_TOPIC, state, { type: 'state' })
  }

  /** The direct transport was replaced (or dropped): refresh what handlers read per call. */
  handleDirectTransportChanged(transport: DirectPortBridgeTransport | null): void {
    const fs = this.fsOver(transport)
    this.context.fs = fs
    this.context.host = transport
      ? hostBridgeOver(transport, () => this.host.createBridgeRequestId())
      : null
    this.context.webUiBridge.fs = fs
    this.context.webUiBridge.directBridge = transport
    // A new bridge is the one moment the host's identity can be asked for
    // (and the only moment it can change: a different binary).
    this.refreshHostIdentity()
    if (transport) void this.ensureHomeDir()
  }

  /**
   * Contract: resolves once the user's home is known or the host could not
   * say; never rejects. Settings and plugin writes anchor `~/.velloc` on
   * `context.homeDir`, and an empty one would land them relative to the
   * browser's working directory.
   */
  private ensureHomeDir(): Promise<void> {
    if (this.context.homeDir || !this.host.resolveHomeDir) return Promise.resolve()
    this.homeProbe ??= this.host
      .resolveHomeDir()
      .then(
        home => {
          if (home && !this.context.homeDir) this.setHomeDir(home)
        },
        () => {},
      )
      .finally(() => {
        this.homeProbe = null
      })
    return this.homeProbe
  }

  private setHomeDir(homeDir: string): void {
    this.context.homeDir = homeDir
    this.context.webUiBridge.homeDir = homeDir
  }

  /**
   * A settings adapter announced a change (`ctx.broadcastEvent`): it becomes a
   * `settings/<cap>` delta typed by action. Shell events have their own
   * capability (`shell.*` → `shell/<panelId>`).
   */
  publishLegacyBroadcast(route: BrowserBridgeRoute, payload: Record<string, unknown>): void {
    if (!isLegacyWebUiCapability(route.capability)) return
    this.broker.publish(topic.settings(route.capability), payload, { type: route.action })
  }

  /**
   * A worker-side boot stage for a panel's overlay (the runtime build's
   * `connectingTools` / `restoring`). Same topic as the guest's own stages,
   * with the panel's single-source and dismissal rules applied here.
   */
  publishBootStage(panelId: string, sessionId: string, stage: string): void {
    if (!this.shell.claimsBootStage(panelId, sessionId)) return
    const payload = { stage }
    this.shell.apply(panelId, 'publishBootProgress', payload)
    this.broker.publish(topic.shell(panelId), payload, { type: SHELL_EVENT_OF.publishBootProgress })
  }

  /**
   * Ask for the user's attention. Published, never dispatched: the desktop
   * shell turns it into a host toast, another client shows it its own way, and
   * a runtime nobody is connected to simply has no one to tell. A notification
   * about a session names the panel that owns it, so that ONE desktop window
   * asks the host rather than every window (`notificationIsForPanel`).
   */
  notify(notification: RuntimeNotification, kind: NotificationKind = 'turnEnd'): void {
    const panelId =
      notification.sessionId !== undefined ? this.host.panelOfSession?.(notification.sessionId) : undefined
    this.broker.publish(
      NOTIFICATIONS_TOPIC,
      { ...notification, ...(panelId !== undefined ? { panelId } : {}) },
      { type: kind },
    )
  }

  publish(id: TopicId, payload: unknown, opts?: PublishOptions): number {
    return this.broker.publish(id, payload, opts)
  }

  list(): readonly ConnectionInfo[] {
    return this.connections.list()
  }

  /** The ISO build stamp of the page that started this runtime, or null. */
  get bootBuild(): string | null {
    return this._bootBuild
  }

  /**
   * Record the build a booting page reported (hello.client.build).
   * First-writer-wins: a later window may run a NEWER page against an OLDER
   * already-running worker (the HTML cache updated in between), and the
   * runtime's identity is the build that booted it — never overwritten.
   * Stores a plain string, not a client reference (09-10 R8).
   */
  private noteHelloBuild(hello: { auth: { mode: string }; client: { kind: string; build?: string } }): void {
    if (this._bootBuild !== null) return
    if (hello.auth.mode !== 'local') return
    if (hello.client.kind !== 'desktop-shell') return
    if (!hello.client.build || !buildKeyFromBuildTime(hello.client.build)) return
    this._bootBuild = hello.client.build
  }

  closeAll(code: ByeCode): void {
    this.connections.closeAll(code)
  }

  /** Close every connection and stop the connection hub's heartbeat reaper: the runtime is going away. */
  dispose(code: ByeCode = 'shutting_down'): void {
    this.pluginUpdates.dispose()
    this.connections.dispose(code)
  }

  private fsOver(transport: DirectPortBridgeTransport | null) {
    return transport
      ? createBrowserFsOperations({
          transport,
          createRequestId: () => this.host.createBridgeRequestId(),
          initialCwd: '.',
        })
      : processFs()
  }

  private bootstrap(): WelcomeFrame['bootstrap'] {
    const homeDir = this.context.homeDir
    const platform =
      (globalThis as { navigator?: { platform?: string } }).navigator?.platform ?? 'unknown'
    return {
      homeDir,
      platform,
      pathSep: homeDir.includes('\\') ? '\\' : '/',
      ...this.hostIdentity,
    }
  }

  /**
   * Ask the host for this machine's identity once per direct transport (F-24), ahead of
   * `welcome.bootstrap`. A host that cannot answer leaves the fields absent; failures are silent.
   */
  private hostIdentity: { hostName?: string; osName?: string } = {}

  private refreshHostIdentity(): void {
    const host = this.context.host
    if (!host) return
    void host
      .request({ namespace: 'nexus', capability: 'appInfo', action: 'getVersionInfo' }, {})
      .then(reply => {
        if (!reply.ok) return
        const result = reply.result as { hostName?: unknown; osName?: unknown } | null
        if (!result || typeof result !== 'object') return
        const next: { hostName?: string; osName?: string } = {}
        if (typeof result.hostName === 'string' && result.hostName) {
          next.hostName = result.hostName
        }
        if (typeof result.osName === 'string' && result.osName) next.osName = result.osName
        this.hostIdentity = next
      })
      .catch(() => {
        // Identity is decoration; a host that cannot answer changes nothing.
      })
  }
}

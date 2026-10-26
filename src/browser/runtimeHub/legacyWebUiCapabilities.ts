/**
 * Security: the ten settings capabilities of the WebUI handlers, wrapped onto the hub. Every action
 * declares a scope: `observe` to read and `control` to write by default; `manager` for provider and
 * MCP secrets; `full` for what needs the local machine (walking its directories, plugin/skill
 * installs, session imports, host code). Action lists are typed against `BrowserBridgeCapabilityMap`.
 */
import type {
  BrowserBridgeAction,
  BrowserBridgeCapability,
  BrowserBridgeRoute,
} from '../bridge/protocol/core'
import type { WebUiBridgeHandler } from '../worker/webUiBridge/registry'
import { wireError, type Scope, type ScopeMode } from '../runtimeProtocol'
import type { CapabilityRegistry } from './CapabilityRegistry'
import { legacyBridgeErrorToWire } from './errors'
import { knownProjectRootOrRefuse } from './knownProjects'
import type { ActionSpec, CapabilityDefinition, ConnectionInfo } from './types'

type LegacyTable = {
  readonly [C in BrowserBridgeCapability]?: Partial<Record<BrowserBridgeAction<C>, ScopeMode>>
}

export const LEGACY_WEBUI_CAPABILITIES = {
  // Which skills and features are on. No secret, no host path.
  features: { catalog: 'observe', snapshot: 'observe', setEnabled: 'control' },
  // Agent limits and debug switches (maxTurns, log, trace), and the global
  // default model for new sessions — a pick any client may make, as it may
  // pick a session's model (`session.setModelSelection` is `control` too).
  agent: { snapshot: 'observe', setField: 'control', setModel: 'control' },
  // The user's identity and their own agent instructions.
  profile: { snapshot: 'observe', setField: 'control' },
  memory: {
    // The live toggles. The memory DIRECTORY is a host path outside any
    // session, so neither action carries it: `snapshot` leaves it out and
    // `setField` refuses it (settings.json-only). A UI input for it would
    // need its own `full` action.
    snapshot: 'observe',
    setField: 'control',
    // These name and read the user's memory directory and the project's
    // instruction files — host paths, outside any session's root.
    list: 'full',
    clear: 'full',
    instructions: 'full',
    userInstructions: 'full',
    writeUserInstructions: 'full',
    // Import (user decision: a remote page imports the HOST's
    // data): each reads only its source's fixed root (`~/.claude/projects`,
    // `~/.codex`) and adds to the Velloc store add-only; `importProject`'s
    // slug is one safe segment (`assertSafeSlug`).
    listImportableProjects: 'control',
    importProject: 'control',
    listImportableGlobalMemory: 'control',
    importGlobalMemory: 'control',
  },
  // The tier dictionary and which model each session type routes to.
  sessionModels: { snapshot: 'observe', autoTiers: 'observe', setField: 'control' },
  // A server config carries its launch command and env — where MCP secrets
  // live. A manager may hold them (a remote the owner trusts with providers).
  // `testConnect` connects the config the form holds: a manager may already
  // save that same config, and the runtime launches a saved server on its
  // own, so a pre-save probe grants nothing the upsert does not.
  mcpSettings: { list: 'manager', upsert: 'manager', remove: 'manager', testConnect: 'manager' },
  plugins: {
    // The catalogs themselves are public listings. `listMarketplacePlugins`
    // reads the LOCAL manifest only; re-fetching is `refreshMarketplace`
    // below. A payload flag must never turn an `observe` row into that write.
    listInstalled: 'observe',
    listMarketplaces: 'observe',
    listMarketplacePlugins: 'observe',
    // The product's own built-ins and their switch state: no host data.
    listBuiltin: 'observe',
    // Enabling re-activates an installed plugin's hooks and MCP servers: host
    // code that runs in every session, not only the ones a connection may
    // drive. The write hot-reloads all of them, the same fan-out as
    // `session.reloadPlugins` (manager). Disabling can switch off a hook the
    // owner relies on, just as widely. A manager can already define host code
    // (`mcpSettings.upsert`); a control client cannot.
    setEnabled: 'manager',
    // The same fan-out for a directory plugin (its folder in or out of the
    // allowlist file); the folder itself is untouched.
    setLocalEnabled: 'manager',
    // Names every sidebar project's folder — more than a session-bound
    // connection may see; the same grant as switching one.
    listLocal: 'manager',
    // Installing fetches code and writes it to the host's disk.
    install: 'full',
    installFromDirectory: 'full',
    uninstall: 'full',
    // Deletes a directory plugin's folder from the host's disk.
    removeLocal: 'full',
    refreshMarketplace: 'full',
    // A marketplace added here is a source installs and updates fetch code
    // from; removing one stops its updates.
    addMarketplace: 'full',
    removeMarketplace: 'full',
    // Which declared settings are unset (names and text, never values), and
    // their write, which reloads every session's plugins — as
    // `providers.modOptions` / `setModOptions`.
    requiredSettings: 'manager',
    setSettings: 'manager',
  },
  skills: {
    listInstalled: 'observe',
    // Reloads every open session's skills when the on-disk set changed (a
    // hand-dropped folder) — the same fan-out `importLocal` makes at
    // `control`, so an observer's listing cannot trigger it.
    rescan: 'control',
    // Install writes into `~/.velloc/skills` from anywhere; uninstall deletes.
    install: 'full',
    uninstall: 'full',
    // Import (user decision): lists / copies one skill from the
    // source's fixed skills root; `importLocal`'s `dir` is one safe segment
    // (`importLocalSkill`), and an existing skill is left untouched.
    listImportable: 'control',
    importLocal: 'control',
  },
  // Import another product's sessions (user decision: a remote
  // page imports the HOST's sessions). Reads stay under the source's fixed
  // root (`readSession` validates the path — `isUnderRoot` + a session file);
  // `writeSession` adds a new session and never touches an existing id. The
  // folder it binds the new session to is held to the known-project rule
  // below `full` (`bindImportedProjectRoot`), as `session.open` is.
  sessionImport: { detect: 'control', listSessions: 'control', readSession: 'control', writeSession: 'control' },
  // Provider configs carry API keys. A manager may hold them — setting a key
  // from a trusted remote is the manager scope's reason to exist.
  // `verify` sends the stored key to its provider, and `modelFamilies` may
  // rewrite the model list (removing entries the provider dropped) — the same
  // reach as the writes that stored them; `setModelEntries` is such a write.
  providers: {
    list: 'manager', upsert: 'manager', remove: 'manager', setActive: 'manager', setOrder: 'manager',
    // `freshModelIds` makes the provider re-list (and a gateway reconcile).
    verify: 'manager', modelFamilies: 'manager', setModelEntries: 'manager', setUserModels: 'manager', dismissRemoved: 'manager', freshModelIds: 'manager',
    // A provider mod's plugin options: the read shows values (sensitive ones
    // never), the write reloads every session's plugins — as `mods.setOptions`.
    modOptions: 'manager', setModOptions: 'manager',
  },
} as const satisfies LegacyTable

export type LegacyWebUiCapability = keyof typeof LEGACY_WEBUI_CAPABILITIES

export function isLegacyWebUiCapability(cap: string): cap is LegacyWebUiCapability {
  return Object.prototype.hasOwnProperty.call(LEGACY_WEBUI_CAPABILITIES, cap)
}

export type LegacyWebUiDeps = {
  /** Populates the legacy registry (idempotent) — `initBuiltinWebUiBridgeHandlers`. */
  primeLegacyHandlers(): void
  /** `getWebUiBridgeHandler` — read per call so a test can swap a handler. */
  getHandler(cap: string): WebUiBridgeHandler | undefined
  /**
   * The folders a connection with this session scope may name below `full`
   * (`RuntimeHub.knownProjectRoots`). Absent: none are known, so a scoped
   * `sessionImport.writeSession` may bind no folder at all.
   */
  knownProjectRoots?(sessionScope: Scope['sessions']): Promise<readonly string[]>
}

/**
 * Security: below `full`, every folder `sessionImport.writeSession` would bind (`result.projectRoot`,
 * `result.meta.metadata.projectRoot`, each sub-agent's) must be a known project, rewritten to the
 * runtime's spelling, or `forbidden_scope`. An absent field stays absent.
 */
export async function bindImportedProjectRoot(
  payload: unknown,
  conn: ConnectionInfo,
  known: (sessionScope: Scope['sessions']) => Promise<readonly string[]>,
): Promise<unknown> {
  if (conn.scope.mode === 'full') return payload
  const result = (payload as { result?: Record<string, unknown> } | null)?.result
  if (!result || typeof result !== 'object') return payload
  let roots: readonly string[] | undefined
  const check = async (requested: unknown): Promise<string> =>
    knownProjectRootOrRefuse(requested, (roots ??= await known(conn.scope.sessions)), 'sessionImport.writeSession')
  const bindMeta = async (meta: unknown): Promise<unknown> => {
    const metadata = (meta as { metadata?: Record<string, unknown> } | null | undefined)?.metadata
    if (!metadata || typeof metadata !== 'object' || metadata.projectRoot === undefined) return meta
    return { ...(meta as object), metadata: { ...metadata, projectRoot: await check(metadata.projectRoot) } }
  }
  const bound: Record<string, unknown> = { ...result }
  if (result.projectRoot !== undefined) bound.projectRoot = await check(result.projectRoot)
  if (result.meta !== undefined) bound.meta = await bindMeta(result.meta)
  if (Array.isArray(result.subAgents)) {
    const subAgents: unknown[] = []
    for (const sub of result.subAgents) {
      subAgents.push(
        sub && typeof sub === 'object' && 'meta' in sub
          ? { ...(sub as object), meta: await bindMeta((sub as { meta: unknown }).meta) }
          : sub,
      )
    }
    bound.subAgents = subAgents
  }
  return { ...(payload as object), result: bound }
}

/** One `CapabilityDefinition` per legacy capability. */
export function legacyWebUiCapabilityDefinitions(deps: LegacyWebUiDeps): CapabilityDefinition[] {
  const known = deps.knownProjectRoots ?? (async () => [])
  return Object.entries(LEGACY_WEBUI_CAPABILITIES).map(([cap, acts]) => {
    const actions: Record<string, ActionSpec> = {}
    for (const [act, scope] of Object.entries(acts as Record<string, ScopeMode>)) {
      actions[act] = { scope }
    }
    return {
      cap,
      actions,
      handle: async (request, ctx) => {
        deps.primeLegacyHandlers()
        const handler = deps.getHandler(cap)
        if (!handler) {
          throw wireError('unknown_route', `legacy WebUI handler for '${cap}' is not registered`)
        }
        const route = {
          namespace: 'nexus',
          capability: cap,
          action: request.route.act,
        } as BrowserBridgeRoute
        const payload =
          cap === 'sessionImport' && request.route.act === 'writeSession'
            ? await bindImportedProjectRoot(request.payload, request.conn, known)
            : request.payload
        const response = await handler(
          { id: request.id, route, payload: payload as never },
          ctx.webUiBridge,
        )
        if (!response.ok) throw legacyBridgeErrorToWire(response.error)
        return offerNestedBytes(response.result, bytes => request.blobs.offer(bytes))
      },
    }
  })
}

/**
 * Replace every nested `Uint8Array` in a handler result with an offered `BlobRef` (JSON frames cannot
 * carry bytes); the bytes follow the `res` as chunks. A result without bytes is returned as is.
 */
export function offerNestedBytes(
  value: unknown,
  offer: (bytes: Uint8Array) => unknown,
): unknown {
  if (value instanceof Uint8Array) return offer(value)
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map(item => {
      const next = offerNestedBytes(item, offer)
      if (next !== item) changed = true
      return next
    })
    return changed ? out : value
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      const next = offerNestedBytes(item, offer)
      if (next !== item) changed = true
      out[key] = next
    }
    return changed ? out : value
  }
  return value
}

export function registerLegacyWebUiCapabilities(
  registry: CapabilityRegistry,
  deps: LegacyWebUiDeps,
): void {
  for (const def of legacyWebUiCapabilityDefinitions(deps)) registry.registerCapability(def)
}

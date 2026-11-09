/**
 * The apps' background modules, booted with the realm (F-40): the
 * contributions host's published apps that declare a `background` are
 * synced into the one `AppBackgroundRuntime`, created the first time there
 * is one — a realm with no such app never loads the runtime's code.
 */

import type { BrowserBridgeTransport } from '../../browser/bridge/browserBridgeProtocol'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import { onProviderModUpdatesChanged } from '../../pluginHost/providerModUpdateHolder'
import type { Grant } from '../../pluginHost/providerGrant'
import { readConsentedGrants } from '../../pluginHost/providerPluginConsent'
import { getNexusAppDir } from '../../utils/conversationStoragePaths'
import { joinRuntimePath } from '../../utils/runtimePaths'
import { getModUiContributionsHost, type AppBackgroundTemplate } from '../ui/contributionsHost'
import { setAppActionDispatch, setAppViewDispatch } from './appActionBus'
import type { AppAgentRunner } from './appAgentRun'
import type { AppBackgroundRef, AppBackgroundRuntime } from './AppBackgroundRuntime'
import { coversFolderScopes, expandScopeFolder, type FolderScopes } from './appFolderScopes'

/** Where an app with a `background` and no `data` file keeps its state, under the app's folder. */
export const APP_STATE_DEFAULT_FILE = 'data/state.json'

export type AppBackgroundBootDeps = {
  homeDir: string
  fs: RuntimeFs
  transport: () => BrowserBridgeTransport | null
  locale?: () => string | undefined
  /** The host environment a plugin's MCP server's `${VAR}` resolves with, as a session's. */
  env?: () => Readonly<Record<string, string>> | undefined
  report?: (line: string) => void
  /** The realm's headless spawn for `$.app.analyze`. Absent: every run fails as unavailable. */
  runAgent?: AppAgentRunner
}

export type AppBackgroundBootSeams = {
  /** The published apps with a background module; default the contributions host's. */
  apps?: () => AppBackgroundTemplate[]
  /** Runs `listener` when the published apps changed; default the contributions host's. */
  onChanged?: (listener: () => void) => () => void
  /** Builds the runtime; default the factory. */
  createRuntime?: (deps: AppBackgroundBootDeps & { onBadge: (appId: string, count: number | null) => void }) => Promise<AppBackgroundRuntime>
  /** Where a module's badge goes; default the contributions host's app entry. */
  badge?: (appId: string, count: number | null) => void
}

/** The folders the person approved for a plugin; `'exempt'` for a hand-placed one. */
export type ApprovedFolders = FolderScopes | 'exempt' | undefined

/**
 * Security: the module reaches its declared folders only when the consent on
 * file covers every one of them as declared; a declared set not covered
 * leaves `$.fs` in the app's folder, and the boot reports it. It may run the
 * agent only when it declares `agent` and the consent on file approved agent
 * runs (or the plugin is hand-placed).
 */
export function appBackgroundRef(
  homeDir: string,
  app: AppBackgroundTemplate,
  approved: ApprovedFolders,
  agentApproved: boolean = approved === 'exempt',
): AppBackgroundRef {
  const folder = getNexusAppDir(homeDir, app.appId)
  const stateFile = joinRuntimePath(folder, ...(app.decl.data ?? APP_STATE_DEFAULT_FILE).split('/'))
  const declared = app.decl.backgroundFs
  const granted = declared && (approved === 'exempt' || coversFolderScopes(approved, declared))
  return {
    plugin: app.plugin,
    path: app.module,
    root: app.root,
    provenance: app.owner,
    appId: app.appId,
    folder,
    stateFile,
    mcpOwner: app.mcp,
    ...(app.decl.backgroundAgent && agentApproved ? { agentType: app.type } : {}),
    ...(granted
      ? {
          folders: {
            read: declared.read.map(scope => expandScopeFolder(scope, homeDir)),
            write: declared.write.map(scope => expandScopeFolder(scope, homeDir)),
          },
        }
      : {}),
  }
}

type Approval = { folders: ApprovedFolders; agent: boolean }

/** What the person approved per published app, from the consent file; a hand-placed plugin is exempt. */
async function approvalsOf(deps: AppBackgroundBootDeps, apps: readonly AppBackgroundTemplate[]): Promise<Map<string, Approval>> {
  const out = new Map<string, Approval>()
  const needing = apps.filter(app => (app.decl.backgroundFs || app.decl.backgroundAgent) && app.consentId)
  const grants: Map<string, Grant> = needing.length > 0 ? await readConsentedGrants({ homeDir: deps.homeDir }, deps.fs) : new Map()
  for (const app of apps) {
    const grant = app.consentId ? grants.get(app.consentId) : undefined
    out.set(app.appId, app.consentId ? { folders: grant?.folders, agent: grant?.agent === true } : { folders: 'exempt', agent: true })
  }
  return out
}

type Booted = {
  runtime: AppBackgroundRuntime | null
  creating: Promise<AppBackgroundRuntime> | null
  stop: () => void
  sync: () => Promise<void>
}

let booted: Booted | null = null

/** Starts following the published apps; idempotent. Never rejects. */
export async function bootAppBackground(deps: AppBackgroundBootDeps, seams: AppBackgroundBootSeams = {}): Promise<void> {
  if (booted) return
  const report = deps.report ?? ((line: string) => console.warn(`[mods/app] ${line}`))
  const host = getModUiContributionsHost()
  const apps = seams.apps ?? (() => host.backgroundApps())
  // A consent change (approve, update, rollback) moves the approved folders without a publish.
  const onChanged =
    seams.onChanged ??
    ((listener: () => void) => {
      const stopHost = host.onChanged(() => listener())
      const stopConsent = onProviderModUpdatesChanged(listener)
      return () => {
        stopHost()
        stopConsent()
      }
    })
  const unapproved = new Set<string>()
  const onBadge = seams.badge ?? ((appId: string, count: number | null) => host.setAppBadge(appId, count))
  const createRuntime =
    seams.createRuntime ??
    (async (bootDeps: AppBackgroundBootDeps & { onBadge: typeof onBadge }) => {
      const { createAppBackgroundRuntime } = await import('./appBackgroundRuntimeFactory')
      return createAppBackgroundRuntime({ ...bootDeps, report })
    })
  const state: Booted = {
    runtime: null,
    creating: null,
    stop: () => undefined,
    sync: async () => {
      const refsOf = async (): Promise<AppBackgroundRef[]> => {
        const published = apps()
        const approvals = await approvalsOf(deps, published)
        return published.map(app => {
          const approval = approvals.get(app.appId)
          const ref = appBackgroundRef(deps.homeDir, app, approval?.folders, approval?.agent === true)
          const key = `${app.plugin}\u0000${app.appId}\u0000${JSON.stringify(app.decl.backgroundFs ?? null)}`
          if (!app.decl.backgroundFs || ref.folders) {
            unapproved.delete(key)
          } else if (!unapproved.has(key)) {
            unapproved.add(key)
            report(`${app.plugin}: the folders ${app.appId} declares are not approved; its $.fs stays in the app's folder`)
          }
          const agentKey = `${app.plugin}\u0000${app.appId}\u0000agent`
          if (!app.decl.backgroundAgent || ref.agentType) {
            unapproved.delete(agentKey)
          } else if (!unapproved.has(agentKey)) {
            unapproved.add(agentKey)
            report(`${app.plugin}: the agent runs ${app.appId} declares are not approved; its $.app.analyze is refused`)
          }
          return ref
        })
      }
      const refs = await refsOf()
      if (refs.length === 0 && !state.runtime && !state.creating) return
      if (!state.runtime) {
        state.creating ??= createRuntime({ ...deps, onBadge })
        try {
          state.runtime = await state.creating
        } catch (error) {
          state.creating = null
          report(`the app background runtime could not start (${error instanceof Error ? error.message : String(error)})`)
          return
        }
        if (booted !== state) {
          await state.runtime.dispose()
          return
        }
        const runtime = state.runtime
        setAppActionDispatch((appId, action, context, sessionId) => runtime.action(appId, action, context, sessionId))
        setAppViewDispatch({
          view: (appId, sessionId, client, layout) => runtime.view(appId, sessionId, client, layout),
          clientGone: client => runtime.viewClientGone(client),
          sessionGone: (appId, sessionId) => runtime.viewSessionGone(appId, sessionId),
        })
      }
      state.runtime.sync(refs)
    },
  }
  booted = state
  let chain: Promise<void> = Promise.resolve()
  const syncLater = () => {
    chain = chain.then(() => state.sync()).catch(() => undefined)
    return chain
  }
  state.stop = onChanged(() => void syncLater())
  await syncLater()
}

/** The booted runtime, for status readers; null before one was needed. */
export function appBackgroundRuntime(): AppBackgroundRuntime | null {
  return booted?.runtime ?? null
}

export async function resetAppBackgroundBootForTests(): Promise<void> {
  const state = booted
  booted = null
  setAppActionDispatch(undefined)
  setAppViewDispatch(undefined)
  if (!state) return
  state.stop()
  const runtime = state.runtime ?? (state.creating ? await state.creating.catch(() => null) : null)
  await runtime?.dispose()
}

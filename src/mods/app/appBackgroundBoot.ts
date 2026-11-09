/**
 * The apps' background modules, booted with the realm (F-40): the
 * contributions host's published apps that declare a `background` are
 * synced into the one `AppBackgroundRuntime`, created the first time there
 * is one — a realm with no such app never loads the runtime's code.
 */

import type { BrowserBridgeTransport } from '../../browser/bridge/browserBridgeProtocol'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import { getNexusAppDir } from '../../utils/conversationStoragePaths'
import { joinRuntimePath } from '../../utils/runtimePaths'
import { getModUiContributionsHost, type AppBackgroundTemplate } from '../ui/contributionsHost'
import type { AppBackgroundRef, AppBackgroundRuntime } from './AppBackgroundRuntime'

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
}

export type AppBackgroundBootSeams = {
  /** The published apps with a background module; default the contributions host's. */
  apps?: () => AppBackgroundTemplate[]
  /** Runs `listener` when the published apps changed; default the contributions host's. */
  onChanged?: (listener: () => void) => () => void
  /** Builds the runtime; default the factory. */
  createRuntime?: (deps: AppBackgroundBootDeps) => Promise<AppBackgroundRuntime>
}

export function appBackgroundRef(homeDir: string, app: AppBackgroundTemplate): AppBackgroundRef {
  const folder = getNexusAppDir(homeDir, app.appId)
  const stateFile = joinRuntimePath(folder, ...(app.decl.data ?? APP_STATE_DEFAULT_FILE).split('/'))
  return {
    plugin: app.plugin,
    path: app.module,
    root: app.root,
    provenance: app.owner,
    appId: app.appId,
    folder,
    stateFile,
    mcpOwner: app.mcp,
  }
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
  const onChanged = seams.onChanged ?? ((listener: () => void) => host.onChanged(() => listener()))
  const createRuntime =
    seams.createRuntime ??
    (async (bootDeps: AppBackgroundBootDeps) => {
      const { createAppBackgroundRuntime } = await import('./appBackgroundRuntimeFactory')
      return createAppBackgroundRuntime({ ...bootDeps, report })
    })
  const state: Booted = {
    runtime: null,
    creating: null,
    stop: () => undefined,
    sync: async () => {
      const refs = apps().map(app => appBackgroundRef(deps.homeDir, app))
      if (refs.length === 0 && !state.runtime && !state.creating) return
      if (!state.runtime) {
        state.creating ??= createRuntime(deps)
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
      }
      state.runtime.sync(apps().map(app => appBackgroundRef(deps.homeDir, app)))
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
  if (!state) return
  state.stop()
  const runtime = state.runtime ?? (state.creating ? await state.creating.catch(() => null) : null)
  await runtime?.dispose()
}

/**
 * Worker-side handlers for the `skills` bridge namespace (SharedWorker, NOT
 * routed to C++). `directBridge` is forwarded so downloads use `network.httpGet`:
 * the SharedWorker's CSP blocks `raw.githubusercontent.com`.
 */

import type {
  BrowserBridgeRequest,
  BrowserBridgeResponse,
  SkillsBridgeActionMap,
} from '../protocol'
import type { BrowserBridgeTransport } from '../protocol/core'
import type { RuntimeFs } from '../../../utils/fs/runtimeFs'
import { createBridgeBackedFetch } from '../../../pluginHost/bridgeBackedFetch'
import {
  getSkillsDirectory,
  installSkill,
  listInstalledSkills,
  uninstallSkill,
} from '../../../skillLibrary/skillInstall'
import {
  importLocalSkill,
  listImportableSkills,
  skillImportSourceRoot,
} from '../../../skillLibrary/skillImport'

export type SkillsAdapterContext = {
  /** The home dir that contains `.velloc/` (same as the plugins adapter). */
  homeDir: string
  /** Worker-side `RuntimeFs`. Bridge-backed in production. */
  fs: RuntimeFs
  /** Injected for tests; defaults to `new Date().toISOString()`. */
  now?: () => string
  /** Injected for tests. In production leave undefined and pass `directBridge`
   *  so downloads route through `network.httpGet` (CSP-safe). */
  fetchImpl?: typeof fetch
  directBridge?: BrowserBridgeTransport | null
  /** Re-read the on-disk skill set across every open session after an
   *  install/uninstall/import or a rescan that saw a change, so a freshly (un)installed skill becomes visible
   *  (`/name` slash picker + model listing) without needing a new session.
   *  Wired in `initBuiltinHandlers` to the same `reloadPluginsOnAllSessions`
   *  fan-out the plugins adapter uses — `loadLocalPromptCommands` re-reads the
   *  `~/.velloc/skills/` dir on that reload. Omitted in tests. */
  reloadSkills?: () => void
}

export type SkillsAction = keyof SkillsBridgeActionMap

function pickFetch(ctx: SkillsAdapterContext): typeof fetch {
  if (ctx.fetchImpl) return ctx.fetchImpl
  if (ctx.directBridge) {
    return createBridgeBackedFetch({
      transport: ctx.directBridge,
      createRequestId: () =>
        `skill-fetch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    })
  }
  return globalThis.fetch.bind(globalThis)
}

/** The on-disk skill set as of the last `rescan` or mutation (`undefined`
 *  before the first). Module-level: the worker builds a fresh ctx per request. */
let lastRescanSignature: string | undefined

function listingSignature(
  skills: SkillsBridgeActionMap['listInstalled']['result']['skills'],
): string {
  return skills
    .map(s => [s.id, s.dir, s.description ?? ''].join('|'))
    .sort()
    .join('||')
}

/** A mutation already fanned its own reload out — record the set it left, so
 *  the settings page's follow-up `rescan` does not reload a second time. */
async function noteSetAfterMutation(ctx: SkillsAdapterContext): Promise<void> {
  lastRescanSignature = listingSignature(
    await listInstalledSkills(ctx.homeDir, ctx.fs),
  )
}

/** Test seam — forget the last rescan so each test starts unseen. */
export function resetSkillsRescanSignatureForTests(): void {
  lastRescanSignature = undefined
}

/**
 * The listing is a READ. It is served at `observe` on the runtime protocol
 * (`legacyWebUiCapabilities.ts`), so it must not reach into every open
 * session — the reload that notices a hand-dropped folder is `rescan`, below.
 */
async function handleListInstalled(
  ctx: SkillsAdapterContext,
): Promise<SkillsBridgeActionMap['listInstalled']['result']> {
  return { skills: await listInstalledSkills(ctx.homeDir, ctx.fs) }
}

/**
 * The Skills page's rescan (`control`): makes a folder dropped into
 * `~/.velloc/skills/` usable NOW. Reloads sessions only on a change, except the
 * first rescan of a worker's life, which always reloads.
 */
async function handleRescan(
  ctx: SkillsAdapterContext,
): Promise<SkillsBridgeActionMap['rescan']['result']> {
  const signature = listingSignature(
    await listInstalledSkills(ctx.homeDir, ctx.fs),
  )
  if (signature === lastRescanSignature) return { reloaded: false }
  lastRescanSignature = signature
  ctx.reloadSkills?.()
  return { reloaded: true }
}

async function handleInstall(
  payload: SkillsBridgeActionMap['install']['payload'],
  ctx: SkillsAdapterContext,
): Promise<SkillsBridgeActionMap['install']['result']> {
  const { entry, fileCount } = await installSkill(payload.skill, {
    homeDir: ctx.homeDir,
    fs: ctx.fs,
    fetchImpl: pickFetch(ctx),
    now: ctx.now,
  })
  // Make the newly installed skill visible in already-open sessions.
  ctx.reloadSkills?.()
  await noteSetAfterMutation(ctx)
  return { ok: true, entry, fileCount }
}

async function handleUninstall(
  payload: SkillsBridgeActionMap['uninstall']['payload'],
  ctx: SkillsAdapterContext,
): Promise<SkillsBridgeActionMap['uninstall']['result']> {
  const removed = await uninstallSkill(payload.id, ctx.homeDir, ctx.fs)
  // Drop the uninstalled skill from already-open sessions.
  if (removed) {
    ctx.reloadSkills?.()
    await noteSetAfterMutation(ctx)
  }
  return { ok: true, removed }
}

async function handleListImportable(
  payload: SkillsBridgeActionMap['listImportable']['payload'],
  ctx: SkillsAdapterContext,
): Promise<SkillsBridgeActionMap['listImportable']['result']> {
  const rootPath = skillImportSourceRoot(payload.source, ctx.homeDir)
  const skills = await listImportableSkills(
    rootPath,
    getSkillsDirectory(ctx.homeDir),
    ctx.fs,
  )
  return { source: payload.source, rootPath, skills }
}

async function handleImportLocal(
  payload: SkillsBridgeActionMap['importLocal']['payload'],
  ctx: SkillsAdapterContext,
): Promise<SkillsBridgeActionMap['importLocal']['result']> {
  const rootPath = skillImportSourceRoot(payload.source, ctx.homeDir)
  const { entry, skipped } = await importLocalSkill(payload.dir, rootPath, {
    homeDir: ctx.homeDir,
    fs: ctx.fs,
    source: payload.source,
    now: ctx.now,
  })
  // Make the newly adopted skill visible in already-open sessions.
  if (!skipped) {
    ctx.reloadSkills?.()
    await noteSetAfterMutation(ctx)
  }
  return { ok: true, skipped, entry }
}

/**
 * Route a `skills/*` request to its handler. Caught throws surface as
 * `{ ok: false, error: { code: 'skills_handler_error' }}` envelopes.
 */
export async function handleSkillsBridgeRequest(
  request: BrowserBridgeRequest,
  ctx: SkillsAdapterContext,
): Promise<BrowserBridgeResponse> {
  const action = request.route.action as SkillsAction
  try {
    let result: unknown
    switch (action) {
      case 'listInstalled':
        result = await handleListInstalled(ctx)
        break
      case 'rescan':
        result = await handleRescan(ctx)
        break
      case 'install':
        result = await handleInstall(
          request.payload as SkillsBridgeActionMap['install']['payload'],
          ctx,
        )
        break
      case 'uninstall':
        result = await handleUninstall(
          request.payload as SkillsBridgeActionMap['uninstall']['payload'],
          ctx,
        )
        break
      case 'listImportable':
        result = await handleListImportable(
          request.payload as SkillsBridgeActionMap['listImportable']['payload'],
          ctx,
        )
        break
      case 'importLocal':
        result = await handleImportLocal(
          request.payload as SkillsBridgeActionMap['importLocal']['payload'],
          ctx,
        )
        break
      default: {
        const _exhaustive: never = action
        return {
          id: request.id,
          route: request.route,
          ok: false,
          error: {
            code: 'unknown_action',
            message: `Unknown skills action: ${String(_exhaustive)}`,
          },
        }
      }
    }
    return {
      id: request.id,
      route: request.route,
      ok: true,
      result,
    } as BrowserBridgeResponse
  } catch (e) {
    return {
      id: request.id,
      route: request.route,
      ok: false,
      error: {
        code: 'skills_handler_error',
        message: e instanceof Error ? e.message : String(e),
      },
    }
  }
}

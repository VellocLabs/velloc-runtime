/**
 * Contract: a desktop window's page runs the web build of the runtime that is alive. The runtime
 * lives in the shell's runtime host page and outlasts a window's page, so a page that loads again
 * (a crash, a second window) can come back as a newer build than the runtime; started as it is, it
 * would bring up a second runtime beside the first. Before the page creates the worker it reads
 * the alive locks: when a runtime of another build is alive and none of its own, it moves to that
 * build's immutable entry (`/runtime/v<N>/b/<key>/`). A page it moved there goes back to the
 * version root once no runtime is alive, so it does not stay on an old build. A dev server has no
 * build entries and never moves. (P-2)
 */
import { readBuildTimeFromDocument } from '../../branding/buildInfo'
import {
  RUNTIME_DEV_BUILD_KEY,
  liveRuntimeBuildKeys,
  runtimeBuildKey,
} from '../worker/runtimeAliveLock'

/** `sessionStorage`: the build key this tab last moved to, so one target is tried once. */
export const BUILD_FOLLOWED_KEY = 'nexus.buildFollowedTo'

const VERSION_ROOT = /^(\/runtime\/v[0-9]+\/)(?:b\/([^/]+)\/)?/

export type BuildFollowDeps = {
  locks?: Pick<LockManager, 'query'> | null
  location?: Pick<Location, 'origin' | 'pathname' | 'search' | 'hash' | 'replace'>
  fetch?: (url: string) => Promise<{ ok: boolean }>
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
  /** This page's build-time stamp; read from the document by default. */
  ownBuildIso?: string
}

/** The version root and the build key of an entry path; null off a `/runtime/v<N>/` path. */
export function parseRuntimePath(pathname: string): { root: string; entryKey: string | null } | null {
  const m = VERSION_ROOT.exec(pathname)
  return m ? { root: m[1], entryKey: m[2] ?? null } : null
}

function safeSessionStorage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

function read(storage: BuildFollowDeps['storage']): string | null {
  try {
    return storage?.getItem(BUILD_FOLLOWED_KEY) ?? null
  } catch {
    return null
  }
}

function write(storage: BuildFollowDeps['storage'], key: string | null): void {
  try {
    if (key === null) storage?.removeItem(BUILD_FOLLOWED_KEY)
    else storage?.setItem(BUILD_FOLLOWED_KEY, key)
  } catch {
    // No storage: the move still happens; a repeat is bounded by the entry check.
  }
}

/**
 * Move this page to the live runtime's build when it differs from the page's own. Resolves `true`
 * when the page is navigating away (the caller must not go on booting), `false` to boot as it is.
 * Never rejects.
 */
export async function followLiveRuntimeBuild(deps: BuildFollowDeps = {}): Promise<boolean> {
  try {
    const locks = deps.locks === undefined ? globalThis.navigator?.locks : deps.locks
    const location = deps.location ?? globalThis.location
    if (!locks || !location) return false
    const path = parseRuntimePath(location.pathname)
    if (!path) return false
    const storage = deps.storage === undefined ? safeSessionStorage() : deps.storage
    const ownKey = runtimeBuildKey(deps.ownBuildIso ?? readBuildTimeFromDocument())
    if (ownKey === RUNTIME_DEV_BUILD_KEY) return false

    const live = liveRuntimeBuildKeys((await locks.query()).held)
    if (live.includes(ownKey)) return false
    const followed = read(storage)
    const tail = `${location.search}${location.hash}`

    if (live.length === 0) {
      // Nothing to follow any more: leave the entry this tab was moved to.
      if (followed === null || path.entryKey !== followed) return false
      write(storage, null)
      location.replace(`${location.origin}${path.root}${tail}`)
      return true
    }

    const target = live[0]
    if (target === RUNTIME_DEV_BUILD_KEY || target === followed) return false
    const entry = `${location.origin}${path.root}b/${target}/`
    const probe = await (deps.fetch ?? ((url: string) => fetch(url, { credentials: 'same-origin' })))(entry)
    if (!probe.ok) return false
    write(storage, target)
    location.replace(`${entry}${tail}`)
    return true
  } catch {
    return false
  }
}

type FollowGlobal = { __nexusBuildFollow?: Promise<boolean> }

/** The page's one follow check: the early worker warm-up and the boot share its answer. */
export function followLiveRuntimeBuildOnce(): Promise<boolean> {
  const g = globalThis as FollowGlobal
  g.__nexusBuildFollow ??= followLiveRuntimeBuild()
  return g.__nexusBuildFollow
}

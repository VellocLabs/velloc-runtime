/**
 * Who the desktop is, as a remote page can know it (F-24).
 *
 * Kept apart from `RemoteHostIndicator.tsx` (which renders it) and from
 * `remoteBoot.tsx` (which supplies it) for one reason: both of those pull in
 * half the app — React and the whole runtime client respectively — and this
 * is three lines of string handling that wants a unit test.
 */

/** What the remote page knows about the desktop it is driving. */
export type DrivenDesktop = {
  /** `host:port` of the listener this page was served from — always known. */
  address: string
  /** The desktop's machine name, from `welcome.bootstrap` (absent on an older host). */
  hostName?: string
  /** The desktop's OS, from `welcome.bootstrap`. */
  osName?: string
  /** The account the runtime runs as, derived from `bootstrap.homeDir`. */
  userName?: string
}

/**
 * The account the desktop runs as, read off `bootstrap.homeDir` — the last
 * path segment, on either separator. A homeDir the host never sent (or a
 * value with no segment) names nobody, and the tooltip prints one line fewer
 * rather than an empty one.
 */
export function userNameFromHomeDir(homeDir: string | undefined): string | undefined {
  if (!homeDir) return undefined
  const segments = homeDir.split(/[/\\]+/).filter(Boolean)
  return segments.length > 0 ? segments[segments.length - 1] : undefined
}

/**
 * Assemble the identity from the two things a remote boot has: the address
 * its own page was served from, and `welcome.bootstrap`. Every field but the
 * address is optional — an older desktop simply names fewer lines.
 */
export function remoteHostFromBootstrap(
  address: string,
  bootstrap: { homeDir?: string; hostName?: string; osName?: string } | undefined,
): DrivenDesktop {
  const userName = userNameFromHomeDir(bootstrap?.homeDir)
  return {
    address,
    ...(bootstrap?.hostName ? { hostName: bootstrap.hostName } : {}),
    ...(bootstrap?.osName ? { osName: bootstrap.osName } : {}),
    ...(userName !== undefined ? { userName } : {}),
  }
}

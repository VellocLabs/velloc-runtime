// Bridge interface version — the compatibility contract with the C++ host. One
// source of truth: NEXUS_INTERFACE_VERSION in src/custom_browser/VERSION, synced
// into ./interfaceVersion.gen.ts by `check_interface_version.py --sync`.
// Enforced by URL (`{base}/v<N>/`), not handshake; dev paths skip it (G-3).

import { NEXUS_INTERFACE_VERSION } from './interfaceVersion.gen'

export { NEXUS_INTERFACE_VERSION }

export type UrlInterfaceVersionCheck =
  | { kind: 'match'; pathVersion: number }
  // No trailing `/v<K>/` segment: dev server, frozen pre-versioning root,
  // or a hand-hosted unversioned copy. The check does not apply.
  | { kind: 'unversioned' }
  | { kind: 'mismatch'; pathVersion: number; guestVersion: number }

// Only the LAST, trailing `/v<K>/` counts, so a self-hosted prefix like
// `/apps/v2/` never shadows it. A remote entry `/v<K>/b/<buildKey>/` matches only
// with the key's exact shape; anything else falls through to 'unversioned'.
const TRAILING_VERSION_SEGMENT =
  /\/v(\d+)\/(?:b\/[0-9]{8}T[0-9]{9}Z\/)?(?:index\.html)?$/

/**
 * Compare the `/v<K>/` the page was loaded from against this build's
 * NEXUS_INTERFACE_VERSION. A mismatch means the deploy placed the wrong
 * bundle at a versioned path (or a cache served one); boot must not
 * proceed — the bridge contracts differ.
 */
export function checkUrlInterfaceVersion(
  pathname: string,
): UrlInterfaceVersionCheck {
  const match = TRAILING_VERSION_SEGMENT.exec(pathname)
  if (!match) {
    return { kind: 'unversioned' }
  }
  const pathVersion = Number.parseInt(match[1], 10)
  if (pathVersion === NEXUS_INTERFACE_VERSION) {
    return { kind: 'match', pathVersion }
  }
  return {
    kind: 'mismatch',
    pathVersion,
    guestVersion: NEXUS_INTERFACE_VERSION,
  }
}

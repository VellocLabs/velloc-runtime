/**
 * The Customize screen's page (F-35): the directory's start page, on the
 * live site or on the e2e seam's origin.
 */
import { DIRECTORY_HOME_PATH } from '../../../customize/customizePageProtocol'
import { DIRECTORY_SITE_ORIGIN } from '../../../customize/directorySite'

/** The page's origin. An e2e run points it at a local server through a guest global. */
function directoryOrigin(): string {
  const override = (globalThis as { __NEXUS_E2E_CUSTOMIZE_ORIGIN__?: unknown }).__NEXUS_E2E_CUSTOMIZE_ORIGIN__
  return typeof override === 'string' && /^https?:\/\/[^/]+$/.test(override) ? override : DIRECTORY_SITE_ORIGIN
}

export function directoryUrl(): string {
  return `${directoryOrigin()}${DIRECTORY_HOME_PATH}`
}

/**
 * The Customize screen's pages (F-35): which marketplace page each segment
 * shows, and how a page path maps back to a segment.
 */

export const CUSTOMIZE_SEGMENTS = ['skills', 'connectors', 'plugins'] as const
export type CustomizeSegment = (typeof CUSTOMIZE_SEGMENTS)[number]

const CUSTOMIZE_ORIGIN = 'https://claude.ai'
const CUSTOMIZE_PATH_PREFIX = '/customize/'

export function isCustomizeSegment(value: unknown): value is CustomizeSegment {
  return typeof value === 'string' && (CUSTOMIZE_SEGMENTS as readonly string[]).includes(value)
}

/** The pages' origin. An e2e run points it at a local server through a guest global. */
function customizeOrigin(): string {
  const override = (globalThis as { __NEXUS_E2E_CUSTOMIZE_ORIGIN__?: unknown }).__NEXUS_E2E_CUSTOMIZE_ORIGIN__
  return typeof override === 'string' && /^https?:\/\/[^/]+$/.test(override) ? override : CUSTOMIZE_ORIGIN
}

export function customizeUrl(segment: CustomizeSegment): string {
  return `${customizeOrigin()}${CUSTOMIZE_PATH_PREFIX}${segment}`
}

/**
 * The segment a page path (or full URL) names, or null for any other page:
 * `/customize/skills`, with or without a trailing slash, query or fragment.
 */
export function segmentOfPath(pathOrUrl: string): CustomizeSegment | null {
  let path = pathOrUrl
  if (/^https?:/i.test(path)) {
    try {
      path = new URL(path).pathname
    } catch {
      return null
    }
  }
  path = path.split('?')[0]!.split('#')[0]!
  if (!path.startsWith(CUSTOMIZE_PATH_PREFIX)) return null
  const segment = path.slice(CUSTOMIZE_PATH_PREFIX.length).split('/')[0]
  return isCustomizeSegment(segment) ? segment : null
}

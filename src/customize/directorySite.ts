/**
 * The external directory site the Customize page shows (F-35): its host, its
 * public listing, and the page parts the page script acts on. Every
 * site-specific name lives here; the rest of the feature reads these.
 */

/** The site's host; its pages are served at `https://<host>`. */
export const DIRECTORY_SITE_HOST = 'claude.ai'
export const DIRECTORY_SITE_ORIGIN = `https://${DIRECTORY_SITE_HOST}`

/** Origin of the site's public listing (`/api/directory/plugins`, no sign-in, CORS `*`). */
export const DIRECTORY_API_ORIGIN = 'https://api.anthropic.com'

/** The directory's public listing, on its API origin. */
export const DIRECTORY_LIST_PATH = '/api/directory/plugins'

/** The site's cookie-preference cookie and the value that turns optional cookies off. */
export const DIRECTORY_CONSENT_COOKIE = 'anthropic-consent-preferences'
export const DIRECTORY_CONSENT_REFUSED = '{"analytics":false,"marketing":false}'

/** The consent banner's reject button. */
export const DIRECTORY_CONSENT_REJECT_SELECTOR = '[data-testid="consent-reject"]'

/** The header sign-in links (the sticky `dframe-header` bar, and any header or nav). */
export const DIRECTORY_HEADER_SIGN_IN_SELECTOR =
  '.dframe-header a[href^="/login"], header a[href^="/login"], nav a[href^="/login"]'

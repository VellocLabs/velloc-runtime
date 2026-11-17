/**
 * The page of an app drawn as one sandboxed page (F-42): the plugin's HTML
 * file and the topics its frame may read. The page reaches the runtime only
 * through a port its frame's creator caps to `observe` on these topics.
 * Session detail is given only on the person's consent to the plugin's grant.
 */

import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import type { ModsAppPageResult } from '../../browser/runtimeProtocol/modApps'
import type { Grant } from '../../pluginHost/providerGrant'
import { getModUiContributionsHost, insideRoot, type ModUiContributionsHost } from '../ui/contributionsHost'
import { SESSION_DETAIL_TOPICS } from './appPageTopics'

/** Security: the only topics a plugin page may be given without consent, whatever its manifest asks. */
export const APP_PAGE_TOPICS: readonly string[] = ['sessions', 'tasks']

/** The largest page file handed to a frame. */
export const APP_PAGE_MAX_BYTES = 4 * 1024 * 1024

/**
 * Security: the manifest's topics the host allows, in the manifest's order:
 * `APP_PAGE_TOPICS`, and the session-detail patterns only when the plugin's
 * grant has `sessionDetail`.
 */
export function allowedPageTopics(asked: readonly string[], grant?: Pick<Grant, 'sessionDetail'>): string[] {
  const detail = grant?.sessionDetail === true
  return asked.filter(topic => APP_PAGE_TOPICS.includes(topic) || (detail && SESSION_DETAIL_TOPICS.includes(topic)))
}

/** The grant the person approved for a plugin id in the consent file; undefined when none. */
export type ConsentedGrantOf = (consentId: string) => Promise<Grant | undefined>

/**
 * Reads the page of the published app `appId`; a refusal names why. A
 * hand-placed plugin (no consent id) is exempt from consent, as its folders are.
 */
export async function readAppPage(
  appId: string,
  fs: Pick<RuntimeFs, 'readFileBytes' | 'stat'>,
  host: Pick<ModUiContributionsHost, 'state' | 'appOf'> = getModUiContributionsHost(),
  consentedGrantOf: ConsentedGrantOf = async () => undefined,
): Promise<ModsAppPageResult> {
  const published = host.state().apps?.find(app => app.appId === appId)
  const app = published ? host.appOf(published.type) : undefined
  const page = app?.decl.page
  if (!app || !page || app.root === undefined) return { ok: false, message: `no app "${appId}" is drawn as a page` }
  const path = insideRoot(app.root, page.file)
  try {
    const stat = await fs.stat(path)
    if (!stat.isFile()) return { ok: false, message: `${page.file} is not a file` }
    if (stat.size > APP_PAGE_MAX_BYTES) {
      return { ok: false, message: `${page.file} is ${stat.size} bytes, over the ${APP_PAGE_MAX_BYTES}-byte limit` }
    }
    const bytes = await fs.readFileBytes(path, APP_PAGE_MAX_BYTES)
    const grant = app.consentId === undefined ? { sessionDetail: true as const } : await consentedGrantOf(app.consentId)
    return { ok: true, html: new TextDecoder().decode(bytes), topics: allowedPageTopics(page.topics, grant) }
  } catch (error) {
    return { ok: false, message: `${page.file} could not be read: ${error instanceof Error ? error.message : String(error)}` }
  }
}

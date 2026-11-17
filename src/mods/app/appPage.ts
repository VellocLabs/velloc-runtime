/**
 * The page of an app drawn as one sandboxed page (F-42): the plugin's HTML
 * file and the topics its frame may read. The page reaches the runtime only
 * through a port its frame's creator caps to `observe` on these topics.
 */

import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import { joinRuntimePath } from '../../utils/runtimePaths'
import type { ModsAppPageResult } from '../../browser/runtimeProtocol/modApps'
import { getModUiContributionsHost, type ModUiContributionsHost } from '../ui/contributionsHost'

/** Security: the only topics a plugin page may be given, whatever its manifest asks. */
export const APP_PAGE_TOPICS: readonly string[] = ['sessions', 'tasks']

/** The largest page file handed to a frame. */
export const APP_PAGE_MAX_BYTES = 4 * 1024 * 1024

/** The manifest's topics the host allows, in the manifest's order. */
export function allowedPageTopics(asked: readonly string[]): string[] {
  return asked.filter(topic => APP_PAGE_TOPICS.includes(topic))
}

/** Reads the page of the published app `appId`; a refusal names why. */
export async function readAppPage(
  appId: string,
  fs: Pick<RuntimeFs, 'readFileBytes' | 'stat'>,
  host: Pick<ModUiContributionsHost, 'state' | 'appOf'> = getModUiContributionsHost(),
): Promise<ModsAppPageResult> {
  const published = host.state().apps?.find(app => app.appId === appId)
  const app = published ? host.appOf(published.type) : undefined
  const page = app?.decl.page
  if (!app || !page || app.root === undefined) return { ok: false, message: `no app "${appId}" is drawn as a page` }
  const path = joinRuntimePath(app.root, ...page.file.replace(/^\.\//, '').split('/'))
  try {
    const stat = await fs.stat(path)
    if (!stat.isFile()) return { ok: false, message: `${page.file} is not a file` }
    if (stat.size > APP_PAGE_MAX_BYTES) {
      return { ok: false, message: `${page.file} is ${stat.size} bytes, over the ${APP_PAGE_MAX_BYTES}-byte limit` }
    }
    const bytes = await fs.readFileBytes(path, APP_PAGE_MAX_BYTES)
    return { ok: true, html: new TextDecoder().decode(bytes), topics: allowedPageTopics(page.topics) }
  } catch (error) {
    return { ok: false, message: `${page.file} could not be read: ${error instanceof Error ? error.message : String(error)}` }
  }
}

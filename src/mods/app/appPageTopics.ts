/**
 * The topic patterns an app page (F-42) may ask for: each session's detail.
 * Asking for one is part of the plugin's grant, so the person consents at
 * install. Pure.
 */

/** Any session's `session/<id>/state`: model, effort, folder, pending permissions. */
export const SESSION_STATE_PATTERN = 'session/*/state'
/** Any session's `turn/<id>`: its turn board. */
export const TURN_PATTERN = 'turn/*'
export const SESSION_DETAIL_TOPICS: readonly string[] = [SESSION_STATE_PATTERN, TURN_PATTERN]

export const isSessionDetailTopic = (topic: unknown): boolean =>
  typeof topic === 'string' && SESSION_DETAIL_TOPICS.includes(topic)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Whether an app page of `manifest` (parsed plugin.json or checked manifest) asks for a session-detail topic. */
export function manifestAsksSessionDetail(manifest: unknown): boolean {
  const templates = isRecord(manifest) && isRecord(manifest.templates) ? manifest.templates : undefined
  if (!templates) return false
  return Object.values(templates).some(decl => {
    const page = isRecord(decl) && isRecord(decl.app) && isRecord(decl.app.page) ? decl.app.page : undefined
    return Array.isArray(page?.topics) && page.topics.some(isSessionDetailTopic)
  })
}

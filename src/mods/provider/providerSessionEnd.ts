/**
 * A deleted session ends in the provider modules: `provider.sessionEnd` is raised
 * only in modules whose hooks are KNOWN to include it, within 5 s in all; the
 * session's stores are deleted whatever the hooks did. Nothing here rejects.
 */

import type { ProviderModRuntime } from './ProviderModRuntime'

export const PROVIDER_SESSION_END_BUDGET_MS = 5_000

export type SessionEnder = (sessionId: string) => Promise<void>

let ender: SessionEnder | undefined

/** Install (or, with undefined, remove) the ender. The factory's. */
export function setProviderSessionEnder(next: SessionEnder | undefined): void {
  ender = next
}

/** The session-deletion path's one call. Never rejects. */
export async function endProviderSessions(sessionIds: Iterable<string>): Promise<void> {
  const current = ender
  if (!current) return
  // Together, so a lead with teammates waits one budget, not one each.
  await Promise.all(
    [...new Set(sessionIds)].map(async sessionId => {
      try {
        await current(sessionId)
      } catch {
        // The ender reports its own failures.
      }
    }),
  )
}

export function createSessionEnder(options: {
  runtime: Pick<ProviderModRuntime, 'hasHook' | 'call'>
  /** Every provider id registered now. */
  providerIds: () => readonly string[]
  /** `endProviderSession` of the nouns: delete the session's stores. */
  end: (sessionId: string) => Promise<void>
  report: (line: string) => void
  budgetMs?: number
}): SessionEnder {
  const budgetMs = options.budgetMs ?? PROVIDER_SESSION_END_BUDGET_MS
  return async sessionId => {
    const asked = options.providerIds().filter(id => options.runtime.hasHook(id, 'provider.sessionEnd') === true)
    if (asked.length > 0) {
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const expired = new Promise<'expired'>(resolve => {
        timer = setTimeout(() => {
          controller.abort()
          resolve('expired')
        }, budgetMs)
      })
      const raised = Promise.allSettled(
        asked.map(id =>
          options.runtime.call(id, 'provider.sessionEnd', { sessionId, reason: 'deleted' }, { signal: controller.signal }),
        ),
      ).then(results => {
        results.forEach((result, index) => {
          if (result.status === 'rejected' && !controller.signal.aborted) {
            const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
            options.report(`${asked[index]}: provider.sessionEnd did not run: ${reason}`)
          }
        })
        return 'done' as const
      })
      try {
        if ((await Promise.race([raised, expired])) === 'expired') {
          options.report(`provider.sessionEnd: not finished within ${budgetMs} ms; the session's deletion went on`)
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        controller.abort()
      }
    }
    try {
      await options.end(sessionId)
    } catch (error) {
      options.report(`provider session stores of ${sessionId} were not deleted: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

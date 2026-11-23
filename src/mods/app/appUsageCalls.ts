/** `$.usage.query({ from, to, by, project?, tzOffsetMinutes? })` of an app's background module or script: the usage log, summed (F-27, F-40). */

/**
 * Security: what a module may read is fixed by the host, never by the module.
 * A router's settings app reads the `hour`, `day`, `switch` and `request`
 * groupings of the requests made through that router alone, and never a
 * project. An app Velloc ships reads every grouping across all routers,
 * including those that carry project roots and file paths. Any other app is
 * refused.
 */

import type { BrowserBridgeTransport } from '../../browser/bridge/browserBridgeProtocol'
import { INSIGHT_BY } from '../../models/usage/requestLogInsights'
import type { RequestLogQuery, RequestLogQueryResult } from '../../models/usage/requestLogStore'
import type { SettingsAppBinding } from './appProviderCalls'

/** The groupings with no path, project root or agent id in them. */
export const USAGE_ROUTER_BY: readonly string[] = Object.freeze(['hour', 'day', 'switch', 'request'])
/** Every grouping. */
export const USAGE_ALL_BY: readonly string[] = Object.freeze([...USAGE_ROUTER_BY, ...INSIGHT_BY])

export const USAGE_METHODS: readonly string[] = Object.freeze(['query'])

/** What the host lets one module read: one router's requests, or everything. */
export type UsageGrant = { router: string } | { all: true }

/** The grant of a module from its ref; null: `$.usage` is refused. */
export function usageGrantOf(settingsFor: SettingsAppBinding | undefined, builtin: boolean | undefined): UsageGrant | null {
  if (builtin === true) return { all: true }
  if (settingsFor?.router) return { router: settingsFor.providerId }
  return null
}

/** Why the module may not call `$.usage.<method>`, or null. */
export function refuseUsageCall(method: string, grant: UsageGrant | null): string | null {
  if (!grant) {
    return "$.usage is open to a router's settings app and to the apps Velloc ships, and this app is neither"
  }
  if (!USAGE_METHODS.includes(method)) return `$.usage.${method} does not exist — $.usage offers ${USAGE_METHODS.join(', ')}`
  return null
}

const notAllowed = (message: string): Error => {
  const error = new Error(message)
  error.name = 'NotAllowedError'
  return error
}

/** Reads the query as the module passed it, under its grant; throws a `TypeError` for a malformed one, `NotAllowedError` for one outside the grant. */
export function readUsageQuery(value: unknown, grant: UsageGrant): RequestLogQuery {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('$.usage.query({ from, to, by }): expected an object')
  }
  const { from, to, by, project, tzOffsetMinutes } = value as Record<string, unknown>
  if (typeof from !== 'number' || typeof to !== 'number') throw new TypeError('$.usage.query: from and to must be times in epoch milliseconds')
  if (typeof by !== 'string' || !USAGE_ALL_BY.includes(by)) throw new TypeError(`$.usage.query: by must be one of ${USAGE_ALL_BY.join(', ')}`)
  if (tzOffsetMinutes !== undefined && typeof tzOffsetMinutes !== 'number') throw new TypeError('$.usage.query: tzOffsetMinutes must be a number of minutes')
  if (project !== undefined && (typeof project !== 'string' || project === '')) throw new TypeError('$.usage.query: project must be a project root path')
  if ('router' in grant) {
    if (!USAGE_ROUTER_BY.includes(by)) {
      throw notAllowed(`$.usage.query: a settings app reads by ${USAGE_ROUTER_BY.join(', ')} only`)
    }
    if (project !== undefined) throw notAllowed('$.usage.query: a settings app reads no project')
  }
  return {
    from,
    to,
    by: by as RequestLogQuery['by'],
    ...(tzOffsetMinutes !== undefined ? { tzOffsetMinutes } : {}),
    ...(project !== undefined ? { project: project as string } : {}),
    // The router comes from the grant, whatever the module passed.
    ...('router' in grant ? { router: grant.router } : {}),
  }
}

/** The usage log's read; the module is loaded only with the background runtime. */
export async function runtimeAppUsage(
  query: RequestLogQuery,
  transport: BrowserBridgeTransport | undefined,
): Promise<RequestLogQueryResult | undefined> {
  const { openRequestLog } = await import('../../models/usage/requestLogWriter')
  return (await openRequestLog(transport))?.query(query)
}

const named = (name: string, message: string): Error => {
  const error = new Error(message)
  error.name = name
  return error
}

/** Serves one call; `read` absent, or answering nothing: the log is unavailable. */
export async function serveUsageCall(
  grant: UsageGrant | null,
  method: string,
  args: readonly unknown[],
  read: ((query: RequestLogQuery) => Promise<RequestLogQueryResult | undefined>) | undefined,
): Promise<RequestLogQueryResult> {
  const refused = refuseUsageCall(method, grant)
  if (refused || !grant) throw notAllowed(refused ?? '$.usage is refused')
  const query = readUsageQuery(args[0], grant)
  const answer = await read?.(query)
  if (!answer) throw named('NotSupportedError', '$.usage.query: the usage log is not available')
  return answer
}

/**
 * `providers.<key>.jobs`: the background jobs a provider declares (F-27).
 *
 * Contract: the block is checked strictly. A property this Velloc does not
 * know, a value of the wrong type, a repeated id or more jobs than the most
 * refuses the provider, naming the field. A number of the right type outside
 * the platform's range is not a refusal: `effectiveJobTiming` clamps it.
 */

/** When a job runs besides its interval. */
export const PROVIDER_JOB_RUN_ON = ['connect'] as const
export type ProviderJobRunOn = (typeof PROVIDER_JOB_RUN_ON)[number]

/** What must hold for a run to start. */
export const PROVIDER_JOB_REQUIRES = ['online'] as const
export type ProviderJobRequirement = (typeof PROVIDER_JOB_REQUIRES)[number]

export type ProviderJobDecl = {
  /** `e.job` of `provider.job`; unique within the provider. */
  id: string
  /** The interval between scheduled runs, as declared. */
  everyMs: number
  /** The hook's own-time budget per run, as declared. */
  budgetMs?: number
  runOn?: ProviderJobRunOn[]
  requires?: ProviderJobRequirement[]
}

export const PROVIDER_JOBS_MAX = 4
export const PROVIDER_JOB_MIN_EVERY_MS = 5 * 60_000
export const PROVIDER_JOB_MAX_EVERY_MS = 7 * 24 * 60 * 60_000
export const PROVIDER_JOB_MIN_BUDGET_MS = 1_000
export const PROVIDER_JOB_MAX_BUDGET_MS = 60_000
export const PROVIDER_JOB_DEFAULT_BUDGET_MS = 20_000

const JOB_ID = /^[A-Za-z0-9_-]{1,32}$/
const JOB_FIELDS: readonly string[] = ['id', 'everyMs', 'budgetMs', 'runOn', 'requires']

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isPositiveInteger = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0

function closedList<T extends string>(
  value: unknown,
  known: readonly T[],
  at: string,
  bad: (message: string) => void,
): T[] | undefined {
  if (!Array.isArray(value)) {
    bad(`${at}: expected a list`)
    return undefined
  }
  const unknown = value.filter(entry => !(known as readonly unknown[]).includes(entry))
  if (unknown.length > 0) {
    bad(`${at}: "${unknown.map(String).join('", "')}" ${unknown.length === 1 ? 'is' : 'are'} not known to this Velloc (it knows ${known.join(' / ')})`)
    return undefined
  }
  return [...new Set(value as T[])]
}

/** Validate a `jobs` block. Each problem goes to `bad` (which refuses the
 *  provider); the declared jobs are returned only when there was none. */
export function checkProviderJobs(value: unknown, bad: (message: string) => void): ProviderJobDecl[] | undefined {
  if (!Array.isArray(value)) {
    bad('jobs: expected a list')
    return undefined
  }
  if (value.length > PROVIDER_JOBS_MAX) {
    bad(`jobs: ${value.length} jobs declared; the most is ${PROVIDER_JOBS_MAX}`)
    return undefined
  }
  let failed = false
  const fail = (message: string): void => {
    failed = true
    bad(message)
  }
  const out: ProviderJobDecl[] = []
  const seen = new Set<string>()
  value.forEach((raw: unknown, index: number) => {
    const at = `jobs[${index}]`
    if (!isRecord(raw)) {
      fail(`${at}: expected an object`)
      return
    }
    const extra = Object.keys(raw).filter(k => !JOB_FIELDS.includes(k))
    if (extra.length > 0) {
      fail(`${at}: unknown ${extra.length === 1 ? 'property' : 'properties'} ${extra.map(k => `"${k}"`).join(', ')}`)
    }
    const id = raw.id
    if (typeof id !== 'string' || !JOB_ID.test(id)) {
      fail(`${at}.id: required; 1-32 characters of letters, digits, "_" and "-"`)
    } else if (seen.has(id)) {
      fail(`${at}.id: "${id}" is declared twice`)
    } else seen.add(id)
    if (!isPositiveInteger(raw.everyMs)) fail(`${at}.everyMs: required; a positive whole number of milliseconds`)
    if (raw.budgetMs !== undefined && !isPositiveInteger(raw.budgetMs)) {
      fail(`${at}.budgetMs: expected a positive whole number of milliseconds`)
    }
    const runOn = raw.runOn === undefined ? undefined : closedList(raw.runOn, PROVIDER_JOB_RUN_ON, `${at}.runOn`, fail)
    const requires =
      raw.requires === undefined ? undefined : closedList(raw.requires, PROVIDER_JOB_REQUIRES, `${at}.requires`, fail)
    if (failed) return
    out.push({
      id: id as string,
      everyMs: raw.everyMs as number,
      ...(raw.budgetMs !== undefined ? { budgetMs: raw.budgetMs as number } : {}),
      ...(runOn && runOn.length > 0 ? { runOn } : {}),
      ...(requires && requires.length > 0 ? { requires } : {}),
    })
  })
  return failed ? undefined : out
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))

/** The interval and budget the platform holds a declared job to. */
export function effectiveJobTiming(job: Pick<ProviderJobDecl, 'everyMs' | 'budgetMs'>): {
  everyMs: number
  budgetMs: number
  clamped: boolean
} {
  const everyMs = clamp(job.everyMs, PROVIDER_JOB_MIN_EVERY_MS, PROVIDER_JOB_MAX_EVERY_MS)
  const budgetMs = clamp(job.budgetMs ?? PROVIDER_JOB_DEFAULT_BUDGET_MS, PROVIDER_JOB_MIN_BUDGET_MS, PROVIDER_JOB_MAX_BUDGET_MS)
  return { everyMs, budgetMs, clamped: everyMs !== job.everyMs || (job.budgetMs !== undefined && budgetMs !== job.budgetMs) }
}

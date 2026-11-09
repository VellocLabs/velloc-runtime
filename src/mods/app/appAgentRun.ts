/**
 * Agent runs an app's background module starts with `$.app.analyze` (F-40):
 * the manifest's `background.agent`, the request's shape, the per-app limits,
 * and the seam the realm's headless spawn fills. Security: a run is declared
 * in the manifest and consented with the plugin's grant; it is headless
 * (every permission ask is refused), bound to the app's template and folder,
 * and reads nothing outside that folder.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Runs one app may start in a local calendar day. */
export const APP_AGENT_DAILY_LIMIT = 24
/** The longest one run may take before it is stopped and fails. */
export const APP_AGENT_RUN_TIMEOUT_MS = 10 * 60_000
export const APP_AGENT_PROMPT_MAX = 20_000
export const APP_AGENT_TITLE_MAX = 120
/** Every app agent run's session id starts with this; the page never takes one for an app's own session. */
export const APP_RUN_SESSION_PREFIX = 'headless-app-'

export const isAppRunSessionId = (sessionId: string): boolean => sessionId.startsWith(APP_RUN_SESSION_PREFIX)

/** What the module asked for, checked. */
export type AppAnalyzeRequest = { prompt: string; title?: string }

/** What `$.app.analyze` resolves with. */
export type AppAnalyzeResult = { ok: true; text: string } | { ok: false; reason: string }

/** One run as the realm spawns it. */
export type AppAgentRunJob = {
  appId: string
  plugin: string
  /** The app's template type: the run's template, its tools and its instructions. */
  templateType: string
  /** The app's folder, absolute: the run's project root, cwd and read boundary. */
  folder: string
  prompt: string
  title?: string
  abortSignal: AbortSignal
}

/** How a run ended, as the realm saw it. */
export type AppAgentRunOutcome =
  | { status: 'success'; text: string }
  | { status: 'aborted' }
  | { status: 'error'; message: string }

/** Starts a headless run for an app; never rejects for the run's own failure. */
export type AppAgentRunner = (job: AppAgentRunJob) => Promise<AppAgentRunOutcome>

/** Whether a parsed plugin.json has an app whose background block declares `agent: true`. */
export function manifestAsksAgent(manifest: unknown): boolean {
  const templates = isRecord(manifest) && isRecord(manifest.templates) ? manifest.templates : undefined
  if (!templates) return false
  return Object.values(templates).some(decl => {
    const background = isRecord(decl) && isRecord(decl.app) ? decl.app.background : undefined
    return isRecord(background) && background.agent === true
  })
}

/** The request of `$.app.analyze(request)`; a `TypeError` names what is wrong. */
export function readAnalyzeRequest(value: unknown): AppAnalyzeRequest {
  const usage = '$.app.analyze({ prompt, title? })'
  if (!isRecord(value)) throw new TypeError(`${usage}: expected an object`)
  const { prompt, title } = value
  if (typeof prompt !== 'string' || prompt.trim() === '') throw new TypeError(`${usage}: prompt is a non-empty string`)
  if (prompt.length > APP_AGENT_PROMPT_MAX) throw new TypeError(`${usage}: prompt is longer than ${APP_AGENT_PROMPT_MAX} characters`)
  if (title !== undefined && (typeof title !== 'string' || title.trim() === '' || title.length > APP_AGENT_TITLE_MAX)) {
    throw new TypeError(`${usage}: title is a non-empty string of at most ${APP_AGENT_TITLE_MAX} characters`)
  }
  return { prompt, ...(title !== undefined ? { title: title.trim() } : {}) }
}

const durationText = (ms: number): string => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${ms} ms`)

const localDay = (ms: number): string => {
  const date = new Date(ms)
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

export type AppAgentRunsOptions = {
  run?: AppAgentRunner
  report: (line: string) => void
  now?: () => number
  dailyLimit?: number
  timeoutMs?: number
}

/**
 * The runs of every app of a realm: at most one in flight per app, at most
 * `dailyLimit` started per app in a local day (kept in memory, across the
 * module's restarts). A run ends `stopped` when `gone` aborts — the module
 * stopping — and fails past `timeoutMs`.
 */
export class AppAgentRuns {
  private readonly inFlight = new Set<string>()
  private readonly started = new Map<string, { day: string; count: number }>()

  constructor(private readonly options: AppAgentRunsOptions) {}

  async start(job: Omit<AppAgentRunJob, 'abortSignal'>, gone: AbortSignal): Promise<AppAnalyzeResult> {
    const { appId, plugin } = job
    if (gone.aborted) return { ok: false, reason: 'stopped' }
    if (this.inFlight.has(appId)) return { ok: false, reason: 'busy' }
    const day = localDay(this.now())
    const used = this.started.get(appId)
    const count = used && used.day === day ? used.count : 0
    const limit = this.options.dailyLimit ?? APP_AGENT_DAILY_LIMIT
    if (count >= limit) {
      this.options.report(`${plugin}: ${appId} started ${limit} agent runs today, its limit; this one is refused`)
      return { ok: false, reason: 'limit' }
    }
    const run = this.options.run
    if (!run) return { ok: false, reason: 'failed: agent runs are not available in this realm' }
    this.started.set(appId, { day, count: count + 1 })
    this.inFlight.add(appId)
    const controller = new AbortController()
    let ended: 'stopped' | 'timeout' | undefined
    const onGone = () => {
      ended ??= 'stopped'
      controller.abort()
    }
    gone.addEventListener('abort', onGone, { once: true })
    const timeoutMs = this.options.timeoutMs ?? APP_AGENT_RUN_TIMEOUT_MS
    const timer = setTimeout(() => {
      ended ??= 'timeout'
      controller.abort()
    }, timeoutMs)
    this.options.report(`${plugin}: ${appId} started an agent run${job.title ? ` "${job.title}"` : ''}`)
    let result: AppAnalyzeResult
    try {
      const outcome = await run({ ...job, abortSignal: controller.signal })
      if (ended === 'stopped') result = { ok: false, reason: 'stopped' }
      else if (ended === 'timeout') result = { ok: false, reason: `failed: the run did not finish within ${durationText(timeoutMs)}` }
      else if (outcome.status === 'success') result = { ok: true, text: outcome.text }
      else if (outcome.status === 'aborted') result = { ok: false, reason: 'stopped' }
      else result = { ok: false, reason: `failed: ${outcome.message}` }
    } catch (error) {
      result = { ok: false, reason: `failed: ${error instanceof Error ? error.message : String(error)}` }
    } finally {
      clearTimeout(timer)
      gone.removeEventListener('abort', onGone)
      this.inFlight.delete(appId)
    }
    this.options.report(`${plugin}: the agent run of ${appId} ended — ${result.ok ? 'ok' : result.reason}`)
    return result
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now()
  }
}

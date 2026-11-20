/**
 * Theme switches in progress (F-25): what a look, an enable or disable of a
 * theme plugin, or *Turn off all* is doing now, step by step, and how it
 * ended. The runtime alone writes it; clients read topic `theme/switch`
 * (`observe`). It names plugins, looks and commands the user already has;
 * no plugin content and no session text.
 */

export const THEME_SWITCH_TOPIC = 'theme/switch'
/** The `type` of the snapshot and of every delta. */
export const THEME_SWITCH_EVENT = 'state'

/** What started the switch. `look`: a look by name; `enable` / `disable`: one theme plugin. */
export type ThemeSwitchSubject =
  | { kind: 'look'; plugin: string; look: string }
  | { kind: 'enable'; plugin: string }
  | { kind: 'disable'; plugin: string }
  | { kind: 'turnOffAll' }

export type ThemeSwitchStepState = 'running' | 'done' | 'failed'

/**
 * `waitTurn`: the session runs a turn, and its plugins reload only after it.
 * `turnOff` / `turnOn`: theme plugins switched. `load`: the session loads the
 * plugin. `command`: the plugin's own command runs, `/name args`.
 */
export type ThemeSwitchStep =
  | { kind: 'waitTurn'; state: ThemeSwitchStepState }
  | { kind: 'turnOff'; state: ThemeSwitchStepState; plugins: string[] }
  | { kind: 'turnOn'; state: ThemeSwitchStepState; plugin: string }
  | { kind: 'load'; state: ThemeSwitchStepState; plugin: string }
  | { kind: 'command'; state: ThemeSwitchStepState; command: string }

export type ThemeSwitchFailure =
  | 'unknownLook'
  | 'notLoaded'
  | 'notOwnCommand'
  | 'unanswered'
  | 'commandFailed'
  | 'request'
  | 'cancelled'

export type ThemeSwitchOutcome = { ok: true } | { ok: false; reason: ThemeSwitchFailure }

export type ThemeSwitchEntry = {
  id: string
  subject: ThemeSwitchSubject
  steps: ThemeSwitchStep[]
  /** Absent while it runs. */
  outcome?: ThemeSwitchOutcome
}

/** Oldest first; the last is the latest. */
export type ThemeSwitchState = { switches: ThemeSwitchEntry[] }

const LIMIT = 8
const NAME_LIMIT = 300
const FAILURES: ReadonlySet<string> = new Set<ThemeSwitchFailure>([
  'unknownLook',
  'notLoaded',
  'notOwnCommand',
  'unanswered',
  'commandFailed',
  'request',
  'cancelled',
])

const isName = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= NAME_LIMIT
const isState = (value: unknown): value is ThemeSwitchStepState => value === 'running' || value === 'done' || value === 'failed'

function readSubject(value: unknown): ThemeSwitchSubject | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (raw.kind === 'turnOffAll') return { kind: 'turnOffAll' }
  if (!isName(raw.plugin)) return null
  if (raw.kind === 'enable' || raw.kind === 'disable') return { kind: raw.kind, plugin: raw.plugin }
  if (raw.kind === 'look' && isName(raw.look)) return { kind: 'look', plugin: raw.plugin, look: raw.look }
  return null
}

function readStep(value: unknown): ThemeSwitchStep | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (!isState(raw.state)) return null
  const state = raw.state
  switch (raw.kind) {
    case 'waitTurn':
      return { kind: 'waitTurn', state }
    case 'turnOff':
      return Array.isArray(raw.plugins) && raw.plugins.length <= 64 && raw.plugins.every(isName)
        ? { kind: 'turnOff', state, plugins: [...raw.plugins] }
        : null
    case 'turnOn':
    case 'load':
      return isName(raw.plugin) ? { kind: raw.kind, state, plugin: raw.plugin } : null
    case 'command':
      return isName(raw.command) ? { kind: 'command', state, command: raw.command } : null
    default:
      return null
  }
}

function readOutcome(value: unknown): ThemeSwitchOutcome | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (raw.ok === true) return { ok: true }
  if (raw.ok === false && typeof raw.reason === 'string' && FAILURES.has(raw.reason)) {
    return { ok: false, reason: raw.reason as ThemeSwitchFailure }
  }
  return null
}

/** A published state, or null when it is not one. An entry or step the reader does not know is left out. */
export function readThemeSwitchState(value: unknown): ThemeSwitchState | null {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { switches?: unknown }).switches)) return null
  const switches: ThemeSwitchEntry[] = []
  for (const each of (value as { switches: unknown[] }).switches.slice(-LIMIT)) {
    if (!each || typeof each !== 'object') continue
    const raw = each as Record<string, unknown>
    const subject = readSubject(raw.subject)
    if (!isName(raw.id) || !subject || !Array.isArray(raw.steps)) continue
    const steps = raw.steps.map(readStep).filter((step): step is ThemeSwitchStep => step !== null)
    const outcome = raw.outcome === undefined ? undefined : readOutcome(raw.outcome)
    if (outcome === null) continue
    switches.push({ id: raw.id, subject, steps, ...(outcome ? { outcome } : {}) })
  }
  return { switches }
}

/** One step under way: `done` or `fail` ends it, with what it came to. */
export type ThemeSwitchStepHandle = {
  done(change?: Partial<ThemeSwitchStep>): void
  fail(): void
}

/** One switch on the board. Every change is published. */
export type ThemeSwitchRun = {
  readonly id: string
  /** Adds a running step. */
  step(step: DistributiveOmit<ThemeSwitchStep, 'state'>): ThemeSwitchStepHandle
  /** Adds a step already done. */
  record(step: DistributiveOmit<ThemeSwitchStep, 'state'>): void
  /** Ends the switch; a step still running is done when it succeeded, else failed. Once only. */
  finish(outcome: ThemeSwitchOutcome): void
  /** Ends it as succeeded after `ms` unless `join` claims it first. */
  finishUnlessJoined(ms: number): void
  readonly finished: boolean
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

export type ThemeSwitchBoardOptions = {
  /** Called with the whole state after every change. */
  publish: (state: ThemeSwitchState) => void
  /** How long a finished switch stays listed. Default 15 s. */
  keepMs?: number
  /** How long a joinable switch waits to be joined. Default 4 s. */
  joinMs?: number
}

/**
 * The runtime's list of theme switches. A switch started under a `key` may be
 * joined by a later request that carries it on (an enable, then the plugin's
 * own command), while it runs.
 */
export class ThemeSwitchBoard {
  private readonly entries: ThemeSwitchEntry[] = []
  private readonly keys = new Map<string, { run: ThemeSwitchRun; joinable: () => void }>()
  private next = 0

  constructor(private readonly options: ThemeSwitchBoardOptions) {}

  state(): ThemeSwitchState {
    return { switches: this.entries.map(entry => ({ ...entry, steps: entry.steps.map(step => ({ ...step })) })) }
  }

  start(subject: ThemeSwitchSubject, key?: string): ThemeSwitchRun {
    if (key !== undefined) this.keys.get(key)?.run.finish({ ok: true })
    this.next += 1
    const entry: ThemeSwitchEntry = { id: `switch-${this.next}`, subject, steps: [] }
    this.entries.push(entry)
    while (this.entries.length > LIMIT) this.entries.shift()
    let timer: ReturnType<typeof setTimeout> | null = null
    const stopTimer = () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
    }
    const changed = () => this.options.publish(this.state())
    const run: ThemeSwitchRun = {
      id: entry.id,
      get finished() {
        return entry.outcome !== undefined
      },
      step: step => {
        const held = { ...step, state: 'running' } as ThemeSwitchStep
        entry.steps.push(held)
        changed()
        const end = (state: ThemeSwitchStepState, change?: Partial<ThemeSwitchStep>) => {
          if (held.state !== 'running' || entry.outcome) return
          Object.assign(held, change ?? {}, { state })
          changed()
        }
        return { done: change => end('done', change), fail: () => end('failed') }
      },
      record: step => {
        if (entry.outcome) return
        entry.steps.push({ ...step, state: 'done' } as ThemeSwitchStep)
        changed()
      },
      finish: outcome => {
        if (entry.outcome) return
        stopTimer()
        entry.outcome = outcome
        for (const step of entry.steps) if (step.state === 'running') step.state = outcome.ok ? 'done' : 'failed'
        if (key !== undefined && this.keys.get(key)?.run === run) this.keys.delete(key)
        changed()
        setTimeout(() => {
          const at = this.entries.indexOf(entry)
          if (at < 0) return
          this.entries.splice(at, 1)
          changed()
        }, this.options.keepMs ?? 15_000)
      },
      finishUnlessJoined: ms => {
        stopTimer()
        timer = setTimeout(() => run.finish({ ok: true }), ms)
      },
    }
    if (key !== undefined) this.keys.set(key, { run, joinable: stopTimer })
    changed()
    return run
  }

  /** The unfinished switch started under `key`, now this caller's to finish; undefined when there is none. */
  join(key: string): ThemeSwitchRun | undefined {
    const held = this.keys.get(key)
    if (!held || held.run.finished) return undefined
    held.joinable()
    return held.run
  }

  /** How long `finishUnlessJoined` should wait by default. */
  get joinMs(): number {
    return this.options.joinMs ?? 4_000
  }
}

/** The key an enable of `plugin` is joined by. */
export const enableSwitchKey = (plugin: string): string => `enable:${plugin}`

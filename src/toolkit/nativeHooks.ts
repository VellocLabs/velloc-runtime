/**
 * Contract: the native hook tier (F-26). Built-in feature modules register on
 * named events once, when the realm boots; the engine and the toolkit raise those
 * events at fixed points and know no feature by name.
 *
 * Position: an `outer` link runs around the whole mod chain (no mod can skip it),
 * an `inner` link runs beneath the mod chain, as part of core. A call site raises
 * the position it stands at. Order is the order table the registry is built from,
 * never the order of `register` calls. Scope `main` links run only for the main
 * agent loop (no `agentId`).
 *
 * Failure: `throw` (default) rejects the raise as the inlined code did; `skip`
 * traces the error and treats the link as absent.
 */
import { traceLine } from '../utils/debugLog'

export type NativeHookPosition = 'inner' | 'outer'
export type NativeHookScope = 'main' | 'all'
export type NativeHookFailure = 'throw' | 'skip'

export type NativeObserver = (e: unknown, live: unknown) => void | Promise<void>
export type NativeAround = (
  e: unknown,
  live: unknown,
  next: (e: unknown) => Promise<unknown>,
) => Promise<unknown>

export type NativeHookRegistration = {
  /** The feature module, as the order table names it. */
  module: string
  event: string
  position?: NativeHookPosition
  scope: NativeHookScope
  onError?: NativeHookFailure
} & ({ observe: NativeObserver; around?: never } | { around: NativeAround; observe?: never })

/** Where and for whom one raise runs. */
export type NativeRaise = {
  position?: NativeHookPosition
  /** The loop's agent id; absent for the main agent. */
  agentId?: string
}

export interface NativeHooks {
  /** Whether any link would run for this raise. */
  has(event: string, raise?: NativeRaise): boolean
  /** Runs each observer of `event`, in order, serially. */
  observe(event: string, e: unknown, live: unknown, raise?: NativeRaise): Promise<void>
  /** Runs each observer of `event` synchronously, for a raise site that may not
   *  yield; an observer that returns a promise throws. */
  observeSync(event: string, e: unknown, live: unknown, raise?: NativeRaise): void
  /** Runs the around links of `event` nested around `core`, first link outermost. */
  around<R>(
    event: string,
    e: unknown,
    live: unknown,
    core: (e: unknown) => Promise<R>,
    raise?: NativeRaise,
  ): Promise<R>
}

/** The order table: per event, the modules whose links run, outermost first. */
export type NativeHookOrder = Readonly<Record<string, readonly string[]>>

function linksFor(
  byEvent: ReadonlyMap<string, readonly NativeHookRegistration[]>,
  event: string,
  raise: NativeRaise | undefined,
): readonly NativeHookRegistration[] {
  const all = byEvent.get(event)
  if (!all) return []
  const position = raise?.position ?? 'inner'
  const isMain = !raise?.agentId
  return all.filter(link => (link.position ?? 'inner') === position && (link.scope === 'all' || isMain))
}

function reportSkipped(link: NativeHookRegistration, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  traceLine(`[native-hook] ${link.module} on ${link.event} failed and was skipped: ${message}`, {
    level: 'warn',
  })
}

/**
 * Builds the registry from `registrations` ordered by `order`. Throws on a
 * registration whose module the order table does not list for its event: an
 * unlisted link would run in an order nobody chose.
 */
export function createNativeHooks(
  order: NativeHookOrder,
  registrations: readonly NativeHookRegistration[],
): NativeHooks {
  const byEvent = new Map<string, NativeHookRegistration[]>()
  for (const registration of registrations) {
    const listed = order[registration.event]
    if (!listed || !listed.includes(registration.module)) {
      throw new Error(
        `native hook: ${registration.module} on ${registration.event} is not in the order table`,
      )
    }
    const list = byEvent.get(registration.event) ?? []
    list.push(registration)
    byEvent.set(registration.event, list)
  }
  for (const [event, list] of byEvent) {
    const rank = order[event]!
    list.sort((a, b) => rank.indexOf(a.module) - rank.indexOf(b.module))
  }
  const frozen: ReadonlyMap<string, readonly NativeHookRegistration[]> = byEvent

  return {
    has(event, raise) {
      return linksFor(frozen, event, raise).length > 0
    },
    async observe(event, e, live, raise) {
      for (const link of linksFor(frozen, event, raise)) {
        if (!link.observe) continue
        try {
          await link.observe(e, live)
        } catch (error) {
          if (link.onError !== 'skip') throw error
          reportSkipped(link, error)
        }
      }
    },
    observeSync(event, e, live, raise) {
      for (const link of linksFor(frozen, event, raise)) {
        if (!link.observe) continue
        try {
          const returned = link.observe(e, live)
          if (returned && typeof (returned as Promise<void>).then === 'function') {
            throw new Error(`native hook: ${link.module} on ${event} is raised synchronously and may not return a promise`)
          }
        } catch (error) {
          if (link.onError !== 'skip') throw error
          reportSkipped(link, error)
        }
      }
    },
    around(event, e, live, core, raise) {
      const links = linksFor(frozen, event, raise).filter(link => link.around)
      const step = (index: number, value: unknown): Promise<unknown> => {
        if (index >= links.length) return core(value)
        const link = links[index]!
        if (link.onError !== 'skip') return link.around!(value, live, next => step(index + 1, next))
        // A skipped link stands aside: beneath runs once, with what it was given
        // or what the link last passed down.
        let beneath: Promise<unknown> | undefined
        const nextOnce = (passed: unknown) => (beneath ??= step(index + 1, passed))
        return link.around!(value, live, nextOnce).catch(error => {
          reportSkipped(link, error)
          return beneath ?? step(index + 1, value)
        })
      }
      return step(0, e) as Promise<never>
    },
  }
}

const NO_HOOKS = createNativeHooks({}, [])

let installed: NativeHooks = NO_HOOKS

/** Installs the realm's registry. Called once by the runtime's composition root. */
export function installNativeHooks(hooks: NativeHooks): void {
  installed = hooks
}

/** The registry a call runs with: the context's own (tests), else the installed one. */
export function nativeHooksOf(holder: { nativeHooks?: NativeHooks } | undefined): NativeHooks {
  return holder?.nativeHooks ?? installed
}

/**
 * A mod slot's session lifecycle (F-25): `session.start` under its bound,
 * `session.end` under one short bound, the roster of attached clients
 * (`session.attach` / `session.detach`), and the observe-only
 * `agent.complete` and `task.stop`.
 */

import { ModTurnRaises } from './ModTurnRaises'
import { errorMessage } from './chainRules'
import { isRecord } from './modNounKit'
import { normalizeModLocale } from './modLocale'
import {
  MOD_SESSION_END_TIMEOUT_MS,
  MOD_SESSION_START_TIMEOUT_MS,
  type ModSessionEndReason,
} from './modRuntimeContract'
import type { ModRosterClient } from './modSlotRegistry'
import type { ModAgentOutcome } from './modAgents'
import type { PluginTaskStopEvent } from '../browser/worker/PluginTaskCoordinator'
import type { PausableDeadline } from '../browser/workerKernel/pausableDeadline'

export abstract class ModSessionLifecycle extends ModTurnRaises {
  protected abstract bound(ms: number, onExpire: () => void): PausableDeadline
  protected abstract unbound(bound: PausableDeadline): void
  /** `session.end` is running: its one short bound is not paused, so a
   *  question is refused rather than cut off. */
  protected ending = false
  /** Settles when the `session.end` in progress has finished. */
  protected endingDone: Promise<void> = Promise.resolve()
  /** The clients attached to the session (`session.attach`), by id, in the
   *  order they attached. */
  private readonly roster = new Map<string, ModRosterClient>()
  /** `session.start` has run: a client that attached before it is raised
   *  after it. */
  private rosterOpen = false
  /** The roster's events, one after another, so a detach never overtakes
   *  its attach. */
  private rosterChain: Promise<void> = Promise.resolve()
  /** `agent.complete` and `task.stop` raises, one at a time. */
  private agentChain: Promise<void> = Promise.resolve()

  /**
   * `session.start`: "fires once per process for each loaded plugin, before
   * the first prompt … The first is awaited." Observe-only: core echoes
   * `{ cwd }` and a hook's own value changes nothing. Bounded, so a module
   * that hangs there cannot hold the session's first prompt forever.
   *
   * `onlyKey`: after a restart, for that module's hooks alone.
   */
  protected async sessionStart(onlyKey?: string): Promise<void> {
    const controller = new AbortController()
    const timeoutMs = this.options.startTimeoutMs ?? MOD_SESSION_START_TIMEOUT_MS
    // Paused while the person is asked: a module asking at session.start is
    // waiting on them, not hanging.
    const bound = this.bound(timeoutMs, () => controller.abort())
    try {
      const cwd = this.options.session.cwd()
      await this.dispatcher.dispatch(
        'session.start',
        // Velloc draws on the `desktop` surface, and a person is at the prompt.
        { cwd, surface: 'desktop', isInteractive: true, locale: normalizeModLocale(this.options.locale) },
        e => ({ cwd: (e as { cwd?: unknown })?.cwd ?? cwd }),
        {
          signal: controller.signal,
          accepts: isRecord,
          ...(onlyKey !== undefined ? { onlyGroup: onlyKey } : {}),
        },
      )
    } catch (error) {
      this.options.report(
        controller.signal.aborted
          ? `mods: session.start did not finish within ${timeoutMs}ms; the session goes on without waiting`
          : `mods: session.start failed: ${errorMessage(error)}`,
      )
    } finally {
      this.unbound(bound)
    }
  }

  /**
   * `session.end`, observe-only, under one short wall-clock bound for the whole
   * chain. On `clear` the modules, variables and timers stay. Never rejects.
   */
  async sessionEnd(reason: ModSessionEndReason): Promise<void> {
    if (this.disposed) return
    // "Fires when a client leaves the roster: … the session ended with it
    // attached." A `/clear` ends the conversation, not the session the
    // clients are attached to: they stay.
    const leaving = reason === 'clear' || !this.rosterOpen ? [] : [...this.roster.values()]
    if (reason !== 'clear') this.roster.clear()
    const detaching = leaving.length > 0 && this.dispatcher.hasHooksFor('session.detach')
    if (!this.dispatcher.hasHooksFor('session.end') && !detaching) return
    const controller = new AbortController()
    const timeoutMs = this.options.endTimeoutMs ?? MOD_SESSION_END_TIMEOUT_MS
    const startedAt = Date.now()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    this.ending = true
    let ended!: () => void
    this.endingDone = new Promise<void>(resolve => {
      ended = resolve
    })
    try {
      if (this.dispatcher.hasHooksFor('session.end')) {
        const sessionId = this.options.session.id()
        await this.dispatcher.dispatch(
          'session.end',
          // The id is also what a resume takes: a Velloc session is reopened by
          // its own id.
          { reason, sessionId, resume: { id: sessionId } },
          () => ({ sessionId }),
          // The hooks share the bound: `next.budget` reads it, not the
          // ordinary 10 s (debt 5).
          { signal: controller.signal, accepts: isRecord, budgetMs: timeoutMs },
        )
      }
    } catch (error) {
      this.options.report(
        controller.signal.aborted
          ? `mods: session.end did not finish within ${timeoutMs}ms; the session ends without waiting`
          : `mods: session.end failed: ${errorMessage(error)}`,
      )
    }
    try {
      // "With reason `end` it runs inside `session.end`'s one short bound:
      // there `next.budget` reads that bound and `next.signal` aborts at it."
      for (const client of detaching ? leaving : []) {
        if (controller.signal.aborted) break
        await this.dispatcher.dispatch(
          'session.detach',
          { surface: client.surface, clientId: client.clientId, reason: 'end' },
          () => ({ clientId: client.clientId }),
          {
            signal: controller.signal,
            accepts: isRecord,
            budgetMs: Math.max(0, timeoutMs - (Date.now() - startedAt)),
          },
        )
      }
    } catch (error) {
      this.options.report(
        controller.signal.aborted
          ? `mods: session.detach did not finish within session.end's ${timeoutMs}ms`
          : `mods: session.detach failed: ${errorMessage(error)}`,
      )
    } finally {
      this.ending = false
      ended()
      clearTimeout(timer)
    }
  }

  // ── the session's roster of attached clients ──

  /**
   * A client joined the session's roster (the hub: its first subscription
   * to the session's topics). `session.attach`: "fires when a remote client
   * joins the session's roster of attached surfaces … Observe; `next(e)`
   * resolves to `{ clientId }`." Raised once `session.start` has run.
   */
  clientAttached(client: ModRosterClient): void {
    if (this.disposed || this.roster.has(client.clientId)) return
    this.roster.set(client.clientId, client)
    if (this.rosterOpen) this.raiseRoster('session.attach', client)
  }

  /** A client left (its last subscription went): `session.detach` with
   *  reason `detach`. A client that left before `session.start` ran was
   *  never raised, and raises nothing. */
  clientDetached(clientId: string): void {
    const client = this.roster.get(clientId)
    if (this.disposed || !client) return
    this.roster.delete(clientId)
    if (this.rosterOpen) this.raiseRoster('session.detach', client)
  }

  protected openRoster(): void {
    if (this.rosterOpen || this.disposed) return
    this.rosterOpen = true
    for (const client of this.roster.values()) this.raiseRoster('session.attach', client)
  }

  /** `agent.complete`: observe-only, raised once per subagent run that
   *  reached a terminal state, in the order the runs ended. Never rejects. */
  agentComplete(e: ModAgentOutcome): void {
    this.agentChain = this.agentChain.then(async () => {
      if (this.disposed || !this.dispatcher.hasHooksFor('agent.complete')) return
      try {
        await this.dispatcher.dispatch('agent.complete', e, () => ({ agentId: e.agentId }), { accepts: isRecord })
      } catch (error) {
        this.options.report(`mods: agent.complete failed: ${errorMessage(error)}`)
      }
    })
  }

  /** `task.stop`: observe-only, raised once per stop asked of a plugin
   *  task; the owning plugin ends its work and finishes the task. Never
   *  rejects. */
  taskStop(e: PluginTaskStopEvent): void {
    this.agentChain = this.agentChain.then(async () => {
      if (this.disposed || !this.dispatcher.hasHooksFor('task.stop')) return
      try {
        await this.dispatcher.dispatch('task.stop', e, () => ({ taskId: e.taskId }), { accepts: isRecord })
      } catch (error) {
        this.options.report(`mods: task.stop failed: ${errorMessage(error)}`)
      }
    })
  }

  private raiseRoster(event: 'session.attach' | 'session.detach', client: ModRosterClient): void {
    const e =
      event === 'session.attach'
        ? { surface: client.surface, clientId: client.clientId }
        : { surface: client.surface, clientId: client.clientId, reason: 'detach' as const }
    this.rosterChain = this.rosterChain.then(async () => {
      if (this.disposed || !this.dispatcher.hasHooksFor(event)) return
      try {
        // Observe: core echoes the id; a hook's own value changes nothing.
        await this.dispatcher.dispatch(event, e, () => ({ clientId: client.clientId }), {
          accepts: isRecord,
        })
      } catch (error) {
        this.options.report(`mods: ${event} failed: ${errorMessage(error)}`)
      }
    })
  }
}

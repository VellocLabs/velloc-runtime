/**
 * Starts a teammate session for the team coordinator: claims its member key, registers and boots
 * its worker, and runs its idle loop (first turn, then one turn per mailbox message until shutdown).
 */

import type { AgentRuntimeWorkerInitPayload, AgentWorkerInboundMessage } from './workerProtocol'
import type { SessionWorkerInboundMessage } from './sharedWorkerProtocol'
import { deriveChildInitPayload } from './childInitPayload'
import type { SpawnTeammateParams } from '../../team/teamTypes'
import { allocateMemberKey } from '../../team/memberKey'
import { TeammateNameInUseError } from '../../team/teammateSpawner'
import type { TeamCoordinator, TeamCoordinatorHost } from './TeamCoordinator'

/**
 * Contract: the coordinator's own registries, shared by reference (the launcher adds to them;
 * the coordinator reads and clears them), and the coordinator steps a teammate's loop calls.
 */
export type TeammateSessionLauncherDeps = {
  host: TeamCoordinatorHost
  teammates: TeamCoordinator['teammates']
  lost: TeamCoordinator['lost']
  aborts: TeamCoordinator['aborts']
  loops: TeamCoordinator['loops']
  mailbox: TeamCoordinator['mailbox']
  retireStaleInbox: (sessionId: string) => Promise<void>
  markStatus: (sessionId: string, status: 'active' | 'idle') => void
  reportTurnEnd: (sessionId: string, interrupted?: boolean) => void
  teardown: (sessionId: string) => Promise<void>
}

export class TeammateSessionLauncher {
  constructor(private readonly deps: TeammateSessionLauncherDeps) {}

  /**
   * Spawn a teammate session (fresh portless worker with team identity); returns the sessionId
   * synchronously. It runs its first turn, then idles on the mailbox until a message or shutdown.
   * Null with no init template.
   */
  spawn(params: SpawnTeammateParams): string | null {
    const template = this.deps.host.getInitTemplate()
    if (!template) return null
    const { teamName, teammateName, prompt, spawnerSessionId, model } = params
    // The display name is the model's and the user's; the KEY is ours. One
    // live teammate per display name per lead — SendMessage / Shutdown
    // address by that name, and two answering to it would be ambiguous.
    const siblings = [...this.deps.teammates.values()].filter(
      tm => tm.spawnerSessionId === spawnerSessionId && tm.status !== 'stopped',
    )
    if (siblings.some(tm => tm.name === teammateName)) {
      throw new TeammateNameInUseError(teammateName)
    }
    const key = allocateMemberKey(
      teammateName,
      new Set(siblings.map(tm => tm.key)),
    )
    // The trailing `Date.now()` is not decoration: it is the ONLY creation
    // time a teammate has (`meta.json` keeps an activity clock and no birth
    // time), and both `memberKeyFromTeammateId` and the topbar tab strip's
    // `teammateSpawnTimeFromId` read it back off the id. Changing this shape
    // reorders the strip.
    const sessionId = `teammate-${teamName}-${key}-${Date.now()}`
    if (spawnerSessionId) {
      // A new teammate under a lost one's name supersedes its marker: the name
      // now means the new one, and once that one ends, the old loss is not
      // the reason it is gone.
      const lost = this.deps.lost.get(spawnerSessionId)
      if (lost) {
        this.deps.lost.set(
          spawnerSessionId,
          lost.filter(l => l.name !== teammateName && l.key !== key),
        )
      }
    }

    this.deps.teammates.set(sessionId, {
      teamName,
      name: teammateName,
      key,
      spawnerSessionId,
      status: 'active',
      startedAt: Date.now(),
      // A child with a read boundary is, by construction, one on an
      // untrusted provider — captured here so its messages stay labelled
      // that way for its whole life, whatever the setting does later.
      trust: params.untrustedReadRoot ? 'untrusted' : 'trusted',
      inboxReady: false,
      ...(params.onCleanup ? { onCleanup: params.onCleanup } : {}),
      // Snapshot the LEAD's globals BEFORE this teammate's `worker.init`
      // below installs its own over them (see `restoreLeadGlobals`). Taken
      // from the lead's own captured report rather than the live slot: a
      // sibling teammate spawned moments earlier already owns the slot, and
      // restoring THAT at teardown would hand the lead a transport belonging
      // to a session that may be reaped first.
      ...(spawnerSessionId
        ? (() => {
            const leadGlobals = this.deps.host.getOwnerGlobals(spawnerSessionId)
            return leadGlobals ? { leadGlobals } : {}
          })()
        : {}),
    })

    // Security: project binding comes from the LEAD, not the template (the last init of any session);
    // an explicit `projectRoot` / `templateType` still wins.
    const parent = spawnerSessionId
      ? (this.deps.host.getParentSessionBinding?.(spawnerSessionId) ?? null)
      : null
    const boundProjectRoot = params.projectRoot ?? parent?.projectRoot
    // A DERIVED template (safe_code for an untrusted child); absent means
    // inherit the lead's.
    const boundTemplateType = params.templateType ?? parent?.templateType

    // The shared derivation (binding from the lead, provider stamping, the
    // lead-prepared directory else the lead's own worktree, cleared trace
    // fields, inherited routine provenance); the read boundary is deliberately
    // NOT `isSubAgent`, which turns off file snapshots and rewrites maxTurns.
    const initPayload: AgentRuntimeWorkerInitPayload = {
      ...deriveChildInitPayload(template, {
        sessionId,
        parent,
        projectRoot: boundProjectRoot,
        templateType: boundTemplateType,
        providerId: params.providerId,
        model,
        thinkingTier: params.thinkingTier,
        cwd: params.cwd,
        untrustedReadRoot: params.untrustedReadRoot,
        routineOriginId: params.routineOriginId,
      }),
      isTeammate: true,
      teamName,
      teammateName,
      // Identity: nests the storage AND persists into the session meta at
      // bind, which is what hides the child from the sidebar after a reload.
      ...(spawnerSessionId ? { spawnerSessionId } : {}),
    }

    const teammateBackend = this.deps.host.prepareWorkerStorage(
      sessionId,
      initPayload,
      spawnerSessionId,
    )
    const { worker, instanceId } = this.deps.host.createWorker(
      sessionId,
      teammateBackend,
    )
    this.deps.host.registerSessionEntry(sessionId, worker, instanceId, {
      ...(spawnerSessionId ? { spawnerSessionId } : {}),
      teammateName,
      // The binding the worker BOOTS on (derived safe_code, else the lead's;
      // the template's with no live lead), so the row icon and any
      // template-gated UI agree with it — and so a sub-agent this teammate
      // spawns inherits it. Without `projectRoot` here the teammate's own
      // binding read `{templateType}` and its sub-agent booted unbound.
      ...(initPayload.templateType
        ? { templateType: initPayload.templateType }
        : {}),
      ...(initPayload.projectRoot
        ? { projectRoot: initPayload.projectRoot }
        : {}),
    })
    this.deps.host.notifySessionUpserted(sessionId)

    const abort = new AbortController()
    this.deps.aborts.set(sessionId, abort)
    void this.deps.retireStaleInbox(sessionId)

    // Idle loop: run the first turn, then idle on the mailbox.
    // Each turn uses submitAndWait which resolves when the turn's
    // executeSubmit settles — NOT on enqueue. "Staying alive" is the gap
    // BETWEEN turns - owned here, event-driven (no poll); a delivered
    // message or a shutdown abort resolves the wait.
    // the next turn restarts the actor from a clean (warm) state.
    const loop = (async () => {
      try {
        await worker.receiveFrame({
          type: 'worker.init',
          sessionId,
          payload: initPayload,
        } as SessionWorkerInboundMessage)
      } catch (err) {
        this.deps.host.tracer.event('nexus_teammate_init_failed', {
          attrs: {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          },
        })
        await this.deps.teardown(sessionId)
        return
      }

      let nextPrompt: string | null = prompt
      while (nextPrompt !== null && !abort.signal.aborted) {
        this.deps.markStatus(sessionId, 'active')
        const current = this.deps.teammates.get(sessionId)
        if (current) {
          current.interruptRequested = false
          current.turnSeq = (current.turnSeq ?? 0) + 1
        }
        // Set when this turn is cut short by a Stop on the lead and the
        // teammate survives it (see the `aborted` branch below).
        let interrupted = false
        try {
          if (worker.submitAndWait) {
            const result = await worker.submitAndWait(
              { type: 'worker.submitMessage', payload: { prompt: nextPrompt } } as Extract<AgentWorkerInboundMessage, { type: 'worker.submitMessage' }>,
              'mailbox',
            )
            // `failed` and `aborted` are normal RESOLUTIONS of
            // submitAndWait (never the catch path). A failed turn is logged
            // but keeps the loop alive, because a follow-up message can
            // recover. An aborted turn means the worker was interrupted /
            // reset / disposed out from under us — exit into teardown rather
            // than idling on the mailbox against a dead worker.
            if (result.status === 'failed') {
              this.deps.host.tracer.event('nexus_teammate_turn_failed', {
                attrs: {
                  sessionId,
                  error: `${result.code} — ${result.message}`,
                },
              })
            }
            if (result.status === 'aborted') {
              // Two kinds of abort reach here. A SHUTDOWN (abort controller
              // fired — Shutdown tool, lead deleted) or a worker that is
              // gone: exit into teardown. A user Stop on the lead
              // (`interruptTeammatesOf`) only interrupts the in-flight turn:
              // the teammate stays alive and parks on its mailbox, so the
              // lead can brief it again — Stop halts activity, Shutdown
              // removes a teammate, and the two must not collapse into one.
              if (
                abort.signal.aborted ||
                !this.deps.host.getSessionWorker(sessionId)
              ) {
                break
              }
              // Survived: the turn was cut short, so whatever text it had
              // produced is a fragment, not an answer. Mark the report —
              // unmarked it reads exactly like a completed turn and a lead
              // would build on work that did not finish.
              interrupted = true
            }
          } else {
            await worker.receiveFrame({
              type: 'worker.submitMessage',
              sessionId,
              payload: { prompt: nextPrompt },
            } as SessionWorkerInboundMessage)
          }
        } catch (err) {
          // A thrown turn must NOT kill the loop either — log and
          // keep idling so a follow-up message can recover.
          this.deps.host.tracer.event('nexus_teammate_turn_failed', {
            attrs: {
              sessionId,
              error: err instanceof Error ? err.message : String(err),
            },
          })
        }
        this.deps.markStatus(sessionId, 'idle')
        // A shutdown that landed mid-turn: the teammate is going away, and a
        // "report" now is a fragment the lead would read after it had already
        // decided to end the teammate.
        if (abort.signal.aborted) break
        // A Stop can interrupt a turn that still RESOLVES `completed` (the
        // interrupt landed between two steps). Unmarked, its fragment read
        // exactly like a finished answer, and a lead shut a teammate down
        // over a half-written "need to reconcile" it took as current.
        if (this.deps.teammates.get(sessionId)?.interruptRequested) interrupted = true
        // Report the turn to the lead. This is the ONLY upward channel a
        // locked-down child has: `safe_code` carries no SendMessage, so
        // without this a lead would never learn its teammate had finished.
        this.deps.reportTurnEnd(sessionId, interrupted)
        nextPrompt = await this.deps.mailbox.awaitInboxOrStop(
          sessionId,
          abort.signal,
        )
      }
      await this.deps.teardown(sessionId)
    })()
    // Tracked until it settles. The loop is not expected to reject (`teardown`
    // guards its own fallible steps, and an init failure above tears down and
    // returns) — if it does, record it rather than leave an unhandled
    // rejection, and still let the waiters go.
    const tracked = loop.catch((err: unknown) => {
      this.deps.host.tracer.event('nexus_teammate_loop_failed', {
        attrs: {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    })
    this.deps.loops.set(sessionId, tracked)
    void tracked.then(() => {
      if (this.deps.loops.get(sessionId) === tracked) this.deps.loops.delete(sessionId)
    })

    return sessionId
  }
}

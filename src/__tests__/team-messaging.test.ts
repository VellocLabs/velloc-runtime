import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TeamCoordinator,
  type TeamCoordinatorHost,
} from '../browser/worker/TeamCoordinator'
import type { AgentRuntimeWorkerHandle } from '../browser/worker/SharedWorkerSessionManager'
import type { OwnerRuntimeGlobals } from '../browser/worker/taskTypes'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import {
  processFs,
  installProcessFs,
} from '../utils/fs/runtimeFs'
import { unconfiguredFs } from '../utils/fs/runtimeFs'
import { TeamRegistry, setTeamRegistry } from '../team/TeamRegistry'
import { TeamMailbox } from '../team/TeamMailbox'
import {
  setTeamMessenger,
  type TeamMessenger,
} from '../team/teamMessenger'
import { MailTool, ShutdownTool } from '../toolkit/builtin/teamTools'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import type { WorkingState } from '../runtime/RuntimeTypes'

afterEach(() => setTeamMessenger(null))

const ALLOW = async () => ({ behavior: 'allow' as const })
const PARENT = {
  type: 'assistant',
  uuid: 'a-1',
  message: { role: 'assistant', content: [] },
} as never

// ── TeamMailbox (the idle-loop primitive) ──────────────────────────

describe('TeamMailbox', () => {
  it('queues when no waiter is parked (recipient busy), drains FIFO', async () => {
    const mb = new TeamMailbox()
    mb.enqueue('s', 'first')
    mb.enqueue('s', 'second')
    const ctrl = new AbortController()
    expect(await mb.awaitInboxOrStop('s', ctrl.signal)).toBe('first')
    expect(await mb.awaitInboxOrStop('s', ctrl.signal)).toBe('second')
  })

  it('resolves a parked waiter immediately on enqueue (recipient idle → inject now)', async () => {
    const mb = new TeamMailbox()
    const ctrl = new AbortController()
    const p = mb.awaitInboxOrStop('s', ctrl.signal)
    let settled = false
    void p.then(() => {
      settled = true
    })
    // Not yet resolved (parked).
    await Promise.resolve()
    expect(settled).toBe(false)
    mb.enqueue('s', 'hello')
    expect(await p).toBe('hello')
  })

  it('returns null when the signal is already aborted', async () => {
    const mb = new TeamMailbox()
    const ctrl = new AbortController()
    ctrl.abort()
    expect(await mb.awaitInboxOrStop('s', ctrl.signal)).toBeNull()
  })

  it('resolves a parked waiter null when the signal aborts (shutdown)', async () => {
    const mb = new TeamMailbox()
    const ctrl = new AbortController()
    const p = mb.awaitInboxOrStop('s', ctrl.signal)
    ctrl.abort()
    expect(await p).toBeNull()
  })

  it('hasPending / takePending reflect the queue (lead-drain path)', () => {
    const mb = new TeamMailbox()
    expect(mb.hasPending('s')).toBe(false)
    mb.enqueue('s', 'x')
    expect(mb.hasPending('s')).toBe(true)
    expect(mb.takePending('s')).toBe('x')
    expect(mb.takePending('s')).toBeNull()
  })

  it('clear() resolves a parked waiter null and drops the inbox', async () => {
    const mb = new TeamMailbox()
    const ctrl = new AbortController()
    const p = mb.awaitInboxOrStop('s', ctrl.signal)
    mb.clear('s')
    expect(await p).toBeNull()
    mb.enqueue('s', 'after-clear')
    expect(mb.hasPending('s')).toBe(true) // fresh inbox
  })

  // Read-on-consume: the file cursor advances from these acks, so an entry
  // must be acked when a TURN takes it — not when it reaches memory.
  it('acks an entry only when it is consumed, never on enqueue', async () => {
    const mb = new TeamMailbox()
    const acked: string[] = []
    mb.enqueue('s', 'a', () => acked.push('a'))
    mb.enqueue('s', 'b', () => acked.push('b'))
    expect(acked).toEqual([])
    expect(mb.takePending('s')).toBe('a')
    expect(acked).toEqual(['a'])
    const ctrl = new AbortController()
    expect(await mb.awaitInboxOrStop('s', ctrl.signal)).toBe('b')
    expect(acked).toEqual(['a', 'b'])
  })

  it('a parked waiter consumes (and acks) on enqueue', async () => {
    const mb = new TeamMailbox()
    const acked: string[] = []
    const p = mb.awaitInboxOrStop('s', new AbortController().signal)
    mb.enqueue('s', 'now', () => acked.push('now'))
    expect(await p).toBe('now')
    expect(acked).toEqual(['now'])
  })

  it('takeAll hands a running turn the whole backlog, oldest first, acking each', () => {
    const mb = new TeamMailbox()
    const acked: string[] = []
    mb.enqueue('s', 'one', () => acked.push('one'))
    mb.enqueue('s', 'two', () => acked.push('two'))
    expect(mb.takeAll('s').map(e => e.prompt)).toEqual(['one', 'two'])
    expect(acked).toEqual(['one', 'two'])
    expect(mb.hasPending('s')).toBe(false)
    expect(mb.takeAll('s')).toEqual([])
  })

  it('clear() returns the unread entries WITHOUT acking them', () => {
    const mb = new TeamMailbox()
    const acked: string[] = []
    mb.enqueue('s', 'never read', () => acked.push('x'))
    expect(mb.clear('s').map(e => e.prompt)).toEqual(['never read'])
    expect(acked).toEqual([])
  })
})

// ── SendMessage / Shutdown tools (via a fake messenger leaf) ────────

function ctx(teamCtx?: { teamName?: string; teammateName?: string }) {
  let state: WorkingState = createEmptyAppState()
  const base = createNoopToolUseContext({
    tools: [],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: state,
    setAppState: (u) => {
      state = u(state)
    },
    sessionId: 'sess',
  })
  if (teamCtx) {
    Object.assign(base.options, teamCtx)
  }
  return base
}

describe('SendMessage tool', () => {
  it('delivers via the messenger, inferring team from a teammate context', async () => {
    const calls: unknown[] = []
    const messenger: TeamMessenger = {
      deliver: (a) => {
        calls.push(a)
        return { ok: true }
      },
      shutdownMember: () => ({ ok: true }),
    }
    setTeamMessenger(messenger)
    const r = await MailTool.call(
      { to: 'team-lead', message: 'task #1 done' },
      ctx({ teamName: 'proj', teammateName: 'researcher' }),
      ALLOW,
      PARENT,
    )
    expect(r.data).toMatch(/sent to "team-lead"/i)
    expect(calls[0]).toMatchObject({
      team: 'proj',
      to: 'team-lead',
      from: 'researcher',
      body: 'task #1 done',
    })
  })

  it('a lead that passes no team addresses its own IMPLICIT team', async () => {
    // A lead owns exactly one team, identified by its session id, so there is
    // nothing for it to name. Requiring a `team` argument only gave the model
    // an identifier to get wrong.
    const calls: Array<{ team: string }> = []
    setTeamMessenger({
      deliver: (a) => {
        calls.push(a)
        return { ok: true }
      },
      shutdownMember: () => ({ ok: true }),
    })
    const r = await MailTool.call(
      { to: 'researcher', message: 'hi' },
      ctx(),
      ALLOW,
      PARENT,
    )
    expect(r.data).toMatch(/sent to "researcher"/i)
    // `sess` is the harness's sessionId, sanitized.
    expect(calls[0]?.team).toBe('sess')
  })

  it('a lead that passes an EMPTY team still addresses its implicit team', async () => {
    // Seen on the first /safe-team run: the OpenAI lead fills
    // every optional parameter, so it sent `team: ""`. `??` accepted the
    // empty string as the team and the lead got "No team context" — the one
    // tool it had for reaching the teammate it had just spawned.
    const calls: Array<{ team: string }> = []
    setTeamMessenger({
      deliver: (a) => {
        calls.push(a)
        return { ok: true }
      },
      shutdownMember: () => ({ ok: true }),
    })
    for (const team of ['', '   ']) {
      calls.length = 0
      const r = await MailTool.call(
        { to: 'researcher', message: 'hi', team },
        ctx(),
        ALLOW,
        PARENT,
      )
      expect(r.data).toMatch(/sent to "researcher"/i)
      expect(calls[0]?.team).toBe('sess')
    }
    // Shutdown resolves the team the same way.
    const shutdowns: Array<{ team: string }> = []
    setTeamMessenger({
      deliver: () => ({ ok: true }),
      shutdownMember: (a) => {
        shutdowns.push(a)
        return { ok: true }
      },
    })
    const s = await ShutdownTool.call(
      { name: 'researcher', team: '' },
      ctx(),
      ALLOW,
      PARENT,
    )
    expect(s.data).toMatch(/shutting down/i)
    expect(shutdowns[0]?.team).toBe('sess')
  })

  it('lead-sent message uses the passed team and from "team-lead"', async () => {
    const calls: Array<{ team: string; from: string }> = []
    setTeamMessenger({
      deliver: (a) => {
        calls.push(a)
        return { ok: true }
      },
      shutdownMember: () => ({ ok: true }),
    })
    await MailTool.call(
      { to: 'researcher', message: 'start task 1', team: 'proj' },
      ctx(),
      ALLOW,
      PARENT,
    )
    expect(calls[0]).toMatchObject({ team: 'proj', from: 'team-lead' })
  })

  it('tells the messenger when its model response also called other tools', async () => {
    const calls: Array<{ withOtherTools?: boolean }> = []
    setTeamMessenger({
      deliver: (a) => {
        calls.push(a)
        return { ok: true }
      },
      shutdownMember: () => ({ ok: true }),
    })
    const parentWith = (...toolNames: string[]) => ({
      type: 'assistant',
      uuid: 'a-2',
      message: {
        role: 'assistant',
        content: toolNames.map((toolName, i) => ({ type: 'tool-call', toolCallId: `c${i}`, toolName, args: {} })),
      },
    }) as never
    const send = (parent: never) =>
      MailTool.call(
        { to: 'team-lead', message: 'report' },
        ctx({ teamName: 'proj', teammateName: 'researcher' }),
        ALLOW,
        parent,
      )
    await send(parentWith('SendMessage', 'Read'))
    await send(parentWith('SendMessage'))
    await send(parentWith('SendMessage', 'SendMessage'))
    expect(calls.map(c => c.withOtherTools)).toEqual([true, false, false])
  })

  it('a lead that passes a WRONG team still reaches its own teammates', async () => {
    // The tool text used to say `team` was required from the lead, so a lead
    // passed its TeamCreate id, the project name or "team-lead" — none of
    // which hold its teammates (they are all in its implicit team) — and got
    // "no member" for the teammate it had just spawned. The requested team is
    // tried first (the one way to reach ANOTHER team's member), the implicit
    // team second.
    const calls: Array<{ team: string }> = []
    setTeamMessenger({
      deliver: (a) => {
        calls.push(a)
        return a.team === 'sess'
          ? { ok: true }
          : { ok: false, reason: `no member "researcher" in team "${a.team}"` }
      },
      shutdownMember: (a) => {
        calls.push(a)
        return a.team === 'sess'
          ? { ok: true }
          : { ok: false, reason: `no member "researcher" in team "${a.team}"` }
      },
    })
    const r = await MailTool.call(
      { to: 'researcher', message: 'hi', team: 'auth-refactor' },
      ctx(),
      ALLOW,
      PARENT,
    )
    expect(r.data).toMatch(/sent to "researcher" in team "sess"/i)
    expect(calls.map(c => c.team)).toEqual(['auth-refactor', 'sess'])

    calls.length = 0
    const s = await ShutdownTool.call({ name: 'researcher', team: 'team-lead' }, ctx(), ALLOW, PARENT)
    expect(s.data).toMatch(/shutting down/i)
    expect(calls.map(c => c.team)).toEqual(['team-lead', 'sess'])
  })

  it('a failure other than "no member" in the requested team is final — the member was found there', async () => {
    const calls: Array<{ team: string }> = []
    setTeamMessenger({
      deliver: (a) => {
        calls.push(a)
        return { ok: false, reason: 'member "researcher" is not currently running' }
      },
      shutdownMember: () => ({ ok: true }),
    })
    const r = await MailTool.call(
      { to: 'researcher', message: 'hi', team: 'other' },
      ctx(),
      ALLOW,
      PARENT,
    )
    expect(r.data).toMatch(/not delivered.*not currently running/i)
    expect(calls.map(c => c.team)).toEqual(['other'])
  })

  it('surfaces a delivery failure reason', async () => {
    setTeamMessenger({
      deliver: () => ({ ok: false, reason: 'no member "ghost"' }),
      shutdownMember: () => ({ ok: true }),
    })
    const r = await MailTool.call(
      { to: 'ghost', message: 'hi', team: 'proj' },
      ctx(),
      ALLOW,
      PARENT,
    )
    expect(r.data).toMatch(/not delivered.*no member/i)
  })

  it('reports unavailable with no messenger registered', async () => {
    setTeamMessenger(null)
    const r = await MailTool.call(
      { to: 'x', message: 'y', team: 't' },
      ctx(),
      ALLOW,
      PARENT,
    )
    expect(r.data).toMatch(/unavailable/i)
  })
})

describe('Shutdown tool', () => {
  it('shuts down a teammate via the messenger', async () => {
    const calls: unknown[] = []
    setTeamMessenger({
      deliver: () => ({ ok: true }),
      shutdownMember: (a) => {
        calls.push(a)
        return { ok: true }
      },
    })
    const r = await ShutdownTool.call(
      { name: 'researcher', team: 'proj' },
      ctx(),
      ALLOW,
      PARENT,
    )
    expect(r.data).toMatch(/shutting down/i)
    expect(calls[0]).toMatchObject({ team: 'proj', name: 'researcher' })
  })

  it('surfaces a shutdown failure reason', async () => {
    setTeamMessenger({
      deliver: () => ({ ok: true }),
      shutdownMember: () => ({ ok: false, reason: 'not a running teammate' }),
    })
    const r = await ShutdownTool.call(
      { name: 'ghost', team: 'proj' },
      ctx(),
      ALLOW,
      PARENT,
    )
    expect(r.data).toMatch(/shutdown failed.*not a running/i)
  })
})

// ── TeamCoordinator idle loop — submitAndWait resolutions ──────
//
// `failed` and `aborted` are normal RESOLUTIONS of submitAndWait, never the
// catch path — pre-B8 both fell through as if the turn completed cleanly:
// a failed turn was silently swallowed, and an aborted one left the loop
// idling on the mailbox against a worker that was interrupted / reset /
// disposed out from under it.

describe('TeamCoordinator idle loop — turn resolutions (B8)', () => {
  const tick = () => new Promise<void>((r) => setTimeout(r, 0))

  function harness(
    submitResults: Array<
      | { status: 'completed' }
      | { status: 'aborted'; reason: string }
      | { status: 'failed'; code: string; message: string }
    >,
    mark: () => Promise<boolean> = async () => true,
  ) {
    const submitPrompts: string[] = []
    const worker = {
      receiveFrame: async () => {},
      submitAndWait: async (
        msg: { payload: { prompt: string } },
      ) => {
        submitPrompts.push(msg.payload.prompt)
        return submitResults.shift() ?? { status: 'completed' as const }
      },
      isBusy: () => false,
    } as unknown as AgentRuntimeWorkerHandle
    const events: string[] = []
    const order: string[] = []
    const counters = { disposed: 0, removed: 0, shutdown: 0 }
    const host: TeamCoordinatorHost = {
      getInitTemplate: () => ({ cwd: '/x' }) as never,
      prepareWorkerStorage: () => null,
      createWorker: () => ({ worker, instanceId: 'i-1' }),
      registerSessionEntry: () => {},
      getSessionWorker: () => worker,
      markSessionShutdown: async () => {
        counters.shutdown += 1
        order.push('mark')
        return mark()
      },
      disposeManagedSession: async () => {
        counters.disposed += 1
        order.push('dispose')
      },
      notifySessionUpserted: () => {},
      broadcastSessionRemoved: () => {
        counters.removed += 1
      },
      enqueueMailboxTurn: () => true,
      getDirectBridgeTransport: () => null,
      getSessionDirectory: () => null,
      isSessionBusy: () => false,
      isDeliverySuppressed: () => false,
      getOwnerGlobals: () => undefined,
      getSessionTrust: () => 'trusted',
      getFinalAssistantText: () => '',
      tracer: {
        event: (name: string) => {
          events.push(name)
        },
      } as never,
    }
    return { coord: new TeamCoordinator(host), submitPrompts, events, counters, order }
  }

  it('a failed turn logs but keeps the loop alive — a follow-up message recovers it', async () => {
    const { coord, submitPrompts, events, counters } = harness([
      { status: 'failed', code: 'provider_error', message: 'boom' },
      { status: 'completed' },
    ])
    const spawned = coord.spawn({
      teamName: 'proj',
      teammateName: 'worker1',
      prompt: 'first task',
      spawnerSessionId: 'lead',
    })
    expect(spawned).not.toBeNull()
    await tick()

    // The failure was surfaced, but the loop did NOT tear down — it parked
    // on the mailbox.
    expect(events).toContain('nexus_teammate_turn_failed')
    expect(counters.disposed).toBe(0)

    // A delivered follow-up wakes the loop and runs a second turn.
    expect(
      coord.deliver({ team: 'proj', to: 'worker1', from: 'lead', body: 'try again' })
        .ok,
    ).toBe(true)
    await tick()
    expect(submitPrompts).toHaveLength(2)
    expect(submitPrompts[1]).toContain('try again')

    // Cleanup: end the loop via shutdown.
    expect(coord.shutdownMember({ team: 'proj', name: 'worker1' }).ok).toBe(true)
    await tick()
    expect(counters.disposed).toBe(1)
  })

  it('an aborted turn exits the loop into teardown instead of idling on a dead worker', async () => {
    const { coord, events, counters, order } = harness([
      { status: 'aborted', reason: 'interrupted' },
    ])
    coord.spawn({
      teamName: 'proj',
      teammateName: 'worker2',
      prompt: 'first task',
      spawnerSessionId: 'lead',
    })
    // A DEAD worker: the abort came from a shutdown, so the teammate's
    // controller is aborted before the turn resolves. (An abort with the
    // controller untouched and the worker still registered is a user Stop
    // on the lead, which parks the teammate instead — see the roster /
    // Stop-cascade tests below.)
    coord.shutdownMember({ team: 'proj', name: 'worker2' })
    await tick()

    // Torn down: the runtime is disposed but the persisted session remains
    // addressable as a read-only transcript.
    expect(counters.disposed).toBe(1)
    expect(counters.removed).toBe(0)
    // The durable shutdown marker was written BEFORE the runtime was disposed
    // (the tab flips read-only without waiting on the dispose) and RE-ASSERTED
    // after it: a still-live runtime's own meta write — a full replace built
    // from in-memory metadata that never carried `shutdown` — could land after
    // the first marker and erase it, and the next restart then read the child
    // as lost. Once disposal has returned nothing can write over the second.
    expect(counters.shutdown).toBe(2)
    expect(order).toEqual(['mark', 'dispose', 'mark'])
    expect(
      coord.deliver({ team: 'proj', to: 'worker2', from: 'lead', body: 'hello' }).ok,
    ).toBe(false)
    // An abort is not a failure — no failure event logged.
    expect(events).not.toContain('nexus_teammate_turn_failed')
  })

  it('a THROWING shutdown-marker write still disposes the teammate and removes its tab', async () => {
    const { coord, events, counters } = harness(
      [{ status: 'aborted', reason: 'interrupted' }],
      async () => {
        throw new Error('sqlite locked')
      },
    )
    coord.spawn({ teamName: 'proj', teammateName: 'w3', prompt: 'p', spawnerSessionId: 'lead' })
    coord.shutdownMember({ team: 'proj', name: 'w3' })
    await tick()
    await tick()
    expect(events).toContain('nexus_teammate_shutdown_mark_failed')
    expect(counters.disposed).toBe(1)
    // No durable marker → nothing would stop a click re-booting it: remove.
    expect(counters.removed).toBe(1)
  })

  it('a teammate with no persisted meta (marker not written) has its tab removed', async () => {
    const { coord, counters } = harness(
      [{ status: 'aborted', reason: 'interrupted' }],
      async () => false,
    )
    coord.spawn({ teamName: 'proj', teammateName: 'w4', prompt: 'p', spawnerSessionId: 'lead' })
    coord.shutdownMember({ team: 'proj', name: 'w4' })
    await tick()
    await tick()
    expect(counters.disposed).toBe(1)
    expect(counters.removed).toBe(1)
  })
})

// ── Lead-side visibility + Stop cascade ───────────────────────
//
// What the first /safe-team run lacked: a lead that could SEE its teammates
// (AgentList listed only sub-agents), ask about one by id (TaskOutput knew
// only "subagent-…" ids), and a user Stop that reached them.

import { AgentListTool, JobReadTool } from '../toolkit/builtin/subAgentControlTools'
import { setSubAgentController } from '../team/subAgentController'

function emptyController() {
  setSubAgentController({
    getSnapshot: () => null,
    waitForCompletion: async () => null,
    stop: () => ({ status: 'not_found' }),
    resume: () => ({ ok: false, reason: 'not_found' }),
    list: () => [],
  })
}

/** A coordinator whose single teammate parks mid-turn until told otherwise.
 *  `leadGlobals` is what the host reports as the LEAD's runtime singletons —
 *  what teardown must reinstall. */
function coordinatorWithParkedTeammate(leadGlobals?: OwnerRuntimeGlobals) {
  const received: Array<{ type?: string }> = []
  let resolveTurn: ((r: { status: string; reason?: string }) => void) | null = null
  const stubWorker = {
    receiveFrame: async (message: { type?: string }) => {
      received.push(message)
    },
    submitAndWait: () =>
      new Promise<{ status: string; reason?: string }>(resolve => {
        resolveTurn = resolve
      }),
    getSnapshot: () => ({ initialized: true }),
    isBusy: () => true,
  }
  let registered = true
  const disposed: string[] = []
  const coordinator = new TeamCoordinator({
    getInitTemplate: () => ({ sessionId: 'template', cwd: '/w' }) as never,
    prepareWorkerStorage: () => null,
    createWorker: () => ({ worker: stubWorker as never, instanceId: 'inst-1' }),
    registerSessionEntry: () => {},
    getSessionWorker: () => (registered ? (stubWorker as never) : undefined),
    disposeManagedSession: async (sid: string) => {
      disposed.push(sid)
    },
    notifySessionUpserted: () => {},
    broadcastSessionRemoved: () => {},
    enqueueMailboxTurn: () => true,
    getDirectBridgeTransport: () => null,
    getSessionDirectory: () => null,
    isSessionBusy: () => false,
    isDeliverySuppressed: () => false,
    getOwnerGlobals: () => leadGlobals,
    getSessionTrust: () => 'trusted',
    getFinalAssistantText: () => '',
    tracer: { event: () => {} } as never,
  } satisfies TeamCoordinatorHost)
  return {
    coordinator,
    received,
    disposed,
    unregister: () => {
      registered = false
    },
    /** Settle the parked turn the way the worker does after an interrupt. */
    abortTurn: () => resolveTurn?.({ status: 'aborted', reason: 'interrupted' }),
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('TeamCoordinator — roster and Stop cascade', () => {
  it('listTeammatesOf: a spawned teammate is listed for its lead, with its live status', async () => {
    const h = coordinatorWithParkedTeammate()
    const sid = h.coordinator.spawn({
      teamName: 'lead-1',
      teammateName: 'worker-a',
      prompt: 'go',
      spawnerSessionId: 'lead-1',
    })
    expect(sid).not.toBeNull()
    await tick()
    expect(h.coordinator.listTeammatesOf('lead-1')).toEqual([
      expect.objectContaining({ sessionId: sid, name: 'worker-a', status: 'active' }),
    ])
    // Scoped by lead: another session sees nothing.
    expect(h.coordinator.listTeammatesOf('lead-2')).toEqual([])
  })

  it('interruptTeammatesOf: a user Stop on the lead interrupts the turn but the teammate stays alive and goes idle', async () => {
    const h = coordinatorWithParkedTeammate()
    const sid = h.coordinator.spawn({
      teamName: 'lead-1',
      teammateName: 'worker-a',
      prompt: 'long task',
      spawnerSessionId: 'lead-1',
    })!
    await tick()
    h.coordinator.interruptTeammatesOf('lead-1')
    // Red-without: nothing reached the worker — the teammate kept running
    // against the provider after the user had stopped the lead.
    expect(h.received.some(m => m.type === 'worker.interrupt')).toBe(true)

    // The worker settles the interrupted turn as `aborted`. Before, the loop
    // read every abort as a shutdown and tore the teammate down.
    h.abortTurn()
    await tick()
    await tick()
    expect(h.disposed).toEqual([])
    expect(h.coordinator.listTeammatesOf('lead-1')).toEqual([
      expect.objectContaining({ sessionId: sid, status: 'idle' }),
    ])
  })

  it('an aborted turn still tears the teammate down when its controller was aborted (shutdown) or its worker is gone', async () => {
    const h = coordinatorWithParkedTeammate()
    const sid = h.coordinator.spawn({
      teamName: 'lead-1',
      teammateName: 'worker-a',
      prompt: 'long task',
      spawnerSessionId: 'lead-1',
    })!
    await tick()
    h.coordinator.abortTeammatesOf('lead-1')
    h.abortTurn()
    await tick()
    await tick()
    expect(h.disposed).toEqual([sid])
    expect(h.coordinator.listTeammatesOf('lead-1')).toEqual([])

    // Worker vanished out from under the loop (no abort): teardown too, never
    // an idle wait against a dead worker.
    const g = coordinatorWithParkedTeammate()
    const sid2 = g.coordinator.spawn({
      teamName: 'lead-1',
      teammateName: 'worker-b',
      prompt: 'long task',
      spawnerSessionId: 'lead-1',
    })!
    await tick()
    g.unregister()
    g.abortTurn()
    await tick()
    await tick()
    expect(g.disposed).toEqual([sid2])
  })

  it("teardown reinstalls the LEAD's fs slot — a disposed teammate must not own it", async () => {
    // A teammate runs in the same JS realm as its lead and its
    // `createAgentRuntime` overwrites the process-global fs slot with its own
    // (installProcessFs). Nothing put it back, so after a Shutdown the
    // slot still held the teammate's DEAD bridge transport and the lead's
    // next write through the fs facade rejected with "Runtime scope was
    // disposed." — observed as `Failed to create task: Runtime
    // scope was disposed.` on the lead's own task list, while its hosted
    // tools (their own transport) kept working. Silent, partial loss.
    const leadFs = { tag: 'lead' } as unknown as RuntimeFs
    const teammateFs = { tag: 'teammate' } as unknown as RuntimeFs
    const before = processFs()
    try {
      const h = coordinatorWithParkedTeammate({
        fs: leadFs,
        conversationStore: undefined,
        sidechainStore: undefined,
      } as unknown as OwnerRuntimeGlobals)
      const sid = h.coordinator.spawn({
        teamName: 'lead-1',
        teammateName: 'worker-a',
        prompt: 'long task',
        spawnerSessionId: 'lead-1',
      })!
      await tick()
      // What the teammate's own runtime boot does.
      installProcessFs(teammateFs)
      h.coordinator.abortTeammatesOf('lead-1')
      h.abortTurn()
      await tick()
      await tick()
      expect(h.disposed).toEqual([sid])
      expect(processFs()).toBe(leadFs)
    } finally {
      installProcessFs(before)
    }
  })

  it('a host that reports no lead globals leaves the slot alone', async () => {
    // A teammate spawned before its lead's runtime reported (or a host
    // without the capability) has nothing to restore TO. Writing `undefined`
    // into the slot would be worse than the bug.
    const teammateFs = { tag: 'teammate' } as unknown as RuntimeFs
    const before = processFs()
    try {
      const h = coordinatorWithParkedTeammate()
      h.coordinator.spawn({
        teamName: 'lead-1',
        teammateName: 'worker-a',
        prompt: 'long task',
        spawnerSessionId: 'lead-1',
      })
      await tick()
      installProcessFs(teammateFs)
      h.coordinator.abortTeammatesOf('lead-1')
      h.abortTurn()
      await tick()
      await tick()
      expect(processFs()).toBe(teammateFs)
    } finally {
      installProcessFs(before)
    }
  })

  it('teardown hands back the unfinished tasks the teammate had claimed', async () => {
    // A task's owner is a NAME, not a live reference, and nothing noticed
    // when the owner stopped existing. After one run the lead's
    // list still read two rows `in_progress @read-media-fixer` with that
    // teammate shut down — work the list said was underway that nobody was
    // doing, on the list the lead reads to decide what is left.
    const files = new Map<string, string>()
    const fs = {
      ...unconfiguredFs,
      async mkdir() {},
      async readFile(path: string): Promise<string> {
        const v = files.get(path)
        if (v === undefined) throw new Error(`ENOENT ${path}`)
        return v
      },
      async writeFile(path: string, data: string): Promise<void> {
        files.set(path, data)
      },
    } as RuntimeFs
    const before = processFs()
    try {
      let n = 1000
      const reg = await TeamRegistry.load(fs, '/rt', () => ++n)
      setTeamRegistry(reg)
      await reg.createTeam({ name: 'lead-1', headSessionId: 'lead-1' })
      await reg.createTask('lead-1', { subject: 'claimed', description: 'd', owner: 'worker-a' })
      await reg.updateTask('lead-1', '1', { status: 'in_progress' })
      await reg.createTask('lead-1', { subject: 'done', description: 'd', owner: 'worker-a' })
      await reg.updateTask('lead-1', '2', { status: 'completed' })
      await reg.createTask('lead-1', { subject: 'sibling', description: 'd', owner: 'worker-b' })
      await reg.updateTask('lead-1', '3', { status: 'in_progress' })

      const h = coordinatorWithParkedTeammate({ fs } as unknown as OwnerRuntimeGlobals)
      h.coordinator.spawn({
        teamName: 'lead-1',
        teammateName: 'worker-a',
        prompt: 'go',
        spawnerSessionId: 'lead-1',
      })
      await tick()
      h.coordinator.abortTeammatesOf('lead-1')
      h.abortTurn()
      await tick()
      await tick()
      await tick()

      // Its claim is released and claimable again...
      expect(reg.getTask('lead-1', '1')?.status).toBe('pending')
      expect(reg.getTask('lead-1', '1')?.owner).toBeFalsy()
      // ...but finished work stays finished...
      expect(reg.getTask('lead-1', '2')?.status).toBe('completed')
      expect(reg.getTask('lead-1', '2')?.owner).toBe('worker-a')
      // ...and a sibling's claim is none of its business.
      expect(reg.getTask('lead-1', '3')?.status).toBe('in_progress')
      expect(reg.getTask('lead-1', '3')?.owner).toBe('worker-b')
    } finally {
      setTeamRegistry(null)
      installProcessFs(before)
    }
  })
})

describe('AgentList / TaskOutput — teammates', () => {
  afterEach(() => setSubAgentController(null))

  function roster(status: 'active' | 'idle' = 'active') {
    setTeamMessenger({
      deliver: () => ({ ok: true }),
      shutdownMember: () => ({ ok: true }),
      listMembers: lead =>
        lead === 'sess'
          ? [{ sessionId: 'teammate-sess-worker-a-1', name: 'worker-a', status, startedAt: 1 }]
          : [],
    })
  }

  it('AgentList lists the lead teammates even with no sub-agents, and under a status filter', async () => {
    emptyController()
    roster('idle')
    const all = await AgentListTool.call({}, ctx(), ALLOW, PARENT)
    expect(all.data).toContain('Teammates of this session (1, 0 active)')
    expect(all.data).toContain('[idle] teammate-sess-worker-a-1 — teammate "worker-a"')
    expect(all.data).toMatch(/end your turn/)
    // The sub-agent status vocabulary cannot name a teammate, so a filter
    // must not hide the roster — the old "0 running" answer is how the lead
    // concluded it had no teammate.
    const running = await AgentListTool.call({ status: 'running' }, ctx(), ALLOW, PARENT)
    expect(running.data).toContain('teammate-sess-worker-a-1')
  })

  it('AgentList without a roster reads exactly as before', async () => {
    emptyController()
    setTeamMessenger({ deliver: () => ({ ok: true }), shutdownMember: () => ({ ok: true }) })
    const r = await AgentListTool.call({}, ctx(), ALLOW, PARENT)
    expect(r.data).toBe('No background sub-agents have been launched from this session.')
  })

  it('TaskOutput on a teammate id returns its status and the wait hint, never blocks, never "not found"', async () => {
    emptyController()
    roster('active')
    const r = await JobReadTool.call(
      { task_id: 'teammate-sess-worker-a-1', block: true, timeout: 600_000 },
      ctx(),
      ALLOW,
      PARENT,
    )
    expect(r.data).toContain('Teammate "worker-a" [active]')
    expect(r.data).toMatch(/end your turn/)
    expect(r.data).not.toMatch(/No background task found/)
  })

  it('TaskOutput on an unknown teammate id says so and points at AgentList', async () => {
    emptyController()
    roster()
    const r = await JobReadTool.call({ task_id: 'teammate-sess-ghost-1' }, ctx(), ALLOW, PARENT)
    expect(r.data).toMatch(/No running teammate/)
    expect(r.data).toContain('AgentList')
  })
})

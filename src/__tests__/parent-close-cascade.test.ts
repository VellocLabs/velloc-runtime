/**
 * Parent-close cascade:
 * - `abortTeammatesOf` interrupts a teammate mid-turn (the abort signal only
 *   guards the between-turns mailbox wait).
 * - the parent-close sub-agent teardown restores the owner runtime's process
 *   globals.
 * Companion tests: shared-worker.test.ts, browser-runtime-worker.test.ts.
 */
import { describe, expect, it, vi } from 'vitest'
import { TeamCoordinator } from '../browser/worker/TeamCoordinator'
import { SubAgentCoordinator } from '../browser/worker/SubAgentCoordinator'
import { TaskRegistry } from '../browser/worker/TaskRegistry'
import {
  processFs,
  installProcessFs,
} from '../utils/fs/runtimeFs'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

describe('parent-close cascade', () => {
  it('abortTeammatesOf interrupts a teammate that is mid-turn', async () => {
    const received: Array<{ type?: string }> = []
    const stubWorker = {
      receiveFrame: vi.fn(async (message: { type?: string }) => {
        received.push(message)
      }),
      // Never settles — the teammate is parked mid-turn, exactly the state
      // where the abort signal alone cannot stop it.
      submitAndWait: () => new Promise(() => {}),
      getSnapshot: () => ({ initialized: true }),
      isBusy: () => true,
    }
    const coordinator = new TeamCoordinator({
      getInitTemplate: () => ({ sessionId: 'template', cwd: '/w' }) as never,
      prepareWorkerStorage: () => null,
      createWorker: () => ({
        worker: stubWorker as never,
        instanceId: 'inst-1',
      }),
      registerSessionEntry: () => {},
      getSessionWorker: () => stubWorker as never,
      disposeManagedSession: async () => {},
      notifySessionUpserted: () => {},
      broadcastSessionRemoved: () => {},
      enqueueMailboxTurn: () => true,
      getDirectBridgeTransport: () => null,
      getSessionDirectory: () => null,
      isSessionBusy: () => false,
      isDeliverySuppressed: () => false,
      getOwnerGlobals: () => undefined,
      getSessionTrust: () => 'trusted',
      getFinalAssistantText: () => '',
      tracer: { event: () => {} } as never,
    })

    const sessionId = coordinator.spawn({
      teamName: 'team',
      teammateName: 'worker-a',
      prompt: 'long task',
      spawnerSessionId: 'lead-1',
    })
    expect(sessionId).not.toBeNull()
    // Let the spawn IIFE run init and park on the never-settling turn.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(received.some(m => m.type === 'worker.init')).toBe(true)

    // The abort + interrupt fire synchronously; the returned promise waits
    // for the (never-settling) teammate turn, which this test does not need.
    void coordinator.abortTeammatesOf('lead-1')

    // Red-without: only the mailbox abort fired — the in-flight model turn
    // kept running until natural completion. The cascade must mirror
    // shutdownMember and interrupt the worker.
    expect(
      received.some(m => m.type === 'worker.interrupt'),
      'parent-close must interrupt the mid-turn teammate',
    ).toBe(true)
  })

  it('sub-agent teardown restores the owner runtime globals', async () => {
    const originalFs = processFs()
    const ownerFs = { __sentinel: 'owner' } as unknown as RuntimeFs
    const childFs = { __sentinel: 'child' } as unknown as RuntimeFs
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const registry = new TaskRegistry<any, any>()
      const coordinator = new SubAgentCoordinator(registry, {
        scheduleSummary: () => {},
        getSessionWorker: () => undefined,
        disposeManagedSession: async () => {},
      } as never)

      registry.registerLive('subagent-r5', {
        type: 'local_agent',
        taskId: 'a-r5',
        spawnerSessionId: 'parent-1',
        sessionId: 'subagent-r5',
        agentId: 'r5',
        description: 'cascade test',
        prompt: 'p',
        messages: [],
        completed: false,
        depth: 1,
        startedAt: 1,
        lastActivityAt: 1,
        ownerGlobals: {
          fs: ownerFs,
          conversationStore: null,
          sidechainStore: null,
        },
      })

      // The child's runtime installed its own globals; the parent-close
      // cascade then tears the child down.
      installProcessFs(childFs)
      await coordinator.teardown('subagent-r5')

      // Red-without: teardown skipped the restore (only finalize/stop did
      // it), leaving the realm's global fs on the disposed child — any other
      // live session reading the global (shell output persistence, settings
      // writes) would hang on a dropped bridge response.
      expect(
        processFs(),
        'teardown must restore the owner globals',
      ).toBe(ownerFs)
    } finally {
      installProcessFs(originalFs)
    }
  })
})

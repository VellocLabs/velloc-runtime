import { describe, expect, it } from 'vitest'
import { SessionStorageCoordinator } from '../browser/worker/SessionStorageCoordinator'
import { projectSessionInfo } from '../browser/worker/sessionInfoProjection'
import {
  isSubAgentSessionId,
  isTeammateSessionId,
} from '../browser/worker/taskProjection'
import type { AgentRuntimeWorkerInitPayload } from '../browser/worker/workerProtocol'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { getScratchpadDirForContext } from '../toolkit/run/toolPermissionGate'
import { getBackgroundShellOutputPath } from '../toolkit/builtin/host/shellArgs'
import { superShellRunDir } from '../toolkit/builtin/superShellRunner'

/**
 * Teammate (child) session plumbing: where a child's transcript directory
 * lands, and how `spawnerSessionId` reaches the sidebar payload.
 *
 * The nesting is what makes deleting a lead sweep its children's files, so
 * these assertions pin a data-loss-shaped contract, not a cosmetic one.
 */

/** A coordinator with the grouped layout forced on, and a routing map the
 *  test controls (the real one is populated by the sidebar scan). */
function makeCoordinator(routed: Record<string, string> = {}) {
  const coordinator = new SessionStorageCoordinator({
    getDirectBridgeTransport: () => ({}) as never,
    onStorageReady: () => {},
  })
  const internals = coordinator as unknown as {
    groupedStorage: unknown
    homeDir: string
  }
  internals.homeDir = '/home/u'
  internals.groupedStorage = {
    projectRouteOf: (sessionId: string) => routed[sessionId],
    setSessionProjectDir: () => {},
  }
  return coordinator
}

function payload(
  partial: Partial<AgentRuntimeWorkerInitPayload> = {},
): AgentRuntimeWorkerInitPayload {
  return { sessionId: 's', ...partial } as AgentRuntimeWorkerInitPayload
}

describe('teammate session-id predicate', () => {
  it('separates teammate ids from sub-agent ids and ordinary sessions', () => {
    expect(isTeammateSessionId('teammate-t-worker-a-1')).toBe(true)
    expect(isTeammateSessionId('subagent-abc')).toBe(false)
    expect(isTeammateSessionId('session-1')).toBe(false)
    expect(isSubAgentSessionId('teammate-t-worker-a-1')).toBe(false)
  })
})

describe('SessionStorageCoordinator — teammate directory nesting', () => {
  it('nests a teammate under its lead in `teammates/`', () => {
    const coordinator = makeCoordinator()
    const prepared = coordinator.prepareWorkerStorageTarget(
      'teammate-t-worker-a-1',
      payload({ sessionId: 'teammate-t-worker-a-1', projectRoot: 'D:/proj' }),
      'lead-1',
    )
    expect(prepared.targetProjectDir?.endsWith('/lead-1/teammates')).toBe(true)
  })

  it('follows the LEAD\u2019s routed directory, not the child\u2019s derived one', () => {
    // A lead re-bound to a real folder: the child must land under THAT
    // directory or the lead\u2019s recursive delete misses it.
    const coordinator = makeCoordinator({
      'lead-1': '/home/u/.velloc/projects/D--real-folder',
    })
    const prepared = coordinator.prepareWorkerStorageTarget(
      'teammate-t-worker-a-1',
      payload({ sessionId: 'teammate-t-worker-a-1' }),
      'lead-1',
    )
    expect(prepared.targetProjectDir).toBe(
      '/home/u/.velloc/projects/D--real-folder/lead-1/teammates',
    )
  })

  it('leaves sub-agent nesting untouched', () => {
    const coordinator = makeCoordinator()
    const prepared = coordinator.prepareWorkerStorageTarget(
      'subagent-1',
      payload({ sessionId: 'subagent-1', projectRoot: 'D:/proj' }),
      'lead-1',
    )
    expect(prepared.targetProjectDir?.endsWith('/lead-1/subagents')).toBe(true)
  })

  it('does NOT re-point a sub-agent at its parent’s routed dir', () => {
    // The parent-routed base is right for a teammate but would MOVE where an
    // existing sub-agent's transcript is written whenever the parent's routed
    // dir differs from the child's derived one. That is a behaviour change to
    // another feature and does not belong in the team change.
    const coordinator = makeCoordinator({
      'lead-1': '/home/u/.velloc/projects/D--somewhere-else',
    })
    const prepared = coordinator.prepareWorkerStorageTarget(
      'subagent-1',
      payload({ sessionId: 'subagent-1', projectRoot: 'D:/proj' }),
      'lead-1',
    )
    expect(prepared.targetProjectDir).not.toContain('D--somewhere-else')
    expect(prepared.targetProjectDir?.endsWith('/lead-1/subagents')).toBe(true)
  })

  it('a teammate id with NO parent stays at the flat project dir', () => {
    const coordinator = makeCoordinator()
    const prepared = coordinator.prepareWorkerStorageTarget(
      'teammate-orphan',
      payload({ sessionId: 'teammate-orphan', projectRoot: 'D:/proj' }),
    )
    expect(prepared.targetProjectDir).not.toContain('teammates')
  })

  it('an ordinary session is unaffected', () => {
    const coordinator = makeCoordinator()
    const prepared = coordinator.prepareWorkerStorageTarget(
      'session-1',
      payload({ sessionId: 'session-1', projectRoot: 'D:/proj' }),
      'lead-1',
    )
    expect(prepared.targetProjectDir).not.toContain('lead-1')
  })
})

describe('projectSessionInfo — teammate identity', () => {
  const fs = {
    sessionId: 'teammate-1',
    firstPrompt: 'hi',
    updatedAt: 1,
    messageCount: 1,
    spawnerSessionId: 'lead-from-disk',
    teammateName: 'worker-from-disk',
  } as never

  it('prefers the live entry (init payload) over the persisted summary', () => {
    const info = projectSessionInfo({
      sessionId: 'teammate-1',
      entry: {
        spawnerSessionId: 'lead-live',
        teammateName: 'worker-live',
        snapshot: { initialized: true } as never,
      },
      live: undefined,
      fs,
    })
    expect(info?.spawnerSessionId).toBe('lead-live')
    expect(info?.teammateName).toBe('worker-live')
  })

  it('falls back to the persisted summary for a session with no worker', () => {
    const info = projectSessionInfo({
      sessionId: 'teammate-1',
      entry: undefined,
      live: undefined,
      fs,
    })
    expect(info?.spawnerSessionId).toBe('lead-from-disk')
    expect(info?.teammateName).toBe('worker-from-disk')
  })

  it('reports the child as a child from the LIVE entry alone, with no fs summary', () => {
    // The shipped bug: a spawned teammate's entry carried no identity, so
    // until a persisted-summary refresh landed the projection returned no
    // `spawnerSessionId` — and the webview then treated the child as an
    // ordinary top-level session: a stray sidebar row and NO tab strip.
    // `fs: undefined` is exactly the moment right after the spawn.
    const info = projectSessionInfo({
      sessionId: 'teammate-1',
      entry: {
        spawnerSessionId: 'lead-1',
        teammateName: 'worker-a',
        templateType: 'safe_code',
        snapshot: { initialized: true } as never,
      },
      live: undefined,
      fs: undefined,
    })
    expect(info?.spawnerSessionId).toBe('lead-1')
    expect(info?.teammateName).toBe('worker-a')
  })

  it('omits both fields for an ordinary session', () => {
    const info = projectSessionInfo({
      sessionId: 's',
      entry: undefined,
      live: undefined,
      fs: {
        sessionId: 's',
        firstPrompt: 'hi',
        updatedAt: 1,
        messageCount: 1,
      } as never,
    })
    expect(info?.spawnerSessionId).toBeUndefined()
    expect(info?.teammateName).toBeUndefined()
  })
})

// A teammate's transcript is nested under its lead, but its per-session SIDE
// dirs (`tasks/` for shell output, `scratch/`, `supershell/`) were derived
// from `projectHomeFor(homeDir, projectRoot)` — the flat project dir — and
// piled up as stray `teammate-<lead>-<name>-<ts>/` directories at the project
// root, beside every lead, outside the lead's cascade delete. Every consumer
// must hang them off the base the router stamped (`sessionStorageBase`).
describe('teammate per-session side dirs follow the routed storage base', () => {
  const TEAMMATE = 'teammate-lead-1-worker-1'

  function teammateContext(): ToolCallContext {
    const prepared = makeCoordinator().prepareWorkerStorageTarget(
      TEAMMATE,
      payload({ sessionId: TEAMMATE, projectRoot: 'D:/proj' }),
      'lead-1',
    )
    return {
      options: {
        sessionId: TEAMMATE,
        homeDir: '/home/u',
        projectRoot: 'D:/proj',
        sessionStorageBase: prepared.targetProjectDir,
      },
    } as unknown as ToolCallContext
  }

  const nested = `/lead-1/teammates/${TEAMMATE}/`
  const flat = `/projects/D--proj/${TEAMMATE}/`

  it('background shell output lands in the nested session dir', () => {
    const path = getBackgroundShellOutputPath(teammateContext(), 'b1')
    expect(path).toContain(`${nested}tasks/`)
    expect(path).not.toContain(flat)
  })

  it('the scratchpad (permission carve-out) is the nested one', () => {
    const dir = getScratchpadDirForContext(teammateContext())
    expect(dir).toContain(`${nested}scratch`)
    expect(dir).not.toContain(flat)
  })

  it('SuperShell step logs land in the nested session dir', () => {
    const dir = superShellRunDir(teammateContext(), 'r1')
    expect(dir).toContain(`${nested}supershell/r1`)
    expect(dir).not.toContain(flat)
  })

  it('an unrouted runtime (no base) keeps the projectRoot-derived dir', () => {
    const context = {
      options: { sessionId: 's1', homeDir: '/home/u', projectRoot: 'D:/proj' },
    } as unknown as ToolCallContext
    expect(getBackgroundShellOutputPath(context, 'b1')).toContain(
      '/projects/D--proj/s1/tasks/',
    )
  })
})

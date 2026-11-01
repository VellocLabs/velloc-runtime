import { describe, expect, it, vi } from 'vitest'
import {
  ChildSessionCoordinator,
  type ChildSessionHost,
} from '../browser/worker/ChildSessionCoordinator'
import type { AgentRuntimeWorkerInitPayload } from '../browser/worker/workerProtocol'
import type { BrowserSessionMetadata, SessionMetaFile } from '../sessions/sessionStore'
import type { ChildReport, ChildStartState } from '../sessions/sessionLineage'
import type { ChildSessionRequest } from '../sessions/childSessionSpec'

// The runtime's half of starting a child session (F-36): the record exists
// before the worker, a failed start stays on record with its reason, a
// worktree failure never shares the tree, a refused fork creates nothing.

const TEMPLATE = {
  sessionId: 'ui-boot',
  projectRoot: '/foreign',
  templateType: 'chat',
  cwd: '/foreign',
  traceId: 'trace-1',
  isHeadless: true,
  isTeammate: true,
  teamName: 'old-team',
  teammateName: 'old-mate',
  spawnerSessionId: 'old-lead',
  routineId: 'routine-1',
  userSpecifiedModel: 'template-model',
} as unknown as AgentRuntimeWorkerInitPayload

function request(overrides: Partial<ChildSessionRequest> = {}): ChildSessionRequest {
  return {
    initiation: 'asked',
    title: 'Fix the login redirect',
    task: 'Land the redirect fix.',
    briefing: 'B'.repeat(80),
    from: 'fresh',
    isolation: 'shared',
    isolationRequested: false,
    permissionMode: 'acceptEdits',
    ...overrides,
  }
}

type Fake = {
  host: ChildSessionHost
  written: Map<string, SessionMetaFile>
  patches: Array<{ sessionId: string; patch: Partial<BrowserSessionMetadata> }>
  startStates: Array<{ sessionId: string; state: ChildStartState | null }>
  reports: Array<{ parentId: string; report: ChildReport }>
  inits: AgentRuntimeWorkerInitPayload[]
  firstTurns: Array<{ sessionId: string; prompt: string }>
  registered: string[]
  disposed: string[]
  upserts: string[]
}

function fakeHost(opts: {
  template?: AgentRuntimeWorkerInitPayload | null
  parent?: { projectRoot?: string; templateType?: string; cwd?: string } | null
  taken?: string[]
  trusted?: string[]
  initThrows?: Error
  submitOk?: boolean
  fork?: { ok: true; cutUuid: string } | { ok: false; reason: string }
  forkResult?: { ok: true; sessionId: string } | { ok: false; reason: string }
  writeThrows?: Error
} = {}): Fake {
  const fake: Fake = {
    written: new Map(),
    patches: [],
    startStates: [],
    reports: [],
    inits: [],
    firstTurns: [],
    registered: [],
    disposed: [],
    upserts: [],
    host: null as unknown as ChildSessionHost,
  }
  const parent = opts.parent === undefined
    ? { projectRoot: '/repo', templateType: 'code', cwd: '/repo' }
    : opts.parent
  fake.host = {
    getInitTemplate: () => (opts.template === undefined ? TEMPLATE : opts.template),
    prepareWorkerStorage: () => null,
    createWorker: sessionId => ({
      instanceId: `inst-${sessionId}`,
      worker: {
        receiveFrame: async (frame: { type: string; payload: AgentRuntimeWorkerInitPayload }) => {
          if (frame.type === 'worker.init') {
            if (opts.initThrows) throw opts.initThrows
            fake.inits.push(frame.payload)
          }
        },
      } as never,
    }),
    registerSessionEntry: sessionId => {
      fake.registered.push(sessionId)
    },
    getSessionWorker: () => undefined,
    disposeManagedSession: async sessionId => {
      fake.disposed.push(sessionId)
    },
    notifySessionUpserted: sessionId => {
      fake.upserts.push(sessionId)
    },
    getParentSessionBinding: () => parent,
    familyNamesOf: () => new Set(opts.taken ?? []),
    isTrustedProjectFolder: async path => (opts.trusted ?? []).includes(path),
    writeChildMeta: async (sessionId, meta) => {
      if (opts.writeThrows) throw opts.writeThrows
      fake.written.set(sessionId, meta)
    },
    patchSessionMeta: async (sessionId, patch) => {
      fake.patches.push({ sessionId, patch })
    },
    setStartState: (sessionId, state) => {
      fake.startStates.push({ sessionId, state })
    },
    submitFirstTurn: (sessionId, prompt) => {
      fake.firstTurns.push({ sessionId, prompt })
      return opts.submitOk ?? true
    },
    recordChildReport: async (parentId, report) => {
      fake.reports.push({ parentId, report })
    },
    planModelFork: async () => opts.fork ?? { ok: true, cutUuid: 'u-9' },
    forkForChild: async () => opts.forkResult ?? { ok: true, sessionId: 'forked-1' },
    tracer: { event: vi.fn() } as never,
  }
  return fake
}

async function settled(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0))
}

describe('ChildSessionCoordinator — a fresh child', () => {
  it('writes the record with its origin before the worker, shows it starting, then clears the state', async () => {
    const fake = fakeHost()
    const outcome = await new ChildSessionCoordinator(fake.host).spawn({
      parentSessionId: 'parent-1',
      request: request({ name: 'login-fix' }),
    })
    expect(outcome).toMatchObject({ ok: true, name: 'login-fix', sharedCheckout: true, cwd: '/repo' })
    if (!outcome?.ok) return
    const meta = fake.written.get(outcome.sessionId)!
    expect(meta.customTitle).toBe('Fix the login redirect')
    expect(meta.metadata).toMatchObject({
      customTitle: 'Fix the login redirect',
      permissionMode: 'acceptEdits',
      templateType: 'code',
      projectRoot: '/repo',
      spawnedFrom: {
        sessionId: 'parent-1',
        kind: 'side_session',
        initiator: 'model',
        sharedCheckout: true,
        name: 'login-fix',
      },
    })
    expect(meta.metadata.spawnedFrom?.taskId).toMatch(/^task_/)
    expect(fake.startStates[0]).toEqual({ sessionId: outcome.sessionId, state: { state: 'starting', since: expect.any(Number) } })
    await settled()
    expect(fake.registered).toEqual([outcome.sessionId])
    expect(fake.startStates.at(-1)).toEqual({ sessionId: outcome.sessionId, state: null })
    expect(fake.upserts.filter(id => id === outcome.sessionId).length).toBeGreaterThanOrEqual(2)
    expect(fake.reports).toEqual([])
    expect(outcome.startFailed).toBeUndefined()
  })

  it('binds the worker to the parent, not the template, and strips every team / trace field', async () => {
    const fake = fakeHost()
    const outcome = await new ChildSessionCoordinator(fake.host).spawn({
      parentSessionId: 'parent-1',
      request: request(),
      providerId: 'minimax',
      routineOriginId: 'origin-7',
    })
    await settled()
    expect(fake.inits).toHaveLength(1)
    const init = fake.inits[0]!
    expect(init).toMatchObject({
      sessionId: outcome?.ok ? outcome.sessionId : 'x',
      projectRoot: '/repo',
      templateType: 'code',
      cwdOverride: '/repo',
      userSpecifiedProviderId: 'minimax',
      routineOriginId: 'origin-7',
    })
    for (const field of ['isTeammate', 'teamName', 'teammateName', 'spawnerSessionId', 'traceId', 'isHeadless', 'routineId', 'userSpecifiedModel']) {
      expect((init as Record<string, unknown>)[field], field).toBeUndefined()
    }
  })

  it('gives the child a two-part first message and nothing of the parent conversation', async () => {
    const fake = fakeHost()
    const outcome = await new ChildSessionCoordinator(fake.host).spawn({
      parentSessionId: 'parent-1',
      request: request({ briefing: 'Everything the child needs to know, written out in full for a reader who was not here.', task: 'Do the thing.' }),
    })
    await settled()
    expect(fake.firstTurns).toEqual([
      {
        sessionId: outcome?.ok ? outcome.sessionId : 'x',
        prompt: '## Background\n\nEverything the child needs to know, written out in full for a reader who was not here.\n\n## Task\n\nDo the thing.',
      },
    ])
  })

  it('allocates the family name against the names already taken', async () => {
    const fake = fakeHost({ taken: ['login-fix', 'login-fix-2'] })
    const outcome = await new ChildSessionCoordinator(fake.host).spawn({
      parentSessionId: 'parent-1',
      request: request({ name: 'login-fix' }),
    })
    expect(outcome?.ok && outcome.name).toBe('login-fix-3')
  })

  it('derives the name from the title when none was given', async () => {
    const fake = fakeHost()
    const outcome = await new ChildSessionCoordinator(fake.host).spawn({
      parentSessionId: 'parent-1',
      request: request({ title: 'Fix the Login Redirect!' }),
    })
    expect(outcome?.ok && outcome.name).toMatch(/^fix-the-login/)
  })

  it('returns null before any UI session booted, and refuses without a live parent', async () => {
    expect(
      await new ChildSessionCoordinator(fakeHost({ template: null }).host).spawn({ parentSessionId: 'p', request: request() }),
    ).toBeNull()
    const fake = fakeHost({ parent: null })
    const outcome = await new ChildSessionCoordinator(fake.host).spawn({ parentSessionId: 'p', request: request() })
    expect(outcome).toEqual({ ok: false, reason: expect.stringMatching(/not a live session/) })
    expect(fake.written.size).toBe(0)
  })

  it('refuses a cwd the runtime does not trust and binds to a trusted one', async () => {
    const refused = fakeHost({ trusted: ['/other'] })
    expect(
      await new ChildSessionCoordinator(refused.host).spawn({ parentSessionId: 'p', request: request({ cwd: '/evil' }) }),
    ).toEqual({ ok: false, reason: expect.stringMatching(/not a project folder this runtime trusts/) })
    expect(refused.written.size).toBe(0)

    const ok = fakeHost({ trusted: ['/other'] })
    const outcome = await new ChildSessionCoordinator(ok.host).spawn({ parentSessionId: 'p', request: request({ cwd: '/other' }) })
    expect(outcome).toMatchObject({ ok: true, cwd: '/other' })
    if (!outcome?.ok) return
    expect(ok.written.get(outcome.sessionId)!.metadata.projectRoot).toBe('/other')
    await settled()
    expect(ok.inits[0]).toMatchObject({ projectRoot: '/other', cwdOverride: '/other' })
  })

  it('refuses a fresh child when neither parent nor request has a project folder', async () => {
    const fake = fakeHost({ parent: { templateType: 'code' } })
    expect(
      await new ChildSessionCoordinator(fake.host).spawn({ parentSessionId: 'p', request: request() }),
    ).toEqual({ ok: false, reason: expect.stringMatching(/no project folder/) })
  })

  it('reports a record that could not be written as a refusal', async () => {
    const fake = fakeHost({ writeThrows: new Error('disk full') })
    const outcome = await new ChildSessionCoordinator(fake.host).spawn({ parentSessionId: 'p', request: request() })
    expect(outcome).toEqual({ ok: false, reason: expect.stringMatching(/could not be written: disk full/) })
    expect(fake.startStates).toEqual([])
  })
})

describe('ChildSessionCoordinator — a start that fails', () => {
  it('a worktree failure leaves the session on record as not started, tells the parent once, and starts no worker', async () => {
    const fake = fakeHost()
    const outcome = await new ChildSessionCoordinator(fake.host).spawn({
      parentSessionId: 'parent-1',
      request: request({ isolation: 'worktree', isolationRequested: true, name: 'wt' }),
      prepareWorktree: async () => ({ ok: false, reason: 'git worktree add: branch exists' }),
    })
    expect(outcome).toMatchObject({ ok: true, name: 'wt', sharedCheckout: false, startFailed: 'git worktree add: branch exists' })
    if (!outcome?.ok) return
    expect(outcome.cwd).toBeUndefined()
    await settled()
    expect(fake.registered).toEqual([])
    expect(fake.inits).toEqual([])
    expect(fake.firstTurns).toEqual([])
    expect(fake.startStates.at(-1)).toEqual({
      sessionId: outcome.sessionId,
      state: { state: 'failed', reason: expect.stringMatching(/worktree could not be created: git worktree add/), at: expect.any(Number) },
    })
    expect(fake.patches).toEqual([
      { sessionId: outcome.sessionId, patch: { startFailed: { reason: expect.stringMatching(/branch exists/), at: expect.any(Number) } } },
    ])
    expect(fake.reports).toEqual([
      {
        parentId: 'parent-1',
        report: {
          sessionId: outcome.sessionId,
          ending: 'failed',
          text: expect.stringMatching(/^Child session "wt" \(.*\) did not start: the worktree could not be created/),
          at: expect.any(Number),
        },
      },
    ])
    // The record still says which checkout was asked for: a worktree, never shared.
    expect(fake.written.get(outcome.sessionId)!.metadata.spawnedFrom?.sharedCheckout).toBe(false)
  })

  it('hands the worktree maker the allocated family name, not the request name', async () => {
    const fake = fakeHost({ taken: ['api-docs'] })
    const seen: string[] = []
    const outcome = await new ChildSessionCoordinator(fake.host).spawn({
      parentSessionId: 'parent-1',
      request: request({ name: 'API docs', isolation: 'worktree', isolationRequested: true }),
      prepareWorktree: async name => {
        seen.push(name)
        return { ok: true, cwd: `/repo/.velloc/worktrees/${name}`, repoRoot: '/repo' }
      },
    })
    expect(outcome).toMatchObject({ ok: true, name: 'api-docs-2', cwd: '/repo/.velloc/worktrees/api-docs-2' })
    expect(seen).toEqual(['api-docs-2'])
  })

  it('a worktree that was made moves the working directory and keeps storage on the repository root', async () => {
    const fake = fakeHost()
    const outcome = await new ChildSessionCoordinator(fake.host).spawn({
      parentSessionId: 'parent-1',
      request: request({ isolation: 'worktree', isolationRequested: true }),
      prepareWorktree: async () => ({ ok: true, cwd: '/repo/.velloc/worktrees/wt', repoRoot: '/repo' }),
    })
    expect(outcome).toMatchObject({ ok: true, sharedCheckout: false, cwd: '/repo/.velloc/worktrees/wt' })
    await settled()
    expect(fake.inits[0]).toMatchObject({ projectRoot: '/repo', cwdOverride: '/repo/.velloc/worktrees/wt' })
  })

  it('an init that throws releases the registered entry and marks the start failed', async () => {
    const fake = fakeHost({ initThrows: new Error('no provider') })
    const outcome = await new ChildSessionCoordinator(fake.host).spawn({ parentSessionId: 'parent-1', request: request() })
    expect(outcome?.ok).toBe(true)
    if (!outcome?.ok) return
    await settled()
    expect(fake.registered).toEqual([outcome.sessionId])
    expect(fake.disposed).toEqual([outcome.sessionId])
    expect(fake.firstTurns).toEqual([])
    expect(fake.startStates.at(-1)).toMatchObject({
      sessionId: outcome.sessionId,
      state: { state: 'failed', reason: expect.stringMatching(/runtime did not start: no provider/) },
    })
    expect(fake.reports).toHaveLength(1)
    expect(fake.reports[0]!.report.ending).toBe('failed')
  })

  it('a first turn the runtime would not take is a failed start', async () => {
    const fake = fakeHost({ submitOk: false })
    const outcome = await new ChildSessionCoordinator(fake.host).spawn({ parentSessionId: 'parent-1', request: request() })
    if (!outcome?.ok) throw new Error('expected ok')
    await settled()
    expect(fake.disposed).toEqual([outcome.sessionId])
    expect(fake.startStates.at(-1)).toMatchObject({
      state: { state: 'failed', reason: expect.stringMatching(/no live runtime to take its first message/) },
    })
  })
})

describe('ChildSessionCoordinator — a fork', () => {
  it('a refused cut creates nothing', async () => {
    const fake = fakeHost({ fork: { ok: false, reason: 'the transcript ends in a tool call with no recorded answer (c1)' } })
    const outcome = await new ChildSessionCoordinator(fake.host).spawn({
      parentSessionId: 'parent-1',
      request: request({ from: 'fork', briefing: undefined }),
    })
    expect(outcome).toEqual({ ok: false, reason: expect.stringMatching(/fork was refused: .*no recorded answer \(c1\)/) })
    expect(fake.written.size).toBe(0)
    expect(fake.startStates).toEqual([])
    expect(fake.upserts).toEqual([])
    await settled()
    expect(fake.inits).toEqual([])
  })

  it('copies the transcript at the planned cut with the origin, and gives the child the task alone', async () => {
    const fake = fakeHost({ fork: { ok: true, cutUuid: 'u-9' }, forkResult: { ok: true, sessionId: 'forked-1' } })
    const forkForChild = vi.fn(fake.host.forkForChild)
    fake.host.forkForChild = forkForChild
    const outcome = await new ChildSessionCoordinator(fake.host).spawn({
      parentSessionId: 'parent-1',
      request: request({ from: 'fork', briefing: undefined, task: 'Carry on with the parser.', name: 'parser' }),
    })
    expect(outcome).toMatchObject({ ok: true, sessionId: 'forked-1', name: 'parser', sharedCheckout: true })
    expect(forkForChild).toHaveBeenCalledWith(
      'parent-1',
      'u-9',
      {
        spawnedFrom: expect.objectContaining({ sessionId: 'parent-1', kind: 'side_session', initiator: 'model', name: 'parser', sharedCheckout: true }),
        permissionMode: 'acceptEdits',
      },
      'Fix the login redirect',
    )
    // No fresh record: the fork wrote its own.
    expect(fake.written.size).toBe(0)
    await settled()
    expect(fake.firstTurns).toEqual([{ sessionId: 'forked-1', prompt: '## Task\n\nCarry on with the parser.' }])
    expect(fake.startStates.at(-1)).toEqual({ sessionId: 'forked-1', state: null })
  })

  it('a fork that failed to copy is a refusal, not a session', async () => {
    const fake = fakeHost({ forkResult: { ok: false, reason: 'source has no transcript' } })
    const outcome = await new ChildSessionCoordinator(fake.host).spawn({
      parentSessionId: 'parent-1',
      request: request({ from: 'fork', briefing: undefined }),
    })
    expect(outcome).toEqual({ ok: false, reason: expect.stringMatching(/fork failed: source has no transcript/) })
    expect(fake.startStates).toEqual([])
  })
})

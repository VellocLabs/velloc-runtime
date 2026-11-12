import { describe, expect, it, vi } from 'vitest'
import {
  ChildSessionCoordinator,
  type ChildSessionHost,
} from '../browser/worker/ChildSessionCoordinator'
import type { AgentRuntimeWorkerInitPayload } from '../browser/worker/workerProtocol'
import type { BrowserSessionMetadata, SessionMetaFile } from '../sessions/sessionStore'
import type { ChildReport, ChildStartState } from '../sessions/sessionLineage'
import type { ChildSessionRequest } from '../sessions/childSessionSpec'
import type { BrowserLlmSelection } from '../browser/bridge/protocol/nexus_llm'
import type { SessionMode } from '../permissions/sessionModes'

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
  userSpecifiedProviderId: 'foreign-provider',
  userSpecifiedModel: 'template-model',
  userSpecifiedThinkingTier: 'foreign-tier',
  modelFallbackSelection: { providerId: 'foreign-provider', modelId: 'foreign-fallback', thinkingTier: 'foreign-tier' },
} as unknown as AgentRuntimeWorkerInitPayload

const PARENT_SELECTION: BrowserLlmSelection = {
  providerId: 'minimax',
  modelId: 'parent-model',
  thinkingTier: 'high',
}

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
  selection?: BrowserLlmSelection | null
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
    getParentPermissionMode: () => 'acceptEdits',
    getParentModelSelection: () => opts.selection === undefined ? PARENT_SELECTION : opts.selection,
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
      userSpecifiedModel: 'parent-model',
      userSpecifiedThinkingTier: 'high',
      modelFallbackSelection: PARENT_SELECTION,
      routineOriginId: 'origin-7',
    })
    for (const field of ['isTeammate', 'teamName', 'teammateName', 'spawnerSessionId', 'traceId', 'isHeadless', 'routineId']) {
      expect((init as Record<string, unknown>)[field], field).toBeUndefined()
    }
  })

  it('gives the child the briefing then the task and nothing of the parent conversation', async () => {
    const fake = fakeHost()
    const outcome = await new ChildSessionCoordinator(fake.host).spawn({
      parentSessionId: 'parent-1',
      request: request({ briefing: 'Everything the child needs to know, written out in full for a reader who was not here.', task: 'Do the thing.' }),
    })
    await settled()
    expect(fake.firstTurns).toEqual([
      {
        sessionId: outcome?.ok ? outcome.sessionId : 'x',
        prompt: 'Everything the child needs to know, written out in full for a reader who was not here.\n\nDo the thing.',
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

describe('ChildSessionCoordinator — launch permission ceiling', () => {
  it.each(['fresh', 'fork'] as const)('inherits the latest downgraded parent mode for a %s child', async from => {
    const fake = fakeHost()
    let mode: SessionMode = 'bypassPermissions'
    fake.host.getParentPermissionMode = () => mode
    const requested = request({ from, permissionMode: mode, permissionModeRequested: false })
    mode = 'plan'
    const fork = vi.spyOn(fake.host, 'forkForChild')
    const result = await new ChildSessionCoordinator(fake.host).spawn({ parentSessionId: 'p', request: requested })
    expect(result?.ok).toBe(true)
    if (!result?.ok) throw new Error('expected a child')
    if (from === 'fresh') expect(fake.written.get(result.sessionId)?.metadata.permissionMode).toBe('plan')
    else expect(fork.mock.calls[0]?.[2].permissionMode).toBe('plan')
  })

  it.each([true, undefined])('refuses a raised explicit mode after downgrade, flag %s', async permissionModeRequested => {
    const fake = fakeHost()
    fake.host.getParentPermissionMode = () => 'plan'
    const fork = vi.spyOn(fake.host, 'planModelFork')
    const worktree = vi.fn()
    const result = await new ChildSessionCoordinator(fake.host).spawn({
      parentSessionId: 'p', request: request({ from: 'fork', permissionMode: 'bypassPermissions', permissionModeRequested }),
      prepareWorktree: worktree,
    })
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/more permissive/) })
    expect(fake.written.size).toBe(0)
    expect(fake.registered).toEqual([])
    expect(fake.startStates).toEqual([])
    expect(fork).not.toHaveBeenCalled()
    expect(worktree).not.toHaveBeenCalled()
  })

  it.each((['trust', 'fork-plan', 'fork-copy'] as const).flatMap(boundary =>
    [false, true].map(permissionModeRequested => ({ boundary, permissionModeRequested })),
  ))(
    'rechecks permissions after awaited $boundary validation, explicit $permissionModeRequested', async ({ boundary, permissionModeRequested }) => {
      const fake = fakeHost()
      let mode: SessionMode = 'bypassPermissions'
      fake.host.getParentPermissionMode = () => mode
      let release!: () => void
      const paused = new Promise<void>(resolve => { release = resolve })
      let entered!: () => void
      const waiting = new Promise<void>(resolve => { entered = resolve })
      const pause = async () => { entered(); await paused }
      if (boundary === 'trust') {
        fake.host.isTrustedProjectFolder = async () => { await pause(); return true }
      } else if (boundary === 'fork-plan') {
        fake.host.planModelFork = async () => { await pause(); return { ok: true, cutUuid: 'u-9' } }
      }
      let copiedMode: SessionMode | undefined
      fake.host.forkForChild = async (...args) => {
        if (boundary === 'fork-copy') await pause()
        try {
          copiedMode = args[4]?.() ?? args[2].permissionMode as SessionMode
          return { ok: true, sessionId: 'forked-1' }
        } catch (error) {
          return { ok: false, reason: (error as Error).message }
        }
      }
      const pending = new ChildSessionCoordinator(fake.host).spawn({
        parentSessionId: 'p',
        request: request({
          from: boundary === 'trust' ? 'fresh' : 'fork',
          ...(boundary === 'trust' ? { cwd: '/other' } : {}),
          permissionMode: mode,
          permissionModeRequested,
        }),
      })
      await waiting
      mode = 'plan'
      release()
      const result = await pending
      await settled()
      if (permissionModeRequested) {
        expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/more permissive/) })
        expect(fake.written.size).toBe(0)
        expect(fake.registered).toEqual([])
        expect(fake.firstTurns).toEqual([])
      } else {
        expect(result?.ok).toBe(true)
        if (!result?.ok) throw new Error('expected a child')
        expect(boundary === 'trust' ? fake.written.get(result.sessionId)?.metadata.permissionMode : copiedMode).toBe('plan')
        expect(fake.firstTurns).toHaveLength(1)
      }
    },
  )

  it('accepts an explicitly lowered mode within the current ceiling', async () => {
    const fake = fakeHost()
    const result = await new ChildSessionCoordinator(fake.host).spawn({
      parentSessionId: 'p', request: request({ permissionMode: 'plan', permissionModeRequested: true }),
    })
    if (!result?.ok) throw new Error('expected a child')
    expect(fake.written.get(result.sessionId)?.metadata.permissionMode).toBe('plan')
  })

  it('refuses a parent with no live permission mode', async () => {
    const fake = fakeHost()
    fake.host.getParentPermissionMode = () => null
    const result = await new ChildSessionCoordinator(fake.host).spawn({ parentSessionId: 'p', request: request() })
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/no resolved permission mode/) })
    expect(fake.written.size).toBe(0)
    expect(fake.registered).toEqual([])
  })
})

describe('ChildSessionCoordinator — model selection', () => {
  it('persists the live parent selection rather than any foreign template defaults', async () => {
    const fake = fakeHost()
    const result = await new ChildSessionCoordinator(fake.host).spawn({ parentSessionId: 'p', request: request() })
    if (!result?.ok) throw new Error('expected a child')
    expect(fake.written.get(result.sessionId)?.metadata.llmSelection).toEqual(PARENT_SELECTION)
    await settled()
    expect(fake.inits[0]).toMatchObject({
      userSpecifiedProviderId: PARENT_SELECTION.providerId,
      userSpecifiedModel: PARENT_SELECTION.modelId,
      userSpecifiedThinkingTier: PARENT_SELECTION.thinkingTier,
      modelFallbackSelection: PARENT_SELECTION,
    })
  })

  it('resolves a delayed start from the current parent, even with a stale defaults-only provider hint', async () => {
    const fake = fakeHost()
    let live = { ...PARENT_SELECTION }
    fake.host.getParentModelSelection = () => live
    const coordinator = new ChildSessionCoordinator(fake.host)
    const proposed = request()
    await coordinator.spawn({ parentSessionId: 'p', request: proposed })
    live = { providerId: 'changed-provider', modelId: 'changed-model', thinkingTier: 'low' }
    await coordinator.spawn({ parentSessionId: 'p', request: proposed, taskId: 'proposal-1', providerId: PARENT_SELECTION.providerId })
    await settled()
    expect(fake.inits.map(init => init.modelFallbackSelection)).toEqual([PARENT_SELECTION, live])
    expect(fake.inits[1]).toMatchObject({
      userSpecifiedProviderId: 'changed-provider', userSpecifiedModel: 'changed-model', userSpecifiedThinkingTier: 'low',
    })
  })

  it('keeps the captured selection consistent if the parent changes during worktree preparation', async () => {
    const fake = fakeHost()
    const live = { ...PARENT_SELECTION }
    fake.host.getParentModelSelection = () => live
    const result = await new ChildSessionCoordinator(fake.host).spawn({
      parentSessionId: 'p',
      request: request({ isolation: 'worktree' }),
      prepareWorktree: async () => {
        Object.assign(live, { providerId: 'later-provider', modelId: 'later-model', thinkingTier: 'low' })
        return { ok: true, cwd: '/repo/worktree', repoRoot: '/repo', branch: 'session/wt' }
      },
    })
    if (!result?.ok) throw new Error('expected a child')
    await settled()
    expect(fake.written.get(result.sessionId)?.metadata.llmSelection).toEqual(PARENT_SELECTION)
    expect(fake.inits[0]?.modelFallbackSelection).toEqual(PARENT_SELECTION)
    expect(fake.inits[0]?.userSpecifiedModel).toBe(PARENT_SELECTION.modelId)
  })

  it('uses an explicit model and effort on the parent provider, keeping the parent as fallback', async () => {
    const fake = fakeHost()
    const result = await new ChildSessionCoordinator(fake.host).spawn({
      parentSessionId: 'p', request: request({ model: 'child-model', effort: 'low' }),
      providerId: PARENT_SELECTION.providerId, thinkingTier: 'low',
    })
    if (!result?.ok) throw new Error('expected a child')
    await settled()
    expect(fake.inits[0]).toMatchObject({
      userSpecifiedProviderId: PARENT_SELECTION.providerId, userSpecifiedModel: 'child-model',
      userSpecifiedThinkingTier: 'low', modelFallbackSelection: PARENT_SELECTION,
    })
    expect(fake.written.get(result.sessionId)?.metadata.llmSelection).toEqual({
      providerId: PARENT_SELECTION.providerId, modelId: 'child-model', thinkingTier: 'low',
    })
  })

  it.each([undefined, PARENT_SELECTION.modelId])('preserves parent effort when the requested model is %s', async model => {
    const fake = fakeHost()
    await new ChildSessionCoordinator(fake.host).spawn({ parentSessionId: 'p', request: request({ model }) })
    await settled()
    expect(fake.inits[0]?.userSpecifiedThinkingTier).toBe('high')
  })

  it('clears parent and template effort when the explicit model changes', async () => {
    const fake = fakeHost()
    const result = await new ChildSessionCoordinator(fake.host).spawn({
      parentSessionId: 'p', request: request({ model: 'child-model' }), providerId: PARENT_SELECTION.providerId,
    })
    if (!result?.ok) throw new Error('expected a child')
    await settled()
    expect(fake.inits[0]?.userSpecifiedThinkingTier).toBeUndefined()
    expect(fake.inits[0]).toHaveProperty('userSpecifiedThinkingTier')
    expect(fake.written.get(result.sessionId)?.metadata.llmSelection).toEqual({
      providerId: PARENT_SELECTION.providerId, modelId: 'child-model', thinkingTier: undefined,
    })
  })

  it('clears foreign template effort when the parent has no tier', async () => {
    const fake = fakeHost({ selection: { providerId: 'parent-provider', modelId: 'plain-model' } })
    await new ChildSessionCoordinator(fake.host).spawn({ parentSessionId: 'p', request: request() })
    await settled()
    expect(fake.inits[0]?.userSpecifiedThinkingTier).toBeUndefined()
    expect(fake.inits[0]?.modelFallbackSelection).toEqual({ providerId: 'parent-provider', modelId: 'plain-model' })
  })

  it('replaces copied fork metadata with the resolved child selection, including cleared effort', async () => {
    const fake = fakeHost()
    let copied: Partial<BrowserSessionMetadata> = { llmSelection: PARENT_SELECTION }
    fake.host.forkForChild = async (_parent, _cut, patch) => {
      copied = { ...copied, ...patch }
      return { ok: true, sessionId: 'forked' }
    }
    await new ChildSessionCoordinator(fake.host).spawn({
      parentSessionId: 'p', request: request({ from: 'fork', model: 'child-model' }),
    })
    await settled()
    expect(copied.llmSelection).toEqual({ providerId: PARENT_SELECTION.providerId, modelId: 'child-model', thinkingTier: undefined })
    expect(fake.inits[0]?.userSpecifiedThinkingTier).toBeUndefined()
  })

  it.each([null, { providerId: '', modelId: 'm' }, { providerId: 'p', modelId: ' ' }])('refuses unresolved parent %j without side effects', async selection => {
    const fake = fakeHost({ selection })
    const worktree = vi.fn()
    const fork = vi.spyOn(fake.host, 'planModelFork')
    const result = await new ChildSessionCoordinator(fake.host).spawn({
      parentSessionId: 'p', request: request({ from: 'fork' }), prepareWorktree: worktree,
    })
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/no resolved model selection/) })
    expect(fake.written.size).toBe(0)
    expect(fake.startStates).toEqual([])
    expect(fake.registered).toEqual([])
    expect(fork).not.toHaveBeenCalled()
    expect(worktree).not.toHaveBeenCalled()
  })

  it('refuses an explicit model checked against a provider that is no longer selected', async () => {
    const fake = fakeHost()
    const result = await new ChildSessionCoordinator(fake.host).spawn({
      parentSessionId: 'p', request: request({ model: 'child-model' }), providerId: 'previous-provider',
    })
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/parent provider changed/) })
    expect(fake.written.size).toBe(0)
    expect(fake.startStates).toEqual([])
    expect(fake.inits).toEqual([])
  })

  it('resolves two parents independently through the same coordinator', async () => {
    const fake = fakeHost()
    const other = { providerId: 'other-provider', modelId: 'other-model', thinkingTier: 'low' }
    fake.host.getParentModelSelection = id => id === 'p1' ? PARENT_SELECTION : other
    const coordinator = new ChildSessionCoordinator(fake.host)
    await coordinator.spawn({ parentSessionId: 'p1', request: request() })
    await coordinator.spawn({ parentSessionId: 'p2', request: request() })
    await settled()
    expect(fake.inits.map(init => [init.userSpecifiedProviderId, init.userSpecifiedModel, init.userSpecifiedThinkingTier])).toEqual([
      [PARENT_SELECTION.providerId, PARENT_SELECTION.modelId, PARENT_SELECTION.thinkingTier],
      [other.providerId, other.modelId, other.thinkingTier],
    ])
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
          notStarted: true,
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
        return { ok: true, cwd: `/repo/.velloc/worktrees/${name}`, repoRoot: '/repo', branch: `session/${name}` }
      },
    })
    expect(outcome).toMatchObject({ ok: true, name: 'api-docs-2', cwd: '/repo/.velloc/worktrees/api-docs-2' })
    expect(seen).toEqual(['api-docs-2'])
  })

  it('a worktree that was made moves the working directory, keeps storage on the repository root and is on record', async () => {
    const fake = fakeHost()
    const outcome = await new ChildSessionCoordinator(fake.host).spawn({
      parentSessionId: 'parent-1',
      request: request({ isolation: 'worktree', isolationRequested: true }),
      prepareWorktree: async () => ({ ok: true, cwd: '/repo/.velloc/worktrees/wt', repoRoot: '/repo', branch: 'session/wt' }),
    })
    expect(outcome).toMatchObject({ ok: true, sharedCheckout: false, cwd: '/repo/.velloc/worktrees/wt' })
    await settled()
    expect(fake.inits[0]).toMatchObject({ projectRoot: '/repo', cwdOverride: '/repo/.velloc/worktrees/wt' })
    if (!outcome?.ok) return
    expect(fake.patches).toContainEqual({
      sessionId: outcome.sessionId,
      patch: { worktree: { dir: '/repo/.velloc/worktrees/wt', branch: 'session/wt', repoRoot: '/repo' } },
    })
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
  it.each(['/other', '/repo'])('refuses cwd %s outside the parent current worktree before any fork writes', async cwd => {
    const fake = fakeHost({ parent: { projectRoot: '/repo', cwd: '/repo/worktree', templateType: 'code' }, trusted: ['/other', '/repo'] })
    const plan = vi.spyOn(fake.host, 'planModelFork')
    const fork = vi.spyOn(fake.host, 'forkForChild')
    const result = await new ChildSessionCoordinator(fake.host).spawn({
      parentSessionId: 'p', request: request({ from: 'fork', cwd }),
    })
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/parent current checkout/) })
    expect(plan).not.toHaveBeenCalled()
    expect(fork).not.toHaveBeenCalled()
    expect(fake.written.size).toBe(0)
    expect(fake.registered).toEqual([])
  })

  it.each([
    ['/repo/worktree', '/repo/./worktree/'],
    ['D:/repo/worktree', 'd:\\repo\\worktree\\'],
  ])('accepts equivalent cwd spelling %s -> %s without changing the storage root', async (cwd, spelling) => {
    const fake = fakeHost({ parent: { projectRoot: '/storage-root', cwd, templateType: 'code' } })
    const result = await new ChildSessionCoordinator(fake.host).spawn({
      parentSessionId: 'p', request: request({ from: 'fork', cwd: spelling }),
    })
    expect(result).toMatchObject({ ok: true, cwd })
    await settled()
    expect(fake.inits[0]).toMatchObject({ projectRoot: '/storage-root', cwdOverride: cwd })
  })

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
        llmSelection: PARENT_SELECTION,
      },
      'Fix the login redirect',
      expect.any(Function),
    )
    // No fresh record: the fork wrote its own.
    expect(fake.written.size).toBe(0)
    await settled()
    expect(fake.firstTurns).toEqual([{ sessionId: 'forked-1', prompt: 'Carry on with the parser.' }])
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

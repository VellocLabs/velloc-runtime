import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ProposeSessionTool,
  WithdrawProposalTool,
  proposalToolCallIdOf,
  proposeChildSession,
  withdrawProposal,
  type ProposeSessionInput,
} from '../toolkit/builtin/proposeSession'
import { HandOffSessionTool, handOffChildSession } from '../toolkit/builtin/handOffSession'
import { SpawnSessionTool, spawnChildSession } from '../toolkit/builtin/spawnSession'
import type { SpawnSessionInput } from '../sessions/childSessionSpec'
import {
  setChildSessionSpawner,
  setParentSelectionGetter,
  type ChildSessionSpawnOutcome,
  type ChildSessionSpawnParams,
} from '../sessions/childSessionSpawner'
import { ProposalBoard, setProposalBoard } from '../sessions/proposalBoard'
import { PROPOSAL_TTL_MS, type ChildProposal } from '../sessions/childProposals'
import { setTemplateChannelForTest } from '../prompting/templateCatalog'
import { installProcessFs, resetProcessFs } from '../utils/fs/runtimeFs'
import { NEXUS_SETTINGS_FILE_NAME, wipeSettingsMemos } from '../settings/settingsStore'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { Message } from '../runtime/RuntimeTypes'

// Proposals and hand-off (F-36): P01–P05 and H01 at the tool layer, over a
// real proposal board and a recording spawner.

const HOME = '/home/test'
const PROVIDER = 'minimax'
const BRIEF = 'Everything the child needs: the goal, the files, what was ruled out, and what done looks like.'

function proposal(overrides: Partial<ProposeSessionInput> = {}): ProposeSessionInput {
  return {
    mode: 'suggest',
    title: 'Tidy the importer',
    task: 'Remove the dead branches in the importer.',
    briefing: BRIEF,
    from: 'fresh',
    name: '',
    isolation: '',
    model: '',
    effort: '',
    permissionMode: '',
    cwd: '',
    baseBranch: '',
    branchName: '',
    ...overrides,
  }
}

function spawnInput(overrides: Partial<SpawnSessionInput> = {}): SpawnSessionInput {
  return {
    initiation: 'asked',
    title: '',
    task: '',
    briefing: '',
    from: '',
    name: '',
    isolation: '',
    model: '',
    effort: '',
    permissionMode: '',
    cwd: '',
    baseBranch: '',
    branchName: '',
    proposalId: '',
    ...overrides,
  }
}

function ctx(sessionId = 'parent-1', abortController?: AbortController): ToolCallContext {
  const base = createNoopToolUseContext({
    tools: [],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
    sessionId,
    cwd: '/repo',
    projectRoot: '/repo',
    ...(abortController ? { abortController } : {}),
  })
  Object.assign(base.options, { homeDir: HOME, templateType: 'code', userSpecifiedProviderId: PROVIDER })
  return base
}

function row(calls: Array<{ id: string; name: string; args: unknown }>): Message {
  return {
    type: 'assistant',
    uuid: 'a-1',
    message: {
      role: 'assistant',
      content: calls.map(c => ({ type: 'tool-call', toolCallId: c.id, toolName: c.name, args: c.args })),
    },
  } as unknown as Message
}

let board: ProposalBoard
let stored: Map<string, unknown>
let now: number

function recordingSpawner(outcome: (params: ChildSessionSpawnParams) => ChildSessionSpawnOutcome = params => ({
  ok: true,
  sessionId: `child-${params.taskId ?? 'direct'}`,
  name: 'tidy',
  sharedCheckout: true,
  cwd: '/repo',
})) {
  const calls: ChildSessionSpawnParams[] = []
  setChildSessionSpawner(async params => {
    calls.push(params)
    return outcome(params)
  })
  return calls
}

beforeEach(() => {
  setTemplateChannelForTest('beta')
  setParentSelectionGetter(() => ({ providerId: PROVIDER, modelId: 'MiniMax-M3' }))
  installProcessFs({
    readFile: async (path: string) => {
      if (path === `${HOME}/.velloc/${NEXUS_SETTINGS_FILE_NAME}`) {
        return JSON.stringify({ version: 1, providers: { activeProviderId: PROVIDER, configs: { [PROVIDER]: { apiKey: 'k' } } } })
      }
      const err = new Error('ENOENT') as Error & { code?: string }
      err.code = 'ENOENT'
      throw err
    },
    writeFile: async () => {},
    mkdir: async () => {},
    stat: async () => {
      const err = new Error('ENOENT') as Error & { code?: string }
      err.code = 'ENOENT'
      throw err
    },
  } as never)
  wipeSettingsMemos()
  now = 1_000_000
  stored = new Map()
  board = new ProposalBoard({
    storage: {
      read: async id => stored.get(id),
      write: async (id, list) => {
        stored.set(id, list)
      },
    },
    now: () => now,
  })
  setProposalBoard(board)
})

afterEach(() => {
  setTemplateChannelForTest(null)
  setChildSessionSpawner(null)
  setParentSelectionGetter(null)
  setProposalBoard(null)
  resetProcessFs()
  wipeSettingsMemos()
})

describe('ProposeSession — schema', () => {
  it('requires mode and title only and keeps all child tools non-strict', async () => {
    const schema = ProposeSessionTool.argsSchema as unknown as { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean }
    expect(schema.required).toEqual(['mode', 'title'])
    for (const tool of [ProposeSessionTool, WithdrawProposalTool, HandOffSessionTool]) {
      expect(tool.strict).not.toBe(true)
      expect(tool.inputJSONSchemaStrict).toBeUndefined()
      expect(tool.argsSchema!.additionalProperties).toBe(false)
    }
    expect(WithdrawProposalTool.argsSchema!.required).toEqual(['taskId'])
    expect(HandOffSessionTool.argsSchema!.required).toEqual(['title', 'remainingPlan'])
    expect(await ProposeSessionTool.checkInput!({ mode: 'offer', title: 'Tidy' }, ctx())).toEqual({ result: true })
    for (const field of Object.keys(schema.properties)) {
      for (const value of [null, 42, undefined]) {
        const bad = { ...proposal(), [field]: value } as unknown as ProposeSessionInput
        expect(await ProposeSessionTool.checkInput!(bad, ctx())).toMatchObject({ result: false, message: `${field} must be a string.` })
        expect((await proposeChildSession(bad, ctx())).data).toBe(`Refused: ${field} must be a string.`)
      }
    }
    for (const field of ['mode', 'title']) {
      const bad = { mode: 'offer', title: 'Tidy' } as Record<string, unknown>
      delete bad[field]
      expect(await ProposeSessionTool.checkInput!(bad as ProposeSessionInput, ctx())).toMatchObject({ result: false })
    }
    expect(await board.list('parent-1')).toEqual([])
  })

  it('finds its own call id on the invoking row: the only call, else the one with its mode and title', () => {
    expect(proposalToolCallIdOf(row([{ id: 'tc-1', name: 'ProposeSession', args: {} }]), 'ProposeSession', {})).toBe('tc-1')
    const two = row([
      { id: 'tc-1', name: 'ProposeSession', args: { mode: 'suggest', title: 'A' } },
      { id: 'tc-2', name: 'ProposeSession', args: { mode: 'suggest', title: 'B' } },
      { id: 'tc-3', name: 'Read', args: {} },
    ])
    expect(proposalToolCallIdOf(two, 'ProposeSession', { mode: 'suggest', title: 'B' })).toBe('tc-2')
    expect(proposalToolCallIdOf(undefined, 'ProposeSession', {})).toBeUndefined()
  })
})

describe('P01 — a suggestion is only a card with a task id', () => {
  it('refuses proposals and handoffs from routine-origin turns', async () => {
    const spawns = recordingSpawner()
    const context = ctx()
    Object.assign(context.options, { isHeadless: true, routineId: 'routine-1' })
    expect((await proposeChildSession(proposal(), context)).data).toContain('routine turn cannot start or propose')
    expect((await handOffChildSession({ title: 'Continue', remainingPlan: 'Finish the checks.' }, context)).data).toContain('routine turn cannot start or propose')
    expect(await board.list('parent-1')).toEqual([])
    expect(spawns).toEqual([])
  })

  it('records a proposal, starts nothing, and answers its task id', async () => {
    const spawns = recordingSpawner()
    const { data } = await proposeChildSession(proposal(), ctx(), row([{ id: 'tc-7', name: 'ProposeSession', args: proposal() }]))
    const [p] = (await board.list('parent-1')) as ChildProposal[]
    expect(p).toMatchObject({ mode: 'suggest', state: 'proposed', toolCallId: 'tc-7', expiresAt: now + PROPOSAL_TTL_MS })
    expect(p!.taskId).toMatch(/^task_[a-z0-9]{8}$/)
    expect(data).toContain(`as task ${p!.taskId}`)
    expect(data).toContain('Nothing has started')
    expect(spawns).toEqual([])
  })

  it('accepts a minimal fork suggestion without a briefing', async () => {
    expect((await proposeChildSession({ mode: 'suggest', title: 'Tidy', task: 'Tidy it.', from: 'fork' }, ctx())).data).toMatch(/^Proposed/)
    expect((await board.list('parent-1'))[0]!.request).toMatchObject({ from: 'fork', briefing: '' })
  })

  it('is checked like a start: a short briefing, a raised mode or a nested caller is refused, recording nothing', async () => {
    expect((await proposeChildSession(proposal({ briefing: 'short' }), ctx())).data).toMatch(/^Refused: briefing must be at least 80/)
    expect((await proposeChildSession(proposal({ permissionMode: 'bypassPermissions' }), ctx())).data).toMatch(/never raise/)
    expect((await proposeChildSession(proposal({ mode: 'later' }), ctx())).data).toMatch(/^Refused: mode must be "suggest" or "offer"/)
    const nested = ctx()
    nested.agentId = 'agent-1'
    expect((await proposeChildSession(proposal(), nested)).data).toMatch(/sub-agent or teammate/)
    expect(await board.list('parent-1')).toEqual([])
  })

  it('the model starts it on the person\'s word exactly as proposed, once, with the proposal as origin', async () => {
    const spawns = recordingSpawner()
    await proposeChildSession({ mode: 'suggest', title: 'Tidy the importer', task: 'Remove the dead branches in the importer.', briefing: BRIEF }, ctx())
    const [p] = await board.list('parent-1')
    expect(p!.request.from).toBe('fresh')
    expect(Object.values(p!.request).every(value => typeof value === 'string')).toBe(true)
    expect(await SpawnSessionTool.checkInput!({ proposalId: p!.taskId }, ctx())).toEqual({ result: true })
    const { data } = await spawnChildSession({ proposalId: p!.taskId }, ctx())
    expect(data).toMatch(new RegExp(`^Started proposal ${p!.taskId}\\. Registered child session "tidy"`))
    expect(spawns).toHaveLength(1)
    expect(spawns[0]).toMatchObject({ taskId: p!.taskId, request: { title: 'Tidy the importer', task: 'Remove the dead branches in the importer.', briefing: BRIEF, from: 'fresh' } })
    expect(spawns[0]!.kind).toBeUndefined()
    expect(await board.get('parent-1', p!.taskId)).toMatchObject({ state: 'started', childSessionId: `child-${p!.taskId}` })
    const again = await spawnChildSession(spawnInput({ proposalId: p!.taskId }), ctx())
    expect(again.data).toMatch(/already started as session child-task_/)
    expect(spawns).toHaveLength(1)
  })

  it('a person\'s Start runs through the proposing turn\'s launcher', async () => {
    const spawns = recordingSpawner()
    await proposeChildSession(proposal(), ctx())
    const [p] = await board.list('parent-1')
    const result = await board.startByPerson('parent-1', p!.taskId)
    expect(result).toMatchObject({ ok: true, proposal: { state: 'started' } })
    expect(spawns).toHaveLength(1)
    expect(spawns[0]!.taskId).toBe(p!.taskId)
  })

  it('a delayed Start checks the live parent provider, not the proposing turn', async () => {
    const spawns = recordingSpawner()
    await proposeChildSession(proposal(), ctx())
    const [p] = await board.list('parent-1')
    setParentSelectionGetter(() => ({ providerId: 'other-provider', modelId: 'other-model', thinkingTier: 'high' }))
    expect(await board.startByPerson('parent-1', p!.taskId)).toMatchObject({ ok: true })
    expect(spawns).toHaveLength(1)
    expect(spawns[0]!.providerId).toBe('other-provider')
    expect(spawns[0]!.request.model).toBeUndefined()
  })

  it('an expired card cannot be started, and a dismissed one is reported as dismissed', async () => {
    const spawns = recordingSpawner()
    await proposeChildSession(proposal(), ctx())
    await proposeChildSession(proposal({ title: 'Second' }), ctx())
    const [a, b] = await board.list('parent-1')
    await board.dismiss('parent-1', b!.taskId)
    now += PROPOSAL_TTL_MS
    expect((await spawnChildSession(spawnInput({ proposalId: a!.taskId }), ctx())).data).toMatch(/is expired; it cannot be started/)
    expect((await spawnChildSession(spawnInput({ proposalId: b!.taskId }), ctx())).data).toMatch(/is dismissed; it cannot be started/)
    expect(spawns).toEqual([])
  })
})

describe('P02 — an offer waits for "New session" or "Do it here"', () => {
  it('"Do it here" creates nothing and tells the model to carry on here', async () => {
    const spawns = recordingSpawner()
    const pending = proposeChildSession({ mode: 'offer', title: 'Tidy the importer' }, ctx())
    await vi.waitFor(async () => expect(await board.list('parent-1')).toHaveLength(1))
    const [p] = await board.list('parent-1')
    expect(p).toMatchObject({ mode: 'offer', state: 'proposed', request: { from: 'fresh' } })
    await board.choose('parent-1', p!.taskId, 'here')
    expect((await pending).data).toMatch(/chose to do "Tidy the importer" here\. No session was created/)
    expect(spawns).toEqual([])
    expect(await board.get('parent-1', p!.taskId)).toMatchObject({ state: 'dismissed', keptHere: true })
  })

  it('"New session" waits for the brief, then the model\'s SpawnSession with the proposal starts it', async () => {
    const spawns = recordingSpawner()
    const pending = proposeChildSession(proposal({ mode: 'offer', task: '', briefing: '' }), ctx())
    await vi.waitFor(async () => expect(await board.list('parent-1')).toHaveLength(1))
    const [p] = await board.list('parent-1')
    // Before the person answers, a start is refused.
    expect((await spawnChildSession(spawnInput({ proposalId: p!.taskId, task: 'T', briefing: BRIEF }), ctx())).data)
      .toMatch(/has not chosen yet/)
    await board.choose('parent-1', p!.taskId, 'new')
    const answer = (await pending).data
    expect(answer).toContain(`proposalId "${p!.taskId}"`)
    // The real intermediate state: accepted, nothing running.
    expect(await board.get('parent-1', p!.taskId)).toMatchObject({ state: 'accepted_awaiting_brief' })
    expect(spawns).toEqual([])
    // A brief that is too short is refused and leaves it waiting for a better one.
    expect((await spawnChildSession(spawnInput({ proposalId: p!.taskId, task: 'Do it.', briefing: 'short' }), ctx())).data)
      .toMatch(/^Refused: briefing must be at least 80/)
    expect(await board.get('parent-1', p!.taskId)).toMatchObject({ state: 'accepted_awaiting_brief' })
    const { data } = await spawnChildSession(spawnInput({ proposalId: p!.taskId, task: 'Do it.', briefing: BRIEF }), ctx())
    expect(data).toMatch(/^Started proposal/)
    expect(spawns).toHaveLength(1)
    expect(spawns[0]).toMatchObject({ taskId: p!.taskId, request: { task: 'Do it.', briefing: BRIEF, title: 'Tidy the importer' } })
  })

  it('a Stop while it waits closes it without a choice', async () => {
    const abort = new AbortController()
    const pending = proposeChildSession(proposal({ mode: 'offer', task: '', briefing: '' }), ctx('parent-1', abort))
    await vi.waitFor(async () => expect(await board.list('parent-1')).toHaveLength(1))
    abort.abort()
    expect((await pending).data).toMatch(/closed without a choice/)
  })
})

describe('P03 — a new message passes an open offer', () => {
  it('closes it as superseded, ends the wait, and refuses the model\'s later brief', async () => {
    const spawns = recordingSpawner()
    const pending = proposeChildSession(proposal({ mode: 'offer', task: '', briefing: '' }), ctx())
    await vi.waitFor(async () => expect(await board.list('parent-1')).toHaveLength(1))
    const [p] = await board.list('parent-1')
    board.supersedeOpenOffers('parent-1')
    expect((await pending).data).toMatch(/sent a new message before choosing/)
    const late = await spawnChildSession(spawnInput({ proposalId: p!.taskId, task: 'T', briefing: BRIEF }), ctx())
    expect(late.data).toMatch(/closed: the user sent a new message before choosing; it cannot be started/)
    expect(spawns).toEqual([])
  })

  it('also closes an accepted offer still waiting for its brief', async () => {
    recordingSpawner()
    const pending = proposeChildSession(proposal({ mode: 'offer', task: '', briefing: '' }), ctx())
    await vi.waitFor(async () => expect(await board.list('parent-1')).toHaveLength(1))
    const [p] = await board.list('parent-1')
    await board.choose('parent-1', p!.taskId, 'new')
    await pending
    board.supersedeOpenOffers('parent-1')
    expect(await board.get('parent-1', p!.taskId)).toMatchObject({ state: 'superseded' })
  })
})

describe('P04 — concurrent starts', () => {
  it('a Start click and the model\'s start of one proposal create one child', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const calls: ChildSessionSpawnParams[] = []
    setChildSessionSpawner(async params => {
      calls.push(params)
      await gate
      return { ok: true, sessionId: 'child-1', name: 'tidy', sharedCheckout: true }
    })
    await proposeChildSession(proposal(), ctx())
    const [p] = await board.list('parent-1')
    const click = board.startByPerson('parent-1', p!.taskId)
    const model = spawnChildSession(spawnInput({ proposalId: p!.taskId }), ctx())
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    release()
    const [clicked, modelled] = await Promise.all([click, model])
    expect(calls).toHaveLength(1)
    expect([clicked.ok, modelled.data.startsWith('Started')].filter(Boolean)).toHaveLength(1)
    expect(await board.get('parent-1', p!.taskId)).toMatchObject({ state: 'started', childSessionId: 'child-1' })
  })
})

describe('P05 — a proposal starts exactly as proposed', () => {
  it('a changed task, briefing, from or target is refused and nothing starts', async () => {
    const spawns = recordingSpawner()
    await proposeChildSession(proposal(), ctx())
    const [p] = await board.list('parent-1')
    for (const changed of [
      { task: 'Something else entirely.' },
      { briefing: `${BRIEF} And one more thing.` },
      { from: 'fork' },
      { cwd: '/other' },
      { isolation: 'worktree' },
    ]) {
      const { data } = await spawnChildSession(spawnInput({ proposalId: p!.taskId, ...changed }), ctx())
      expect(data, JSON.stringify(changed)).toMatch(new RegExp(`^Refused: ${Object.keys(changed)[0]} differs`))
    }
    expect((await spawnChildSession(spawnInput({ proposalId: 'task_notthere' }), ctx())).data).toMatch(/no proposal task_notthere/)
    expect((await spawnChildSession(spawnInput({ proposalId: 'not-an-id' }), ctx())).data).toMatch(/proposalId must be a task id/)
    for (const field of ['task', 'briefing', 'from', 'model', 'permissionMode', 'cwd']) {
      for (const value of [null, 42]) {
        const bad = { proposalId: p!.taskId, [field]: value } as unknown as SpawnSessionInput
        expect((await spawnChildSession(bad, ctx())).data).toBe(`Refused: ${field} must be a string.`)
      }
    }
    expect(spawns).toEqual([])
    expect(await board.get('parent-1', p!.taskId)).toMatchObject({ state: 'proposed' })
  })

  it('an accepted offer\'s brief is the one exception, and its target still cannot change', async () => {
    const spawns = recordingSpawner()
    const pending = proposeChildSession(proposal({ mode: 'offer', task: '', briefing: '' }), ctx())
    await vi.waitFor(async () => expect(await board.list('parent-1')).toHaveLength(1))
    const [p] = await board.list('parent-1')
    await board.choose('parent-1', p!.taskId, 'new')
    await pending
    const moved = await spawnChildSession(spawnInput({ proposalId: p!.taskId, task: 'T', briefing: BRIEF, cwd: '/other' }), ctx())
    expect(moved.data).toMatch(/^Refused: cwd differs/)
    expect(spawns).toEqual([])
  })
})

describe('session.propose — the plugins see a proposal before it is recorded', () => {
  type ProposeMods = NonNullable<ToolCallContext['options']['mods']>
  function withMods(hook: NonNullable<ProposeMods['sessionPropose']>): ToolCallContext {
    const context = ctx()
    context.options.mods = { hasSessionProposeHooks: () => true, sessionPropose: hook } as ProposeMods
    return context
  }

  it('a deny records nothing and names the reason; a rewrite is recorded after its checks; a rewrite the checks refuse throws', async () => {
    recordingSpawner()
    const seen: unknown[] = []
    const denied = await proposeChildSession(proposal(), withMods(async e => (seen.push(e), { deny: 'one proposal a day' })))
    expect(denied.data).toBe('Refused: a plugin refused this proposal: one proposal a day')
    expect(seen).toEqual([
      { initiation: 'suggest', title: proposal().title, task: proposal().task, briefing: BRIEF, parentSessionId: 'parent-1' },
    ])
    expect(await board.list('parent-1')).toEqual([])

    const refusals: string[] = []
    const { data } = await proposeChildSession(
      proposal(),
      withMods(async (e, core) => {
        await core({ title: e.title, task: e.task, briefing: 'short' }).catch((error: Error) => refusals.push(error.message))
        return core({ title: `${e.title} (tidy)`, task: e.task, briefing: e.briefing })
      }),
    )
    expect(refusals).toEqual([expect.stringMatching(/briefing must be at least 80/)])
    const [p] = (await board.list('parent-1')) as ChildProposal[]
    expect(p!.request.title).toBe(`${proposal().title} (tidy)`)
    expect(data).toContain(`as task ${p!.taskId}`)
  })
})

describe('session.propose — one record per call', () => {
  it('a second run of core is refused: one proposal is recorded', async () => {
    recordingSpawner()
    const context = ctx()
    const again: string[] = []
    context.options.mods = {
      hasSessionProposeHooks: () => true,
      sessionPropose: async (e, core) => {
        const first = await core({ title: e.title, task: e.task, briefing: e.briefing })
        await core({ title: 'Second', task: e.task, briefing: e.briefing }).catch((error: Error) => again.push(error.message))
        return first
      },
    } as NonNullable<ToolCallContext['options']['mods']>
    await proposeChildSession(proposal(), context)
    expect(again).toEqual(['this proposal has already been recorded'])
    expect(await board.list('parent-1')).toHaveLength(1)
  })
})

describe('WithdrawProposal', () => {
  it('withdraws a waiting proposal and refuses a started one with its real state', async () => {
    recordingSpawner()
    await proposeChildSession(proposal(), ctx())
    await proposeChildSession(proposal({ title: 'Second' }), ctx())
    const [a, b] = await board.list('parent-1')
    expect((await withdrawProposal({ taskId: a!.taskId }, ctx())).data).toMatch(/^Withdrew proposal task_/)
    expect(await board.get('parent-1', a!.taskId)).toMatchObject({ state: 'dismissed' })
    await spawnChildSession(spawnInput({ proposalId: b!.taskId }), ctx())
    expect((await withdrawProposal({ taskId: b!.taskId }, ctx())).data).toMatch(/is already started as session child-task_\w+; only a proposal still waiting/)
    expect((await withdrawProposal({ taskId: 'task_notthere' }, ctx())).data).toMatch(/no proposal task_notthere/)
    expect((await withdrawProposal({ taskId: 'x' }, ctx())).data).toMatch(/taskId must be a task id/)
  })
})

describe('H01 — hand-off', () => {
  it('forks with the remaining plan as the first task, records a hand_off origin, and stops nothing', async () => {
    const spawns = recordingSpawner(() => ({ ok: true, sessionId: 'child-h', name: 'finish-migration', sharedCheckout: true }))
    const abort = new AbortController()
    const context = ctx('parent-1', abort)
    const { data } = await handOffChildSession({ title: 'Finish the migration', remainingPlan: '1. Port the last two tables.\n2. Run the tests.' }, context)
    expect(spawns).toHaveLength(1)
    expect(spawns[0]).toMatchObject({
      kind: 'hand_off',
      request: { from: 'fork', title: 'Finish the migration', task: '1. Port the last two tables.\n2. Run the tests.' },
    })
    expect(spawns[0]!.taskId).toBeUndefined()
    // The parent's turn is not interrupted; the text asks it to stop the task and answer.
    expect(abort.signal.aborted).toBe(false)
    expect(data).toContain('Handed off "Finish the migration" to child session "finish-migration" (session child-h)')
    expect(data).toContain('Stop working on that task here')
    expect(data).toContain('this session keeps running, so answer the user\'s latest message')
  })

  it('refuses an empty plan, and a nested caller, creating nothing', async () => {
    const spawns = recordingSpawner()
    expect((await handOffChildSession({ title: 'X', remainingPlan: '  ' }, ctx())).data).toMatch(/^Refused: remainingPlan is required/)
    const nested = ctx()
    nested.agentId = 'agent-1'
    expect((await handOffChildSession({ title: 'X', remainingPlan: 'Plan.' }, nested)).data).toMatch(/sub-agent or teammate/)
    expect(spawns).toEqual([])
  })
})

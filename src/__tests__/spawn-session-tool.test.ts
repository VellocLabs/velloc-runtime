import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SpawnSessionTool, spawnChildSession } from '../toolkit/builtin/spawnSession'
import type { SpawnSessionInput } from '../sessions/childSessionSpec'
import {
  setChildSessionSpawner,
  type ChildSessionSpawnOutcome,
  type ChildSessionSpawnParams,
} from '../sessions/childSessionSpawner'
import { setTemplateChannelForTest } from '../prompting/templateCatalog'
import { installProcessFs, resetProcessFs } from '../utils/fs/runtimeFs'
import { NEXUS_SETTINGS_FILE_NAME, wipeSettingsMemos } from '../settings/settingsStore'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { getBrowserTools, getToolsForHostManifest } from '../toolkit/toolRegistry'
import type { BrowserHostManifest } from '../browser/bridge/protocol/manifest'

// The built-in catalog is the authority on effort tiers; this test gives one
// made-up id a tier list so the accepted path is observable without a
// catalog row.
vi.mock('../engine/contextWindow', async importOriginal => {
  const actual = await importOriginal<typeof import('../engine/contextWindow')>()
  return {
    ...actual,
    getAvailableThinkingTiersForModel: (modelId: string | undefined, providerId?: string) =>
      modelId === 'm-tiered' ? ['low', 'high'] : actual.getAvailableThinkingTiersForModel(modelId, providerId),
  }
})

// The `SpawnSession` tool (F-36): a strict all-required schema, the runtime
// gate, and an acknowledgement that says registered, never delivered.

const HOME = '/home/test'
const BRIEF = 'Everything the child needs: the goal, the files, what was ruled out, and what done looks like.'

function input(overrides: Partial<SpawnSessionInput> = {}): SpawnSessionInput {
  return {
    initiation: 'asked',
    title: 'Fix the login redirect',
    task: 'Land the redirect fix.',
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

function ctx(overrides: Record<string, unknown> = {}, sessionId = 'parent-1'): ToolCallContext {
  const appState = createEmptyAppState()
  const base = createNoopToolUseContext({
    tools: [],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState,
    setAppState: () => {},
    sessionId,
    cwd: '/repo',
    projectRoot: '/repo',
  })
  Object.assign(base.options, {
    homeDir: HOME,
    templateType: 'code',
    userSpecifiedProviderId: PROVIDER,
    ...overrides,
  })
  return base
}

function installSettings(providers: unknown, dirs: readonly string[] = []): void {
  const files = new Map<string, string>([
    [`${HOME}/.velloc/${NEXUS_SETTINGS_FILE_NAME}`, JSON.stringify({ version: 1, providers })],
  ])
  installProcessFs({
    readFile: async (path: string) => {
      const content = files.get(path)
      if (content === undefined) {
        const err = new Error('ENOENT') as Error & { code?: string }
        err.code = 'ENOENT'
        throw err
      }
      return content
    },
    writeFile: async () => {},
    mkdir: async () => {},
    stat: async (path: string) => {
      if (dirs.includes(path)) return { isDirectory: () => true, isFile: () => false }
      const err = new Error('ENOENT') as Error & { code?: string }
      err.code = 'ENOENT'
      throw err
    },
  } as never)
  wipeSettingsMemos()
}

/** A built-in provider whose catalog publishes no effort tiers. */
const PROVIDER = 'minimax'
const MODEL = 'MiniMax-M3'
const OTHER_MODEL = 'MiniMax-Text-01'
/** A model id the mocked catalog gives tiers to (no built-in row has any here). */
const TIERED_MODEL = 'm-tiered'

beforeEach(() => {
  setTemplateChannelForTest('beta')
  installSettings({
    activeProviderId: PROVIDER,
    configs: { [PROVIDER]: { apiKey: 'k', enabledModels: [MODEL, OTHER_MODEL, TIERED_MODEL] } },
  })
})

afterEach(() => {
  setTemplateChannelForTest(null)
  setChildSessionSpawner(null)
  resetProcessFs()
  wipeSettingsMemos()
})

/** A spawner that records its params and answers `outcome`. */
function fakeSpawner(outcome: ChildSessionSpawnOutcome | null) {
  const calls: ChildSessionSpawnParams[] = []
  setChildSessionSpawner(async params => {
    calls.push(params)
    return outcome
  })
  return calls
}

describe('SpawnSession — schema', () => {
  it('is strict with every field required and nothing extra', () => {
    const schema = SpawnSessionTool.inputJSONSchemaStrict as unknown as { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean }
    expect(SpawnSessionTool.name).toBe('SpawnSession')
    expect(SpawnSessionTool.strict).toBe(true)
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required.sort()).toEqual(Object.keys(schema.properties).sort())
    expect(schema.required).toHaveLength(13)
  })

  it('checkInput refuses a non-string field by name', async () => {
    const bad = { ...input(), model: undefined } as unknown as SpawnSessionInput
    const check = await SpawnSessionTool.checkInput!(bad, ctx())
    expect(check).toMatchObject({ result: false, message: expect.stringMatching(/^model is required/) })
    expect(await SpawnSessionTool.checkInput!(input(), ctx())).toEqual({ result: true })
  })

  it('is neither read-only nor parallel-safe', () => {
    expect(SpawnSessionTool.readsOnly({} as never)).toBe(false)
    expect(SpawnSessionTool.parallelSafe({} as never)).toBe(false)
  })

  it('describes the tool as registered-not-delivered', async () => {
    const description = await SpawnSessionTool.description({} as never, {} as never)
    expect(description).toContain('registered, not that the task was delivered')
    expect(description).toContain('CHILD SESSION')
  })
})

describe('SpawnSession — the gate', () => {
  it('refuses on the stable channel before anything else, and calls no spawner', async () => {
    setTemplateChannelForTest('stable')
    const calls = fakeSpawner({ ok: true, sessionId: 'c', name: 'n', sharedCheckout: true })
    const { data } = await spawnChildSession(input(), ctx())
    expect(data).toMatch(/^Refused: child sessions are not available on this release channel/)
    expect(calls).toEqual([])
  })

  it('refuses from a sub-agent or teammate loop', async () => {
    const calls = fakeSpawner({ ok: true, sessionId: 'c', name: 'n', sharedCheckout: true })
    const sub = ctx()
    sub.agentId = 'agent-7'
    expect((await spawnChildSession(input(), sub)).data).toMatch(/sub-agent or teammate cannot start a session/)
    expect((await spawnChildSession(input(), ctx({}, 'subagent-abc'))).data).toMatch(/sub-agent or teammate/)
    expect((await spawnChildSession(input(), ctx({ teammateName: 'worker-a' }))).data).toMatch(/sub-agent or teammate/)
    expect(calls).toEqual([])
  })

  it('refuses from a session type other than code or agent', async () => {
    const calls = fakeSpawner({ ok: true, sessionId: 'c', name: 'n', sharedCheckout: true })
    expect((await spawnChildSession(input(), ctx({ templateType: 'team' }))).data).toMatch(/code or agent session only/)
    expect((await spawnChildSession(input(), ctx({ templateType: 'chat' }))).data).toMatch(/code or agent session only/)
    expect(calls).toEqual([])
  })

  it('refuses a malformed request with the field named', async () => {
    const calls = fakeSpawner({ ok: true, sessionId: 'c', name: 'n', sharedCheckout: true })
    expect((await spawnChildSession(input({ briefing: 'short' }), ctx())).data).toMatch(/^Refused: briefing must be at least 80/)
    expect((await spawnChildSession(input({ from: 'fork', isolation: 'worktree' }), ctx())).data).toMatch(/fork takes no isolation/)
    expect((await spawnChildSession(input({ permissionMode: 'bypassPermissions' }), ctx())).data).toMatch(/never raise/)
    expect(calls).toEqual([])
  })

  it('refuses when no session manager registered a spawner', async () => {
    const { data } = await spawnChildSession(input(), ctx())
    expect(data).toMatch(/^Refused: child sessions are unavailable here/)
  })

  it('refuses a model the provider has not enabled, and an effort the model does not publish', async () => {
    const calls = fakeSpawner({ ok: true, sessionId: 'c', name: 'n', sharedCheckout: true })
    expect((await spawnChildSession(input({ model: 'm-x' }), ctx())).data).toBe(
      `Refused: model "m-x" is not enabled on provider "${PROVIDER}". Enabled: ${MODEL}, ${OTHER_MODEL}, ${TIERED_MODEL}.`,
    )
    expect((await spawnChildSession(input({ model: TIERED_MODEL, effort: 'turbo' }), ctx())).data).toBe(
      `Refused: effort "turbo" is not one model "${TIERED_MODEL}" accepts. Accepted: low, high.`,
    )
    expect((await spawnChildSession(input({ model: MODEL, effort: 'low' }), ctx())).data).toBe(
      `Refused: model "${MODEL}" publishes no effort tiers; leave effort empty.`,
    )
    expect(calls).toEqual([])
  })
})

describe('SpawnSession — forwarding and acknowledgement', () => {
  it('forwards the checked request, the provider and the pinned tier, and says registered, not delivered', async () => {
    const calls = fakeSpawner({ ok: true, sessionId: 'child-1', name: 'login-fix', sharedCheckout: true, cwd: '/repo' })
    const { data } = await spawnChildSession(input({ name: 'login-fix', model: TIERED_MODEL, effort: 'low' }), ctx())
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      parentSessionId: 'parent-1',
      providerId: PROVIDER,
      thinkingTier: 'low',
      request: {
        from: 'fresh',
        name: 'login-fix',
        model: TIERED_MODEL,
        effort: 'low',
        isolation: 'shared',
        permissionMode: 'default',
        briefing: BRIEF,
        task: 'Land the redirect fix.',
      },
    })
    expect(calls[0]!.prepareWorktree).toBeUndefined()
    expect(data).toMatch(/^Registered child session "login-fix" \(session child-1\)\./)
    expect(data).toContain('does not mean the task has been delivered')
    expect(data).toContain('SHARED directory /repo')
    expect(data).not.toMatch(/\bdelivered\.\s*$/)
  })

  it('a worktree child carries a worktree maker; a shared child none', async () => {
    const calls = fakeSpawner({ ok: true, sessionId: 'child-2', name: 'wt', sharedCheckout: false, cwd: '/repo/.velloc/worktrees/wt' })
    const { data } = await spawnChildSession(input({ isolation: 'worktree' }), ctx())
    expect(calls[0]!.request.isolation).toBe('worktree')
    expect(typeof calls[0]!.prepareWorktree).toBe('function')
    expect(data).toContain('own worktree at /repo/.velloc/worktrees/wt')
    expect(data).not.toContain('SHARED')
  })

  it('a parent working in a worktree defaults its child to a worktree', async () => {
    const calls = fakeSpawner({ ok: true, sessionId: 'c', name: 'n', sharedCheckout: false })
    await spawnChildSession(input(), ctx({ cwd: '/repo/.velloc/worktrees/mine', projectRoot: '/repo' }))
    expect(calls[0]!.request).toMatchObject({ isolation: 'worktree', isolationRequested: false })
    expect(typeof calls[0]!.prepareWorktree).toBe('function')
  })

  it('relays a runtime refusal and the not-booted case as refusals', async () => {
    fakeSpawner({ ok: false, reason: 'the fork was refused: the transcript ends in a tool call with no recorded answer (c1)' })
    expect((await spawnChildSession(input({ from: 'fork', briefing: '' }), ctx())).data).toBe(
      'Refused: the fork was refused: the transcript ends in a tool call with no recorded answer (c1)',
    )
    fakeSpawner(null)
    expect((await spawnChildSession(input(), ctx())).data).toMatch(/^Refused: the runtime cannot start a session yet/)
  })

  it('a registered session that did not start is reported with its reason, never as running', async () => {
    fakeSpawner({ ok: true, sessionId: 'child-3', name: 'wt', sharedCheckout: false, startFailed: 'the worktree could not be created: branch exists' })
    const { data } = await spawnChildSession(input({ isolation: 'worktree' }), ctx())
    expect(data).toMatch(/^Child session "wt" \(session child-3\) is registered but did not start: the worktree could not be created: branch exists/)
    expect(data).toContain('nothing was shared or run')
    expect(data).not.toContain('Registered child session')
  })

  it('a fork request forwards without a briefing and says what a fork carries', async () => {
    const calls = fakeSpawner({ ok: true, sessionId: 'forked-1', name: 'parser', sharedCheckout: true, cwd: '/repo' })
    const { data } = await spawnChildSession(input({ from: 'fork', briefing: '', name: 'parser' }), ctx())
    expect(calls[0]!.request.from).toBe('fork')
    expect(calls[0]!.request.briefing).toBeUndefined()
    expect(data).toContain('copy of this conversation up to the last answered message')
  })

  it('without a home directory no model check runs, and the request still forwards', async () => {
    const calls = fakeSpawner({ ok: true, sessionId: 'c', name: 'n', sharedCheckout: true })
    const { data } = await spawnChildSession(input({ model: 'anything' }), ctx({ homeDir: undefined }))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.request.model).toBe('anything')
    expect(data).toMatch(/^Registered child session/)
  })

  it('the tool call runs the same path', async () => {
    const spy = vi.fn(async () => ({ ok: true as const, sessionId: 'c', name: 'n', sharedCheckout: true }))
    setChildSessionSpawner(spy)
    const result = await SpawnSessionTool.call(input(), ctx(), async () => ({ behavior: 'allow' as const }), { type: 'assistant', uuid: 'a-1', message: { role: 'assistant', content: [] } } as never)
    expect(spy).toHaveBeenCalledTimes(1)
    expect((result as { data: string }).data).toMatch(/^Registered child session "n"/)
  })
})

describe('SpawnSession — in the tool pool', () => {
  it('is a default-set tool, and stays in the pool under a hosted catalog', () => {
    expect(getBrowserTools().map(t => t.name)).toContain('SpawnSession')
    const manifest = {
      hostKind: 'nexus',
      capabilities: ['fs', 'model', 'browser'],
      toolNames: [],
      commandNames: [],
      hostedTools: [
        {
          type: 'function',
          name: 'browser_navigate',
          description: 'Navigate the active tab.',
          parameters: { type: 'object', properties: {} },
        },
      ],
    } as unknown as BrowserHostManifest
    const names = getToolsForHostManifest(manifest).map(t => t.name)
    expect(names).toContain('browser_navigate')
    expect(names).toContain('SpawnTeammate')
    expect(names).toContain('SpawnSession')
  })

  it('is not in the overlay set', () => {
    expect(getBrowserTools('glic').map(t => t.name)).not.toContain('SpawnSession')
  })
})

describe('SpawnSession — the worktree carries the allocated family name', () => {
  /** A host Bash that records every git command and answers a sha to `rev-parse`. */
  function gitRecorder() {
    const commands: string[] = []
    const callTool = async ({ args }: { args: Record<string, unknown> }) => {
      const command = String(args.command ?? '')
      commands.push(command)
      return command.includes('rev-parse HEAD') ? 'cafe0001\n' : ''
    }
    return { commands, callTool }
  }

  /** A spawner that allocates names the way the runtime does and calls the
   *  maker inside the spawn, as the coordinator does. */
  function allocatingSpawner(names: string[]) {
    let next = 0
    setChildSessionSpawner(async params => {
      const name = names[next++] ?? 'session'
      const made = await params.prepareWorktree!(name)
      if (!made.ok) return { ok: true, sessionId: `s-${name}`, name, sharedCheckout: false, startFailed: made.reason }
      return { ok: true, sessionId: `s-${name}`, name, sharedCheckout: false, cwd: made.cwd }
    })
  }

  function gitCtx(callTool: (p: { args: Record<string, unknown> }) => Promise<unknown>) {
    const base = ctx()
    ;(base as { platformCapabilities: unknown }).platformCapabilities = { browser: { callTool } }
    return base
  }

  beforeEach(() => {
    installSettings(
      { activeProviderId: PROVIDER, configs: { [PROVIDER]: { apiKey: 'k' } } },
      ['/repo/.git'],
    )
  })

  it('a name with spaces yields a valid branch and directory from the allocated slug', async () => {
    allocatingSpawner(['api-docs'])
    const { commands, callTool } = gitRecorder()
    const { data } = await spawnChildSession(input({ name: 'API docs', isolation: 'worktree' }), gitCtx(callTool))
    const add = commands.find(c => c.includes('worktree add'))
    expect(add).toBe(`git -C "/repo" worktree add -b 'session/api-docs' "/repo/.velloc/worktrees/api-docs" 'cafe0001'`)
    expect(data).toContain('own worktree at /repo/.velloc/worktrees/api-docs')
  })

  it('two unnamed worktree children get distinct branches and directories', async () => {
    allocatingSpawner(['session', 'session-2'])
    const { commands, callTool } = gitRecorder()
    await spawnChildSession(input({ isolation: 'worktree' }), gitCtx(callTool))
    await spawnChildSession(input({ isolation: 'worktree' }), gitCtx(callTool))
    const adds = commands.filter(c => c.includes('worktree add'))
    expect(adds).toHaveLength(2)
    expect(adds[0]).toContain(`-b 'session/session' "/repo/.velloc/worktrees/session"`)
    expect(adds[1]).toContain(`-b 'session/session-2' "/repo/.velloc/worktrees/session-2"`)
  })

  it('an explicit branchName and baseBranch still win, and stay allow-listed', async () => {
    allocatingSpawner(['api-docs'])
    const { commands, callTool } = gitRecorder()
    await spawnChildSession(
      input({ name: 'API docs', isolation: 'worktree', branchName: 'feat/docs', baseBranch: 'main' }),
      gitCtx(callTool),
    )
    const add = commands.find(c => c.includes('worktree add'))
    expect(add).toBe(`git -C "/repo" worktree add -b 'feat/docs' "/repo/.velloc/worktrees/api-docs" 'main'`)
    // The directory still follows the allocated name; only the branch is the caller's.
    const refused = await spawnChildSession(input({ isolation: 'worktree', branchName: 'feat;rm' }), gitCtx(callTool))
    expect(refused.data).toMatch(/^Refused: branchName .* is not a valid git branch name/)
    expect(commands.filter(c => c.includes('worktree add'))).toHaveLength(1)
  })
})

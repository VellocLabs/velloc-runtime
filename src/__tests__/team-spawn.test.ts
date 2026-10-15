import { afterEach, describe, expect, it } from 'vitest'
import {
  TeammateNameInUseError,
  setTeammateSpawner,
  getTeammateSpawner,
} from '../team/teammateSpawner'
import type { SpawnTeammateParams } from '../team/teamTypes'
import { SpawnAgentTool } from '../toolkit/builtin/subagentLaunch'
import {
  SpawnTeammateTool,
  type SpawnTeammateInput,
} from '../toolkit/builtin/spawnTeammate'
import { TEAMMATE_ACK_WAIT_HINT } from '../toolkit/builtin/team/spawnTeammate'
import { MailTool, ShutdownTool } from '../toolkit/builtin/teamTools'
import { setTeamMessenger } from '../team/teamMessenger'
import { shouldInlineToolPayloads } from '../utils/toolCallDetails'
import {
  installProcessFs,
  resetProcessFs,
} from '../utils/fs/runtimeFs'
import {
  NEXUS_SETTINGS_FILE_NAME,
  wipeSettingsMemos,
} from '../settings/settingsStore'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'

afterEach(() => {
  setTeammateSpawner(null)
  setTeamMessenger(null)
})

const ALLOW = async () => ({ behavior: 'allow' as const })
const PARENT = {
  type: 'assistant',
  uuid: 'a-1',
  message: { role: 'assistant', content: [] },
} as never

function ctx(sessionId = 'lead') {
  return createNoopToolUseContext({
    tools: [],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
    sessionId,
  })
}

const HOME = '/home/test'

/**
 * Run `body` with a settings.json on a memory fs. Every spawn test needs one:
 * a lead whose provider cannot be resolved from settings is REFUSED rather
 * than assumed trusted, so "no settings at all" is a refusal path.
 */
async function withSettings(
  providers: unknown,
  run: () => Promise<void>,
  /** Directories that exist on the memory fs — what a lead-prepared `cwd`
   *  is checked against. */
  dirs: readonly string[] = [],
) {
  const files = new Map<string, string>([
    [
      `${HOME}/.velloc/${NEXUS_SETTINGS_FILE_NAME}`,
      JSON.stringify({ version: 1, providers }),
    ],
  ])
  const fs = {
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
  }
  installProcessFs(fs as never)
  wipeSettingsMemos()
  try {
    await run()
  } finally {
    resetProcessFs()
    wipeSettingsMemos()
  }
}

/** The settings a plain trusted lead runs under. */
const TRUSTED_ONLY = {
  activeProviderId: 'anthropic',
  configs: { anthropic: { apiKey: 'k' } },
}

/** A `team` session bound to a trusted provider — the ordinary lead. */
function teamCtx(sessionId = 'lead') {
  const base = ctx(sessionId)
  Object.assign(base.options, {
    homeDir: HOME,
    templateType: 'team',
    userSpecifiedProviderId: 'anthropic',
  })
  return base
}

/** A context carrying a homeDir + the lead's provider + a project root. */
function leadCtx(providerId: string | undefined) {
  const base = ctx('lead-1')
  Object.assign(base.options, {
    homeDir: HOME,
    projectRoot: '/repo',
    templateType: 'team',
    ...(providerId ? { userSpecifiedProviderId: providerId } : {}),
  })
  return base
}

/**
 * A complete SpawnTeammate call. Every field is REQUIRED on the wire, so a
 * test that varies one still sends all six — exactly what a model does.
 */
function spawnInput(overrides: Partial<SpawnTeammateInput> = {}): SpawnTeammateInput {
  return {
    name: 'worker-a',
    prompt: 'do it',
    provider_id: 'anthropic',
    model: 'opus',
    cwd: null,
    effort: null,
    ...overrides,
  }
}

function spawn(input: SpawnTeammateInput, context = teamCtx()) {
  return SpawnTeammateTool.call(input, context, ALLOW, PARENT)
}

/** Record spawner calls; returns the list they land in. */
function recordSpawns(sessionId = 'teammate-1'): SpawnTeammateParams[] {
  const calls: SpawnTeammateParams[] = []
  setTeammateSpawner(p => {
    calls.push(p)
    return sessionId
  })
  return calls
}

/** A spawner that must NOT be reached; returns a probe. */
function forbidSpawn(): { spawned: boolean } {
  const probe = { spawned: false }
  setTeammateSpawner(() => {
    probe.spawned = true
    return 'x'
  })
  return probe
}

describe('teammateSpawner leaf', () => {
  it('set/get round-trips, defaults null', () => {
    expect(getTeammateSpawner()).toBeNull()
    const fn = () => 'x'
    setTeammateSpawner(fn)
    expect(getTeammateSpawner()).toBe(fn)
  })
})

// ── The tool's contract: strict, every field required ─────────────────────

/**
 * A lead's provider can change under a running team — the trusted-lead rule is
 * enforced only at spawn. The coordination surface says so; the delivered
 * report carries the full banner (TeamCoordinator.UNTRUSTED_LEAD_BANNER).
 */
describe('coordination from a lead that is no longer trusted', () => {
  const RELAY_LEAD = {
    activeProviderId: 'relay',
    configs: {
      anthropic: { apiKey: 'k' },
      relay: { isCustomProvider: true, trust: 'untrusted', enabledModels: ['big-1'] },
    },
  }

  function messenger() {
    setTeamMessenger({
      deliver: () => ({ ok: true }),
      shutdownMember: () => ({ ok: true }),
      listMembers: () => [],
    })
  }

  function leadOn(providerId: string) {
    const base = ctx('lead-1')
    Object.assign(base.options, {
      homeDir: HOME,
      templateType: 'team',
      userSpecifiedProviderId: providerId,
    })
    return base
  }

  it('SendMessage and Shutdown warn when the session moved onto an untrusted provider', async () => {
    messenger()
    await withSettings(RELAY_LEAD, async () => {
      const sent = await MailTool.call(
        { to: 'worker-a', message: 'carry on', team: 'lead-1' },
        leadOn('relay'),
        ALLOW,
        PARENT,
      )
      expect(sent.data).toContain('no longer a trusted reviewer')
      expect(sent.data).toContain('relay')
      // A warning, not a refusal: the message still went.
      expect(sent.data).toContain('Message sent')
      expect(sent.isError).toBeUndefined()

      const down = await ShutdownTool.call(
        { name: 'worker-a', team: 'lead-1' },
        leadOn('relay'),
        ALLOW,
        PARENT,
      )
      expect(down.data).toContain('no longer a trusted reviewer')
      expect(down.data).toContain('is shutting down')
    })
  })

  it('says nothing while the lead is still trusted, or to a teammate', async () => {
    messenger()
    await withSettings(RELAY_LEAD, async () => {
      const trusted = await MailTool.call(
        { to: 'worker-a', message: 'go', team: 'lead-1' },
        leadOn('anthropic'),
        ALLOW,
        PARENT,
      )
      expect(trusted.data).not.toContain('no longer a trusted reviewer')

      // A teammate supervises nobody — the warning would be noise it cannot
      // act on, and it has no provider choice to make.
      const mate = leadOn('relay')
      Object.assign(mate.options, { teammateName: 'worker-a', templateType: 'safe_code' })
      const fromMate = await MailTool.call(
        { to: 'team-lead', message: 'done', team: 'lead-1' },
        mate,
        ALLOW,
        PARENT,
      )
      expect(fromMate.data).not.toContain('no longer a trusted reviewer')
    })
  })
})

describe('SpawnTeammate — schema and validation', () => {
  it('declares every field required, no extras, and ships the same schema as its strict variant', () => {
    const schema = SpawnTeammateTool.argsSchema!
    expect(schema.required).toEqual([
      'name',
      'prompt',
      'provider_id',
      'model',
      'cwd',
      'effort',
    ])
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(
      [...schema.required!].sort(),
    )
    expect(schema.additionalProperties).toBe(false)
    // Every property is a PLAIN string — never `['string','null']`. A union
    // type does not survive to the model: it is flattened to `type: 'string'`
    // AND the property is dropped from `required` (see
    // the team template golden, captured from the wire), which
    // reopens the optional-field hole this tool exists to close and, under
    // `strict: true`, forbids the very `null` a description would ask for.
    // "None" is therefore `""`.
    const props = schema.properties as Record<string, { type: unknown; description?: string }>
    for (const [field, prop] of Object.entries(props)) {
      expect(prop.type, `${field} must be a single string type`).toBe('string')
    }
    expect(props.cwd?.description).toContain('Empty string')
    expect(props.effort?.description).toContain('Empty string')
    expect(SpawnTeammateTool.inputJSONSchemaStrict).toBe(schema)
    expect(SpawnTeammateTool.strict).toBe(true)
  })

  it('steers the name toward a PERSON name, not an identifier slug', () => {
    // The name is what the user reads on the teammate's tab and on every
    // report card it sends. The old description's examples ("researcher")
    // were role slugs, and every real run picked one to match:
    // settings-designer, read-media-fixer, kimi-settings — which read as
    // machine ids, to the point that a user asked whether the UI was
    // displaying the session id rather than the name. It was the name.
    const props = SpawnTeammateTool.argsSchema!.properties as Record<string, { description?: string }>
    const description = props.name?.description ?? ''
    expect(description).toContain('PERSON name')
    expect(description).toContain('colleague')
    expect(description).toContain('Not an identifier-style slug')
    // Any language stays — the key is derived, the display name is free text.
    expect(description).toContain('Any language')
    expect(description).not.toContain('"researcher"')
  })

  it('is one of the agent-teams tools (hidden until the skill is loaded), not an always-on tool', () => {
    expect(SpawnTeammateTool.skill).toBe('agent-teams')
  })

  it('refuses outside a TEAM session — the agent-teams skill alone must not buy a teammate', async () => {
    // The tool ships in the agent-teams bundle, so a `code` / `chat` session
    // reaches it the moment it activates that skill (its deferred-tool
    // catalog even advertises it). A teammate outlives the turn and injects
    // turns back; only a team session's prompt explains that lifecycle. The
    // branch this tool replaced carried the same gate.
    const probe = forbidSpawn()
    for (const templateType of ['code', 'chat', undefined]) {
      const base = ctx('code-1')
      Object.assign(base.options, {
        homeDir: HOME,
        userSpecifiedProviderId: 'anthropic',
        ...(templateType ? { templateType } : {}),
      })
      let r: { data?: unknown } = {}
      await withSettings(TRUSTED_ONLY, async () => {
        r = await spawn(spawnInput(), base)
      })
      expect(r.data, String(templateType)).toMatch(/^Refused: teammates can only be spawned from a team session/)
      expect(r.data).toContain('`Agent`')
    }
    expect(probe.spawned).toBe(false)
  })

  it('keeps its args and ack INLINE in the transcript, like Agent — the spawn card reads them', () => {
    // Red-without: lazy-loaded, the call persisted with
    // its args stripped and its ack in the sidecar, so `classifyTeammateSpawn`
    // saw neither and the spawn rendered as a bare tool row.
    expect(shouldInlineToolPayloads('SpawnTeammate')).toBe(true)
  })

  it('validateInput refuses a missing or blank required string, naming the field', async () => {
    for (const field of ['name', 'prompt', 'provider_id', 'model'] as const) {
      for (const bad of ['', '   ', undefined]) {
        const r = await SpawnTeammateTool.checkInput?.(
          spawnInput({ [field]: bad } as Partial<SpawnTeammateInput>),
          teamCtx(),
        )
        expect(r?.result, `${field}=${JSON.stringify(bad)}`).toBe(false)
        expect(r && 'message' in r ? r.message : '').toContain(field)
      }
    }
  })

  it('validateInput accepts null for cwd / effort and refuses other non-strings', async () => {
    expect((await SpawnTeammateTool.checkInput?.(spawnInput(), teamCtx()))?.result).toBe(true)
    expect(
      (await SpawnTeammateTool.checkInput?.(
        spawnInput({ cwd: 7 as unknown as string }),
        teamCtx(),
      ))?.result,
    ).toBe(false)
    expect(
      (await SpawnTeammateTool.checkInput?.(
        spawnInput({ effort: true as unknown as string }),
        teamCtx(),
      ))?.result,
    ).toBe(false)
  })
})

// ── The spawn itself ───────────────────────────────────────────────────────

describe('SpawnTeammate — spawns a teammate through the spawner leaf', () => {
  it('forwards identity, prompt, provider, model and the parent; acks with the session id and the wait hint', async () => {
    const calls = recordSpawns('teammate-lead1-worker-a-1')
    let r: { data?: unknown } = {}
    await withSettings(
      { activeProviderId: 'anthropic', configs: { anthropic: { apiKey: 'k', enabledModels: ['opus'] } } },
      async () => {
        r = await spawn(spawnInput({ prompt: 'survey the auth flow' }), teamCtx('lead-1'))
      },
    )
    expect(r.data).toContain('Spawned teammate "worker-a"')
    expect(r.data).toContain('teammate-lead1-worker-a-1')
    // The one instruction the first /safe-team lead never got: end the turn.
    expect(r.data).toContain(TEAMMATE_ACK_WAIT_HINT)
    expect(r.data).toMatch(/end your turn/)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      // The team is implicit — derived from the lead's session id.
      teamName: 'lead-1',
      teammateName: 'worker-a',
      prompt: 'survey the auth flow',
      spawnerSessionId: 'lead-1',
      providerId: 'anthropic',
      model: 'opus',
    })
    expect(calls[0]?.thinkingTier).toBeUndefined()
  })

  it('refuses a lead whose settings cannot be read at all', async () => {
    // No settings ⇒ nothing can be shown to be trusted.
    const probe = forbidSpawn()
    const bare = ctx('lead-1')
    Object.assign(bare.options, { templateType: 'team' })
    const r = await spawn(spawnInput(), bare)
    expect(r.data).toMatch(/^Refused:/)
    expect(probe.spawned).toBe(false)
  })

  it('reports unavailable when no spawner is registered', async () => {
    setTeammateSpawner(null)
    const r = await spawn(spawnInput(), teamCtx())
    expect(r.data).toMatch(/unavailable/i)
  })

  it('reports deferred when the spawner returns null (no UI session yet)', async () => {
    setTeammateSpawner(() => null)
    let r: { data?: unknown } = {}
    await withSettings(TRUSTED_ONLY, async () => {
      r = await spawn(spawnInput())
    })
    expect(r.data).toMatch(/deferred/i)
  })

  it('`Agent` no longer spawns teammates: a `name` on an Agent call is ignored', async () => {
    // The teammate branch moved out of `Agent` wholesale — the loose,
    // all-optional schema is what let a lead fill every field with "" and
    // guess an effort tier. `name` / `team_name` are no longer on Agent's
    // schema, and a call carrying them (an older skill, a replayed
    // transcript) takes the sub-agent path, never the spawner.
    const probe = forbidSpawn()
    const schema = SpawnAgentTool.argsSchema!
    for (const gone of ['name', 'team_name', 'cwd', 'provider_id', 'child_model', 'child_effort']) {
      expect(schema.properties, gone).not.toHaveProperty(gone)
    }
    await withSettings(TRUSTED_ONLY, async () => {
      await SpawnAgentTool.call(
        { description: 'd', prompt: 'p', name: 'worker-a', team_name: 't' } as never,
        teamCtx('lead-1'),
        ALLOW,
        PARENT,
      )
    })
    expect(probe.spawned).toBe(false)
  })
})

// ── Trust-derived isolation (WP-H/I) ──────────────────────────────────────
//
// The property under test is that the model has NO say in it: `templateType`
// and `untrustedReadRoot` are derived from the target provider's trust setting
// in settings.json, and the tool exposes no parameter for either.

describe('SpawnTeammate — teammate isolation is derived, not requested', () => {
  const WITH_RELAY = {
    configs: {
      anthropic: { apiKey: 'k' },
      relay: { isCustomProvider: true, trust: 'untrusted', enabledModels: ['big-1'] },
    },
  }

  it('locks a child on an UNTRUSTED provider into safe_code with a read boundary', async () => {
    const calls = recordSpawns()
    await withSettings(WITH_RELAY, async () => {
      const r = await spawn(
        spawnInput({ provider_id: 'relay', model: 'big-1' }),
        leadCtx('anthropic'),
      )
      expect(calls[0]?.templateType).toBe('safe_code')
      expect(calls[0]?.untrustedReadRoot).toBeTruthy()
      expect(calls[0]?.providerId).toBe('relay')
      expect(calls[0]?.model).toBe('big-1')
      // The lead is told what it got, so it knows to review by diff.
      expect(r.data).toContain('UNTRUSTED')
    })
  })

  it('leaves a child on a TRUSTED provider unrestricted', async () => {
    const calls = recordSpawns()
    await withSettings(
      { configs: { anthropic: { apiKey: 'k', enabledModels: ['opus'] } } },
      async () => {
        await spawn(spawnInput(), leadCtx('anthropic'))
        expect(calls[0]?.templateType).toBeUndefined()
        expect(calls[0]?.untrustedReadRoot).toBeUndefined()
      },
    )
  })

  // The teammate's directory is the LEAD's to prepare and pass as `cwd`. The
  // platform never creates a worktree for anyone — trusted or untrusted —
  // so the same spawn shape serves both, and the read boundary of an
  // untrusted child is simply rooted at whatever directory the lead gave it.
  it('spawns into the lead-prepared `cwd` when it exists', async () => {
    const calls = recordSpawns()
    await withSettings(
      TRUSTED_ONLY,
      async () => {
        const r = await spawn(spawnInput({ cwd: '/repo/wt-a' }), leadCtx('anthropic'))
        expect(calls).toHaveLength(1)
        expect(calls[0]?.cwd).toBe('/repo/wt-a')
        // Memory / skills anchor stays the lead's project: a prepared
        // directory is a checkout OF that project, not a different one.
        expect(calls[0]?.projectRoot).toBeUndefined()
        expect(calls[0]?.onCleanup).toBeUndefined()
        expect(calls[0]?.untrustedReadRoot).toBeUndefined()
        expect(r.data).toContain('It works in /repo/wt-a,')
        // A teammate is bound to ONE tree for life and the ack has to say so:
        // a lead that reads only "it works in X" reasonably tries to send it
        // to Y later, and every call it makes there is refused.
        expect(r.data).toContain('FIXED for its lifetime')
        expect(r.data).toContain('needs a NEW teammate spawned there')
      },
      ['/repo/wt-a'],
    )
  })

  it('refuses a `cwd` that does not exist, without spawning', async () => {
    const probe = forbidSpawn()
    await withSettings(TRUSTED_ONLY, async () => {
      const r = await spawn(spawnInput({ cwd: '/repo/missing' }), leadCtx('anthropic'))
      expect(r.data).toMatch(/^Refused: cwd "\/repo\/missing" does not exist/)
      expect(r.data).toContain('git worktree add')
      expect(probe.spawned).toBe(false)
    })
  })

  it('`cwd: ""` (and the tolerated null) mean the project directory — no worktree is made', async () => {
    for (const cwd of ['', null]) {
      const calls = recordSpawns()
      await withSettings(TRUSTED_ONLY, async () => {
        const r = await spawn(spawnInput({ cwd }), leadCtx('anthropic'))
        expect(calls[0]?.cwd).toBeUndefined()
        expect(calls[0]?.projectRoot).toBeUndefined()
        expect(calls[0]?.onCleanup).toBeUndefined()
        expect(r.data).toContain('It works in your project directory,')
      expect(r.data).toContain('FIXED for its lifetime')
      })
    }
  })

  it('roots an UNTRUSTED child’s read boundary at the lead-prepared `cwd`', async () => {
    const calls = recordSpawns()
    await withSettings(
      WITH_RELAY,
      async () => {
        const r = await spawn(
          spawnInput({ cwd: '/repo/wt-a', provider_id: 'relay', model: 'big-1' }),
          leadCtx('anthropic'),
        )
        expect(calls[0]?.templateType).toBe('safe_code')
        expect(calls[0]?.cwd).toBe('/repo/wt-a')
        expect(calls[0]?.untrustedReadRoot).toBe('/repo/wt-a')
        expect(r.data).toContain('It works in /repo/wt-a,')
        expect(r.data).toContain('FIXED for its lifetime')
        expect(r.data).toContain('confined to that directory')
      },
      ['/repo/wt-a'],
    )
  })

  it('roots an UNTRUSTED child’s read boundary at the project when cwd is null', async () => {
    const calls = recordSpawns()
    await withSettings(WITH_RELAY, async () => {
      await spawn(spawnInput({ provider_id: 'relay', model: 'big-1' }), leadCtx('anthropic'))
      expect(calls[0]?.untrustedReadRoot).toBe('/repo')
      expect(calls[0]?.cwd).toBeUndefined()
    })
  })

  it('REFUSES an UNTRUSTED child when no read root can be derived (no project folder, no cwd)', async () => {
    // Every consumer keys the boundary on the root being PRESENT: without one
    // the read check allowed every path, the coordinator labelled the child
    // trusted and the memory lock-out did not fire — only the safe_code tool
    // set was left. Fail closed instead of spawning an unconfined child.
    const calls = recordSpawns()
    await withSettings(WITH_RELAY, async () => {
      // A lead with NO bound project folder (the noop context seeds one).
      const unbound = leadCtx('anthropic')
      Object.assign(unbound.options, { projectRoot: undefined })
      const r = await spawn(spawnInput({ provider_id: 'relay', model: 'big-1' }), unbound)
      expect(r.data).toMatch(/^Refused: provider "relay" is untrusted/)
      expect(r.data).toContain('cwd')
      expect(calls).toHaveLength(0)
    })
  })

  it('passes the display name through in any language, normalized', async () => {
    const calls = recordSpawns()
    await withSettings(TRUSTED_ONLY, async () => {
      const r = await spawn(spawnInput({ name: '  程序员-小民 ' }), leadCtx('anthropic'))
      expect(calls[0]?.teammateName).toBe('程序员-小民')
      expect(r.data).toContain('Spawned teammate "程序员-小民"')
    })
  })

  it('refuses a name with nothing displayable in it', async () => {
    const probe = forbidSpawn()
    await withSettings(TRUSTED_ONLY, async () => {
      const r = await spawn(spawnInput({ name: '()' }), leadCtx('anthropic'))
      expect(r.data).toMatch(/^Refused: teammate name/)
      expect(probe.spawned).toBe(false)
    })
  })

  it('relays a duplicate-name refusal from the spawner as a Refused result', async () => {
    setTeammateSpawner(p => {
      throw new TeammateNameInUseError(p.teammateName)
    })
    await withSettings(TRUSTED_ONLY, async () => {
      const r = await spawn(spawnInput(), leadCtx('anthropic'))
      expect(r.data).toMatch(/^Refused: A teammate named "worker-a" is already running/)
    })
  })

  it('refuses a model the user has not enabled on that provider', async () => {
    const probe = forbidSpawn()
    await withSettings(WITH_RELAY, async () => {
      const r = await spawn(
        spawnInput({ provider_id: 'relay', model: 'some-other-model' }),
        leadCtx('anthropic'),
      )
      expect(r.data).toMatch(/^Refused:/)
      expect(r.data).toContain('big-1')
      expect(probe.spawned).toBe(false)
    })
  })

  it('refuses to delegate at all when the LEAD is on an untrusted provider', async () => {
    const probe = forbidSpawn()
    await withSettings(
      { configs: { relay: { isCustomProvider: true, trust: 'untrusted' } } },
      async () => {
        const r = await spawn(spawnInput({ provider_id: 'relay', model: 'm' }), leadCtx('relay'))
        expect(r.data).toMatch(/^Refused:/)
        expect(probe.spawned).toBe(false)
      },
    )
  })

  it('treats an UNRESOLVED lead provider as untrusted, not as trusted', async () => {
    // A session can genuinely have no `userSpecifiedProviderId` (the catalog
    // fetch is slow or fails); the lead then resolves to the ACTIVE provider,
    // and if that is the relay it may not lead a team at all.
    const calls = recordSpawns()
    await withSettings(
      {
        activeProviderId: 'relay',
        configs: { relay: { isCustomProvider: true, trust: 'untrusted' } },
      },
      async () => {
        const r = await spawn(spawnInput({ provider_id: 'relay', model: 'm' }), leadCtx(undefined))
        expect(r.data).toMatch(/^Refused:/)
        expect(calls).toHaveLength(0)
      },
    )
  })

  it('resolves an unpinned lead session to the ACTIVE provider for the decision', async () => {
    const calls = recordSpawns()
    await withSettings(
      { activeProviderId: 'anthropic', ...WITH_RELAY },
      async () => {
        await spawn(spawnInput({ provider_id: 'relay', model: 'big-1' }), leadCtx(undefined))
        // Lead resolves to trusted `anthropic` (so no refusal), child to the
        // relay (so it is locked down).
        expect(calls[0]?.templateType).toBe('safe_code')
        expect(calls[0]?.providerId).toBe('relay')
      },
    )
  })

  it('refuses a provider_id that names NO provider the user has', async () => {
    // The host falls back to the ACTIVE provider for an id it cannot find,
    // so a bogus id would run the child on whatever is active — possibly the
    // relay — while the isolation decision was made about the bogus id.
    const probe = forbidSpawn()
    await withSettings(
      {
        activeProviderId: 'relay',
        configs: {
          anthropic: { apiKey: 'k' },
          relay: { isCustomProvider: true, trust: 'untrusted' },
        },
      },
      async () => {
        const r = await spawn(spawnInput({ provider_id: 'anything', model: 'm' }), leadCtx('anthropic'))
        expect(r.data).toMatch(/^Refused:/)
        expect(r.data).toContain('"anything"')
        expect(r.data).toMatch(/not one of the user's configured providers/)
        expect(probe.spawned).toBe(false)
      },
    )
  })

  it('refuses a lead whose pinned provider id names NO provider the user has', async () => {
    const probe = forbidSpawn()
    await withSettings(
      {
        activeProviderId: 'relay',
        configs: { relay: { isCustomProvider: true, trust: 'untrusted' } },
      },
      async () => {
        const r = await spawn(spawnInput({ provider_id: 'relay', model: 'm' }), leadCtx('ghost-provider'))
        expect(r.data).toMatch(/^Refused:/)
        expect(r.data).toContain('"ghost-provider"')
        expect(probe.spawned).toBe(false)
      },
    )
  })

  it('still spawns unrestricted on an UNCONFIGURED built-in provider', async () => {
    // The known-provider check must not over-reach: a built-in id needs no
    // settings entry to be a real provider.
    const calls = recordSpawns()
    await withSettings(
      { activeProviderId: 'anthropic', configs: { anthropic: { apiKey: 'k' } } },
      async () => {
        const r = await spawn(spawnInput({ provider_id: 'openai', model: 'gpt-x' }), leadCtx('anthropic'))
        expect(r.data).toContain('Spawned teammate')
        expect(calls[0]?.providerId).toBe('openai')
        expect(calls[0]?.model).toBe('gpt-x')
        expect(calls[0]?.templateType).toBeUndefined()
      },
    )
  })

  it('refuses a nested spawn from inside a teammate or sub-agent session', async () => {
    const probe = forbidSpawn()
    for (const sid of ['teammate-t-worker-a-1', 'subagent-explore_ab12']) {
      const r = await spawn(spawnInput(), ctx(sid))
      expect(r.data).toMatch(/not available inside a sub-agent/i)
    }
    expect(probe.spawned).toBe(false)
  })
})

describe('SpawnTeammate — `effort`', () => {
  // `claude-sonnet-5` is a curated Anthropic entry with published tiers
  // (`availableThinkingTiers`), so the check below reads the real catalog
  // rather than a stub. A custom provider's models would not do: their
  // catalog overlay (`setCustomProviderRecords`) is not applied in this realm.
  const CURATED = {
    activeProviderId: 'anthropic',
    configs: { anthropic: { apiKey: 'k', enabledModels: ['claude-sonnet-5'] } },
  }

  it('forwards a published effort as the spawn thinkingTier', async () => {
    const calls = recordSpawns()
    await withSettings(CURATED, async () => {
      const r = await spawn(spawnInput({ model: 'claude-sonnet-5', effort: 'high' }))
      expect(r.data).not.toMatch(/^Refused:/)
      expect(calls[0]?.model).toBe('claude-sonnet-5')
      expect(calls[0]?.thinkingTier).toBe('high')
      expect(calls[0]?.providerId).toBe('anthropic')
    })
  })

  it('`effort: ""` (and the tolerated null) leave thinkingTier unset', async () => {
    for (const effort of ['', null]) {
      const calls = recordSpawns()
      await withSettings(CURATED, async () => {
        const r = await spawn(spawnInput({ model: 'claude-sonnet-5', effort }))
        expect(r.data).not.toMatch(/^Refused:/)
        expect(calls[0]?.thinkingTier).toBeUndefined()
      })
    }
  })

  it('refuses an effort the model does not publish, naming the accepted ones', async () => {
    // Without the check the tier would reach the query layer, which drops an
    // unpublished tier SILENTLY (`deps.ts`): the teammate would run at its
    // default effort while the lead believes it pinned one.
    const probe = forbidSpawn()
    await withSettings(CURATED, async () => {
      const r = await spawn(spawnInput({ model: 'claude-sonnet-5', effort: 'turbo' }))
      expect(r.data).toMatch(/^Refused:/)
      expect(r.data).toContain('"turbo"')
      expect(r.data).toContain('high')
      expect(probe.spawned).toBe(false)
    })
  })

  it('refuses an effort on a model with no published tiers — the kimi case', async () => {
    // No curated subset, so the model check passes; the id matches no
    // catalog entry, so there is no tier list to validate against — which is
    // what `TeamProviders` renders as "pass effort: null". The first
    // /safe-team lead sent "high" for exactly such a model and was refused;
    // the refusal text has to say what to send instead.
    const probe = forbidSpawn()
    await withSettings(TRUSTED_ONLY, async () => {
      const r = await spawn(spawnInput({ model: 'mystery-model', effort: 'high' }))
      expect(r.data).toMatch(/^Refused:/)
      expect(r.data).toContain('no effort tiers')
      expect(probe.spawned).toBe(false)
    })
  })
})

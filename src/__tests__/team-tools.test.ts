import { afterEach, describe, expect, it } from 'vitest'
import { unconfiguredFs, type RuntimeFs } from '../utils/fs/runtimeFs'
import { TeamRegistry, setTeamRegistry } from '../team/TeamRegistry'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import { setTeamMessenger } from '../team/teamMessenger'
import {
  TeamOpenTool,
  TeamCloseTool,
  BoardAddTool,
  BoardEditTool,
  BoardListTool,
  UNTRUSTED_AUTHOR_META,
} from '../toolkit/builtin/teamTools'

afterEach(() => setTeamRegistry(null))

const PARENT = {
  type: 'assistant',
  uuid: 'a-1',
  message: { role: 'assistant', content: [] },
} as never
const ALLOW = async () => ({ behavior: 'allow' as const })

function memFs(files = new Map<string, string>()): RuntimeFs {
  return {
    ...unconfiguredFs,
    async mkdir() {},
    async readFile(p: string): Promise<string> {
      const v = files.get(p)
      if (v === undefined) throw new Error(`ENOENT ${p}`)
      return v
    },
    async writeFile(p: string, d: string): Promise<void> {
      files.set(p, d)
    },
  } as RuntimeFs
}

function ctx(sessionId = 'lead-sess') {
  return createNoopToolUseContext({
    tools: [],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
    sessionId,
  })
}

async function armRegistry() {
  let n = 1000
  const reg = await TeamRegistry.load(memFs(), '/rt', () => ++n)
  setTeamRegistry(reg)
  return reg
}

describe('a failed team-tool call is flagged as a failure', () => {
  it('sets isError on real failures — and NOT on deliberate refusals', async () => {
    // A bare `{ data: 'Failed to …' }` renders exactly like a success: the
    // row is not marked and nothing nudges the model to correct.
    // Once a teammate's TaskUpdate failed twice with `Runtime scope was
    // disposed.`, and it went on to report the work complete over a row still
    // reading `in_progress`.
    setTeamRegistry(null)
    const down = await BoardAddTool.call(
      { subject: 's', description: 'd' },
      ctx(),
      ALLOW,
      PARENT,
    )
    expect(down.isError).toBe(true)

    const reg = await armRegistry()
    await reg.createTeam({ name: 'lead-sess', headSessionId: 'lead-sess' })
    const missingTeam = await BoardListTool.call({ team: 'ghost' }, ctx(), ALLOW, PARENT)
    expect(missingTeam.isError).toBe(true)
    const missingTask = await BoardEditTool.call(
      { team: 'lead-sess', task_id: '99', status: 'completed' },
      ctx(),
      ALLOW,
      PARENT,
    )
    expect(missingTask.isError).toBe(true)

    // A refusal is a correct, final answer to a question the caller was
    // allowed to ask. Flagging it would invite the retry it exists to stop.
    await reg.createTask('lead-sess', { subject: 'theirs', description: 'd', owner: 'worker-b' })
    const untrusted = ctx('teammate-x')
    Object.assign(untrusted.options, {
      teamName: 'lead-sess',
      teammateName: 'worker-a',
      templateType: 'safe_code',
    })
    const refused = await BoardEditTool.call(
      { task_id: '1', status: 'completed' },
      untrusted,
      ALLOW,
      PARENT,
    )
    expect(refused.data).toMatch(/^Refused:/)
    expect(refused.isError).toBeUndefined()

    // Neither is a success.
    const ok = await BoardListTool.call({ team: 'lead-sess' }, ctx(), ALLOW, PARENT)
    expect(ok.isError).toBeUndefined()
  })
})

describe('task ownership survives a replay', () => {
  it('unclaiming a task persists — an undefined owner is dropped by JSON', async () => {
    // The task log is JSONL and `JSON.stringify({ owner: undefined })` emits
    // no key at all, so the merge on replay left the OLD owner in place: the
    // unclaim held in memory and was gone after a restart. An empty string
    // is written instead, and every reader treats it as unclaimed (falsy).
    const files = new Map<string, string>()
    let n = 1000
    const reg = await TeamRegistry.load(memFs(files), '/rt', () => ++n)
    setTeamRegistry(reg)
    await reg.createTeam({ name: 'lead-sess', headSessionId: 'lead-sess' })
    await reg.createTask('lead-sess', {
      subject: 's',
      description: 'd',
      owner: 'worker-a',
    })
    const cleared = await BoardEditTool.call(
      { team: 'lead-sess', task_id: '1', owner: '' },
      ctx(),
      ALLOW,
      PARENT,
    )
    expect(cleared.data).not.toContain('@worker-a')
    expect(reg.getTask('lead-sess', '1')?.owner).toBeFalsy()

    // The whole point: a fresh registry replaying the same log agrees.
    const replayed = await TeamRegistry.load(memFs(files), '/rt', () => ++n)
    expect(replayed.getTask('lead-sess', '1')?.owner).toBeFalsy()
  })
})

describe('team tools', () => {
  it('return a graceful "not initialized" message when the registry is absent', async () => {
    setTeamRegistry(null)
    const r = await TeamOpenTool.call({ name: 'X' }, ctx(), ALLOW, PARENT)
    expect(r.data).toMatch(/not initialized/i)
  })

  it('validateInput rejects missing required fields', async () => {
    expect((await TeamOpenTool.checkInput?.({}, ctx()))?.result).toBe(false)
    expect((await BoardAddTool.checkInput?.({ team: 't' }, ctx()))?.result).toBe(false)
    expect((await BoardEditTool.checkInput?.({ team: 't' }, ctx()))?.result).toBe(false)
    expect(
      (await BoardEditTool.checkInput?.(
        { team: 't', task_id: '1', status: 'bogus' as never },
        ctx(),
      ))?.result,
    ).toBe(false)
  })

  it('round-trips: create team → add task → list → update → delete', async () => {
    const reg = await armRegistry()

    const created = await TeamOpenTool.call(
      { name: 'Auth Refactor', description: 'split the module' },
      ctx(),
      ALLOW,
      PARENT,
    )
    expect(created.data).toContain('auth-refactor')
    // Lead session id is captured from the tool context.
    expect(reg.getTeam('auth-refactor')!.headSessionId).toBe('lead-sess')

    // Team arg resolves by display name too (not just id).
    const t = await BoardAddTool.call(
      { team: 'Auth Refactor', subject: 'extract validators', description: 'move to utils' },
      ctx(),
      ALLOW,
      PARENT,
    )
    expect(t.data).toContain('#1')

    const listed = await BoardListTool.call({ team: 'auth-refactor' }, ctx(), ALLOW, PARENT)
    expect(listed.data).toContain('#1')
    expect(listed.data).toContain('[pending]')
    expect(listed.data).toContain('extract validators')

    const updated = await BoardEditTool.call(
      { team: 'auth-refactor', task_id: '1', status: 'completed', owner: 'impl' },
      ctx(),
      ALLOW,
      PARENT,
    )
    expect(updated.data).toContain('[completed]')
    expect(updated.data).toContain('@impl')

    const deleted = await TeamCloseTool.call({ team: 'auth-refactor' }, ctx(), ALLOW, PARENT)
    expect(deleted.data).toMatch(/deleted/i)
    expect(reg.getTeam('auth-refactor')).toBeUndefined()
  })

  it('unknown team / task surface clear errors', async () => {
    await armRegistry()
    const noTeam = await BoardAddTool.call(
      { team: 'ghost', subject: 's', description: 'd' },
      ctx(),
      ALLOW,
      PARENT,
    )
    expect(noTeam.data).toMatch(/no team found/i)

    await TeamOpenTool.call({ name: 'real' }, ctx(), ALLOW, PARENT)
    const noTask = await BoardEditTool.call(
      { team: 'real', task_id: '99', status: 'completed' },
      ctx(),
      ALLOW,
      PARENT,
    )
    expect(noTask.data).toMatch(/not found/i)
  })

  it('duplicate team id is rejected with a friendly message', async () => {
    await armRegistry()
    await TeamOpenTool.call({ name: 'Dup' }, ctx(), ALLOW, PARENT)
    const again = await TeamOpenTool.call({ name: 'dup' }, ctx(), ALLOW, PARENT)
    expect(again.data).toMatch(/already exists/i)
  })
})

// ── Team inferred from context ─────────────────────────────────
//
// The task tools read the task list off the session's team context; the
// model never passes one. The lead's team is IMPLICIT here (its session id,
// created on first use — the same rule the spawn applies), so a lead that
// never called TeamCreate, or spawned and was not told the id, still reaches
// its own list. A teammate's own team is stamped on its runtime options.

describe('task tools — team inferred from context', () => {
  function teammateCtx(
    teamName: string,
    teammateName = 'worker-a',
    templateType = 'code',
  ) {
    const base = ctx('teammate-x')
    Object.assign(base.options, { teamName, teammateName, templateType })
    return base
  }

  /** A LEAD: only a team session gets an implicit list minted for it. */
  function leadCtx(sessionId = 'lead-sess') {
    const base = ctx(sessionId)
    Object.assign(base.options, { templateType: 'team' })
    return base
  }

  it('a lead with no team yet: TaskCreate creates the implicit team and adds to it', async () => {
    const reg = await armRegistry()
    const r = await BoardAddTool.call(
      { subject: 'extract validators', description: 'move to utils' },
      leadCtx(),
      ALLOW,
      PARENT,
    )
    expect(r.data).toContain('#1')
    expect(r.data).toContain('team "lead-sess"')
    expect(reg.getTeam('lead-sess')?.headSessionId).toBe('lead-sess')

    // …and TaskList / TaskUpdate find it the same way, no `team` passed.
    const listed = await BoardListTool.call({}, leadCtx(), ALLOW, PARENT)
    expect(listed.data).toContain('extract validators')
    const updated = await BoardEditTool.call(
      { task_id: '1', status: 'in_progress', owner: 'worker-a' },
      leadCtx(),
      ALLOW,
      PARENT,
    )
    expect(updated.data).toContain('[in_progress]')
  })

  it('TaskList on a lead with nothing yet reports an empty list, not a missing team', async () => {
    await armRegistry()
    const r = await BoardListTool.call({}, leadCtx(), ALLOW, PARENT)
    expect(r.data).toMatch(/Team "lead-sess" has no tasks/)
  })

  it('a teammate works on its OWN team, no `team` passed', async () => {
    const reg = await armRegistry()
    await reg.createTeam({ name: 'lead-sess', headSessionId: 'lead-sess' })
    await reg.createTask('lead-sess', { subject: 'write tests', description: 'd' })
    const listed = await BoardListTool.call({}, teammateCtx('lead-sess'), ALLOW, PARENT)
    expect(listed.data).toContain('write tests')
    const claimed = await BoardEditTool.call(
      { task_id: '1', owner: 'worker-a', status: 'in_progress' },
      teammateCtx('lead-sess'),
      ALLOW,
      PARENT,
    )
    expect(claimed.data).toContain('@worker-a')
    // A teammate's `team` never falls through to an implicit one of its own.
    expect(reg.getTeam('teammate-x')).toBeUndefined()
  })

  it('an explicit `team` still wins, by id or by name, and an unknown one is an error', async () => {
    await armRegistry()
    await TeamOpenTool.call({ name: 'Auth Refactor' }, leadCtx(), ALLOW, PARENT)
    const byName = await BoardAddTool.call(
      { team: 'Auth Refactor', subject: 's', description: 'd' },
      leadCtx(),
      ALLOW,
      PARENT,
    )
    expect(byName.data).toContain('team "auth-refactor"')
    const unknown = await BoardListTool.call({ team: 'ghost' }, leadCtx(), ALLOW, PARENT)
    expect(unknown.data).toMatch(/no team found/i)
    // A blank `team` (the OpenAI habit) reads as omitted.
    const blank = await BoardListTool.call({ team: '  ' }, leadCtx(), ALLOW, PARENT)
    expect(blank.data).toMatch(/Team "lead-sess"/)
  })

  it('a teammate resolves its team from its PARENT when `teamName` did not survive the hop', async () => {
    // Caught: the field is stamped on the init payload but was
    // absent in the tool context, so the teammate fell through to the
    // implicit branch and read a different, empty list. A teammate is bound
    // to its lead's implicit team by construction, so the parent id derives
    // the same answer.
    const reg = await armRegistry()
    await reg.createTeam({ name: 'lead-sess', headSessionId: 'lead-sess' })
    await reg.createTask('lead-sess', { subject: 'shared work', description: 'd' })
    const base = ctx('teammate-lead-sess-worker-a-1')
    Object.assign(base.options, {
      teammateName: 'worker-a',
      spawnerSessionId: 'lead-sess',
      templateType: 'safe_code',
    })
    const listed = await BoardListTool.call({}, base, ALLOW, PARENT)
    expect(listed.data).toContain('shared work')
    // …and it did NOT mint a list of its own.
    expect(reg.getTeam('teammate-lead-sess-worker-a-1')).toBeUndefined()
  })

  it('a NON-team session gets no implicit list minted for it', async () => {
    // These tools are reachable from any type that activates the agent-teams
    // skill. Minting a team per session would leave a permanent registry
    // record behind every `code` session that ever touched a task list, and
    // nothing deletes it. Such a session keeps the older contract instead.
    const reg = await armRegistry()
    const codeCtx = ctx('code-sess')
    Object.assign(codeCtx.options, { templateType: 'code' })
    const r = await BoardAddTool.call(
      { subject: 's', description: 'd' },
      codeCtx,
      ALLOW,
      PARENT,
    )
    expect(r.data).toMatch(/not a team session/i)
    expect(r.data).toContain('TeamCreate')
    expect(reg.getTeam('code-sess')).toBeUndefined()

    // Naming an existing team still works from anywhere.
    await TeamOpenTool.call({ name: 'shared' }, codeCtx, ALLOW, PARENT)
    const named = await BoardAddTool.call(
      { team: 'shared', subject: 's', description: 'd' },
      codeCtx,
      ALLOW,
      PARENT,
    )
    expect(named.data).toContain('#1')
  })

  it('an UNTRUSTED teammate may claim an unowned task and update its own — nothing else', async () => {
    // The list is state the lead reads and acts on. Unconfined, a safe_code
    // child could complete the whole backlog or reassign it, and the lead
    // would report success on work nobody did.
    const reg = await armRegistry()
    await reg.createTeam({ name: 'lead-sess', headSessionId: 'lead-sess' })
    await reg.createTask('lead-sess', { subject: 'mine', description: 'd' })
    await reg.createTask('lead-sess', { subject: 'theirs', description: 'd', owner: 'worker-b' })
    const untrusted = teammateCtx('lead-sess', 'worker-a', 'safe_code')

    // Claim an unowned task: allowed.
    const claim = await BoardEditTool.call(
      { task_id: '1', owner: 'worker-a', status: 'in_progress' },
      untrusted,
      ALLOW,
      PARENT,
    )
    expect(claim.data).toContain('@worker-a')
    // Complete the one it owns: allowed.
    const done = await BoardEditTool.call(
      { task_id: '1', status: 'completed' },
      untrusted,
      ALLOW,
      PARENT,
    )
    expect(done.data).toContain('[completed]')

    // Someone else's task: refused, unchanged.
    const steal = await BoardEditTool.call(
      { task_id: '2', status: 'completed' },
      untrusted,
      ALLOW,
      PARENT,
    )
    expect(steal.data).toMatch(/^Refused:/)
    expect(reg.getTask('lead-sess', '2')?.status).toBe('pending')
    // Assigning to a third party: refused.
    const assign = await BoardEditTool.call(
      { task_id: '1', owner: 'worker-c' },
      untrusted,
      ALLOW,
      PARENT,
    )
    expect(assign.data).toMatch(/^Refused:/)

    // A TRUSTED teammate (code) is not restricted — same calls, no refusal.
    const trusted = teammateCtx('lead-sess', 'worker-a')
    const ok = await BoardEditTool.call(
      { task_id: '2', status: 'completed' },
      trusted,
      ALLOW,
      PARENT,
    )
    expect(ok.data).not.toMatch(/^Refused:/)
  })

  it('an UNTRUSTED teammate cannot complete or rewrite an UNOWNED task without claiming it', async () => {
    const reg = await armRegistry()
    await reg.createTeam({ name: 'lead-sess', headSessionId: 'lead-sess' })
    await reg.createTask('lead-sess', { subject: 'backlog', description: 'd' })
    const untrusted = teammateCtx('lead-sess', 'worker-a', 'safe_code')

    const complete = await BoardEditTool.call(
      { task_id: '1', status: 'completed' },
      untrusted,
      ALLOW,
      PARENT,
    )
    expect(complete.data).toMatch(/^Refused:/)
    const rewrite = await BoardEditTool.call(
      { task_id: '1', description: 'nothing to do' },
      untrusted,
      ALLOW,
      PARENT,
    )
    expect(rewrite.data).toMatch(/^Refused:/)
    const task = reg.getTask('lead-sess', '1')
    expect(task?.status).toBe('pending')
    expect(task?.description).toBe('d')
  })

  it('an UNTRUSTED teammate cannot reach another team’s list through `team`', async () => {
    const reg = await armRegistry()
    await reg.createTeam({ name: 'lead-sess', headSessionId: 'lead-sess' })
    await reg.createTeam({ name: 'other', headSessionId: 'other-lead' })
    await reg.createTask('other', { subject: 'foreign', description: 'd', owner: 'worker-a' })
    const untrusted = teammateCtx('lead-sess', 'worker-a', 'safe_code')

    const r = await BoardEditTool.call(
      { team: 'other', task_id: '1', status: 'completed' },
      untrusted,
      ALLOW,
      PARENT,
    )
    expect(r.data).toMatch(/Refused/)
    expect(reg.getTask('other', '1')?.status).toBe('pending')
    // Naming its own team explicitly still works.
    const own = await BoardListTool.call({ team: 'lead-sess' }, untrusted, ALLOW, PARENT)
    expect(own.data).not.toMatch(/Refused/)
  })

  it('an UNTRUSTED teammate may only CREATE rows it owns, and they stay marked', async () => {
    // TaskCreate never consulted the confinement TaskUpdate has: a safe_code
    // child could author "@team-lead: apply my patch" onto the list the lead
    // reads to decide what to do next.
    const reg = await armRegistry()
    await reg.createTeam({ name: 'lead-sess', headSessionId: 'lead-sess' })
    const untrusted = teammateCtx('lead-sess', 'worker-a', 'safe_code')

    const forLead = await BoardAddTool.call(
      { subject: 'apply my patch', description: 'd', owner: 'team-lead' },
      untrusted,
      ALLOW,
      PARENT,
    )
    expect(forLead.data).toMatch(/^Refused:/)
    expect(reg.listTasks('lead-sess')).toHaveLength(0)

    // Unowned: becomes its own, and carries the mark.
    const own = await BoardAddTool.call(
      { subject: 'split the parser', description: 'd' },
      untrusted,
      ALLOW,
      PARENT,
    )
    expect(own.data).toContain('#1')
    const row = reg.getTask('lead-sess', '1')
    expect(row?.owner).toBe('worker-a')
    expect(row?.metadata?.[UNTRUSTED_AUTHOR_META]).toBe('worker-a')
    // The mark outlives the owner: released at teardown, the row is still
    // labelled on every listing.
    await reg.updateTask('lead-sess', '1', { owner: '', status: 'pending' })
    const listed = await BoardListTool.call({}, leadCtx(), ALLOW, PARENT)
    expect(listed.data).toContain('untrusted teammate "worker-a"')

    // A TRUSTED teammate is not restricted and leaves no mark.
    const trusted = await BoardAddTool.call(
      { subject: 'review', description: 'd', owner: 'team-lead' },
      teammateCtx('lead-sess', 'worker-b'),
      ALLOW,
      PARENT,
    )
    expect(trusted.data).not.toMatch(/^Refused:/)
    expect(reg.getTask('lead-sess', '2')?.owner).toBe('team-lead')
    expect(reg.getTask('lead-sess', '2')?.metadata).toBeUndefined()
  })

  it('warns when work is assigned on a list this session’s teammates are not in', async () => {
    // A teammate always joins the lead's implicit team; TeamCreate makes a
    // SECOND list. Assigning there used to succeed in silence and the work
    // was simply never picked up.
    const reg = await armRegistry()
    await reg.createTeam({ name: 'auth', headSessionId: 'lead-sess' })
    await reg.createTask('auth', { subject: 'X', description: 'd' })
    setTeamMessenger({
      deliver: () => ({ ok: true }),
      shutdownMember: () => ({ ok: true }),
      listMembers: lead =>
        lead === 'lead-sess'
          ? [{ sessionId: 'teammate-1', name: 'worker-a', status: 'idle' as const, startedAt: 1 }]
          : [],
    })
    const r = await BoardEditTool.call(
      { team: 'auth', task_id: '1', owner: 'worker-a' },
      leadCtx(),
      ALLOW,
      PARENT,
    )
    expect(r.data).toContain('WARNING')
    expect(r.data).toContain('"worker-a"')
    expect(r.data).toContain('team "auth"')

    // No warning on the session's OWN list.
    await reg.createTeam({ name: 'lead-sess', headSessionId: 'lead-sess' })
    await reg.createTask('lead-sess', { subject: 'Y', description: 'd' })
    const own = await BoardEditTool.call(
      { task_id: '1', owner: 'worker-a' },
      leadCtx(),
      ALLOW,
      PARENT,
    )
    expect(own.data).not.toContain('WARNING')
  })

  it('the schemas no longer require `team`', () => {
    for (const tool of [BoardAddTool, BoardEditTool, BoardListTool]) {
      expect(tool.argsSchema?.required ?? []).not.toContain('team')
    }
  })
})

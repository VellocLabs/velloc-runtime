import { afterEach, describe, expect, it } from 'vitest'
import { unconfiguredFs, type RuntimeFs } from '../utils/fs/runtimeFs'
import {
  TeamRegistry,
  TeamNameTakenError,
  TeamNotFoundError,
  TaskNotFoundError,
  getTeamRegistry,
  sanitizeTeamId,
  setTeamRegistry,
} from '../team/TeamRegistry'

afterEach(() => setTeamRegistry(null))

// In-memory FS backed by a Map — the registry only uses mkdir/readFile/
// writeFile. A shared `files` Map lets a second `TeamRegistry.load` replay
// the same on-disk state a first instance wrote (the crash-safety invariant).
function makeFs(files = new Map<string, string>()): {
  fs: RuntimeFs
  files: Map<string, string>
} {
  const fs = {
    ...unconfiguredFs,
    async mkdir() {
      /* no-op: dirs are implicit in the flat Map */
    },
    async readFile(path: string): Promise<string> {
      const v = files.get(path)
      if (v === undefined) throw new Error(`ENOENT: ${path}`)
      return v
    },
    async writeFile(path: string, data: string): Promise<void> {
      files.set(path, data)
    },
  } as RuntimeFs
  return { fs, files }
}

// Deterministic, monotonic injected clock.
function makeClock(start = 1_000): () => number {
  let t = start
  return () => ++t
}

const BASE = '/runtime'

async function freshRegistry(files?: Map<string, string>) {
  const { fs, files: f } = makeFs(files)
  const reg = await TeamRegistry.load(fs, BASE, makeClock())
  return { reg, files: f }
}

describe('sanitizeTeamId', () => {
  it('lowercases, replaces non-alnum runs with single dashes, trims edges', () => {
    expect(sanitizeTeamId('My Project!')).toBe('my-project')
    expect(sanitizeTeamId('  Refactor / Auth  ')).toBe('refactor-auth')
    expect(sanitizeTeamId('a__b')).toBe('a-b')
  })
  it('is empty for all-symbol names', () => {
    expect(sanitizeTeamId('!!!')).toBe('')
  })
})

describe('TeamRegistry — teams', () => {
  it('creates a team with a sanitized id + a lead member', async () => {
    const { reg } = await freshRegistry()
    const team = await reg.createTeam({
      name: 'My Project',
      description: 'feature X',
      headSessionId: 'sess-1',
      leadName: 'lead',
    })
    expect(team.id).toBe('my-project')
    expect(team.name).toBe('My Project')
    expect(team.headSessionId).toBe('sess-1')
    expect(team.members).toHaveLength(1)
    expect(team.members[0]).toMatchObject({ name: 'lead', isLead: true, status: 'active' })
    expect(reg.getTeam('my-project')).toBeDefined()
    expect(reg.listTeams()).toHaveLength(1)
  })

  it('rejects a duplicate team id', async () => {
    const { reg } = await freshRegistry()
    await reg.createTeam({ name: 'Dup' })
    await expect(reg.createTeam({ name: 'dup' })).rejects.toBeInstanceOf(
      TeamNameTakenError,
    )
  })

  it('rejects an all-symbol name', async () => {
    const { reg } = await freshRegistry()
    await expect(reg.createTeam({ name: '!!!' })).rejects.toThrow()
  })

  it('addMember appends + replaces by name', async () => {
    const { reg } = await freshRegistry()
    await reg.createTeam({ name: 'T' })
    await reg.addMember('t', { name: 'researcher', status: 'active', joinedAt: 0 })
    expect(reg.getTeam('t')!.members.map(m => m.name)).toEqual([
      'team-lead',
      'researcher',
    ])
    // Replace-by-name (e.g. status flip), not duplicate.
    await reg.addMember('t', { name: 'researcher', status: 'idle', joinedAt: 0 })
    const members = reg.getTeam('t')!.members.filter(m => m.name === 'researcher')
    expect(members).toHaveLength(1)
    expect(members[0]!.status).toBe('idle')
  })

  it('deleteTeam tombstones the team', async () => {
    const { reg } = await freshRegistry()
    await reg.createTeam({ name: 'Gone' })
    await reg.deleteTeam('gone')
    expect(reg.getTeam('gone')).toBeUndefined()
    await expect(reg.deleteTeam('gone')).rejects.toBeInstanceOf(TeamNotFoundError)
  })
})

describe('TeamRegistry — tasks', () => {
  it('creates tasks with sequential ids, sorted listing', async () => {
    const { reg } = await freshRegistry()
    await reg.createTeam({ name: 'T' })
    const a = await reg.createTask('t', { subject: 'A', description: 'do a' })
    const b = await reg.createTask('t', { subject: 'B', description: 'do b' })
    expect([a.id, b.id]).toEqual(['1', '2'])
    expect(a.status).toBe('pending')
    expect(reg.listTasks('t').map(x => x.id)).toEqual(['1', '2'])
  })

  it('carries owner + blocks/blockedBy + metadata', async () => {
    const { reg } = await freshRegistry()
    await reg.createTeam({ name: 'T' })
    const t = await reg.createTask('t', {
      subject: 'X',
      description: 'd',
      owner: 'researcher',
      blockedBy: ['0'],
      metadata: { pr: 42 },
    })
    expect(t.owner).toBe('researcher')
    expect(t.blockedBy).toEqual(['0'])
    expect(t.metadata).toEqual({ pr: 42 })
  })

  it('updateTask assigns owner / flips status and bumps updatedAt', async () => {
    const { reg } = await freshRegistry()
    await reg.createTeam({ name: 'T' })
    const t = await reg.createTask('t', { subject: 'X', description: 'd' })
    const before = t.updatedAt
    const updated = await reg.updateTask('t', t.id, {
      owner: 'impl',
      status: 'in_progress',
    })
    expect(updated.owner).toBe('impl')
    expect(updated.status).toBe('in_progress')
    expect(updated.updatedAt).toBeGreaterThan(before)
    expect(updated.id).toBe(t.id)
    expect(updated.createdAt).toBe(t.createdAt)
  })

  it('listTasks filters by status + owner', async () => {
    const { reg } = await freshRegistry()
    await reg.createTeam({ name: 'T' })
    await reg.createTask('t', { subject: 'A', description: 'd', owner: 'x' })
    const b = await reg.createTask('t', { subject: 'B', description: 'd', owner: 'y' })
    await reg.updateTask('t', b.id, { status: 'completed' })
    expect(reg.listTasks('t', { owner: 'x' }).map(x => x.id)).toEqual(['1'])
    expect(reg.listTasks('t', { status: 'completed' }).map(x => x.id)).toEqual(['2'])
  })

  it('deleteTask tombstones; getTask returns undefined after', async () => {
    const { reg } = await freshRegistry()
    await reg.createTeam({ name: 'T' })
    const t = await reg.createTask('t', { subject: 'X', description: 'd' })
    await reg.deleteTask('t', t.id)
    expect(reg.getTask('t', t.id)).toBeUndefined()
    await expect(reg.updateTask('t', t.id, { status: 'completed' })).rejects.toBeInstanceOf(
      TaskNotFoundError,
    )
  })

  it('createTask on an unknown team throws', async () => {
    const { reg } = await freshRegistry()
    await expect(reg.createTask('nope', { subject: 'X', description: 'd' })).rejects.toBeInstanceOf(
      TeamNotFoundError,
    )
  })
})

describe('TeamRegistry — persistence replay (crash safety)', () => {
  it('a second load() reconstructs teams + tasks from the same on-disk log', async () => {
    const { reg, files } = await freshRegistry()
    await reg.createTeam({ name: 'Proj', headSessionId: 's1', leadName: 'lead' })
    await reg.addMember('proj', { name: 'researcher', status: 'active', joinedAt: 1 })
    const t1 = await reg.createTask('proj', { subject: 'A', description: 'da' })
    const t2 = await reg.createTask('proj', { subject: 'B', description: 'db' })
    await reg.updateTask('proj', t1.id, { owner: 'researcher', status: 'in_progress' })
    await reg.deleteTask('proj', t2.id)

    // Replay from the SAME files map into a fresh instance.
    const { reg: reloaded } = await freshRegistry(files)
    const team = reloaded.getTeam('proj')
    expect(team).toBeDefined()
    expect(team!.members.map(m => m.name).sort()).toEqual(['lead', 'researcher'])
    const tasks = reloaded.listTasks('proj')
    expect(tasks.map(t => t.id)).toEqual(['1']) // t2 tombstoned
    expect(tasks[0]).toMatchObject({ owner: 'researcher', status: 'in_progress' })
    // New task after reload continues the id sequence (max+1), not reusing '2'.
    const t3 = await reloaded.createTask('proj', { subject: 'C', description: 'dc' })
    expect(t3.id).toBe('2')
  })

  it('survives a deleted team (its tasks are not replayed)', async () => {
    const { reg, files } = await freshRegistry()
    await reg.createTeam({ name: 'Keep' })
    await reg.createTeam({ name: 'Drop' })
    await reg.createTask('drop', { subject: 'X', description: 'd' })
    await reg.deleteTeam('drop')
    const { reg: reloaded } = await freshRegistry(files)
    expect(reloaded.getTeam('keep')).toBeDefined()
    expect(reloaded.getTeam('drop')).toBeUndefined()
    expect(reloaded.listTasks('drop')).toEqual([])
  })
})

describe('TeamRegistry — singleton accessor', () => {
  it('set/get round-trips and resets to null', async () => {
    expect(getTeamRegistry()).toBeNull()
    const { reg } = await freshRegistry()
    setTeamRegistry(reg)
    expect(getTeamRegistry()).toBe(reg)
  })
})

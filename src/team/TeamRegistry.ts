/**
 * Append-only JSONL store for teams and their task lists, under
 * `{basePath}/teams/`: `teams.jsonl` and `{teamId}/tasks.jsonl`. Replay drops
 * tombstoned ids and merges updates. One per SharedWorker via
 * `getTeamRegistry()`.
 */

import type { RuntimeFs } from '../utils/fs/runtimeFs'
import {
  getTeamsDirectoryPath,
  getTeamsLogPath,
  getTeamTasksDirectoryPath,
  getTeamTasksLogPath,
} from './teamPaths'
import type {
  Task,
  TaskListFilter,
  TaskLogEntry,
  Team,
  TeamLogEntry,
  TeamMember,
} from './teamTypes'

export class TeamNameInvalidError extends Error {
  constructor(name: string) {
    super(
      `Invalid team name: ${JSON.stringify(name)}. Use letters/digits/spaces; it must contain at least one [a-z0-9] character.`,
    )
    this.name = 'TeamNameInvalidError'
  }
}

export class TeamNameTakenError extends Error {
  constructor(id: string) {
    super(`Team already exists: ${JSON.stringify(id)}.`)
    this.name = 'TeamNameTakenError'
  }
}

export class TeamNotFoundError extends Error {
  constructor(idOrName: string) {
    super(`Team not found: ${JSON.stringify(idOrName)}.`)
    this.name = 'TeamNotFoundError'
  }
}

export class TaskNotFoundError extends Error {
  constructor(teamId: string, taskId: string) {
    super(`Task ${JSON.stringify(taskId)} not found in team ${JSON.stringify(teamId)}.`)
    this.name = 'TaskNotFoundError'
  }
}

/** Sanitize a display name into a stable team id (also the task-list key). */
export function sanitizeTeamId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export type CreateTeamInput = {
  name: string
  description?: string
  headSessionId?: string
  /** Lead member's display name; defaults to "team-lead". */
  leadName?: string
}

export type CreateTaskInput = {
  subject: string
  description: string
  activeForm?: string
  owner?: string
  blocks?: string[]
  blockedBy?: string[]
  metadata?: Record<string, unknown>
}

export class TeamRegistry {
  private constructor(
    // Resolved lazily per-operation, NOT captured once: the browser-backed
    // fs is installed by `createBrowserRuntime` (per-session init), which
    // can run AFTER `bootTeamRuntimeOnce` captures `processFs()`
    // at `ensureStorage` time. Resolving per-write guarantees the registry
    // uses the configured fs by the time a Team/Task tool actually runs.
    private readonly fsProvider: () => RuntimeFs,
    private readonly basePath: string,
    private readonly teams: Map<string, Team>,
    private readonly tasksByTeam: Map<string, Map<string, Task>>,
    private readonly now: () => number,
  ) {}

  /**
   * Load and replay the logs, creating the teams dir. Missing logs or an
   * unconfigured fs give an empty registry. Accepts a `RuntimeFs` or a lazy
   * provider.
   */
  static async load(
    fsOrProvider: RuntimeFs | (() => RuntimeFs),
    basePath: string,
    now: () => number = () => Date.now(),
  ): Promise<TeamRegistry> {
    const fsProvider =
      typeof fsOrProvider === 'function' ? fsOrProvider : () => fsOrProvider
    const fs = fsProvider()
    const dir = getTeamsDirectoryPath(basePath)
    try {
      await fs.mkdir(dir)
    } catch {
      // Directory likely already exists OR fs not yet configured; ignore.
    }

    const teams = new Map<string, Team>()
    const tasksByTeam = new Map<string, Map<string, Task>>()

    // Replay the team log.
    const teamsRaw = await readFileOrEmpty(fs, getTeamsLogPath(basePath))
    for (const entry of parseJsonl<TeamLogEntry>(teamsRaw)) {
      applyTeamEntry(teams, entry)
    }

    // Replay each surviving team's task log.
    for (const teamId of teams.keys()) {
      const tasks = new Map<string, Task>()
      const tasksRaw = await readFileOrEmpty(
        fs,
        getTeamTasksLogPath(basePath, teamId),
      )
      for (const entry of parseJsonl<TaskLogEntry>(tasksRaw)) {
        applyTaskEntry(tasks, entry)
      }
      tasksByTeam.set(teamId, tasks)
    }

    return new TeamRegistry(fsProvider, basePath, teams, tasksByTeam, now)
  }

  // ----- Team ops ---------------------------------------------------------

  listTeams(): Team[] {
    return [...this.teams.values()]
  }

  getTeam(id: string): Team | undefined {
    return this.teams.get(id)
  }

  async createTeam(input: CreateTeamInput): Promise<Team> {
    const id = sanitizeTeamId(input.name)
    if (!id) {
      throw new TeamNameInvalidError(input.name)
    }
    if (this.teams.has(id)) {
      throw new TeamNameTakenError(id)
    }
    const lead: TeamMember = {
      name: input.leadName ?? 'team-lead',
      sessionId: input.headSessionId,
      status: 'active',
      isLead: true,
      joinedAt: this.now(),
    }
    const team: Team = {
      id,
      name: input.name,
      description: input.description,
      createdAt: this.now(),
      headSessionId: input.headSessionId,
      members: [lead],
    }
    const entry: TeamLogEntry = { type: 'team', team }
    await this.appendTeamLog(entry)
    applyTeamEntry(this.teams, entry)
    this.tasksByTeam.set(id, new Map())
    return team
  }

  async updateTeam(id: string, patch: Partial<Team>): Promise<void> {
    if (!this.teams.has(id)) throw new TeamNotFoundError(id)
    if ('id' in patch && patch.id !== id) {
      throw new Error('TeamRegistry.updateTeam cannot change a team id.')
    }
    const entry: TeamLogEntry = { type: 'team_update', id, patch }
    await this.appendTeamLog(entry)
    applyTeamEntry(this.teams, entry)
  }

  /** Add (or replace by name) a member on a team. */
  async addMember(teamId: string, member: TeamMember): Promise<void> {
    const team = this.teams.get(teamId)
    if (!team) throw new TeamNotFoundError(teamId)
    const members = [
      ...team.members.filter(m => m.name !== member.name),
      member,
    ]
    await this.updateTeam(teamId, { members })
  }

  async deleteTeam(id: string): Promise<void> {
    if (!this.teams.has(id)) throw new TeamNotFoundError(id)
    const entry: TeamLogEntry = {
      type: 'team_tombstone',
      id,
      deletedAt: this.now(),
    }
    await this.appendTeamLog(entry)
    applyTeamEntry(this.teams, entry)
    this.tasksByTeam.delete(id)
  }

  // ----- Task ops ---------------------------------------------------------

  listTasks(teamId: string, filter?: TaskListFilter): Task[] {
    const tasks = this.tasksByTeam.get(teamId)
    if (!tasks) return []
    const out: Task[] = []
    for (const task of tasks.values()) {
      if (filter?.status && task.status !== filter.status) continue
      if (filter?.owner && task.owner !== filter.owner) continue
      out.push(task)
    }
    // Stable, sortable order by numeric id.
    return out.sort((a, b) => Number(a.id) - Number(b.id))
  }

  getTask(teamId: string, taskId: string): Task | undefined {
    return this.tasksByTeam.get(teamId)?.get(taskId)
  }

  async createTask(teamId: string, input: CreateTaskInput): Promise<Task> {
    if (!this.teams.has(teamId)) throw new TeamNotFoundError(teamId)
    const tasks = this.tasksByTeam.get(teamId) ?? new Map<string, Task>()
    this.tasksByTeam.set(teamId, tasks)

    // Sequential numeric id = max existing + 1 (never reuses ids within
    // the in-memory set; survives across the replayed log).
    let maxId = 0
    for (const id of tasks.keys()) {
      const n = Number(id)
      if (Number.isFinite(n) && n > maxId) maxId = n
    }
    const ts = this.now()
    const task: Task = {
      id: String(maxId + 1),
      subject: input.subject,
      description: input.description,
      activeForm: input.activeForm,
      owner: input.owner,
      status: 'pending',
      blocks: input.blocks ?? [],
      blockedBy: input.blockedBy ?? [],
      metadata: input.metadata,
      createdAt: ts,
      updatedAt: ts,
    }
    const entry: TaskLogEntry = { type: 'task', task }
    await this.appendTaskLog(teamId, entry)
    applyTaskEntry(tasks, entry)
    return task
  }

  async updateTask(
    teamId: string,
    taskId: string,
    patch: Partial<Omit<Task, 'id' | 'createdAt'>>,
  ): Promise<Task> {
    const tasks = this.tasksByTeam.get(teamId)
    if (!tasks || !tasks.has(taskId)) {
      throw new TaskNotFoundError(teamId, taskId)
    }
    const fullPatch: Partial<Task> = { ...patch, updatedAt: this.now() }
    const entry: TaskLogEntry = { type: 'task_update', id: taskId, patch: fullPatch }
    await this.appendTaskLog(teamId, entry)
    applyTaskEntry(tasks, entry)
    return tasks.get(taskId)!
  }

  async deleteTask(teamId: string, taskId: string): Promise<void> {
    const tasks = this.tasksByTeam.get(teamId)
    if (!tasks || !tasks.has(taskId)) {
      throw new TaskNotFoundError(teamId, taskId)
    }
    const entry: TaskLogEntry = {
      type: 'task_tombstone',
      id: taskId,
      deletedAt: this.now(),
    }
    await this.appendTaskLog(teamId, entry)
    applyTaskEntry(tasks, entry)
  }

  // ----- Persistence ------------------------------------------------------

  private async appendTeamLog(entry: TeamLogEntry): Promise<void> {
    const fs = this.fsProvider()
    // Ensure the teams dir exists at WRITE time (configured fs) — the
    // load-time mkdir may have run against an unconfigured fs and been
    // swallowed, leaving the dir absent for the bridge writeFile.
    await ensureDir(fs, getTeamsDirectoryPath(this.basePath))
    await appendLine(fs, getTeamsLogPath(this.basePath), entry)
  }

  private async appendTaskLog(
    teamId: string,
    entry: TaskLogEntry,
  ): Promise<void> {
    const fs = this.fsProvider()
    // Create the dir chain (parent teams/ then the per-team dir) in case
    // the browser fs mkdir isn't recursive; both are idempotent.
    await ensureDir(fs, getTeamsDirectoryPath(this.basePath))
    await ensureDir(fs, getTeamTasksDirectoryPath(this.basePath, teamId))
    await appendLine(fs, getTeamTasksLogPath(this.basePath, teamId), entry)
  }
}

// ---------------------------------------------------------------------------
// Replay helpers.
// ---------------------------------------------------------------------------

function applyTeamEntry(state: Map<string, Team>, entry: TeamLogEntry): void {
  switch (entry.type) {
    case 'team':
      state.set(entry.team.id, entry.team)
      return
    case 'team_tombstone':
      state.delete(entry.id)
      return
    case 'team_update': {
      const existing = state.get(entry.id)
      if (!existing) return
      state.set(entry.id, { ...existing, ...entry.patch, id: existing.id })
      return
    }
  }
}

function applyTaskEntry(state: Map<string, Task>, entry: TaskLogEntry): void {
  switch (entry.type) {
    case 'task':
      state.set(entry.task.id, entry.task)
      return
    case 'task_tombstone':
      state.delete(entry.id)
      return
    case 'task_update': {
      const existing = state.get(entry.id)
      if (!existing) return
      state.set(entry.id, { ...existing, ...entry.patch, id: existing.id })
      return
    }
  }
}

/** Idempotently create a directory; swallows "already exists" errors. */
async function ensureDir(fs: RuntimeFs, path: string): Promise<void> {
  try {
    await fs.mkdir(path)
  } catch {
    // Already exists (or fs not yet configured at this call); ignore.
  }
}

async function readFileOrEmpty(
  fs: RuntimeFs,
  path: string,
): Promise<string> {
  try {
    return await fs.readFile(path, { encoding: 'utf-8' })
  } catch {
    return ''
  }
}

function* parseJsonl<T>(raw: string): Generator<T> {
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      yield JSON.parse(trimmed) as T
    } catch {
      // Corrupted line — skip rather than fail the whole load.
    }
  }
}

async function appendLine(
  fs: RuntimeFs,
  path: string,
  entry: unknown,
): Promise<void> {
  const line = `${JSON.stringify(entry)}\n`
  // Read-modify-write (no append API on RuntimeFs), same as
  // RoutineRegistry. Logs are small.
  let prior = ''
  try {
    prior = await fs.readFile(path, { encoding: 'utf-8' })
  } catch {
    // No log yet.
  }
  await fs.writeFile(path, prior + line, { encoding: 'utf-8' })
}

// ---------------------------------------------------------------------------
// Module-level singleton accessor (same pattern as getRoutineRegistry).
// ---------------------------------------------------------------------------

let registrySingleton: TeamRegistry | null = null

export function setTeamRegistry(registry: TeamRegistry | null): void {
  registrySingleton = registry
}

export function getTeamRegistry(): TeamRegistry | null {
  return registrySingleton
}

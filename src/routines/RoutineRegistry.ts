/**
 * Append-only JSONL routine store under `{basePath}/routines/`:
 * `routines.jsonl` (create / update / tombstone events) and
 * `runs/<id>-<ts>.json` run summaries. `load()` folds the log: tombstones drop
 * earlier entries, updates merge on the latest. In-memory id and name index.
 */

import type { RuntimeFs } from '../utils/fs/runtimeFs'
import {
  getRoutinesDirectoryPath,
  getRoutinesLogPath,
} from './routinePaths'
import type {
  Routine,
  RoutineKind,
  RoutineLogEntry,
} from './routineTypes'
import { resolveHostTimeZone } from './routineTimezone'

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

export class RoutineNameInvalidError extends Error {
  constructor(name: string) {
    super(
      `Invalid routine name: ${JSON.stringify(name)}. Use 1-64 lowercase characters [a-z0-9_-], starting with a letter or digit.`,
    )
    this.name = 'RoutineNameInvalidError'
  }
}

export class RoutineNameTakenError extends Error {
  constructor(name: string) {
    super(`Routine name already in use: ${JSON.stringify(name)}.`)
    this.name = 'RoutineNameTakenError'
  }
}

export class RoutineNotFoundError extends Error {
  constructor(idOrName: string) {
    super(`Routine not found: ${JSON.stringify(idOrName)}.`)
    this.name = 'RoutineNotFoundError'
  }
}

export type RoutineListFilter = {
  kind?: RoutineKind
  enabledOnly?: boolean
}

export class RoutineRegistry {
  private constructor(
    private readonly fs: RuntimeFs,
    private readonly basePath: string,
    private readonly state: Map<string, Routine>,
    private readonly byName: Map<string, string>,
    /**
     * Cron routines loaded without a `timezone` (records written before
     * every routine carried one). `load()` stamps the host zone in memory;
     * the stamp is persisted with the routine's next write.
     */
    private readonly unpersistedZones: Set<string> = new Set(),
  ) {}

  /**
   * Load (and replay) the on-disk log. Creates the routines directory
   * if it doesn't exist. Tolerates a missing log file (returns an empty
   * registry).
   */
  static async load(
    fs: RuntimeFs,
    basePath: string,
  ): Promise<RoutineRegistry> {
    const dir = getRoutinesDirectoryPath(basePath)
    try {
      await fs.mkdir(dir)
    } catch {
      // Directory likely already exists; ignore.
    }

    const logPath = getRoutinesLogPath(basePath)
    let raw = ''
    try {
      raw = await fs.readFile(logPath, { encoding: 'utf-8' })
    } catch {
      // No log yet — empty registry.
      return new RoutineRegistry(fs, basePath, new Map(), new Map())
    }

    const state = new Map<string, Routine>()
    const byName = new Map<string, string>()

    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let entry: RoutineLogEntry
      try {
        entry = JSON.parse(trimmed) as RoutineLogEntry
      } catch {
        // Corrupted line — skip rather than fail the whole load.
        continue
      }
      applyEntry(state, byName, entry)
    }

    const unpersistedZones = new Set<string>()
    for (const [id, routine] of state) {
      if (routine.kind === 'cron' && !routine.timezone?.trim()) {
        state.set(id, { ...routine, timezone: resolveHostTimeZone().zone })
        unpersistedZones.add(id)
      }
    }

    return new RoutineRegistry(fs, basePath, state, byName, unpersistedZones)
  }

  /** In-memory snapshot. Cheap — uses the existing Map. */
  list(filter?: RoutineListFilter): Routine[] {
    const out: Routine[] = []
    for (const routine of this.state.values()) {
      if (filter?.kind && routine.kind !== filter.kind) continue
      if (filter?.enabledOnly && !routine.enabled) continue
      out.push(routine)
    }
    return out
  }

  get(id: string): Routine | undefined {
    return this.state.get(id)
  }

  getByName(name: string): Routine | undefined {
    const id = this.byName.get(name)
    return id ? this.state.get(id) : undefined
  }

  /**
   * Resolve an `id` or `name` (the model may pass either). Returns
   * undefined if not found.
   */
  resolve(idOrName: string): Routine | undefined {
    return this.get(idOrName) ?? this.getByName(idOrName)
  }

  /** Create a brand-new routine. Throws if the name is taken or invalid. */
  async create(routine: Routine): Promise<void> {
    if (!NAME_PATTERN.test(routine.name)) {
      throw new RoutineNameInvalidError(routine.name)
    }
    if (this.byName.has(routine.name)) {
      throw new RoutineNameTakenError(routine.name)
    }
    if (this.state.has(routine.id)) {
      // ID collision — shouldn't happen with ulid, but defend.
      throw new Error(`Routine id collision: ${routine.id}`)
    }

    const stamped: Routine =
      routine.kind === 'cron' && !routine.timezone?.trim()
        ? { ...routine, timezone: resolveHostTimeZone().zone }
        : routine
    const entry: RoutineLogEntry = { type: 'routine', routine: stamped }
    await this.appendLogEntry(entry)
    applyEntry(this.state, this.byName, entry)
  }

  /**
   * Patch an existing routine. Used by HeadlessRunner to record
   * `lastRunAt` etc. without re-serializing the entire routine.
   *
   * Does NOT support renaming via patch (would need name-index
   * bookkeeping). To rename, delete + create.
   */
  async update(id: string, patch: Partial<Routine>): Promise<void> {
    const current = this.state.get(id)
    if (!current) {
      throw new RoutineNotFoundError(id)
    }
    if ('name' in patch && patch.name !== current.name) {
      throw new Error(
        'RoutineRegistry.update does not support renaming. Delete and recreate the routine.',
      )
    }
    if ('kind' in patch && patch.kind !== current.kind) {
      throw new Error('RoutineRegistry.update does not support changing kind.')
    }
    const persistZone =
      this.unpersistedZones.has(id) && current.kind === 'cron'
    const fullPatch: Partial<Routine> =
      persistZone && !('timezone' in patch)
        ? ({ ...patch, timezone: current.timezone } as Partial<Routine>)
        : patch
    const entry: RoutineLogEntry = { type: 'update', id, patch: fullPatch }
    await this.appendLogEntry(entry)
    this.unpersistedZones.delete(id)
    applyEntry(this.state, this.byName, entry)
  }

  async delete(id: string): Promise<void> {
    const current = this.state.get(id)
    if (!current) {
      throw new RoutineNotFoundError(id)
    }
    const entry: RoutineLogEntry = {
      type: 'tombstone',
      id,
      deletedAt: Date.now(),
    }
    await this.appendLogEntry(entry)
    applyEntry(this.state, this.byName, entry)
  }

  private async appendLogEntry(entry: RoutineLogEntry): Promise<void> {
    const logPath = getRoutinesLogPath(this.basePath)
    const line = `${JSON.stringify(entry)}\n`
    // Read-modify-write: there's no append API on RuntimeFs today, so
    // we read the existing content and rewrite. JSONL files are small
    // (typically a few hundred bytes per routine), so this is fine.
    let prior = ''
    try {
      prior = await this.fs.readFile(logPath, { encoding: 'utf-8' })
    } catch {
      // No log yet — start fresh.
    }
    await this.fs.writeFile(logPath, prior + line, { encoding: 'utf-8' })
  }
}

function applyEntry(
  state: Map<string, Routine>,
  byName: Map<string, string>,
  entry: RoutineLogEntry,
): void {
  switch (entry.type) {
    case 'routine': {
      state.set(entry.routine.id, entry.routine)
      byName.set(entry.routine.name, entry.routine.id)
      return
    }
    case 'tombstone': {
      const existing = state.get(entry.id)
      if (existing) {
        byName.delete(existing.name)
      }
      state.delete(entry.id)
      return
    }
    case 'update': {
      const existing = state.get(entry.id)
      if (!existing) return
      // Merge — fields not in patch stay as-is. The kind/name guards in
      // `update()` keep the index consistent without recomputation.
      state.set(entry.id, { ...existing, ...entry.patch } as Routine)
      return
    }
  }
}

// Module-level singleton: set by the manager at boot via `setRoutineRegistry`,
// read by tools via `getRoutineRegistry()`; tests reset it with null.

let registrySingleton: RoutineRegistry | null = null

export function setRoutineRegistry(registry: RoutineRegistry | null): void {
  registrySingleton = registry
}

export function getRoutineRegistry(): RoutineRegistry | null {
  return registrySingleton
}

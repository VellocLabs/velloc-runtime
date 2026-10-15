/**
 * Contract: consolidation stamp/lock file in the memory dir, body
 * `{ lastConsolidatedAt, holderId, expiresAt }` (no `utimes`, so not mtime).
 * Holder is the sessionId; a stale lock is reclaimed by `expiresAt`. Acquire
 * keeps the prior time; success stamps now; failure rewinds. Best-effort: a
 * failed write means no run this turn.
 */

import { processFs, type RuntimeFs } from '../../utils/fs/runtimeFs'
import { joinPath } from '../memoryPaths'

const LOCK_FILE = '.consolidate-lock'

/** Stale past this even if the holder is non-empty (crashed-tab guard). */
export const TIDY_LEASE_EXPIRY_MS = 60 * 60 * 1000

export type ConsolidationStamp = {
  /** ms timestamp of the last SUCCESSFUL consolidation. 0 if never. */
  lastConsolidatedAt: number
  /** sessionId of an in-flight holder; `''` when not held. */
  holderId: string
  /** ms wall-clock after which a non-empty holder is considered stale. */
  expiresAt: number
}

/** Deps for the session-count gate. Threaded from the runtime's conversation
 *  storage backend (absent → no enumeration → the gate counts 0 → no-op). */
export type SessionScanDeps = {
  /** Session ids with a persisted transcript under the project dir. */
  listSessions: () => Promise<string[]>
  /** Absolute path of a session's transcript file (for its mtime). */
  transcriptPath: (sessionId: string) => string
}

function lockPath(memoryDir: string): string {
  return joinPath(memoryDir, LOCK_FILE)
}

async function readStamp(
  memoryDir: string,
  fs: RuntimeFs,
): Promise<ConsolidationStamp | null> {
  try {
    const raw = await fs.readFile(lockPath(memoryDir), {
      encoding: 'utf8',
    })
    const parsed = JSON.parse(raw) as Partial<ConsolidationStamp>
    if (
      typeof parsed.lastConsolidatedAt !== 'number' ||
      typeof parsed.holderId !== 'string' ||
      typeof parsed.expiresAt !== 'number'
    ) {
      return null
    }
    return parsed as ConsolidationStamp
  } catch {
    return null
  }
}

async function writeStamp(
  memoryDir: string,
  stamp: ConsolidationStamp,
  fs: RuntimeFs,
): Promise<void> {
  // Best-effort dir create — `RuntimeFs.mkdir` has no `recursive`, and by
  // the time periodic tidy fires the memory dir already exists (memory has been
  // written), so a throw here is harmless and swallowed.
  try {
    await fs.mkdir(memoryDir)
  } catch {
    /* dir exists, or parents missing — the write below will reveal it */
  }
  await fs.writeFile(lockPath(memoryDir), JSON.stringify(stamp))
}

/**
 * The last successful-consolidation timestamp (the time gate's input). 0 if
 * the stamp is absent or unreadable. Per-turn cost: one read.
 */
export async function lastTidyStamp(
  memoryDir: string,
  fs: RuntimeFs = processFs(),
): Promise<number> {
  const stamp = await readStamp(memoryDir, fs)
  return stamp?.lastConsolidatedAt ?? 0
}

/**
 * Acquire the lock for `holderId`: the prior `lastConsolidatedAt` (for
 * rollback), or `null` when held and unexpired or a write race was lost. A
 * crashed holder is reclaimed after `expiresAt`.
 */
export async function claimTidyLease(
  memoryDir: string,
  holderId: string,
  fs: RuntimeFs = processFs(),
): Promise<number | null> {
  const prior = await readStamp(memoryDir, fs)
  const now = Date.now()

  // Held by a live (non-expired) holder — bail. No PID liveness check is
  // possible in a SharedWorker; `expiresAt` is the only reclaim signal.
  if (prior && prior.holderId !== '' && now < prior.expiresAt) {
    return null
  }

  const priorAt = prior?.lastConsolidatedAt ?? 0
  try {
    await writeStamp(memoryDir, {
      lastConsolidatedAt: priorAt,
      holderId,
      expiresAt: now + TIDY_LEASE_EXPIRY_MS,
    }, fs)
  } catch {
    return null
  }

  // Two reclaimers both write → last wins. Loser bails on re-read.
  const verify = await readStamp(memoryDir, fs)
  if (!verify || verify.holderId !== holderId) return null

  return priorAt
}

/**
 * Stamp a successful consolidation: `lastConsolidatedAt = now`, holder cleared.
 * Also the optimistic stamp for a manual `/tidy-memory` (best-effort, no completion
 * hook).
 */
export async function stampTidyDone(
  memoryDir: string,
  fs: RuntimeFs = processFs(),
): Promise<void> {
  try {
    await writeStamp(memoryDir, {
      lastConsolidatedAt: Date.now(),
      holderId: '',
      expiresAt: 0,
    }, fs)
  } catch {
    /* best-effort — a missed stamp just lets the next turn re-fire */
  }
}

/**
 * Rewind to the pre-acquire timestamp after a failed fork, clearing the holder
 * so the still-running tab doesn't look like it's holding. `priorAt === 0`
 * (no prior stamp) → unlink to restore the no-file state.
 */
export async function releaseTidyLease(
  memoryDir: string,
  priorAt: number,
  fs: RuntimeFs = processFs(),
): Promise<void> {
  try {
    if (priorAt === 0) {
      await fs.unlink(lockPath(memoryDir))
      return
    }
    await writeStamp(memoryDir, {
      lastConsolidatedAt: priorAt,
      holderId: '',
      expiresAt: 0,
    }, fs)
  } catch {
    /* best-effort — next trigger delayed at most to the time gate */
  }
}

/**
 * Session ids whose transcript was TOUCHED (mtime) after `sinceMs`. Caller
 * excludes the current session. Enumerates via the threaded storage-backend
 * deps. Per-session stat failures are skipped (a skip-gate, so
 * undercounting is safe). Returns `[]` when no deps are wired.
 */
export async function sessionsActiveSince(
  sinceMs: number,
  deps: SessionScanDeps,
  fs: RuntimeFs = processFs(),
): Promise<string[]> {
  const ids = await deps.listSessions()
  const touched = await Promise.all(
    ids.map(async id => {
      try {
        const s = await fs.stat(deps.transcriptPath(id))
        return (s.mtimeMs ?? 0) > sinceMs ? id : null
      } catch {
        return null
      }
    }),
  )
  return touched.filter((id): id is string => id !== null)
}

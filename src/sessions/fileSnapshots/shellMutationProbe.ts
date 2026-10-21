/**
 * Contract: shell write capture (F-6). `beginShellMutationProbe` snapshots
 * the files a command line names as write targets before the command runs;
 * `settle()` drops the snapshots the command left unchanged, so only real
 * writes reach the Diff panel. Never throws, never blocks the command (a
 * failed capture is skipped); `settle()` is idempotent. A probe for a command
 * still running when the tool call returns is held by task id and settled
 * when the task ends; one never settled is left to the turn finalize.
 */
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import { isFsNotFoundError } from '../../utils/fsTransportFailure'
import type { FileSnapshotRecorder, SnapshotTurnInfo } from './snapshotRecorder'
import { extractShellWriteCandidates, type ShellKind, type ShellWriteCandidate } from './shellWriteTargets'

/** A weak (`argument`) candidate over this size is not captured: it is an
 *  operand of a command whose effect is unknown, and most such operands are
 *  inputs. Named write targets keep the recorder's own cap. */
export const ARGUMENT_CANDIDATE_MAX_BYTES = 2 * 1024 * 1024

/** Probes held for background commands, at most this many. */
const MAX_HELD_PROBES = 256

export type ShellMutationProbe = {
  /** Paths this probe captured (newly tracked this turn). */
  readonly tracked: readonly string[]
  /** Compare each tracked path with its capture; discard the unchanged. */
  settle(): Promise<void>
}

export type ShellMutationProbeArgs = {
  recorder: FileSnapshotRecorder
  fs: RuntimeFs
  turn: SnapshotTurnInfo
  command: string
  shell: ShellKind
  /** The directory the command starts in. */
  cwd: string
  homeDir?: string
}

type Stat = { kind: 'file'; size: number } | { kind: 'directory' } | { kind: 'absent' } | { kind: 'unknown' }

async function statCandidate(fs: RuntimeFs, path: string): Promise<Stat> {
  try {
    const st = await fs.stat(path)
    return st.isDirectory() ? { kind: 'directory' } : { kind: 'file', size: st.size }
  } catch (err) {
    return isFsNotFoundError(err) ? { kind: 'absent' } : { kind: 'unknown' }
  }
}

/** Whether a candidate in this on-disk state is captured, and how. */
function captureKind(candidate: ShellWriteCandidate, stat: Stat): 'file' | 'tree' | null {
  switch (stat.kind) {
    case 'unknown':
      return null
    case 'directory':
      return candidate.onDirectory === 'tree' ? 'tree' : null
    case 'absent':
      return candidate.source === 'argument' ? null : 'file'
    case 'file':
      if (candidate.source === 'argument' && stat.size > ARGUMENT_CANDIDATE_MAX_BYTES) return null
      return 'file'
  }
}

export async function beginShellMutationProbe(args: ShellMutationProbeArgs): Promise<ShellMutationProbe> {
  const { recorder, fs, turn } = args
  const tracked: string[] = []
  let candidates: ShellWriteCandidate[] = []
  try {
    candidates = extractShellWriteCandidates(args.command, {
      shell: args.shell,
      cwd: args.cwd,
      homeDir: args.homeDir,
    })
  } catch {
    candidates = []
  }
  for (const candidate of candidates) {
    try {
      const kind = captureKind(candidate, await statCandidate(fs, candidate.path))
      if (kind === 'tree') {
        // A tree capture is per file and not discarded here: the finalize
        // reads each unchanged file as no change.
        await recorder.trackBeforeDirectoryRemoval(candidate.path, turn)
      } else if (kind === 'file') {
        if (await recorder.probeBeforeMutation(candidate.path, turn)) tracked.push(candidate.path)
      }
    } catch {
      // Best-effort: the command runs with or without this capture.
    }
  }
  let settled: Promise<void> | null = null
  return {
    tracked,
    settle(): Promise<void> {
      if (!settled) {
        settled = (async () => {
          for (const path of tracked) {
            try {
              await recorder.discardUnchangedProbe(path, turn.seq)
            } catch {
              // The row stays; finalize reads an unchanged file as no change.
            }
          }
        })()
      }
      return settled
    },
  }
}

const heldProbes = new Map<string, ShellMutationProbe>()

/** Keep a background command's probe until {@link settleHeldShellMutationProbe}. */
export function holdShellMutationProbe(taskId: string, probe: ShellMutationProbe): void {
  if (probe.tracked.length === 0) return
  if (heldProbes.size >= MAX_HELD_PROBES) {
    const oldest = heldProbes.keys().next().value
    if (oldest !== undefined) heldProbes.delete(oldest)
  }
  heldProbes.set(taskId, probe)
}

/** Settle the probe held for `taskId`, if any. Never throws. */
export async function settleHeldShellMutationProbe(taskId: string): Promise<void> {
  const probe = heldProbes.get(taskId)
  if (!probe) return
  heldProbes.delete(taskId)
  await probe.settle()
}

/** Test seam: forget every held probe. */
export function resetHeldShellMutationProbes(): void {
  heldProbes.clear()
}

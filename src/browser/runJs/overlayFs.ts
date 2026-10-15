/**
 * Contract: OverlayFs, SuperEdit's transactional virtual filesystem (F-21).
 * During a script every mutation (writeFile / mkdir / remove / move) is recorded
 * into an ordered log and nothing touches disk; reads are served from the overlay
 * over pristine disk. After the script succeeds, SuperEditTool replays the log
 * verbatim through its commit pipeline (conflict check → per-path permission and
 * hook → execute with snapshots).
 * This module performs no permission checks, hooks, snapshots or disk writes. It
 * reads disk only through the read-only {@link OverlayDisk}, for paths the caller
 * already gated. A move commits as one `fs.rename`; for the read view it
 * materializes the destination (captured bytes or a lazy `diskRef`) and
 * tombstones the source, and those materialized entries are never committed.
 */

import {
  isFsNotFoundError,
  isFsTransportFailure,
} from '../../utils/fsTransportFailure'

/** Read-only disk surface the overlay reads through on a cache miss, plus for
 *  baselines and move enumeration. A strict subset of `RuntimeFs`; commit
 *  EXECUTION (write/mkdir/remove/rename) is the caller's job, not this. */
export type OverlayDisk = {
  stat(path: string): Promise<{
    size: number
    mtimeMs?: number
    isDirectory(): boolean
  }>
  readFileBytes(path: string): Promise<Uint8Array>
  readdir(path: string): Promise<Array<{ name: string; isDirectory(): boolean }>>
}

/** One recorded mutation, replayed verbatim at commit against absolute paths. */
export type CommitOp =
  | { op: 'writeFile'; path: string; bytes: Uint8Array }
  | { op: 'mkdir'; path: string }
  | { op: 'remove'; path: string }
  | { op: 'move'; from: string; to: string }

/** A touched path's disk state captured at FIRST touch (first read-miss or
 *  first mutation, whichever came first) — the conflict-check's "before"
 *  image. `null` means the path was absent at first touch. */
export type Baseline = { kind: 'file' | 'dir'; size: number; mtimeMs: number } | null

/** What SuperEdit's commit pipeline consumes: the verbatim op log plus the
 *  distinct mutation targets (both ends of every move) with their baselines. */
export type CommitPlan = {
  ops: CommitOp[]
  targets: Array<{ path: string; baseline: Baseline }>
}

/** Result of an overlay read served without touching disk, or a directive to
 *  read a concrete disk path (already gated by the caller for the NAMED path). */
type Entry =
  | { t: 'file'; bytes: Uint8Array }
  /** A move-materialized destination file whose bytes still live at the
   *  pristine source path — read lazily, never copied into memory. */
  | { t: 'diskRef'; from: string }
  /** A created / move-materialized directory. `opaque` when it is FRESH (its
   *  children are only what the overlay adds); transparent when it shadows an
   *  existing disk directory (a redundant mkdir of a dir that already exists),
   *  in which case readdir still merges the disk listing. */
  | { t: 'dir'; opaque: boolean }
  /** A removed path or a move source — absent from here on. */
  | { t: 'gone' }

/** The overlay's knowledge about a path, before any disk fallback. */
type Classified =
  | { kind: 'file'; bytes?: Uint8Array; from?: string }
  | { kind: 'dir'; opaque: boolean }
  | { kind: 'absent' }
  /** No overlay knowledge — behave as raw disk at this path. */
  | { kind: 'disk' }

const NOT_FOUND = 'NotFoundError'

function overlayError(name: string, message: string): Error {
  const err = new Error(message)
  err.name = name
  return err
}

/** Absolute-path parent ('a/b/c' → 'a/b'); '' when there is no separator. */
function parentOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '' : path.slice(0, i)
}

/** True when `p` is `ancestor` itself or sits underneath it (boundary-aware:
 *  'a' does not contain 'ab'). */
function isUnder(ancestor: string, p: string): boolean {
  return p === ancestor || p.startsWith(`${ancestor}/`)
}

export class OverlayFs {
  private readonly entries = new Map<string, Entry>()
  private readonly log: CommitOp[] = []
  /** First-touch baseline per touched path (first write wins; a read-miss also
   *  seeds it so a read→write pair keeps the tighter pre-read window). */
  private readonly baselines = new Map<string, Baseline>()
  /** Distinct mutation targets, in first-seen order, for the commit gate. */
  private readonly targetOrder: string[] = []
  private readonly seenTargets = new Set<string>()

  constructor(private readonly disk: OverlayDisk) {}

  // ── plan (consumed by SuperEdit's commit pipeline) ────────────────────────

  /** True when the script recorded no mutations — commit is a no-op. */
  hasChanges(): boolean {
    return this.log.length > 0
  }

  getCommitPlan(): CommitPlan {
    return {
      ops: this.log.slice(),
      targets: this.targetOrder.map(path => ({
        path,
        baseline: this.baselines.get(path) ?? null,
      })),
    }
  }

  /** Every path the run TOUCHED — read or mutated — with its first-touch
   *  baseline. A superset of the mutation targets: the conflict-check runs
   *  over this so a file the script only READ that changed on disk mid-run is
   *  caught too (its derived write would otherwise commit stale-derived
   *  content). Read-miss baselines are seeded by `statForScript` /
   *  `readFileForScript`; mutation baselines by the `record*` methods. */
  getTouchedBaselines(): Array<{ path: string; baseline: Baseline }> {
    return [...this.baselines.entries()].map(([path, baseline]) => ({ path, baseline }))
  }

  // ── reads (served from overlay layered over pristine disk) ─────────────────
  //
  // The caller has already permission-gated the NAMED path; these methods only
  // resolve the virtual state, reading disk (ungated) for misses/diskRefs.

  async statForScript(abs: string): Promise<{ kind: 'file' | 'directory'; size: number; mtimeMs: number }> {
    const c = this.classify(abs)
    if (c.kind === 'absent') throw overlayError(NOT_FOUND, `No such file or directory: ${abs}`)
    if (c.kind === 'dir') return { kind: 'directory', size: 0, mtimeMs: 0 }
    if (c.kind === 'file') {
      if (c.bytes) return { kind: 'file', size: c.bytes.length, mtimeMs: 0 }
      const st = await this.diskStatOrThrow(c.from!)
      return { kind: 'file', size: st.size, mtimeMs: st.mtimeMs ?? 0 }
    }
    // 'disk': defer entirely to the real path.
    const st = await this.diskStatOrThrow(abs)
    await this.seedBaseline(abs, st)
    return {
      kind: st.isDirectory() ? 'directory' : 'file',
      size: st.size,
      mtimeMs: st.mtimeMs ?? 0,
    }
  }

  async readFileForScript(abs: string): Promise<{ bytes: Uint8Array; mtimeMs?: number }> {
    const c = this.classify(abs)
    if (c.kind === 'absent') throw overlayError(NOT_FOUND, `No such file or directory: ${abs}`)
    if (c.kind === 'dir') {
      throw overlayError(NOT_FOUND, `Is a directory: ${abs}`)
    }
    if (c.kind === 'file') {
      if (c.bytes) return { bytes: c.bytes, mtimeMs: undefined }
      return { bytes: await this.readDiskBytesOrThrow(c.from!), mtimeMs: undefined }
    }
    // 'disk'
    const bytes = await this.readDiskBytesOrThrow(abs)
    let mtimeMs: number | undefined
    try {
      const st = await this.disk.stat(abs)
      mtimeMs = st.mtimeMs
      await this.seedBaseline(abs, st)
    } catch (err) {
      // Must not fail open: a file left out of the baselines would skip the
      // commit's stale-derived-write check. Transport/transient failures
      // rethrow; a genuine ENOENT seeds an absent baseline, so a file that
      // reappears by commit time reads as a conflict.
      if (isFsTransportFailure(err) || !isFsNotFoundError(err)) throw err
      if (!this.baselines.has(abs)) this.baselines.set(abs, null)
      mtimeMs = undefined
    }
    return { bytes, mtimeMs }
  }

  async readdirForScript(abs: string): Promise<Array<{ name: string; kind: 'file' | 'directory' }>> {
    const c = this.classify(abs)
    if (c.kind === 'absent') throw overlayError(NOT_FOUND, `No such file or directory: ${abs}`)
    if (c.kind === 'file') throw overlayError(NOT_FOUND, `Not a directory: ${abs}`)

    const merged = new Map<string, 'file' | 'directory'>()
    const opaque = c.kind === 'dir' && c.opaque
    let sawDisk = false
    if (!opaque) {
      // Transparent dir or unknown: merge the real listing (tolerating a
      // missing dir — the overlay may know it exists purely from descendants).
      try {
        for (const d of await this.disk.readdir(abs)) {
          merged.set(d.name, d.isDirectory() ? 'directory' : 'file')
        }
        sawDisk = true
      } catch (err) {
        // "No disk dir here" is tolerable; a dead transport is not — it would
        // silently present a partial (overlay-only) listing as the truth.
        if (isFsTransportFailure(err)) throw err
        // The host's readdir failure wording is CAUSE-BLIND ("Path is not a
        // directory" covers missing AND access-denied — DirectoryExists is a
        // bool), so disambiguate with a stat, which does carry the taxonomy:
        // if the path exists as a directory, the
        // listing genuinely failed — rethrow rather than presenting a
        // truncated view a script might act on (`readdir().length === 0 →
        // remove(dir)` would delete a real tree). Only a confirmed-absent /
        // not-a-dir path keeps the merge tolerance.
        try {
          const st = await this.disk.stat(abs)
          if (st.isDirectory()) throw err
        } catch (statErr) {
          if (statErr === err) throw err
          if (isFsTransportFailure(statErr) || !isFsNotFoundError(statErr)) {
            throw statErr
          }
          // stat says absent/not-a-dir → the old tolerance was right here.
        }
      }
    }
    // Apply overlay direct children: tombstones remove, everything else sets.
    let sawOverlay = false
    for (const [name, kind] of this.overlayChildren(abs)) {
      sawOverlay = true
      if (kind === null) merged.delete(name)
      else merged.set(name, kind)
    }
    if (c.kind === 'disk' && !sawDisk && !sawOverlay) {
      throw overlayError(NOT_FOUND, `No such file or directory: ${abs}`)
    }
    return [...merged.entries()].map(([name, kind]) => ({ name, kind }))
  }

  // ── mutations (recorded; never touch disk here) ────────────────────────────

  async recordWrite(abs: string, bytes: Uint8Array): Promise<void> {
    await this.captureBaseline(abs)
    this.entries.set(abs, { t: 'file', bytes })
    this.log.push({ op: 'writeFile', path: abs, bytes })
    this.addTarget(abs)
  }

  async recordMkdir(abs: string): Promise<void> {
    const prior = this.entries.get(abs)
    const baseline = await this.captureBaseline(abs)
    // A mkdir over an existing disk directory stays TRANSPARENT (keep its disk
    // children visible); one over an absent path, a file, or a just-removed
    // path is a FRESH, opaque directory.
    const opaque = prior?.t === 'gone' ? true : baseline?.kind !== 'dir'
    this.entries.set(abs, { t: 'dir', opaque })
    this.log.push({ op: 'mkdir', path: abs })
    this.addTarget(abs)
  }

  async recordRemove(abs: string): Promise<void> {
    const baseline = await this.captureBaseline(abs)
    // Same as eager execution: removing a path that does not exist throws
    // NotFoundError to the script, rather than "succeeding" and only failing at
    // commit. Effective existence folds the overlay over disk.
    const c = this.classify(abs)
    const exists =
      c.kind === 'file' ||
      c.kind === 'dir' ||
      (c.kind === 'disk' && baseline !== null)
    if (!exists) {
      throw overlayError(NOT_FOUND, `No such file or directory: ${abs}`)
    }
    // Drop any pending overlay entries under this path — after the remove the
    // subtree is gone, and a stale descendant write must not shadow it on read
    // (the verbatim log still executes those earlier writes, then this remove).
    for (const key of [...this.entries.keys()]) {
      if (key !== abs && isUnder(abs, key)) this.entries.delete(key)
    }
    this.entries.set(abs, { t: 'gone' })
    this.log.push({ op: 'remove', path: abs })
    this.addTarget(abs)
  }

  /** Record a move. `from`/`to` are absolute; the caller has already verified
   *  the source exists, the destination is free, and `to` is not inside
   *  `from`. Commits as ONE native rename; here it only updates the read-view. */
  async recordMove(from: string, to: string): Promise<void> {
    // The first-touch baseline already knows the source's kind (pristine disk,
    // which the `'disk'` classification models); no third stat.
    const fromBaseline = await this.captureBaseline(from)
    await this.captureBaseline(to)
    const c = this.classify(from)
    const isDir =
      c.kind === 'dir' || (c.kind === 'disk' && fromBaseline?.kind === 'dir')

    if (isDir) {
      await this.materializeDirMove(from, to)
    } else {
      // File move: destination inherits the source's effective bytes (a pending
      // write's bytes, a chained diskRef, or a lazy ref to the pristine source).
      const src = this.entries.get(from)
      if (src?.t === 'file') this.entries.set(to, { t: 'file', bytes: src.bytes })
      else if (src?.t === 'diskRef') this.entries.set(to, { t: 'diskRef', from: src.from })
      else this.entries.set(to, { t: 'diskRef', from })
      this.entries.set(from, { t: 'gone' })
    }
    this.log.push({ op: 'move', from, to })
    this.addTarget(from)
    this.addTarget(to)
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private addTarget(abs: string): void {
    if (this.seenTargets.has(abs)) return
    this.seenTargets.add(abs)
    this.targetOrder.push(abs)
  }

  /** Capture (first-wins) the disk baseline for a path, classified like
   *  `currentDiskState`: only a not-found failure (`ENOENT`/`ENOTDIR`,
   *  `NotFoundError`, or an older host's legacy wording) seeds an absent (`null`)
   *  baseline. A transport death or a transient failure (`EACCES`/`EBUSY`/
   *  `EUNKNOWN`) rethrows: an unknown state read as absent could pass a
   *  null-vs-null conflict check. */
  private async captureBaseline(abs: string): Promise<Baseline> {
    const existing = this.baselines.get(abs)
    if (existing !== undefined) return existing
    let baseline: Baseline
    try {
      const st = await this.disk.stat(abs)
      baseline = {
        kind: st.isDirectory() ? 'dir' : 'file',
        size: st.size,
        mtimeMs: st.mtimeMs ?? 0,
      }
    } catch (err) {
      // A dead TRANSPORT is not "absent" — swallowing it here would seed a
      // null baseline for a file that exists, and the commit's later
      // isConflict(null, <file>) would report the fake "changed on disk"
      // verdict this pipeline was hardened against. Fail the script loudly;
      // the tool classifies the rethrow into its bridge-down message.
      if (isFsTransportFailure(err)) throw err
      // Same for a DISCRIMINATED transient failure (the host's EACCES /
      // EBUSY / EUNKNOWN stat codes): the path's state is unknown, not
      // absent — rethrow with the real reason rather than seeding a null
      // baseline. Only a not-found-shaped failure (which also covers an
      // older host's ambiguous wording) reads as absent.
      if (!isFsNotFoundError(err)) throw err
      baseline = null
    }
    this.baselines.set(abs, baseline)
    return baseline
  }

  /** Seed a baseline from a stat already in hand (a script read-miss), so a
   *  later write to the same path keeps the pre-read window. */
  private async seedBaseline(
    abs: string,
    st: { size: number; mtimeMs?: number; isDirectory(): boolean },
  ): Promise<void> {
    if (this.baselines.has(abs)) return
    this.baselines.set(abs, {
      kind: st.isDirectory() ? 'dir' : 'file',
      size: st.size,
      mtimeMs: st.mtimeMs ?? 0,
    })
  }

  private async diskStatOrThrow(
    abs: string,
  ): Promise<{ size: number; mtimeMs?: number; isDirectory(): boolean }> {
    try {
      return await this.disk.stat(abs)
    } catch (err) {
      // A dead transport must not be REWRITTEN into a not-found — the model
      // would "fix" a path that was never wrong. Rethrow it identity-intact;
      // same for a discriminated transient failure (EACCES/EBUSY/EUNKNOWN).
      if (isFsTransportFailure(err) || !isFsNotFoundError(err)) throw err
      throw overlayError(NOT_FOUND, `No such file or directory: ${abs}`)
    }
  }

  private async readDiskBytesOrThrow(abs: string): Promise<Uint8Array> {
    try {
      return await this.disk.readFileBytes(abs)
    } catch (err) {
      // Same rule as diskStatOrThrow: never rewrite a transport death — or a
      // discriminated transient failure — into a fabricated NotFoundError.
      if (isFsTransportFailure(err) || !isFsNotFoundError(err)) throw err
      throw overlayError(NOT_FOUND, `No such file or directory: ${abs}`)
    }
  }

  /** The overlay's knowledge about `abs`, folding direct entries, ancestor
   *  tombstones/files (which make a path absent), opaque-vs-transparent
   *  directories, and directories IMPLIED by deeper pending entries. */
  private classify(abs: string): Classified {
    const e = this.entries.get(abs)
    if (e) {
      if (e.t === 'file') return { kind: 'file', bytes: e.bytes }
      if (e.t === 'diskRef') return { kind: 'file', from: e.from }
      if (e.t === 'dir') return { kind: 'dir', opaque: e.opaque }
      return { kind: 'absent' }
    }
    const cut = this.nearestAncestorEntry(abs)
    const hasDesc = this.hasDescendant(abs)
    if (cut) {
      if (cut.t === 'gone' || cut.t === 'file' || cut.t === 'diskRef') {
        // Under a removed path or a file — nothing can exist here.
        return { kind: 'absent' }
      }
      // cut.t === 'dir' (opaque or transparent). An opaque fresh dir only holds
      // what the overlay put under it; a transparent one still lets disk show
      // through. Either way, an implied intermediate dir is a directory.
      if (hasDesc) return { kind: 'dir', opaque: cut.opaque }
      if (cut.opaque) return { kind: 'absent' }
      return { kind: 'disk' }
    }
    // No ancestor entry: transparent to disk. Descendants imply a directory
    // exists here (on disk or purely virtual); readdir merges disk if present.
    if (hasDesc) return { kind: 'dir', opaque: false }
    return { kind: 'disk' }
  }

  private nearestAncestorEntry(abs: string): Entry | null {
    let p = parentOf(abs)
    while (p) {
      const e = this.entries.get(p)
      if (e) return e
      const next = parentOf(p)
      if (next === p) break
      p = next
    }
    return null
  }

  private hasDescendant(abs: string): boolean {
    const prefix = `${abs}/`
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) return true
    }
    return false
  }

  /** Direct children the overlay contributes to `abs`: name → kind, or `null`
   *  kind for a tombstoned child (removed from the merged listing). A deeper
   *  entry implies a directory child; a direct entry overrides that guess. */
  private overlayChildren(abs: string): Map<string, 'file' | 'directory' | null> {
    const prefix = `${abs}/`
    const direct = new Map<string, Entry>()
    const impliedDirs = new Set<string>()
    for (const [key, e] of this.entries) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash < 0) direct.set(rest, e)
      else impliedDirs.add(rest.slice(0, slash))
    }
    const out = new Map<string, 'file' | 'directory' | null>()
    for (const name of impliedDirs) out.set(name, 'directory')
    for (const [name, e] of direct) {
      if (e.t === 'gone') out.set(name, null)
      else if (e.t === 'dir') out.set(name, 'directory')
      else out.set(name, 'file') // file | diskRef
    }
    return out
  }

  /** Populate the destination subtree in the read-view from the source's
   *  EFFECTIVE listing (overlay layered over disk), then tombstone the source.
   *  Files carry pending bytes when the script already wrote them, else a lazy
   *  `diskRef` to the still-pristine source path. Structure only — no bytes are
   *  read here. The commit executes the move as a single native rename. */
  private async materializeDirMove(from: string, to: string): Promise<void> {
    type Node = { relFrom: string; relTo: string }
    const queue: Node[] = [{ relFrom: from, relTo: to }]
    this.entries.set(to, { t: 'dir', opaque: true })
    while (queue.length > 0) {
      const { relFrom, relTo } = queue.shift()!
      let listing: Array<{ name: string; kind: 'file' | 'directory' }>
      try {
        listing = await this.readdirEffective(relFrom)
      } catch (err) {
        // Tolerate only a confirmed-absent subtree; a transport death or a
        // transient enumeration failure must not materialize an empty
        // destination subtree in the read view.
        if (isFsTransportFailure(err) || !isFsNotFoundError(err)) throw err
        continue
      }
      for (const { name, kind } of listing) {
        const childFrom = `${relFrom}/${name}`
        const childTo = `${relTo}/${name}`
        if (kind === 'directory') {
          this.entries.set(childTo, { t: 'dir', opaque: true })
          queue.push({ relFrom: childFrom, relTo: childTo })
        } else {
          const src = this.entries.get(childFrom)
          if (src?.t === 'file') this.entries.set(childTo, { t: 'file', bytes: src.bytes })
          else if (src?.t === 'diskRef') this.entries.set(childTo, { t: 'diskRef', from: src.from })
          else this.entries.set(childTo, { t: 'diskRef', from: childFrom })
        }
      }
    }
    // Tombstone the whole source subtree. The destination is guaranteed not to
    // sit inside the source (the caller refused that), so this never deletes a
    // freshly materialized destination entry.
    for (const key of [...this.entries.keys()]) {
      if (isUnder(from, key)) this.entries.delete(key)
    }
    this.entries.set(from, { t: 'gone' })
  }

  /** Internal effective listing (overlay + disk), no gating, no NotFound
   *  swallowing beyond the caller's try — the move-materialization walker. */
  private async readdirEffective(
    abs: string,
  ): Promise<Array<{ name: string; kind: 'file' | 'directory' }>> {
    return this.readdirForScript(abs)
  }
}

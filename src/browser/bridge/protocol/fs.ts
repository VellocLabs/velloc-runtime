/** The stat a compare-and-swap `writeFile` checks against. */
export type BridgeFsIfMatch = { mtimeMs: number; size: number }

/** Payload of the host-pushed `fs.onChange` EVENT (one coalesced burst). */
export type BridgeFsOnChangePayload = {
  watchId: string
  /** Changed paths (the watched root when the platform cannot tell which
   *  descendant changed), at most 256. */
  paths: string[]
  /** created | deleted | modified | moved when every change of the burst
   *  agreed, else `change`. */
  kind: 'created' | 'deleted' | 'modified' | 'moved' | 'change'
  /** More paths changed than the event carries. */
  overflow?: boolean
}

export type BridgeFsStatResult = {
  size: number
  mtimeMs?: number
  ctimeMs?: number
  birthtimeMs?: number
  isFile: boolean
  isDirectory: boolean
  isSymbolicLink: boolean
  isFIFO: boolean
  isSocket: boolean
  isCharacterDevice: boolean
  isBlockDevice: boolean
}

export type BridgeFsDirentResult = {
  name: string
  isFile: boolean
  isDirectory: boolean
  isSymbolicLink: boolean
}

/**
 * One row of a `readdirTree` scan.
 *
 * `path` is relative to the scan root and **always '/'-separated, on every
 * platform** — a wire contract, not an implementation detail. The host emits
 * '/' even on Windows so the guest can split on it; rebuild absolute paths
 * with `joinRuntimePath`, which normalizes separators against the base.
 */
export type BridgeFsTreeEntry = {
  path: string
  isDirectory: boolean
  /** 0 for directories. Carrying it here is what lets a caller skip a
   *  per-file `fs.stat` before a ranged read. */
  size: number
  /** Absent when the platform reports no timestamp. */
  mtimeMs?: number
}

/** One requested read in a `readBatch`. `length` omitted or 0 means "to end
 *  of file" from `offset`. */
export type BridgeFsReadBatchItem = {
  path: string
  offset?: number
  length?: number
}

export type FsBridgeActionMap = {
  cwd: {
    payload: Record<string, never>
    result: string
  }
  /** OS user home (HOME / USERPROFILE / DIR_HOME). Used by the WebUI
   *  bridge to anchor per-user settings (e.g. `~/.velloc/settings.json`
   *  for feature toggles) so they carry across browser profiles and
   *  cwds. Returns an empty string if no home dir is resolvable —
   *  callers must handle the empty case (the features handler falls
   *  back to the runtime cwd, which is its own legitimate fallback). */
  userHome: {
    payload: Record<string, never>
    result: string
  }
  stat: {
    payload: { path: string }
    result: BridgeFsStatResult
  }
  readdir: {
    payload: { path: string }
    result: BridgeFsDirentResult[]
  }
  readFile: {
    payload: { path: string }
    result: Uint8Array
  }
  readFileBytes: {
    payload: { path: string; maxBytes?: number }
    result: Uint8Array
  }
  readRange: {
    payload: { path: string; offset: number; length: number }
    result: { data: Uint8Array; bytesRead: number }
  }
  writeFile: {
    /**
     * `atomic` (additive, ignore-if-absent — no interface bump): ask the host
     * to write via a temp file + replace so a crash mid-write never leaves a
     * torn file. Older hosts ignore the field and write in place, which is
     * exactly today's behaviour. Used for `meta.json`, whose unlogged fields
     * have no other copy.
     */
    payload: {
      path: string
      content: Uint8Array
      atomic?: boolean
      /**
       * Compare-and-swap: write only while the file still has this size and
       * an mtime within 1 ms of `mtimeMs`; otherwise the call fails with the
       * distinct code `PRECONDITION_FAILED` and nothing is written. An older
       * host IGNORES this field and writes unconditionally — send it only
       * when the manifest's `primitives` lists `fs.writeFile.ifMatch`
       * (`NativePrimitives.fs.writeFileIfMatch` does).
       */
      ifMatch?: BridgeFsIfMatch
    }
    /** With `ifMatch`, also the stat after the write (the next ifMatch). */
    result: { ok: true; mtimeMs?: number; size?: number }
  }
  appendFile: {
    payload: { path: string; data: Uint8Array; mode?: number }
    result: { ok: true }
  }
  mkdir: {
    payload: { path: string; mode?: number }
    result: { ok: true }
  }
  rm: {
    payload: { path: string; recursive?: boolean; force?: boolean }
    result: { ok: true }
  }
  unlink: {
    payload: { path: string }
    result: { ok: true }
  }
  /**
   * Rename/move (host `base::Move`); never overwrites. An older host answers
   * `NOT_IMPLEMENTED`. The refusal strings ("Source does not exist" /
   * "Destination already exists") are wire contract.
   */
  rename: {
    payload: { oldPath: string; newPath: string }
    result: { ok: true }
  }
  exists: {
    payload: { path: string }
    result: boolean
  }
  realpath: {
    /**
     * `resolveLinks`: follow links on every platform (containment checks send it).
     * The default form stays: it is the session cwd and session-storage identity.
     * An older host ignores the key.
     */
    payload: { path: string; resolveLinks?: boolean }
    // Canonical absolute path with symlinks resolved (POSIX) /
    // normalized (Windows). Wrapped in an object so the wire shape
    // matches the C++ adapter's `Dict envelope.Set("path", ...)` and
    // leaves room for additional metadata later (e.g. a `wasSymlink`
    // flag) without breaking the existing route.
    result: { path: string }
  }
  /** Stat many paths in one round-trip. Rows are 1:1 with `paths`, in the
   *  same order (duplicates preserved), each echoing the REQUEST string
   *  rather than the resolved path. An unreadable path is `stat: null`, not
   *  an error — every caller here is an existence check. Over 2000 paths is
   *  rejected rather than truncated. */
  statBatch: {
    payload: { paths: string[] }
    result: Array<{ path: string; stat: BridgeFsStatResult | null }>
  }
  /**
   * Read many files or byte ranges in one round-trip; bytes are concatenated into
   * `blob` — use `sliceReadBatch`. Per-item failure never fails the call: callers
   * skip `ok: false` and `byteLength: 0` entries.
   */
  readBatch: {
    payload: { items: Array<BridgeFsReadBatchItem> }
    result: {
      entries: Array<{
        path: string
        ok: boolean
        byteOffset: number
        byteLength: number
        error?: string
      }>
      totalBytes: number
      /** The host's per-call byte budget stopped the loop; remaining items
       *  are `ok:false`. Re-request them in another call. */
      truncated: boolean
      blob: Uint8Array
    }
  }
  /**
   * Bounded-depth recursive directory listing. `maxDepth` is load-bearing (the
   * session store holds thousands of files); directories AT the cap are not descended.
   */
  readdirTree: {
    payload: {
      path: string
      /** Levels below `path`. 1 = plain readdir (the default). Max 8. */
      maxDepth?: number
      /** Row cap; the scan stops and sets `truncated`. Default 20000. */
      maxEntries?: number
    }
    result: {
      /** The resolved absolute root, echoed. */
      root: string
      truncated: boolean
      entries: Array<BridgeFsTreeEntry>
    }
  }
  // Host-process platform identifiers used by the `# Environment`
  // system-prompt block. Populated by `base::SysInfo` on the C++
  // side (see `nexus_fs_host.cc:SystemInfo`). All three fields are
  // best-effort: an empty string means "unknown" and the guest's
  // prompt builder drops the corresponding line. There is
  // intentionally no JS-side fallback — accurate info or no info.
  systemInfo: {
    payload: Record<string, never>
    result: {
      // 'win32' | 'darwin' | 'linux', matching Node's process.platform
      // strings. Empty on unknown platforms.
      platform: string
      // Human-readable OS version, e.g. "Windows 11 Pro 10.0.26200" or
      // "Linux 6.6.4". Empty when base::SysInfo returns nothing useful.
      osVersion: string
      // Interpreter name only (no path, no .exe suffix). Derived from
      // $SHELL on POSIX, $SHELL → $COMSPEC fallback on Windows. Empty
      // when neither env var is set.
      shell: string
      // The PowerShell the PowerShell tool launches on Windows: "pwsh"
      // (PowerShell 7+) or "powershell" (Windows PowerShell 5.1). Empty or
      // absent when there is none, off Windows, or on an older host.
      powershell?: string
    }
  }

  // ---- Additive native primitives (P-3) -----------------
  // Each answers NOT_IMPLEMENTED on an older host; the manifest's
  // `primitives` names the ones a host serves. Use the typed wrappers in
  // `bridge/nativePrimitives.ts`, which check both.

  /** Watch a file or directory; changes arrive as `fs.onChange` events. A
   *  watch dies with the bridge connection. At most 64 per connection. */
  watch: {
    payload: { path: string; recursive?: boolean }
    result: { watchId: string; mode: 'native' | 'poll' }
  }
  unwatch: {
    payload: { watchId: string }
    result: { found: boolean }
  }
  /** Host-pushed EVENT (never requested). */
  onChange: {
    payload: BridgeFsOnChangePayload
    result: never
  }
  /** Without `overwrite` an existing destination fails `EEXIST: …`. */
  copyFile: {
    payload: { src: string; dst: string; overwrite?: boolean }
    result: { ok: true }
  }
  /** Windows needs Developer Mode or elevation (`EPERM: …` otherwise). */
  symlink: {
    payload: { target: string; path: string }
    result: { ok: true }
  }
  /** POSIX: the raw stored target. Windows: the resolved final path. */
  readlink: {
    payload: { path: string }
    result: { target: string }
  }
  /** `applied: false` on Windows, where it is a successful no-op. */
  chmod: {
    payload: { path: string; mode: number }
    result: { applied: boolean }
  }
  /** Well-known per-user directories; '' when unresolvable. */
  paths: {
    payload: Record<string, never>
    result: { home: string; temp: string; appData: string; cache: string }
  }
}

/**
 * Turn a `readBatch` response into per-item byte views (no copy). Throws when the
 * index length does not match the request: a short index would hand one file's
 * bytes to another. `ok:false` and zero-length items are not throws.
 */
export function sliceReadBatch(
  requested: readonly BridgeFsReadBatchItem[],
  result: {
    entries: Array<{
      path: string
      ok: boolean
      byteOffset: number
      byteLength: number
      error?: string
    }>
    blob: Uint8Array
  },
): Array<{ path: string; ok: boolean; bytes: Uint8Array | null; error?: string }> {
  const entries = result.entries ?? []
  if (entries.length !== requested.length) {
    throw new Error(
      `fs.readBatch returned ${entries.length} entries for ${requested.length} items`,
    )
  }
  const blob = result.blob ?? new Uint8Array(0)
  return entries.map((entry, index) => {
    const expected = requested[index]!.path
    if (entry.path !== expected) {
      throw new Error(
        `fs.readBatch entry ${index} is "${entry.path}", expected "${expected}"`,
      )
    }
    if (!entry.ok) {
      return { path: entry.path, ok: false, bytes: null, error: entry.error }
    }
    const start = entry.byteOffset
    const end = start + entry.byteLength
    if (start < 0 || end > blob.byteLength) {
      // The index disagrees with the buffer we were handed. Treat it as an
      // unreadable item rather than trusting either.
      return {
        path: entry.path,
        ok: false,
        bytes: null,
        error: 'readBatch index out of range',
      }
    }
    return { path: entry.path, ok: true, bytes: blob.subarray(start, end) }
  })
}

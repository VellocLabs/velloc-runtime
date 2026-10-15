/**
 * Sidechain transcript store: each forked sub-agent's message stream persisted
 * as JSONL keyed by `agentId` (first entry is a `__sidechain_meta` marker).
 * In-memory and `RuntimeFs`-backed implementations. Append / load errors are
 * best-effort: transcript loss never aborts the fork.
 */

import type { Message } from '../runtime/RuntimeTypes'
import type { RuntimeFs } from './fs/runtimeFs'
import {
  getSubagentTranscriptPath,
  getSubagentsDirectoryPath,
  parseAgentIdFromFilename,
} from './sidechainStoragePaths'

// ============================================================================
// Types
// ============================================================================

/**
 * First entry of every sidechain transcript file. Identifies the fork
 * and its parent context for later attribution.
 *
 * The discriminator string mirrors the main transcript's
 * `__session_meta` convention so readers can tell meta-entries from
 * message entries with a single `type` check.
 */
export type SidechainMetadata = {
  type: '__sidechain_meta'
  /** Unique agent id within the parent session. Filename-safe. */
  agentId: string
  /** Parent session id — needed to walk back to the main transcript. */
  spawnerSessionId: string
  /** Free-form fork label (`extract_memories`, `side_question`, etc.). */
  forkLabel: string
  /** Unix ms timestamp when the fork started. */
  startedAt: number
  /** Resolved `mainLoopModel` at fork time. Audit-only. */
  model: string
  /** UUID of the last message in the parent's cache prefix. */
  parentUuid?: string
  /**
   * The resolved agent type — SpawnAgentTool's `subagent_type`. Undefined for a
   * plain context-inheriting fork. Kept in the inline `__sidechain_meta`
   * header (single-file layout) so resume can route the transcript back to
   * the right agent definition.
   */
  agentType?: string
  /**
   * The original task description (SpawnAgentTool's
   * `description`, 3-5 words). Surfaced to the user in the sub-agent UI
   * card and in any future sidechain listing.
   */
  description?: string
  /**
   * How the fork's model was chosen when it was routed through the
   * sub-session model policy (`getModelForSessionType`):
   * 'session-model-policy' (a user pin/tier resolved a non-parent model),
   * 'inherit' (policy present, resolved to the parent), or
   * 'window-fallback' (a resolved model couldn't fit the inherited context
   * and degraded to the parent). Absent for unrouted forks. Audit-only.
   */
  modelSource?: string
}

/** Anything that can appear on a single line of a sidechain JSONL file. */
export type SidechainEntry = SidechainMetadata | Message

export function isSidechainMetadata(
  entry: SidechainEntry,
): entry is SidechainMetadata {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    (entry as { type?: unknown }).type === '__sidechain_meta'
  )
}

/**
 * Build a root→leaf conversation chain from a sidechain's raw entries, stripping
 * the meta header and chain-stamp fields. Walks `parentUuid` from the latest
 * leaf (cycle-guarded); write order when no links are present.
 */
export function buildSidechainChain(entries: readonly SidechainEntry[]): Message[] {
  const messages = entries.filter(
    (entry): entry is Message => !isSidechainMetadata(entry),
  )
  if (messages.length === 0) {
    return []
  }

  type Linked = Message & { parentUuid?: string | null; uuid?: string }
  const linked = messages as Linked[]
  const byUuid = new Map<string, Linked>()
  for (const message of linked) {
    if (typeof message.uuid === 'string') {
      byUuid.set(message.uuid, message)
    }
  }

  // Leaf = last message whose uuid is not referenced as any parent.
  const parentRefs = new Set(
    linked
      .map(message => message.parentUuid)
      .filter((value): value is string => typeof value === 'string'),
  )
  let leaf: Linked | undefined
  for (let i = linked.length - 1; i >= 0; i--) {
    const candidate = linked[i]
    if (candidate && typeof candidate.uuid === 'string' && !parentRefs.has(candidate.uuid)) {
      leaf = candidate
      break
    }
  }
  leaf ??= linked[linked.length - 1]

  const chain: Linked[] = []
  const seen = new Set<string>()
  let current: Linked | undefined = leaf
  while (current) {
    const id = current.uuid
    if (typeof id === 'string') {
      if (seen.has(id)) break // cycle guard
      seen.add(id)
    }
    chain.push(current)
    const parent: string | null | undefined = current.parentUuid
    current = typeof parent === 'string' ? byUuid.get(parent) : undefined
  }
  chain.reverse()

  // Strip chain-stamp fields, yielding plain runtime messages.
  return chain.map(message => {
    const { parentUuid: _p, sessionId: _s, transcriptOrdinal: _t, ...rest } =
      message as Record<string, unknown>
    return rest as Message
  })
}

// ============================================================================
// Store interface
// ============================================================================

export interface SidechainTranscriptStore {
  /**
   * Append a single entry to the sub-agent's transcript. Idempotent at
   * the file level (each call adds a line); idempotency at the logical
   * level (don't re-append a message we already wrote) is the
   * caller's responsibility via a `lastRecordedUuid` cursor.
   */
  append(
    sessionId: string,
    agentId: string,
    entry: SidechainEntry,
  ): Promise<void>

  /**
   * Load every entry from a sub-agent's transcript in write order.
   * Returns an empty array when the transcript doesn't exist — callers
   * that want to distinguish "missing" from "empty" should call
   * `loadMetadata` first.
   */
  load(sessionId: string, agentId: string): Promise<SidechainEntry[]>

  /**
   * Read just the metadata header. Optimization for callers that need
   * to enumerate sub-agents by label / start time without paying to
   * read the whole transcript.
   */
  loadMetadata(
    sessionId: string,
    agentId: string,
  ): Promise<SidechainMetadata | null>

  /**
   * List the agentIds of every sub-agent transcript recorded under
   * the given session.
   */
  list(sessionId: string): Promise<string[]>

  /**
   * Delete one sub-agent's transcript. Used by GC; never called
   * by the fork itself.
   */
  delete(sessionId: string, agentId: string): Promise<void>

  /**
   * Load the sub-agent's conversation chain in root→leaf
   * order, with the `__sidechain_meta` header stripped and chain fields
   * (`parentUuid`, `sessionId`, legacy `transcriptOrdinal`) removed. Returns `[]`
   * when the transcript doesn't exist or has no message entries.
   */
  loadChain(sessionId: string, agentId: string): Promise<Message[]>
}

// ============================================================================
// Active store registry
// ============================================================================

/**
 * Process-wide handle to the production sidechain store, set once at runtime
 * boot. Unset in tests and mock hosts: forks then run without persistence.
 */
let activeSidechainStore: SidechainTranscriptStore | null = null

export function setActiveSidechainStore(
  store: SidechainTranscriptStore | null,
): void {
  activeSidechainStore = store
}

export function getActiveSidechainStore(): SidechainTranscriptStore | null {
  return activeSidechainStore
}

/**
 * The caller's sidechain store: `options.sidechainStore`, falling back to the
 * realm-shared slot only when the context publishes none (`undefined`). The slot
 * is last-writer-wins across runtimes; `null` means "no persistence", honoured.
 */
export function getContextSidechainStore(context: {
  options: { sidechainStore?: SidechainTranscriptStore | null }
}): SidechainTranscriptStore | undefined {
  const own = context.options.sidechainStore
  if (own !== undefined) return own ?? undefined
  return activeSidechainStore ?? undefined
}

// ============================================================================
// Agent ID generator
// ============================================================================

/**
 * A filename-safe agentId from a fork label:
 * `{label}_{8 random hex chars}_{base36 timestamp}`; label characters outside
 * `[A-Za-z0-9_-]` become `_`.
 */
export function createSidechainAgentId(forkLabel: string): string {
  // Replace runs of unsafe chars with `_`, then strip leading/trailing
  // underscores so labels like `!!!` (which would otherwise become a
  // bare `_`) fall through to the `fork` fallback rather than
  // producing a meaningless `_xxxxxxxx_yyy` id.
  const safeLabel =
    forkLabel
      .replace(/[^A-Za-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'fork'
  const randomHex =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 8)
      : Math.random().toString(16).slice(2, 10)
  const tsSuffix = Date.now().toString(36)
  return `${safeLabel}_${randomHex}_${tsSuffix}`
}

// ============================================================================
// In-memory implementation
// ============================================================================

/**
 * RAM-backed store for tests and ephemeral runtimes. The internal
 * shape mirrors the on-disk layout (Map<sessionId, Map<agentId,
 * SidechainEntry[]>>) so it plainly behaves like the fs-backed store.
 */
export class InMemorySidechainTranscriptStore
  implements SidechainTranscriptStore
{
  private readonly entries = new Map<string, Map<string, SidechainEntry[]>>()

  async append(
    sessionId: string,
    agentId: string,
    entry: SidechainEntry,
  ): Promise<void> {
    let perSession = this.entries.get(sessionId)
    if (!perSession) {
      perSession = new Map()
      this.entries.set(sessionId, perSession)
    }
    let list = perSession.get(agentId)
    if (!list) {
      list = []
      perSession.set(agentId, list)
    }
    list.push(entry)
  }

  async load(sessionId: string, agentId: string): Promise<SidechainEntry[]> {
    return this.entries.get(sessionId)?.get(agentId)?.slice() ?? []
  }

  async loadMetadata(
    sessionId: string,
    agentId: string,
  ): Promise<SidechainMetadata | null> {
    const list = this.entries.get(sessionId)?.get(agentId)
    if (!list || list.length === 0) return null
    const first = list[0]
    return first && isSidechainMetadata(first) ? first : null
  }

  async list(sessionId: string): Promise<string[]> {
    const perSession = this.entries.get(sessionId)
    return perSession ? Array.from(perSession.keys()) : []
  }

  async delete(sessionId: string, agentId: string): Promise<void> {
    const perSession = this.entries.get(sessionId)
    perSession?.delete(agentId)
    if (perSession && perSession.size === 0) {
      this.entries.delete(sessionId)
    }
  }

  async loadChain(sessionId: string, agentId: string): Promise<Message[]> {
    const entries = await this.load(sessionId, agentId)
    return buildSidechainChain(entries)
  }
}

// ============================================================================
// RuntimeFs-backed implementation
// ============================================================================

const TEXT_ENCODER = new TextEncoder()

export type FsSidechainStoreOptions = {
  /** Filesystem implementation. Production uses `processFs()`. */
  fs: RuntimeFs
  /**
   * Storage root. Should match the main conversation backend's basePath
   * so sub-agent transcripts sit alongside their parent session's
   * `transcript.jsonl`. Typically `~/.velloc/sessions` or the
   * `VELLOC_MEMORY_ROOT`-derived equivalent.
   */
  basePath: string
}

/**
 * Disk-backed store using the `sidechainStoragePaths` layout. Each `agentId`
 * owns its file; appends to one agentId must be sequential.
 */
export function createFsSidechainTranscriptStore(
  options: FsSidechainStoreOptions,
): SidechainTranscriptStore {
  const { fs, basePath } = options
  const ensuredSessionDirs = new Set<string>()
  // Full JSONL content per path: the bridge fs has no synchronous append, so each
  // append rewrites the whole file. Seeded from disk on first append, so an
  // existing transcript is never truncated.
  const contentCache = new Map<string, string>()

  async function readRawOrEmpty(path: string): Promise<string> {
    try {
      return await fs.readFile(path, { encoding: 'utf-8' })
    } catch (err) {
      // A read failure on a file that does NOT exist is the normal first-append
      // case → start fresh. But if the file ALREADY exists (a resumed /
      // re-opened fork) and the read failed transiently, seeding empty here
      // would make the next `writeFile` TRUNCATE the entire prior transcript —
      // so re-throw to abort this append (the fork's `recordEntry` swallows it)
      // and leave the on-disk file intact. `existsSync` is best-effort: if it
      // throws or can't answer, fall through to the safe fresh-start (the prior
      // always-empty behavior, correct for brand-new files).
      let exists = false
      try {
        exists = fs.existsSync(path)
      } catch {
        exists = false
      }
      if (exists) throw err
      return ''
    }
  }

  async function ensureSessionSubagentsDir(sessionId: string): Promise<void> {
    if (ensuredSessionDirs.has(sessionId)) return
    const dir = getSubagentsDirectoryPath(basePath, sessionId)
    try {
      await fs.mkdir(dir)
    } catch {
      // mkdir is recursive on the bridge adapter; an EEXIST is the
      // expected path and is swallowed by the impl. Anything reaching
      // here will surface on the actual write attempt below.
    }
    ensuredSessionDirs.add(sessionId)
  }

  async function readJsonlEntries(path: string): Promise<SidechainEntry[]> {
    let raw: string
    try {
      raw = await fs.readFile(path, { encoding: 'utf-8' })
    } catch {
      return []
    }
    const out: SidechainEntry[] = []
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue
      try {
        out.push(JSON.parse(line) as SidechainEntry)
      } catch {
        // Corrupt line — skip but keep reading. Matches the main
        // transcript reader's resilience to partial writes.
      }
    }
    return out
  }

  return {
    async append(sessionId, agentId, entry) {
      await ensureSessionSubagentsDir(sessionId)
      const path = getSubagentTranscriptPath(basePath, sessionId, agentId)
      let existing = contentCache.get(path)
      if (existing === undefined) {
        // First append to this path this process: seed the mirror from disk so
        // we extend (never truncate) any transcript already there.
        existing = await readRawOrEmpty(path)
        contentCache.set(path, existing)
      }
      const next = existing + JSON.stringify(entry) + '\n'
      contentCache.set(path, next)
      // Async, bridge-backed write (the path the main transcript uses). Encode
      // once so the binary fs port carries bytes, not a re-encoded string.
      await fs.writeFile(path, TEXT_ENCODER.encode(next))
    },

    async load(sessionId, agentId) {
      const path = getSubagentTranscriptPath(basePath, sessionId, agentId)
      return readJsonlEntries(path)
    },

    async loadMetadata(sessionId, agentId) {
      const entries = await this.load(sessionId, agentId)
      const first = entries[0]
      if (!first) return null
      return isSidechainMetadata(first) ? first : null
    },

    async list(sessionId) {
      const dir = getSubagentsDirectoryPath(basePath, sessionId)
      let dirents
      try {
        dirents = await fs.readdir(dir)
      } catch {
        return []
      }
      const agentIds: string[] = []
      for (const dirent of dirents) {
        if (!dirent.isFile()) continue
        const id = parseAgentIdFromFilename(dirent.name)
        if (id) agentIds.push(id)
      }
      return agentIds
    },

    async delete(sessionId, agentId) {
      const path = getSubagentTranscriptPath(basePath, sessionId, agentId)
      contentCache.delete(path)
      try {
        await fs.unlink(path)
      } catch {
        // Already gone — treat as success.
      }
    },

    async loadChain(sessionId, agentId) {
      const entries = await this.load(sessionId, agentId)
      return buildSidechainChain(entries)
    },
  }
}

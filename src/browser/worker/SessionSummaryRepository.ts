/**
 * SessionSummaryRepository — the sidebar read-model caches: the live metadata overlay, the
 * fs-summary LRU, the memoized routing scan, the persisted-binding reconcile and the throttled preload.
 */
import { LruMap } from './LruMap'
import type {
  BrowserConversationStorageBackend,
  BrowserSessionMetadata,
  BrowserSessionSummary,
} from '../../sessions/sessionStore'
import type { installSessionTracer } from '../../utils/sessionTrace'
import type { AgentRuntimeWorkerInitPayload } from './workerProtocol'
import { DEFAULT_TEMPLATE_TYPE } from './workerProtocol'
import {
  getNexusWorkspaceDirForType,
  projectHomeFor,
} from '../../utils/conversationStoragePaths'
import type { SessionStorageCoordinator } from './SessionStorageCoordinator'

type SessionTracer = ReturnType<typeof installSessionTracer>

export type LiveMeta = {
  title?: string
  /** User-assigned title override; wins over `title` in buildSessionInfo.
   *  Tombstone semantics: `null` = the user explicitly
   *  CLEARED the rename — the projection must not fall back to the stale
   *  fs-cache value while the persist/refresh round-trip is in flight;
   *  `undefined`/absent = the live overlay has no opinion (fs may fill). */
  customTitle?: string | null
  previewText?: string
  updatedAt?: number
  /** Same tombstone contract as `customTitle` — a cleared draft must not
   *  resurrect from the fs cache. */
  composerDraft?: string | null
  lastComposerEditAt?: number
  /** Set by a pin/unpin ahead of the fs refresh; wins over the fs summary. */
  pinned?: boolean
}

const FS_SUMMARY_CACHE_MAX = 500

/** The narrow view of the Manager the repository needs. */
export type SessionSummaryRepositoryHost = {
  /** The realm's shared tracer (the Manager installs it once). */
  tracer: SessionTracer
  /**
   * Fired after the one-shot summary preload finishes successfully — the
   * Manager snaps list subscribers from "live only" to the full session
   * list. Not fired on a failed routing scan (the preload declines to
   * latch and the sidebar keeps showing live sessions only).
   */
  onPreloadComplete(): void
  /**
   * Broadcast one session's refreshed `SessionCard` to its subscribers
   * (the Manager owns payload building + the ports). Fired whenever a
   * cache update changes what the sidebar should show.
   */
  notifySessionUpserted(sessionId: string): void
  /**
   * True while a runtime is registered for the session. A live session's own
   * store owns its `meta.json`; every summary read this repository makes for
   * it must stay READ-ONLY (`loadSessionSummary(…, {migrate: false})`, the
   * batch's `skipCommit`) or a manager-side migration write could land after
   * the store's first persist and erase the model / permission / draft /
   * bind backfill it carried.
   */
  isSessionLive(sessionId: string): boolean
}

export class SessionSummaryRepository {
  // Live in-memory metadata derived from streamed messages for each active
  // session worker. Overrides fs summaries when both are present (the worker
  // is authoritative for sessions it's currently driving).
  readonly liveMeta = new Map<string, LiveMeta>()
  // fs-persisted summaries indexed by sessionId. Populated at storage init
  // and refreshed incrementally on append. Bounded LRU so a profile with
  // thousands of archived sessions can't blow the worker heap — the
  // sidebar only renders a handful of recently-touched entries anyway.
  readonly fsSummaries = new LruMap<string, BrowserSessionSummary>(
    FS_SUMMARY_CACHE_MAX,
  )
  private preloadComplete = false
  /** Memoized `listSessions()` — the readdir/statBatch routing scan that maps
   *  each `sessionId → projectDir` (in `GroupedConversationStorage`) without
   *  reading any transcript. Shared by the boot-critical projectRoot reconcile
   *  and the (throttled, background) sidebar summary preload so the scan runs
   *  once. Resolves `null` when the scan FAILED (vs `[]` for a genuinely empty
   *  profile) so `preloadFsSummaries` can decline to latch `preloadComplete` —
   *  latching on a failure would permanently disable the reconcile's targeted
   *  reads even though the failed attempt is un-memoized and retriable. */
  private sessionRoutingPromise: Promise<string[] | null> | null = null

  constructor(
    private readonly storageCoordinator: SessionStorageCoordinator,
    private readonly host: SessionSummaryRepositoryHost,
  ) {}

  ensureSessionRouting(): Promise<string[] | null> {
    if (this.sessionRoutingPromise) return this.sessionRoutingPromise
    return this.refreshSessionRouting()
  }

  /**
   * Re-run the routing scan UNCONDITIONALLY, replacing the memo (a route can go stale after a
   * successful scan).
   */
  refreshSessionRouting(): Promise<string[] | null> {
    const storage = this.storageCoordinator.getStorage()
    if (!storage) return Promise.resolve([])
    const attempt: Promise<string[] | null> = storage
      .listSessions()
      .catch((): null => {
        // Do NOT memoize a transient failure: a single flaky readdir would
        // otherwise disable both the slow-path reconcile and the sidebar for
        // the worker's whole lifetime. Clear so the next caller retries.
        if (this.sessionRoutingPromise === attempt) {
          this.sessionRoutingPromise = null
        }
        return null
      })
    this.sessionRoutingPromise = attempt
    return attempt
  }

  /**
   * Resolve a resumed session's persisted `projectRoot` and `templateType` into the init payload; both
   * address its project dir. Awaits only the routing scan, then reads that ONE session's summary.
   * Type-agnostic, and the persisted value wins over the payload; the re-bind path does not come here.
   */
  async reconcilePersistedSessionBinding(
    sessionId: string,
    payload: AgentRuntimeWorkerInitPayload,
  ): Promise<void> {
    const cachedSummary = this.fsSummaries.get(sessionId)
    let persistedProjectRoot = cachedSummary?.projectRoot
    let persistedTemplateType = cachedSummary?.templateType
    const storage = this.storageCoordinator.getStorage()
    const grouped = this.storageCoordinator.getGroupedStorage()
    const homeDir = this.storageCoordinator.getHomeDir()
    // A projectRoot-less migrated session routes by the folder recorded in the
    // store (`project_dir` → `summary.projectDir`). When the sidebar preload has
    // already cached this session's summary (the common post-preload open, where
    // the expensive reconcile block below is skipped), restore the router's map
    // from it so `prepareWorkerStorageTarget` targets the real transcript folder.
    // Fill a GAP only — never clobber a route the routing scan or a bind already
    // committed (an explicit `projectRoot` still wins downstream regardless).
    if (
      grouped &&
      cachedSummary?.projectDir &&
      grouped.projectRouteOf(sessionId) === undefined
    ) {
      grouped.setSessionProjectDir(sessionId, cachedSummary.projectDir)
    }
    if (persistedProjectRoot === undefined && !this.preloadComplete && storage) {
      let summary: BrowserSessionSummary | null = null

      // Established routing wins: read there directly, without pre-routing over the scan's mapping.
      const establishedDir = grouped?.projectRouteOf(sessionId)
      if (establishedDir !== undefined) {
        try {
          summary = await storage.loadSessionSummary(sessionId, {
            migrate: !this.host.isSessionLive(sessionId),
          })
        } catch {
          // best-effort — fall through with no summary
        }
        // The established route may be a stale guess: with no summary there, rescan for real
        // (refresh, not the memo) and re-read.
        if (!summary) {
          await this.refreshSessionRouting()
          try {
            summary = await storage.loadSessionSummary(sessionId, {
              migrate: !this.host.isSessionLive(sessionId),
            })
          } catch {
            // best-effort — a bound session simply falls back to the sandbox
          }
        }
      } else {
        // FAST PATH (unrouted only): read this session's summary at its
        // type-default project dir (`shared-workspace/<type>` — where every
        // unbound agent/chat and not-yet-bound code session lives). One stat +
        // one readRange, NO directory scan. The overwhelmingly common default
        // session resolves here without ever touching `listSessions()`.
        const typeDefaultDir =
          grouped && homeDir
            ? projectHomeFor(
                homeDir,
                getNexusWorkspaceDirForType(
                  homeDir,
                  payload.templateType ?? DEFAULT_TEMPLATE_TYPE,
                ),
              )
            : undefined
        if (grouped && typeDefaultDir) {
          // The unrouted check above and this set are one synchronous block —
          // atomic against the scan's async loop, so this can only route a
          // session the scan hasn't claimed yet.
          grouped.setSessionProjectDir(sessionId, typeDefaultDir)
        }
        try {
          summary = await storage.loadSessionSummary(sessionId, {
            migrate: !this.host.isSessionLive(sessionId),
          })
        } catch {
          // fall through to the scan
        }
        // SLOW PATH: the session isn't at its type-default dir → it is a bound
        // `code`/`project` session living under its real folder's project dir.
        // Only now pay the routing scan (`listSessions()` — readdir + batched
        // stat, no transcript reads) to locate it, then read its summary. This
        // is the rare bound-session-cold-resume case the persisted-root
        // reconcile exists for; the page's stale/absent `projectRoot` gets
        // corrected here.
        if (!summary) {
          // Undo OUR speculative route only if it is still ours — during the
          // read await, an in-flight scan may have overwritten it with the
          // session's REAL dir, and that mapping must survive.
          if (
            grouped &&
            typeDefaultDir &&
            grouped.projectRouteOf(sessionId) === typeDefaultDir
          ) {
            grouped.dropSessionRouting(sessionId)
          }
          await this.ensureSessionRouting()
          try {
            summary = await storage.loadSessionSummary(sessionId, {
              migrate: !this.host.isSessionLive(sessionId),
            })
          } catch {
            // best-effort — a bound session simply falls back to the sandbox
          }
        }
      }

      if (summary) {
        persistedProjectRoot = summary.projectRoot
        // `??`, not `=`: a summary written before `templateType` was persisted
        // is IGNORANT of the type, not authoritative that there is none — it
        // must not erase a value the cache already had.
        persistedTemplateType = summary.templateType ?? persistedTemplateType
        // A session migrated from a legacy `meta.json` persisted NEITHER
        // `projectRoot` nor `templateType` — its only routing key is the folder
        // the store recorded (`project_dir`, surfaced as `summary.projectDir`).
        // Correct the map to it, overwriting the FAST PATH's speculative
        // type-default route (which sent this session to the sandbox and opened
        // it EMPTY while its transcript sat in its real project folder).
        if (grouped && summary.projectDir) {
          grouped.setSessionProjectDir(sessionId, summary.projectDir)
        }
        // Seed the sidebar cache so the throttled background preload skips it.
        this.fsSummaries.set(sessionId, summary)
      }
    }

    if (persistedProjectRoot && payload.projectRoot !== persistedProjectRoot) {
      payload.projectRoot = persistedProjectRoot
    }
    if (persistedTemplateType && payload.templateType !== persistedTemplateType) {
      payload.templateType = persistedTemplateType
    }
  }

  async preloadFsSummaries(): Promise<void> {
    const storage = this.storageCoordinator.getStorage()
    if (!storage) return

    const preloadSpan = this.host.tracer.span('worker.manager.fsSummaries.preload')

    // Reuse the memoized routing scan (shared with the boot-critical
    // projectRoot reconcile) so `listSessions()` runs once, not twice.
    const listSpan = this.host.tracer.span('worker.fs.listSessions', {
      traceId: preloadSpan.traceId,
      parentSpanId: preloadSpan.spanId,
    })
    const sessionIds = await this.ensureSessionRouting()
    listSpan.end({ count: sessionIds?.length ?? 0, ok: sessionIds !== null })
    if (sessionIds === null) {
      // The routing scan FAILED (transient readdir error — distinct from an
      // empty profile, which resolves `[]`). Do NOT latch `preloadComplete`:
      // the reconcile's targeted-read path is gated on `!preloadComplete`, and
      // latching here with zero summaries would send every bound-session
      // resume to the sandbox for the worker's lifetime, even though the
      // failed scan is un-memoized and the next `ensureSessionRouting` caller
      // retries it. The preload itself stays one-shot — the sidebar shows
      // live sessions only until a reload — but resumes stay correct.
      preloadSpan.end({ ok: false })
      return
    }

    // One batched read (`fs.readBatch`), not a round-trip per session; `GroupedConversationStorage`
    // chunks it small so boot traffic is not starved.
    const batchSpan = this.host.tracer.span('worker.fs.loadSessionSummaryBatch', {
      traceId: preloadSpan.traceId,
      parentSpanId: preloadSpan.spanId,
      attrs: { sessions: sessionIds.length },
    })
    try {
      const summaries = await this.loadSummariesBatched(storage, sessionIds)
      for (const [sessionId, summary] of summaries) {
        this.fsSummaries.set(sessionId, summary)
      }
      batchSpan.end({ found: summaries.size })
    } catch {
      // The sidebar degrades to live sessions only for this pass; individual
      // sessions still resolve through `refreshFsSummary` as they are used.
      batchSpan.end({ ok: false })
    }
    preloadSpan.end({ count: sessionIds.length })

    this.preloadComplete = true
    this.host.onPreloadComplete()
  }

  /**
   * Batched summary read when the storage router supports it (the grouped,
   * home-anchored layout), falling back to the per-session path for the flat
   * layout, which has no projects tree and so no batch to make.
   */
  private async loadSummariesBatched(
    storage: BrowserConversationStorageBackend,
    sessionIds: readonly string[],
  ): Promise<Map<string, BrowserSessionSummary>> {
    // Sessions with a bound runtime own their `meta.json`; the batch reads
    // them but must not write a migrated file under their store's feet.
    const skipCommit = new Set(
      sessionIds.filter(sessionId => this.host.isSessionLive(sessionId)),
    )
    const batched = storage as BrowserConversationStorageBackend & {
      loadSessionSummariesBatch?: (
        ids: readonly string[],
        options?: { skipCommit?: ReadonlySet<string> },
      ) => Promise<Map<string, BrowserSessionSummary>>
    }
    if (batched.loadSessionSummariesBatch) {
      return batched.loadSessionSummariesBatch(sessionIds, { skipCommit })
    }

    const summaries = new Map<string, BrowserSessionSummary>()
    for (const sessionId of sessionIds) {
      try {
        const summary = await storage.loadSessionSummary?.(sessionId, {
          migrate: !skipCommit.has(sessionId),
        })
        if (summary) summaries.set(sessionId, summary)
      } catch {
        // one unreadable session must not cost the rest their rows
      }
    }
    return summaries
  }

  /** Derive title/preview/updatedAt from a streamed transcript batch into the live overlay. On the
   *  delta path (`mode`) the existing title, and the preview when the delta has no assistant text, are kept. */
  updateSessionMeta(
    sessionId: string,
    messages: unknown[],
    mode: 'full' | 'delta' = 'full',
  ): void {
    let title: string | undefined
    let previewText: string | undefined

    for (const msg of messages) {
      const m = msg as {
        type?: string
        message?: { content?: unknown }
        isMeta?: boolean
        toolUseResult?: unknown
      }
      const content = m.message?.content
      if (
        m.type === 'user' &&
        !title &&
        !m.isMeta &&
        !m.toolUseResult
      ) {
        title = this.extractText(content)
      }
      if (m.type === 'assistant') {
        previewText = this.extractText(content)
      }
    }

    if (!title && !previewText) return

    const updatedAt = this.extractLastTimestamp(messages)
    const prev = this.liveMeta.get(sessionId)
    const nextTitle = mode === 'delta' ? prev?.title : title
    const nextPreview =
      mode === 'delta' ? (previewText ?? prev?.previewText) : previewText
    const changed =
      nextTitle !== prev?.title ||
      nextPreview !== prev?.previewText ||
      updatedAt !== prev?.updatedAt
    if (!changed) return

    // Preserve a manual `customTitle` across stream-derived updates so a
    // new assistant turn never wipes a rename from the live overlay.
    this.liveMeta.set(sessionId, {
      ...prev,
      title: nextTitle,
      previewText: nextPreview,
      updatedAt,
    })
    this.host.notifySessionUpserted(sessionId)
  }

  /**
   * Merge a `worker.metadataUpdated` payload into the live overlay.
   * Merges only the fields the manager actually surfaces. Title/preview/
   * updatedAt continue to flow through `worker.messages` (transcript-
   * derived) so we don't overwrite them here even if metadata also
   * carries them. Composer draft fields are exclusive to this path.
   */
  applyMetadataUpdate(sessionId: string, metadata: BrowserSessionMetadata): void {
    const prev = this.liveMeta.get(sessionId) ?? {}
    const next: LiveMeta = { ...prev }
    if (typeof metadata.composerDraft === 'string') {
      next.composerDraft = metadata.composerDraft
    } else if ('composerDraft' in metadata) {
      // Explicit clear — tombstone, not delete: deleting
      // let the projection fall back to the fs cache's OLD draft until the
      // async refresh landed, resurrecting what the user just cleared.
      next.composerDraft = null
    }
    if (typeof metadata.lastComposerEditAt === 'number') {
      next.lastComposerEditAt = metadata.lastComposerEditAt
    }
    this.liveMeta.set(sessionId, next)
    this.host.notifySessionUpserted(sessionId)
    // Refresh fs summary asynchronously so the cache reflects the new
    // metadata once it lands on disk; harmless race because live wins
    // on conflict in `buildSessionInfo`.
    void this.refreshFsSummary(sessionId)
  }

  /** Re-read one session's persisted summary into the LRU, then notify
   *  subscribers via the host. Best-effort (span-traced). */
  async refreshFsSummary(sessionId: string): Promise<void> {
    const storage = this.storageCoordinator.getStorage()
    if (!storage) return
    const span = this.host.tracer.span('worker.fs.refreshSummary', {
      attrs: { sessionId },
    })
    try {
      const summary = await storage.loadSessionSummary(sessionId, {
        migrate: !this.host.isSessionLive(sessionId),
      })
      if (summary) {
        this.fsSummaries.set(sessionId, summary)
      }
      span.end({ found: !!summary })
    } catch {
      span.end({ ok: false })
      return
    }
    this.host.notifySessionUpserted(sessionId)
  }

  private extractLastTimestamp(messages: unknown[]): number | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      const timestamp = (messages[i] as { timestamp?: unknown })?.timestamp
      if (typeof timestamp === 'string') {
        const parsed = Date.parse(timestamp)
        if (Number.isFinite(parsed)) return parsed
      }
    }
    return undefined
  }

  private extractText(content: unknown): string | undefined {
    if (typeof content === 'string') return content.slice(0, 200)
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as { type?: string; text?: string }
        if (b.type === 'text' && typeof b.text === 'string') {
          return b.text.slice(0, 200)
        }
      }
    }
    return undefined
  }
}

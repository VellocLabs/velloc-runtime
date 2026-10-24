import { useCallback, useEffect, useRef, useState } from 'react'
import { sessionActivityTime } from './sessionTimeBucket'
import { hiddenSessionIds, pickNeighborSession } from './sessionVisibility'
import { cliOfTemplateType } from '../../prompting/templateCatalog'
import { randomUuid } from '../../utils/randomUuid'
import type { ForkRetarget } from '../worker/sharedWorkerProtocol'

function createFallbackSessionId(): string {
  return randomUuid()
}

export type LocalSessionEntry = {
  sessionId: string
  title: string
  /**
   * User-assigned title override (`customTitle`). When
   * set it IS `title`; tracked separately so derived-title updates from
   * `updateSessionMeta` don't overwrite a manual rename.
   */
  customTitle?: string
  previewText: string
  /** Creation time: the runtime's persisted one, else this webview's own for a
   *  session it created and the runtime has not persisted yet. Absent = unknown. */
  createdAt?: number
  updatedAt: number
  /**
   * Transcript messages seen for this session: `messageCount === 0` is the "is this session empty?" check
   * `openNewSession` reuses on. The title is not.
   */
  messageCount: number
  /**
   * In-progress composer text the user typed but hasn't sent yet.
   * Persisted via the worker's session metadata path so drafts survive
   * reloads and propagate to subscribers via session.updated.
   */
  composerDraft: string
  /**
   * Wall-clock time of the last composer keystroke that produced a
   * persisted change. Combined with `updatedAt` (last transcript
   * activity) via `Math.max` to give the sidebar's primary sort key,
   * so sessions where the user is *typing* float above sessions whose
   * transcript merely received an old reply.
   */
  lastComposerEditAt: number
  /**
   * Per-session agent template type (e.g. 'code') chosen by the thread
   * launcher; selects the prompt + tools at worker.init. `undefined` = the
   * boot default. Set at creation; not yet persisted across reloads.
   */
  templateType?: string
  /**
   * The lead session that spawned this one. Present ⇒ a teammate (child)
   * session: hidden from the sidebar, listed in its lead's tab strip.
   * Immutable identity — never resolved "newest wins" like the mutable
   * fields around it.
   */
  spawnerSessionId?: string
  /** This teammate's member name within its lead's team. */
  teammateName?: string
  shutdown?: boolean
  shutdownAt?: number
  /**
   * Bound project folder for a `code` session. Flows in from the persisted
   * session metadata (via the remote summary) and is read back by
   * `getSessionProjectRoot` so resume re-binds the same folder. `undefined` =
   * unbound (sandbox).
   */
  projectRoot?: string
  /**
   * When the user last re-launched this session from a launcher (reuse instead of a new id): a floor on
   * the merged `updatedAt`, so the reused session floats to the top. Local-only; survives the merge.
   */
  relaunchedAt?: number
  /** Pinned by the user. Owned by the runtime: taken from the remote summary only. */
  pinned?: boolean
  /** The title is a manual rename, which a CLI session's automatic title does not replace (F-34). */
  renamed?: boolean
}

export type SessionMetaUpdate = {
  title?: string
  previewText?: string
  updatedAt?: number
  messageCount?: number
  composerDraft?: string
  lastComposerEditAt?: number
}

export type RemoteSessionSummary = {
  sessionId: string
  title?: string
  customTitle?: string
  templateType?: string
  projectRoot?: string
  spawnerSessionId?: string
  teammateName?: string
  shutdown?: boolean
  shutdownAt?: number
  previewText?: string
  updatedAt?: number
  messageCount?: number
  composerDraft?: string
  lastComposerEditAt?: number
  createdAt?: number
  /** The runtime holds a persisted copy of this session. */
  persisted?: boolean
  pinned?: boolean
  renamed?: boolean
}

export type SessionManagerOptions = {
  openingSessionId: string
  onRequestDelete?: (sessionId: string, requestId: string) => void
  onRequestRename?: (
    sessionId: string,
    title: string,
    requestId: string,
  ) => void
  onRequestFork?: (
    fromSessionId: string,
    /** Absent = the whole conversation. */
    cutUuid: string | undefined,
    requestId: string,
    /**
     * The source session's REAL title — its user rename or AI title
     * (`customTitle` in the same merge the sidebar renders from) — or
     * undefined when it has only a derived first-prompt title. The shell names
     * the fork after it ("<title> (fork)"); an untitled source leaves the fork
     * to its own auto-title.
     */
    sourceTitle?: string,
    /**
     * Keep the cut message IN the fork (inclusive cut) instead of moving it to
     * the fork's composer. Set by "Send in a forked session", which copies the
     * whole conversation; "Fork from here" leaves it unset.
     */
    keepCutMessage?: boolean,
    /** The copy's own type and folder ("Continue in Code"). */
    retarget?: ForkRetarget,
  ) => void
}

export type SessionManagerState = {
  activeSessionId: string
  sessions: LocalSessionEntry[]
  /**
   * Mint (or reuse) a session. `projectRoot` binds it to a real project folder
   * at creation — the path the sidebar's Projects node launches through, which
   * is also what lets a `code` session skip the forced folder picker.
   */
  openNewSession: (templateType?: string, projectRoot?: string) => string
  getSessionTemplateType: (sessionId: string) => string | undefined
  getSessionProjectRoot: (sessionId: string) => string | undefined
  focusSession: (sessionId: string) => void
  /** `rowOrders`: row id lists in display order, tried in turn, so the successor is the deleted row's neighbor (see `pickNeighborSession`). */
  deleteSession: (sessionId: string, rowOrders?: readonly (readonly string[])[]) => void
  retitleSession: (sessionId: string, title: string) => void
  /** Returns the fork request's id — the `session.forked` ack echoes it. */
  forkSession: (
    fromSessionId: string,
    /** Absent = copy the whole conversation. */
    cutUuid: string | undefined,
    options?: { keepCutMessage?: boolean; retarget?: ForkRetarget },
  ) => string
  updateSessionMeta: (
    sessionId: string,
    meta: SessionMetaUpdate,
  ) => void
  applyRemoteList: (sessions: RemoteSessionSummary[]) => void
  applyRemoteUpdate: (session: RemoteSessionSummary) => void
  applyRemoteRemoval: (sessionId: string) => void
}

function effectiveSortTime(entry: LocalSessionEntry): number {
  return sessionActivityTime(entry.updatedAt, entry.lastComposerEditAt)
}

function sortSessions(entries: Iterable<LocalSessionEntry>): LocalSessionEntry[] {
  return Array.from(entries).sort((left, right) => {
    const leftTime = effectiveSortTime(left)
    const rightTime = effectiveSortTime(right)
    if (leftTime !== rightTime) {
      return rightTime - leftTime
    }

    return left.sessionId.localeCompare(right.sessionId)
  })
}

function createLocalSessionEntry(
  sessionId: string,
  updatedAt: number,
  templateType?: string,
  projectRoot?: string,
): LocalSessionEntry {
  return {
    sessionId,
    title: 'New Thread',
    previewText: '',
    createdAt: updatedAt,
    updatedAt,
    messageCount: 0,
    composerDraft: '',
    lastComposerEditAt: 0,
    ...(templateType ? { templateType } : {}),
    // A folder set HERE is what makes a project-launched session skip the
    // forced folder picker: `createSessionInitPayload` reads it back through
    // `getSessionProjectRoot` and names it in the open (an explicitly-bound
    // folder always wins, for any template type), so the runtime resolves a
    // real project root and `needsProjectFolder` is false.
    ...(projectRoot ? { projectRoot } : {}),
  }
}

/**
 * Rehydrate a whole `LocalSessionEntry` from the persisted remote summary: the one place the two shapes
 * are mapped, so callers never enumerate fields. Local-only defaults come from {@link createLocalSessionEntry}.
 */
function entryFromSummary(
  sessionId: string,
  summary: RemoteSessionSummary | undefined,
  fallbackTime: number,
): LocalSessionEntry {
  const base = createLocalSessionEntry(
    sessionId,
    summary?.updatedAt ?? fallbackTime,
    summary?.templateType,
    summary?.projectRoot,
  )
  if (!summary) return base

  return {
    ...base,
    title: summary.title ?? base.title,
    ...(summary.customTitle ? { customTitle: summary.customTitle } : {}),
    ...(summary.spawnerSessionId
      ? { spawnerSessionId: summary.spawnerSessionId }
      : {}),
    ...(summary.teammateName ? { teammateName: summary.teammateName } : {}),
    ...(summary.shutdown ? { shutdown: true } : {}),
    ...(typeof summary.shutdownAt === 'number'
      ? { shutdownAt: summary.shutdownAt }
      : {}),
    previewText: summary.previewText ?? base.previewText,
    messageCount: summary.messageCount ?? base.messageCount,
    composerDraft: summary.composerDraft ?? base.composerDraft,
    lastComposerEditAt:
      summary.lastComposerEditAt ?? base.lastComposerEditAt,
    ...(summary.pinned ? { pinned: true } : {}),
    ...(summary.renamed ? { renamed: true } : {}),
  }
}

/**
 * Coerce an `openNewSession(templateType?)` argument to `string | undefined`, so a miswired caller
 * (a React event as the argument) cannot reach the structured-cloned `worker.init` payload.
 */
export function normalizeStringArg(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** {@link normalizeStringArg} under its original name — the template-type call
 *  sites and their tests read better with the specific name. */
export const normalizeTemplateType = normalizeStringArg

/**
 * An empty thread (`messageCount === 0`) `openNewSession` may hand back instead of minting a new one.
 * Never reused: another `templateType`, a `customTitle`, or the active session (pass the id from
 * `activeSessionIdRef`), nor any CLI session. A project launch reuses only an empty bound to that folder; a plain launch prefers
 * an unbound empty but falls back to a bound one.
 */
export function findReusableEmptySession(
  sessions: readonly LocalSessionEntry[],
  templateType: string | undefined,
  projectRoot: string | undefined,
  activeSessionId: string | undefined,
): LocalSessionEntry | undefined {
  // A CLI session never counts messages, so "empty" says nothing about it (F-34).
  if (cliOfTemplateType(templateType)) return undefined
  const isReusable = (entry: LocalSessionEntry): boolean =>
    entry.messageCount === 0 &&
    entry.templateType === templateType &&
    !entry.customTitle &&
    entry.sessionId !== activeSessionId &&
    // A teammate is never reuse fodder for a launcher click: it belongs to
    // its lead, is not in the sidebar the user clicked from, and reusing it
    // would hand the user a session that vanishes with its lead.
    !entry.spawnerSessionId
  const exact = sessions.find(
    entry => isReusable(entry) && entry.projectRoot === projectRoot,
  )
  if (exact || projectRoot !== undefined) return exact
  return sessions.find(isReusable)
}

/**
 * Merge the worker's session summaries with the UI's local cache, newer wins per field: title / preview /
 * `updatedAt` on `updatedAt` (local on ties), draft fields on `lastComposerEditAt`.
 */
export function mergeSessions(
  remoteSummaries: readonly RemoteSessionSummary[],
  localCache: ReadonlyMap<string, LocalSessionEntry>,
): LocalSessionEntry[] {
  const merged = new Map<string, LocalSessionEntry>()

  for (const summary of remoteSummaries) {
    const local = localCache.get(summary.sessionId)
    const remoteUpdatedAt = summary.updatedAt ?? 0
    // An untouched empty placeholder never out-ranks a content-bearing remote summary, whatever its boot
    // timestamp.
    const localIsUntouchedPlaceholder =
      !!local &&
      local.messageCount === 0 &&
      !local.customTitle &&
      local.title === 'New Thread' &&
      local.previewText === ''
    const preferLocalTranscript =
      !!local &&
      !localIsUntouchedPlaceholder &&
      Number.isFinite(local.updatedAt) &&
      local.updatedAt >= remoteUpdatedAt

    const remoteLastComposerEditAt = summary.lastComposerEditAt ?? 0
    const preferLocalDraft =
      !!local &&
      Number.isFinite(local.lastComposerEditAt) &&
      local.lastComposerEditAt >= remoteLastComposerEditAt

    // messageCount is monotonically increasing; take whichever side
    // has seen more messages so a stale broadcast can never "un-empty"
    // a session into a state where reuse incorrectly skips it.
    const remoteMessageCount = summary.messageCount ?? 0
    const localMessageCount = local?.messageCount ?? 0
    const messageCount = Math.max(localMessageCount, remoteMessageCount)

    const remoteCustom =
      typeof summary.customTitle === 'string' && summary.customTitle.length > 0
        ? summary.customTitle
        : undefined
    const localCustom =
      typeof local?.customTitle === 'string' && local.customTitle.length > 0
        ? local.customTitle
        : undefined
    // Manual rename (customTitle) wins; the fresher side (by updatedAt)
    // decides when the two disagree, mirroring the derived-title rule.
    const customTitle = preferLocalTranscript
      ? localCustom ?? remoteCustom
      : remoteCustom ?? localCustom
    const derivedTitle =
      (preferLocalTranscript ? local?.title : summary.title) ||
      summary.title ||
      local?.title ||
      'New Thread'
    // A persisted session's creation time is the runtime's alone; a local
    // placeholder's "now" must not stand in for an unknown one.
    const createdAt =
      summary.createdAt ?? (summary.persisted ? undefined : local?.createdAt)

    merged.set(summary.sessionId, {
      sessionId: summary.sessionId,
      title: customTitle ?? derivedTitle,
      ...(customTitle !== undefined ? { customTitle } : {}),
      ...((local?.templateType ?? summary.templateType)
        ? { templateType: local?.templateType ?? summary.templateType }
        : {}),
      ...((local?.projectRoot ?? summary.projectRoot)
        ? { projectRoot: local?.projectRoot ?? summary.projectRoot }
        : {}),
      // Immutable identity, so it is taken unconditionally rather than
      // through `preferLocalTranscript` / `preferLocalDraft`: a remote
      // summary that knows the parent must never be overridden by a local
      // placeholder that predates the spawn.
      ...((summary.spawnerSessionId ?? local?.spawnerSessionId)
        ? { spawnerSessionId: summary.spawnerSessionId ?? local?.spawnerSessionId }
        : {}),
      ...((summary.teammateName ?? local?.teammateName)
        ? { teammateName: summary.teammateName ?? local?.teammateName }
        : {}),
      ...((summary.shutdown ?? local?.shutdown)
        ? { shutdown: summary.shutdown ?? local?.shutdown }
        : {}),
      ...((summary.shutdownAt ?? local?.shutdownAt)
        ? { shutdownAt: summary.shutdownAt ?? local?.shutdownAt }
        : {}),
      previewText:
        (preferLocalTranscript ? local?.previewText : summary.previewText) ||
        summary.previewText ||
        local?.previewText ||
        '',
      ...(createdAt !== undefined ? { createdAt } : {}),
      // `relaunchedAt` is a FLOOR, not a source: re-launching an empty
      // session floats it to the top without touching the title/preview
      // resolution above (which must still prefer the persisted summary).
      // A live session with no transcript yet has no remote clock; its local
      // creation time must stand in, or the row sorts below every older one (F-17).
      updatedAt: Math.max(
        preferLocalTranscript
          ? local.updatedAt
          : summary.updatedAt ?? local?.updatedAt ?? 0,
        local?.relaunchedAt ?? 0,
      ),
      ...(local?.relaunchedAt !== undefined
        ? { relaunchedAt: local.relaunchedAt }
        : {}),
      messageCount,
      composerDraft: preferLocalDraft
        ? local.composerDraft
        : summary.composerDraft ?? local?.composerDraft ?? '',
      lastComposerEditAt: preferLocalDraft
        ? local.lastComposerEditAt
        : remoteLastComposerEditAt,
      ...(summary.pinned ? { pinned: true } : {}),
      // The runtime's word, unless this client renamed it since.
      ...(summary.renamed || (preferLocalTranscript && local?.renamed) ? { renamed: true } : {}),
    })
  }

  for (const [sessionId, entry] of localCache) {
    if (!merged.has(sessionId)) {
      merged.set(sessionId, entry)
    }
  }

  return sortSessions(merged.values())
}

export function useSessionManager(
  options: SessionManagerOptions,
): SessionManagerState {
  const initialUpdatedAt = useRef(Date.now())
  const [activeSessionId, setActiveSessionId] = useState(
    options.openingSessionId,
  )
  // Mirror of `activeSessionId` readable from a callback that runs BEFORE the
  // next render (two launcher clicks in one tick): `openNewSession` both reads
  // the active id (reuse exclusion) and writes it, so the state value alone
  // would be stale for the second click.
  const activeSessionIdRef = useRef(options.openingSessionId)
  const selectSession = useCallback((sessionId: string) => {
    activeSessionIdRef.current = sessionId
    setActiveSessionId(sessionId)
  }, [])
  const [sessions, setSessions] = useState<LocalSessionEntry[]>([])

  const localCacheRef = useRef(new Map<string, LocalSessionEntry>())
  const remoteSummariesRef = useRef(new Map<string, RemoteSessionSummary>())
  // Sessions this client deleted: a late write for one (a composer draft
  // flushed as its thread unmounts) must not re-create its row.
  const deletedSessionIdsRef = useRef(new Set<string>())
  // The boot id this hook last seeded a placeholder for — see below.
  const seededInitialSessionIdRef = useRef<string | null>(null)
  const onRequestDeleteRef = useRef(options.onRequestDelete)
  onRequestDeleteRef.current = options.onRequestDelete
  const onRequestRenameRef = useRef(options.onRequestRename)
  onRequestRenameRef.current = options.onRequestRename
  const onRequestForkRef = useRef(options.onRequestFork)
  onRequestForkRef.current = options.onRequestFork

  // Seed the boot session's placeholder ONCE per boot id, not on every render.
  // Deleting a session (`deleteSession`, or the worker's `session.removed` via
  // `applyRemoteRemoval`) drops its local entry, and a render-time
  // "missing → add" check put a deleted boot session straight back as an empty
  // "New Thread" on the next render. The row returned to the sidebar, and
  // because it is empty and not active, the next launcher click reused the
  // dead id (`findReusableEmptySession`), silently handing the user a session
  // the worker had already disposed and deleted from disk.
  if (seededInitialSessionIdRef.current !== options.openingSessionId) {
    seededInitialSessionIdRef.current = options.openingSessionId
    if (!localCacheRef.current.has(options.openingSessionId)) {
      localCacheRef.current.set(
        options.openingSessionId,
        createLocalSessionEntry(
          options.openingSessionId,
          initialUpdatedAt.current,
        ),
      )
    }
  }

  const mergeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const applyMergedSessions = useCallback(() => {
    if (mergeDebounceRef.current !== null) {
      clearTimeout(mergeDebounceRef.current)
    }
    mergeDebounceRef.current = setTimeout(() => {
      mergeDebounceRef.current = null
      setSessions(
        mergeSessions(
          Array.from(remoteSummariesRef.current.values()),
          localCacheRef.current,
        ),
      )
    }, 16)
  }, [])

  useEffect(() => {
    return () => {
      if (mergeDebounceRef.current !== null) {
        clearTimeout(mergeDebounceRef.current)
        mergeDebounceRef.current = null
      }
    }
  }, [])

  const openNewSession = useCallback((
    templateType?: string,
    projectRoot?: string,
  ) => {
    // Defense-in-depth — see `normalizeTemplateType`: a miswired caller
    // (`onClick={openNewSession}`) would otherwise inject a React
    // SyntheticEvent here, which rides into the `worker.init` payload and
    // throws `DataCloneError`, wedging the new session's boot.
    const safeTemplateType = normalizeTemplateType(templateType)
    // Same defense for the folder: only a real string is a project binding.
    const safeProjectRoot = normalizeStringArg(projectRoot)
    const merged = mergeSessions(
      Array.from(remoteSummariesRef.current.values()),
      localCacheRef.current,
    )
    // Reuse an empty same-type session that ISN'T the active one — see
    // `findReusableEmptySession` for the full rule. The active id comes from
    // the ref, not from state: this callback both reads and writes it, so a
    // second click in the same tick would read a stale value off state.
    const existingEmpty = findReusableEmptySession(
      merged,
      safeTemplateType,
      safeProjectRoot,
      activeSessionIdRef.current,
    )
    if (existingEmpty) {
      // Float the reused session to the top of the list — a launcher click
      // must LOOK like it did something, and a reused empty session sitting
      // mid-list (its clock is the moment it was created, possibly days ago)
      // looks like nothing happened. See `relaunchedAt`.
      const relaunchedAt = Date.now()
      const base = localCacheRef.current.get(existingEmpty.sessionId) ??
        existingEmpty
      localCacheRef.current.set(existingEmpty.sessionId, {
        ...base,
        updatedAt: Math.max(base.updatedAt, relaunchedAt),
        relaunchedAt,
      })
      selectSession(existingEmpty.sessionId)
      applyMergedSessions()
      return existingEmpty.sessionId
    }

    const updatedAt = Date.now()
    const newId = createFallbackSessionId()
    localCacheRef.current.set(
      newId,
      createLocalSessionEntry(
        newId,
        updatedAt,
        safeTemplateType,
        safeProjectRoot,
      ),
    )
    selectSession(newId)
    applyMergedSessions()
    return newId
  }, [applyMergedSessions, selectSession])

  // Resolve a session's launcher-chosen template type (read at worker.init
  // by MultiSessionShell). Reads the local cache, where openNewSession
  // records it synchronously before the client mounts.
  const getSessionTemplateType = useCallback(
    (sessionId: string): string | undefined =>
      localCacheRef.current.get(sessionId)?.templateType ??
      remoteSummariesRef.current.get(sessionId)?.templateType,
    [],
  )

  // Resolve a `code` session's bound project folder (read at worker.init by
  // MultiSessionShell's `createSessionInitPayload` to auto-bind on resume).
  // Reads the local cache, then the persisted remote summary — so a folder
  // bound in a previous run survives reload.
  const getSessionProjectRoot = useCallback(
    (sessionId: string): string | undefined =>
      localCacheRef.current.get(sessionId)?.projectRoot ??
      remoteSummariesRef.current.get(sessionId)?.projectRoot,
    [],
  )

  const focusSession = useCallback(
    (sessionId: string) => {
      selectSession(sessionId)
    },
    [selectSession],
  )

  const deleteSession = useCallback(
    (sessionId: string, rowOrders?: readonly (readonly string[])[]) => {
      // Every known session, deleted row included, so the successor is that
      // row's neighbor in `rowOrder`. The deleted session is on screen
      // when it is active or one of its teammates is (a lead's teammates go
      // with it).
      const before = mergeSessions(
        Array.from(remoteSummariesRef.current.values()),
        localCacheRef.current,
      )
      const activeId = activeSessionIdRef.current
      const deletesActive =
        sessionId === activeId ||
        before.some(
          entry =>
            entry.sessionId === activeId &&
            entry.spawnerSessionId === sessionId,
        )
      localCacheRef.current.delete(sessionId)
      remoteSummariesRef.current.delete(sessionId)
      deletedSessionIdsRef.current.add(sessionId)

      // Read AND write the active id through the ref/`selectSession` pair. A ref still naming the deleted id
      // excludes nothing in `findReusableEmptySession`, so the newly-active empty session would be reused and the
      // next launcher click would be a no-op.
      if (deletesActive) {
        // Teammates and sessions this channel hides are excluded from the
        // succession: neither is a sidebar row, so promoting one would leave
        // the UI showing a session the list does not contain.
        const next = pickNeighborSession(
          before,
          sessionId,
          hiddenSessionIds(before),
          rowOrders,
        )

        if (next) {
          selectSession(next.sessionId)
        } else {
          const fallbackId = createFallbackSessionId()
          localCacheRef.current.set(
            fallbackId,
            createLocalSessionEntry(fallbackId, Date.now()),
          )
          selectSession(fallbackId)
        }
      }

      applyMergedSessions()

      const requestId = randomUuid()
      onRequestDeleteRef.current?.(sessionId, requestId)
    },
    [applyMergedSessions, selectSession],
  )

  const retitleSession = useCallback(
    (sessionId: string, title: string) => {
      const trimmed = title.trim()
      const existing = localCacheRef.current.get(sessionId)
      const remote = remoteSummariesRef.current.get(sessionId)
      if (!trimmed) {
        // An empty title clears the rename; the runtime's next summary carries the automatic title.
        if (!existing?.customTitle && !remote?.customTitle) return
        if (existing) {
          const { customTitle: _cleared, ...rest } = existing
          localCacheRef.current.set(sessionId, { ...rest, title: '', renamed: false })
          applyMergedSessions()
        }
        onRequestRenameRef.current?.(sessionId, '', randomUuid())
        return
      }
      const now = Date.now()
      // Spread a whole entry and override only what a rename changes. `customTitle` and a fresh `updatedAt`
      // make the next `mergeSessions` keep the local title.
      localCacheRef.current.set(sessionId, {
        ...(existing ?? entryFromSummary(sessionId, remote, now)),
        title: trimmed,
        customTitle: trimmed,
        renamed: true,
        updatedAt: now,
        // messageCount is monotonic and the two sides can disagree: a local
        // entry that predates the latest broadcast must not un-count the
        // session (a session counted back down to 0 becomes a reuse candidate
        // for the thread launcher).
        messageCount: Math.max(
          existing?.messageCount ?? 0,
          remote?.messageCount ?? 0,
        ),
      })
      applyMergedSessions()

      const requestId = randomUuid()
      onRequestRenameRef.current?.(sessionId, trimmed, requestId)
    },
    [applyMergedSessions],
  )

  // Fork a session at a message: the manager copies the transcript prefix into
  // a NEW session and replies `session.forked`, at which point the UI switches.
  // No optimistic local entry — the new sessionId is manager-assigned and
  // arrives via the broadcast + ack.
  const forkSession = useCallback((
    fromSessionId: string,
    cutUuid: string | undefined,
    options?: { keepCutMessage?: boolean; retarget?: ForkRetarget },
  ): string => {
    const requestId = randomUuid()
    // The source's REAL title — a user rename or the AI title, i.e. the
    // merged entry's `customTitle` (the same merge the sidebar renders from,
    // so it is what the user sees). Deliberately NOT the derived first-prompt
    // fallback: the fork's title becomes a persisted user title, which would
    // pin "<first prompt> (fork)" forever and block the fork's own auto-title.
    // A source that is still only first-prompt-titled leaves the fork
    // untitled, so it gets its own AI title like any new session.
    const sourceTitle = mergeSessions(
      Array.from(remoteSummariesRef.current.values()),
      localCacheRef.current,
    ).find(entry => entry.sessionId === fromSessionId)?.customTitle
    onRequestForkRef.current?.(
      fromSessionId,
      cutUuid,
      requestId,
      // A retargeted copy is a new piece of work, not "<title> (fork)".
      options?.retarget ? undefined : sourceTitle || undefined,
      options?.keepCutMessage,
      options?.retarget,
    )
    return requestId
  }, [])

  const updateSessionMeta = useCallback(
    (sessionId: string, meta: SessionMetaUpdate) => {
      const existing = localCacheRef.current.get(sessionId)
      const remote = remoteSummariesRef.current.get(sessionId)
      if (!existing && !remote && deletedSessionIdsRef.current.has(sessionId)) {
        return
      }
      // Merge the two sources ONCE, into a whole entry: everything below reads
      // this base, and the write at the end overrides only the fields this
      // update actually touches. The alternative — an `existing?.X ??
      // remote?.X ?? default` ladder plus a matching literal — is a closed set
      // of keys that silently drops every field added later. That is exactly
      // how `relaunchedAt` came to need an explicit carry-across line here.
      const base =
        existing ??
        entryFromSummary(sessionId, remote, meta.updatedAt ?? Date.now())

      // A manual rename pins the title: derived `meta.title` updates must
      // not move it (they still update preview / draft / messageCount).
      const hasCustomTitle =
        typeof base.customTitle === 'string' && base.customTitle.length > 0
      const customTitle = hasCustomTitle ? base.customTitle : undefined

      const titleChanged =
        !hasCustomTitle && meta.title !== undefined && meta.title !== base.title
      const previewChanged =
        meta.previewText !== undefined && meta.previewText !== base.previewText
      const explicitUpdatedAtChanged =
        meta.updatedAt !== undefined && meta.updatedAt !== base.updatedAt
      const draftChanged =
        meta.composerDraft !== undefined &&
        meta.composerDraft !== base.composerDraft
      const lastComposerEditAtChanged =
        meta.lastComposerEditAt !== undefined &&
        meta.lastComposerEditAt !== base.lastComposerEditAt

      // Only a session that ALREADY has a local entry can be left alone —
      // without one there is nothing cached to leave, so the synthesized base
      // must be written even when the update carries no new information.
      if (
        existing &&
        !titleChanged &&
        !previewChanged &&
        !explicitUpdatedAtChanged &&
        !draftChanged &&
        !lastComposerEditAtChanged
      ) {
        return
      }

      const nextUpdatedAt =
        meta.updatedAt ??
        (titleChanged || previewChanged || !existing
          ? Date.now()
          : base.updatedAt)

      // messageCount is monotonic — keep the larger of (current local,
      // current remote, explicit update). A composer-only update
      // (the common case from `handleComposerEdit`) leaves it
      // unchanged.
      const currentMessageCount = Math.max(
        base.messageCount,
        remote?.messageCount ?? 0,
      )
      const nextMessageCount =
        meta.messageCount !== undefined
          ? Math.max(currentMessageCount, meta.messageCount)
          : currentMessageCount

      // Override, never re-enumerate. Fields this update does not speak for —
      // `createdAt`, `templateType`, `projectRoot`, `relaunchedAt` (the
      // launcher's sort floor), `customTitle`, and anything added later —
      // ride along on the spread.
      localCacheRef.current.set(sessionId, {
        ...base,
        title: customTitle ?? meta.title ?? base.title,
        previewText: meta.previewText ?? base.previewText,
        updatedAt: nextUpdatedAt,
        messageCount: nextMessageCount,
        composerDraft: meta.composerDraft ?? base.composerDraft,
        lastComposerEditAt:
          meta.lastComposerEditAt ?? base.lastComposerEditAt,
      })

      applyMergedSessions()
    },
    [applyMergedSessions],
  )

  const applyRemoteList = useCallback(
    (incoming: RemoteSessionSummary[]) => {
      const next = new Map<string, RemoteSessionSummary>()
      for (const entry of incoming) {
        next.set(entry.sessionId, entry)
      }
      remoteSummariesRef.current = next
      applyMergedSessions()
    },
    [applyMergedSessions],
  )

  const applyRemoteUpdate = useCallback(
    (entry: RemoteSessionSummary) => {
      remoteSummariesRef.current.set(entry.sessionId, entry)
      applyMergedSessions()
    },
    [applyMergedSessions],
  )

  const applyRemoteRemoval = useCallback(
    (sessionId: string) => {
      remoteSummariesRef.current.delete(sessionId)
      localCacheRef.current.delete(sessionId)
      applyMergedSessions()
    },
    [applyMergedSessions],
  )

  return {
    activeSessionId,
    sessions,
    openNewSession,
    getSessionTemplateType,
    getSessionProjectRoot,
    focusSession,
    deleteSession,
    retitleSession,
    forkSession,
    updateSessionMeta,
    applyRemoteList,
    applyRemoteUpdate,
    applyRemoteRemoval,
  }
}

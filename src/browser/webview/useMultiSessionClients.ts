import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppendMessage } from '@assistant-ui/react'
import type { BrowserBridgeTransport } from '../bridge/browserBridgeProtocol'
import type { RuntimeFileAccess } from '../runtimeClient/fileAccess'
import type { FsxListDirResult, FsxListTreeResult, FsxSearchState } from '../runtimeProtocol'
import type { FileSearchRequest } from '../runtimeClient/fileAccess'
import type { BrowserLlmSelection } from '../bridge/browserBridgeProtocol'
import type { AgentRuntimeWorkerInitPayload } from '../worker/workerProtocol'
import type { RuleEdit } from '../../permissions/ruleUpdates'
import {
  deriveSessionMetadataFromMessages,
  type BrowserSessionMetadata,
} from '../../sessions/sessionStore'
import { isBridgeTraceEnabled } from '../bridge/tracer'
import { setE2eTestCode } from './windowTitle'
import { installSessionTracer } from '../../utils/sessionTrace'
import {
  BrowserRuntimeClient,
  type BrowserRuntimeClientState,
  type BrowserRuntimeToolResultSubmission,
  type BrowserWorkerClientTransport,
  type InjectRemoveResult,
  type SubmitDelivery,
} from './BrowserRuntimeClient'
import type { BrowserToolCallDetailRecord } from '../../utils/toolCallDetails'
import type { BundledSkillBodyResult } from '../../skillLibrary/builtinSkillBody'
import type { TurnFileChange } from '../../utils/turnDiffs'
import { isTeammateSessionId } from '../../utils/sidechainStoragePaths'

/**
 * The designed test interface. Additive companion to the bare
 * `__NEXUS_E2E_CLIENT__` slot (which stays a raw BrowserRuntimeClient for
 * back-compat with existing specs). This object is STABLE: prefer it over
 * reaching into `getState().snapshot.*` via evaluate(). 
 */
export interface NexusE2eTestApi {
  /** The active session's runtime client (re-pointed on every switch). */
  getClient(): BrowserRuntimeClient | undefined
  /** The active client's current state, or undefined if none is installed. */
  getState(): BrowserRuntimeClientState | undefined
  /**
   * Resolve when `predicate(state)` first holds. Event-driven via the
   * client's `subscribe` (NOT polling) — fires on every state push and
   * checks immediately, so an already-satisfied predicate resolves at once.
   * Rejects on timeout. Tracks the ACTIVE client across session switches.
   */
  waitUntil(
    predicate: (state: BrowserRuntimeClientState) => boolean,
    timeoutMs?: number,
  ): Promise<BrowserRuntimeClientState>
  /** Resolve when the active client's status equals `target` (or any of). */
  waitForStatus(target: string | string[], timeoutMs?: number): Promise<void>
  /** Subscribe to active-client state pushes; returns an unsubscribe fn. */
  on(listener: (state: BrowserRuntimeClientState) => void): () => void
  /** The page modules specs drive directly (extra runtime connections, the
   *  workspace store, cold-panel warm-up), resolved the same way in a dev
   *  server and in a built bundle. */
  loadTestModules(): Promise<typeof import('./e2eTestModules')>
  /** Recent status transitions (ring buffer, newest last) for failure
   *  diagnostics — replay "what the client did" when a wait times out. */
  getEventLog(): ReadonlyArray<{
    ts: number
    status: string
    sessionId?: string
    lastError?: string
  }>
  /**
   * Set the running e2e test's code (its stable test id), which the guest prefixes
   * onto the NATIVE window title.
   * The e2e harness calls this on every guest bring-up; nothing else should.
   * See G-2.
   */
  setTestCode(code: string): void
}

declare global {
  // eslint-disable-next-line no-var
  var __NEXUS_E2E_CLIENT__: BrowserRuntimeClient | undefined
  // eslint-disable-next-line no-var
  var __NEXUS_E2E__: NexusE2eTestApi | undefined
}

// The active client the test API tracks. Re-pointed by the install helper on
// every session switch so `__NEXUS_E2E__` always reflects the visible thread.
let activeTestClient: BrowserRuntimeClient | undefined
// Unsubscribe for the data-* state stamper bound to the current active client.
let stateStamperUnsub: (() => void) | null = null

/** N4: a small ring buffer of status transitions so a spec timeout can print
 *  the recent state history ("ready → submitting → ready, tool never appeared")
 *  instead of just the final frozen state. Fed by the state stamper. */
interface E2eTransition {
  ts: number
  status: string
  sessionId?: string
  lastError?: string
}
const E2E_EVENT_LOG_CAP = 100
const e2eEventLog: E2eTransition[] = []
let lastLoggedStatus: string | undefined

/**
 * Reflect runtime-state fields onto document-root `data-*` attributes (`data-client-status`) so specs can
 * wait declaratively. Stamped synchronously on each state push (rAF may never fire); a stamping error
 * never reaches the subscribe path. Returns the unsubscribe.
 */
function bindStateSignalStamper(client: BrowserRuntimeClient): () => void {
  const stamp = (state: BrowserRuntimeClientState) => {
    if (typeof document === 'undefined') return
    try {
      const root = document.documentElement
      const snap = state.snapshot as
        | { toolNames?: unknown[]; commandNames?: unknown[]; sessionId?: string }
        | null
        | undefined
      root.setAttribute('data-client-status', state.status ?? '')
      root.setAttribute(
        'data-tools-count',
        String(Array.isArray(snap?.toolNames) ? snap!.toolNames!.length : 0),
      )
      root.setAttribute(
        'data-slash-count',
        String(
          Array.isArray(snap?.commandNames) ? snap!.commandNames!.length : 0,
        ),
      )
      if (snap?.sessionId) root.setAttribute('data-session-id', snap.sessionId)
      root.setAttribute('data-last-error', state.lastError?.code ?? '')
      // N4: record a transition when the status (or error) changes.
      const status = state.status ?? ''
      const errCode = state.lastError?.code ?? ''
      if (status !== lastLoggedStatus || errCode) {
        lastLoggedStatus = status
        e2eEventLog.push({
          ts: Date.now(),
          status,
          sessionId: snap?.sessionId,
          ...(errCode ? {lastError: errCode} : {}),
        })
        if (e2eEventLog.length > E2E_EVENT_LOG_CAP) e2eEventLog.shift()
      }
    } catch {
      /* never let a test-signal stamp break the client subscribe path */
    }
  }
  return client.subscribe(stamp)
}

/**
 * Opt-in test hook: when the e2e trace flag is set (same `?e2eTrace=1` query
 * switch that turns on `installBridgeTracerIfEnabled`), stash the active
 * BrowserRuntimeClient on `globalThis.__NEXUS_E2E_CLIENT__` (raw, back-compat)
 * AND expose the designed `globalThis.__NEXUS_E2E__` interface + the data-*
 * state signals. No-op in production.
 */
function installRuntimeClientTestHookIfEnabled(
  client: BrowserRuntimeClient,
) {
  if (!isBridgeTraceEnabled()) return
  globalThis.__NEXUS_E2E_CLIENT__ = client
  activeTestClient = client
  // Rebind the data-* stamper to the now-active client.
  if (stateStamperUnsub) stateStamperUnsub()
  stateStamperUnsub = bindStateSignalStamper(client)
  // Install the stable API once; it reads `activeTestClient` dynamically so it
  // survives session switches without re-installation.
  if (!globalThis.__NEXUS_E2E__) {
    globalThis.__NEXUS_E2E__ = createNexusE2eTestApi()
  }
}

function createNexusE2eTestApi(): NexusE2eTestApi {
  const waitUntil: NexusE2eTestApi['waitUntil'] = (predicate, timeoutMs = 30_000) =>
    new Promise((resolve, reject) => {
      const client = activeTestClient
      if (!client) {
        reject(new Error('__NEXUS_E2E__.waitUntil: no active client installed'))
        return
      }
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        unsub()
        reject(
          new Error(
            `__NEXUS_E2E__.waitUntil timed out after ${timeoutMs}ms; ` +
              `last status=${client.getState().status}`,
          ),
        )
      }, timeoutMs)
      // subscribe() invokes the listener immediately with current state, so an
      // already-satisfied predicate resolves synchronously on this tick.
      const unsub = client.subscribe(state => {
        if (settled || !predicate(state)) return
        settled = true
        clearTimeout(timer)
        // Defer unsub: subscribe may still be inside its synchronous initial
        // call when this fires.
        queueMicrotask(() => unsub())
        resolve(state)
      })
    })
  return {
    getClient: () => activeTestClient,
    getState: () => activeTestClient?.getState(),
    waitUntil,
    waitForStatus: (target, timeoutMs) => {
      const targets = Array.isArray(target) ? target : [target]
      return waitUntil(s => targets.includes(s.status), timeoutMs).then(
        () => undefined,
      )
    },
    on: listener => {
      const client = activeTestClient
      if (!client) return () => {}
      return client.subscribe(listener)
    },
    loadTestModules: () => import('./e2eTestModules'),
    getEventLog: () => e2eEventLog.slice(),
    // Stamp the running test's code into the native window title. The harness calls this on every guest
    // bring-up: a `useSharedNexus` file shares one browser. (G-2)
    setTestCode: (code: string) => setE2eTestCode(code),
  }
}

/**
 * Mirror of the install helper for teardown. When a client is being disposed,
 * only clear the global if it still points at *this* client — otherwise we'd
 * race with a newer client that already took the slot.
 */
function uninstallRuntimeClientTestHookIfMatch(
  client: BrowserRuntimeClient,
) {
  if (globalThis.__NEXUS_E2E_CLIENT__ === client) {
    globalThis.__NEXUS_E2E_CLIENT__ = undefined
  }
  if (activeTestClient === client) {
    activeTestClient = undefined
    if (stateStamperUnsub) {
      stateStamperUnsub()
      stateStamperUnsub = null
    }
  }
}

const BLANK_CLIENT_STATE: BrowserRuntimeClientState = {
  status: 'idle',
  snapshot: null,
  transcriptMessages: [],
  liveEvents: [],
  lastError: null,
  pendingPrompt: null,
  pendingPromptId: null,
}

export type MultiSessionClientsOptions = {
  activeSessionId: string
  shutdownSessionIds?: ReadonlySet<string>
  /**
   * Sessions whose subtrees stay mounted; each gets a `BrowserRuntimeClient` and an entry in
   * `sessionStates`. Always include `activeSessionId`; the LRU policy is the caller's.
   */
  mountedSessionIds: string[]
  createWorkerTransport: () => BrowserWorkerClientTransport
  hostBridgeTransport: BrowserBridgeTransport
  /** See `BrowserRuntimeClientOptions.files`. */
  files?: RuntimeFileAccess
  createInitPayload: (sessionId: string) => AgentRuntimeWorkerInitPayload
  onSessionStateChange?: (
    sessionId: string,
    state: BrowserRuntimeClientState,
    metadata: BrowserSessionMetadata,
  ) => void
}

export type MultiSessionClientsResult = {
  /** Current state of the active session — convenience accessor. */
  activeState: BrowserRuntimeClientState
  /**
   * State for every mounted session (including the active one). Keyed
   * by sessionId. Updated on every push from the per-session client.
   * Caller iterates this to render mounted thread trees with
   * display:none on non-active.
   */
  sessionStates: ReadonlyMap<string, BrowserRuntimeClientState>
  submitPrompt: (prompt: string) => Promise<void>
  /** Submit a hidden, model-only turn (A2UI surface actions) on the active session. */
  submitActionMessage: (prompt: string) => Promise<void>
  /** Resume the active session's interrupted/completed conversation via a
   *  hidden `isMeta` continuation (the composer's Continue button). */
  continueConversation: () => Promise<void>
  submitComposerMessage: (
    message: AppendMessage,
    options?: { delivery?: SubmitDelivery },
  ) => Promise<void>
  /** `submitComposerMessage` into a named session (not necessarily active). */
  submitComposerMessageToSession: (
    sessionId: string,
    message: AppendMessage,
    options?: { delivery?: SubmitDelivery },
  ) => Promise<void>
  submitToolResult: (
    submission: BrowserRuntimeToolResultSubmission,
  ) => Promise<void>
  loadToolCallDetail: (
    toolCallId: string,
  ) => Promise<BrowserToolCallDetailRecord | null>
  loadTurnDiffDetail: (turnIndex: number) => Promise<TurnFileChange[] | null>
  /** Ask the active session's worker for its turn-diff history (computed on
   *  first need; the open sends only the stored change figures). */
  requestTurnDiffHistory: () => void
  /** Resolve a BUNDLED skill's displayable body from the active session's
   *  worker (Skills tab — `bundled:<name>` paths have no on-disk SKILL.md).
   *  Resolves null when no active client. */
  loadBundledSkillBody: (
    name: string,
  ) => Promise<BundledSkillBodyResult | null>
  /** Read a file's full UTF-8 contents from the host fs bridge (right-panel
   *  Files view). Resolves null when no active client; rejects on bridge error. */
  readFileText: (path: string) => Promise<string | null>
  /** A directory's entries for the Files pane's browse state (`fsx.listDir`).
   *  Resolves null when no active client; rejects on a runtime error. */
  listDir: (path: string) => Promise<FsxListDirResult | null>
  /** The tree below `path` for the Files pane's go-to-file index
   *  (`fsx.listTree`). Resolves null when no active client; rejects on a
   *  runtime error. */
  listTree: (path: string, depth?: number) => Promise<FsxListTreeResult | null>
  /** One Files pane search through the ACTIVE session's client; resolves with the function that
   *  ends it, or null with no active client. Rejects when the search cannot start. */
  startFileSearch: (
    request: FileSearchRequest,
    onState: (state: FsxSearchState) => void,
  ) => Promise<(() => void) | null>
  /** Batched `isFile` check for the transcript's auto-detected paths. */
  statFilePaths: (
    paths: string[],
  ) => Promise<Array<{ path: string; isFile: boolean }>>
  /** Write UTF-8 text back to a file via the host fs bridge (right-panel Files
   *  view editable mode). Resolves false when no active client; rejects on
   *  bridge error. */
  writeFileText: (path: string, text: string) => Promise<boolean>
  /** Open the host's native multi-file picker (composer paperclip) on the
   *  active client and return the chosen files as `File`s; [] when canceled or
   *  no active client. `allowImages: false` tells the dialog's default filter
   *  group to withhold image extensions (active model is text-only). */
  pickComposerAttachmentFiles: (options?: {
    allowImages?: boolean
  }) => Promise<File[]>
  setModelSelection: (selection: BrowserLlmSelection) => Promise<void>
  /** Apply a selection to the NAMED session (the composer's effort control),
   *  whichever session is active. A teammate keeps its model, as above. */
  setModelSelectionForSession: (
    sessionId: string,
    selection: BrowserLlmSelection,
  ) => Promise<void>
  /** Save (tokens) or clear (`'auto'`) the NAMED session's active model's
   *  auto-compact window (the composer popover's drag handle). */
  setAutoCompactWindowForSession: (
    sessionId: string,
    value: number | 'auto',
  ) => Promise<void>
  setPermissionMode: (mode: string) => Promise<void>
  /** Persist the bypass-warning acknowledgment (F-13) on the active session. */
  setSkipDangerousMode: (value: boolean) => Promise<void>
  /** Clear the active session's saved "next message" (NextMessageStrip ×). The
   *  client hides the strip optimistically + ignores stale updates until the
   *  manager's `worker.pendingMessageCleared` confirms. */
  clearPendingMessage: () => void
  removeInjectMessage: (uuid: string) => Promise<InjectRemoveResult>
  /** Resolve a queued interactive tool confirmation (one ask at a time). */
  resolveToolUseConfirm: (params: {
    approvalCallId: string
    behavior: 'allow' | 'reject' | 'abort'
    updatedInput?: Record<string, unknown>
    feedback?: string
    ruleEdits?: RuleEdit[]
  }) => Promise<void>
  /** Resolve a pending plan approval on the active session: clear it in the
   *  engine and pull a fresh snapshot so the plan-approval control dismisses
   *  immediately (called before setPermissionMode + submitToolResult). */
  clearPlanApproval: (toolCallId?: string) => Promise<void>
  /** Grant an allow rule from the ask-modal banner: adds it
   *  to the active session's live rule list (+ settings.json when `persist`). */
  addPermissionRule: (params: {
    rule: string
    toolCallId: string
    persist: boolean
  }) => Promise<void>
  /** Apply a general RuleEdit (F-13) to the active session — used by
   *  the banner's "Allow this folder" (addDirectories). */
  applyPermissionUpdate: (params: {
    update: RuleEdit
    toolCallId?: string
  }) => Promise<void>
  refreshModelCatalog: () => Promise<void>
  /**
   * Re-resolve the ACTIVE session's git branch for the composer's branch chip.
   * Active-only on purpose: the chip renders one session's branch, and each
   * resolve spawns a host `git rev-parse`, so fanning out would cost one shell
   * per warm session on every window focus for chips nobody is looking at.
   */
  refreshProjectBranch: () => Promise<void>
  /**
   * Broadcast a unified agent-config dict to every live session's worker
   * (global keys like maxTurns apply to all runtimes). The
   * model key is per-session and is NOT applied here.
   */
  applyRuntimeSettings: (config: Record<string, unknown>) => Promise<void>
  restartRuntime: (
    updates: Partial<AgentRuntimeWorkerInitPayload>,
  ) => Promise<void>
  /**
   * Re-bind a code session's project folder by rebuilding its runtime in
   * place (`forceReinit`) so `createBrowserRuntime` re-resolves `cwd` +
   * `projectRoot` to the new folder. Refuses (resolves `false`) once the
   * session has any messages — the folder is locked after the first message;
   * the caller falls back to "start a new session". Resolves `true` when the
   * rebuild was issued.
   */
  rebindProjectFolder: (
    sessionId: string,
    projectRoot: string,
  ) => Promise<boolean>
  interrupt: () => Promise<void>
  /**
   * Persist a partial metadata patch (composer draft, edit time, ...)
   * to a specific session's fs entry. Targets a session by id rather
   * than the active session so debounce timers that survive a switch
   * still write to the session they were typing in.
   */
  updateSessionMetadata: (
    sessionId: string,
    metadata: Partial<BrowserSessionMetadata>,
  ) => Promise<void>
  disposeClient: (sessionId: string) => void
}

/**
 * Manages a pool of BrowserRuntimeClient instances — one per session.
 * Workers stay alive when the user switches sessions, so background
 * conversations keep running. Only the active session's state is
 * subscribed to for UI rendering.
 */
export function useMultiSessionClients(
  options: MultiSessionClientsOptions,
): MultiSessionClientsResult {
  const clientsRef = useRef(new Map<string, BrowserRuntimeClient>())
  const unsubscribersRef = useRef(new Map<string, () => void>())
  const summaryDigestsRef = useRef(new Map<string, string>())
  // Per session: the transcript last derived from and its metadata, so a
  // stream tick that leaves the transcript untouched skips the walk.
  const derivedMetadataRef = useRef(
    new Map<string, { messages: unknown; metadata: BrowserSessionMetadata }>(),
  )
  const optionsRef = useRef(options)
  optionsRef.current = options

  // Per-session state map. Replaces the prior single `activeState` slot
  // so non-active mounted sessions can keep their trees up-to-date and
  // re-renders don't collapse mounted-but-hidden thread state.
  const [sessionStates, setSessionStates] = useState<
    Map<string, BrowserRuntimeClientState>
  >(() => new Map())

  /**
   * Coalesce a per-session state push into the Map. Same-reference
   * shortcut means components that subscribe to a particular session's
   * state via React.memo can skip re-render when nothing actually
   * changed for them.
   */
  const updatePerSessionState = useCallback(
    (sessionId: string, state: BrowserRuntimeClientState): void => {
      setSessionStates(prev => {
        if (prev.get(sessionId) === state) return prev
        const next = new Map(prev)
        next.set(sessionId, state)
        return next
      })
    },
    [],
  )

  const emitSessionStateChange = useCallback(
    (sessionId: string, state: BrowserRuntimeClientState) => {
      let derived = derivedMetadataRef.current.get(sessionId)
      if (derived?.messages !== state.transcriptMessages) {
        derived = {
          messages: state.transcriptMessages,
          metadata: deriveSessionMetadataFromMessages(
            state.transcriptMessages,
            null,
          ),
        }
        derivedMetadataRef.current.set(sessionId, derived)
      }
      const metadata = { ...derived.metadata }
      const pendingPrompt =
        typeof state.pendingPrompt === 'string' ? state.pendingPrompt.trim() : ''
      if (!metadata.firstPrompt && pendingPrompt) {
        metadata.firstPrompt = pendingPrompt
      }
      if (!metadata.previewText && pendingPrompt) {
        metadata.previewText = pendingPrompt
      }
      if (pendingPrompt && (metadata.messageCount ?? 0) === 0) {
        metadata.messageCount = 1
      }
      if (!metadata.firstPrompt && !metadata.previewText) {
        return
      }

      const digest = JSON.stringify([
        metadata.firstPrompt ?? '',
        metadata.previewText ?? '',
        state.transcriptMessages.length,
      ])
      if (summaryDigestsRef.current.get(sessionId) === digest) {
        return
      }

      summaryDigestsRef.current.set(sessionId, digest)
      optionsRef.current.onSessionStateChange?.(sessionId, state, metadata)
    },
    [],
  )

  const getOrCreateClient = useCallback(
    (
      sessionId: string,
      traceOpts?: { traceId?: string; parentSpanId?: string },
    ): BrowserRuntimeClient => {
      const existing = clientsRef.current.get(sessionId)
      if (existing) return existing

      // ui.client.create — synchronous bookkeeping (constructor +
      // subscribe). Anything > a few ms here is unexpected and points at
      // a heavyweight state-listener registration.
      const tracer = installSessionTracer({ context: 'ui' })
      const createSpan = tracer.span('ui.client.create', {
        traceId: traceOpts?.traceId,
        parentSpanId: traceOpts?.parentSpanId,
        attrs: { sessionId },
      })

      const client = new BrowserRuntimeClient({
        createWorkerTransport: optionsRef.current.createWorkerTransport,
        hostBridgeTransport: optionsRef.current.hostBridgeTransport,
        files: optionsRef.current.files,
        initPayload: optionsRef.current.createInitPayload(sessionId),
      })
      clientsRef.current.set(sessionId, client)
      // Hoist the tracer outside the subscribe callback so we don't pay
      // the (cheap, but non-zero) lookup on every state push during a
      // hot streaming turn.
      const subscribeTracer = installSessionTracer({ context: 'ui' })
      unsubscribersRef.current.set(
        sessionId,
        client.subscribe(state => {
          // ui.client.stateUpdate — fires for every state push out of
          // the runtime client. The count + cumulative duration during
          // a session-switch tells us if cascading setStates are
          // driving render churn. Only recorded when a session.switch
          // trace is active; during idle / steady-state runs it stays
          // silent so the trace doesn't grow into noise.
          const ctx = subscribeTracer.getCurrentTraceContext()
          if (ctx) {
            const updateSpan = subscribeTracer.span('ui.client.stateUpdate', {
              traceId: ctx.traceId,
              parentSpanId: ctx.parentSpanId,
              attrs: { sessionId, status: state.status },
            })
            updatePerSessionState(sessionId, state)
            emitSessionStateChange(sessionId, state)
            updateSpan.end({
              messages: state.transcriptMessages.length,
            })
            return
          }
          // No active trace — do the work, skip the span.
          updatePerSessionState(sessionId, state)
          emitSessionStateChange(sessionId, state)
        }),
      )
      createSpan.end()
      // Pass the parent traceId in so ui.client.start joins the same
      // lineage as ui.session.switch + ui.client.create.
      void (optionsRef.current.shutdownSessionIds?.has(sessionId)
        ? client.startReadOnly()
        : client.start({ traceId: traceOpts?.traceId }))
      return client
    },
    [emitSessionStateChange],
  )

  const disposeClient = useCallback((sessionId: string) => {
    const unsubscribe = unsubscribersRef.current.get(sessionId)
    unsubscribe?.()
    unsubscribersRef.current.delete(sessionId)
    summaryDigestsRef.current.delete(sessionId)
    derivedMetadataRef.current.delete(sessionId)

    const client = clientsRef.current.get(sessionId)
    if (client) {
      uninstallRuntimeClientTestHookIfMatch(client)
      void client.dispose()
      clientsRef.current.delete(sessionId)
    }
    setSessionStates(prev => {
      if (!prev.has(sessionId)) return prev
      const next = new Map(prev)
      next.delete(sessionId)
      return next
    })
  }, [])

  // Reconcile the client pool against the mounted-session LRU: create a client for every mounted session,
  // dispose one evicted from it (the worker keeps the session running). The active session is never swept.
  useEffect(() => {
    for (const sessionId of options.mountedSessionIds) {
      if (!clientsRef.current.has(sessionId)) {
        getOrCreateClient(sessionId)
      }
      // Seed the state map so the caller can render the tree even
      // before the first push arrives.
      const client = clientsRef.current.get(sessionId)
      if (client) {
        updatePerSessionState(sessionId, client.getState())
      }
    }
    const mounted = new Set(options.mountedSessionIds)
    for (const sessionId of [...clientsRef.current.keys()]) {
      if (mounted.has(sessionId)) continue
      if (sessionId === optionsRef.current.activeSessionId) continue
      disposeClient(sessionId)
    }
  }, [
    options.mountedSessionIds,
    getOrCreateClient,
    updatePerSessionState,
    disposeClient,
  ])

  useEffect(() => {
    // ui.session.switch — wraps the work the React effect does in
    // response to activeSessionId changing. Anything between this
    // span's end and `ui.worker.ready.recv` is React render +
    // assistant-ui internals + other main-thread tasks.
    const tracer = installSessionTracer({ context: 'ui' })
    const switchSpan = tracer.span('ui.session.switch', {
      attrs: { sessionId: options.activeSessionId },
    })
    // Pin this trace as the "current" diagnostic root so subsequent
    // render commits (MultiSessionShell layout effect) and state
    // updates from BrowserRuntimeClient.subscribe join the same
    // lineage rather than orphaning into fresh traceIds.
    tracer.setCurrentTraceContext({
      traceId: switchSpan.traceId,
      parentSpanId: switchSpan.spanId,
    })

    const client = getOrCreateClient(options.activeSessionId, {
      traceId: switchSpan.traceId,
      parentSpanId: switchSpan.spanId,
    })
    updatePerSessionState(options.activeSessionId, client.getState())
    // Keep the e2e test hook pointed at whichever session is currently driving
    // the UI. Specs should always interact with the visible conversation,
    // and that maps 1:1 to the active session's client.
    installRuntimeClientTestHookIfEnabled(client)

    switchSpan.end()
    // Mark the moment the effect body fully returned, so the trace
    // shows the gap between effect-end and worker.ready.recv as the
    // unattributed React-render / message-queue stretch.
    tracer.event('ui.session.switch.done', {
      traceId: switchSpan.traceId,
      parentSpanId: switchSpan.spanId,
      attrs: { sessionId: options.activeSessionId },
    })
  }, [options.activeSessionId, getOrCreateClient])

  useEffect(() => {
    return () => {
      for (const unsubscribe of unsubscribersRef.current.values()) {
        unsubscribe()
      }
      unsubscribersRef.current.clear()

      for (const client of clientsRef.current.values()) {
        uninstallRuntimeClientTestHookIfMatch(client)
        void client.dispose()
      }
      clientsRef.current.clear()
      summaryDigestsRef.current.clear()
      derivedMetadataRef.current.clear()
    }
  }, [])

  const submitPrompt = useCallback(async (prompt: string) => {
    const client = clientsRef.current.get(optionsRef.current.activeSessionId)
    await client?.submitMessage(prompt)
  }, [])

  const submitActionMessage = useCallback(async (prompt: string) => {
    const client = clientsRef.current.get(optionsRef.current.activeSessionId)
    await client?.submitActionMessage(prompt)
  }, [])

  const continueConversation = useCallback(async () => {
    const client = clientsRef.current.get(optionsRef.current.activeSessionId)
    await client?.continueConversation()
  }, [])

  const submitComposerMessage = useCallback(async (
    message: AppendMessage,
    options?: { delivery?: SubmitDelivery },
  ) => {
    const client = clientsRef.current.get(optionsRef.current.activeSessionId)
    await client?.submitComposerMessage(message, options)
  }, [])

  // Submit into a NAMED session rather than the active one — a fork-send lands
  // in the new copy before (or while) the switch mounts it. Creates the client
  // when the mount has not yet; the mount then reuses it.
  const submitComposerMessageToSession = useCallback(async (
    sessionId: string,
    message: AppendMessage,
    options?: { delivery?: SubmitDelivery },
  ) => {
    await getOrCreateClient(sessionId).submitComposerMessage(message, options)
  }, [getOrCreateClient])

  const submitToolResult = useCallback(
    async (submission: BrowserRuntimeToolResultSubmission) => {
      const client = clientsRef.current.get(optionsRef.current.activeSessionId)
      await client?.submitToolResult(submission)
    },
    [],
  )

  const loadToolCallDetail = useCallback(
    async (toolCallId: string) => {
      const client = clientsRef.current.get(optionsRef.current.activeSessionId)
      return await client?.loadToolCallDetail(toolCallId) ?? null
    },
    [],
  )

  const loadTurnDiffDetail = useCallback(
    async (turnIndex: number) => {
      const client = clientsRef.current.get(optionsRef.current.activeSessionId)
      return (await client?.loadTurnDiffDetail(turnIndex)) ?? null
    },
    [],
  )

  // A new identity per active session, so a view asking on mount asks again
  // after a switch.
  const activeSessionIdForHistory = options.activeSessionId
  const requestTurnDiffHistory = useCallback(() => {
    const client = clientsRef.current.get(activeSessionIdForHistory)
    void client?.requestTurnDiffHistory().catch(() => {})
  }, [activeSessionIdForHistory])

  // Bundled-skill body for the Skills tab, from the ACTIVE session's worker —
  // the answer is session-scoped (a dynamic skill's body is the one invoked
  // in THAT session), unlike the host-global fs reads below.
  const loadBundledSkillBody = useCallback(
    async (name: string) => {
      const client = clientsRef.current.get(optionsRef.current.activeSessionId)
      return (await client?.loadBundledSkillBody(name)) ?? null
    },
    [],
  )

  // Read a file from the host fs bridge via the ACTIVE session's client (any
  // client can read any absolute path — fs is host-global). Rejections
  // propagate so the FilePanel can render its own error state.
  const readFileText = useCallback(async (path: string) => {
    const client = clientsRef.current.get(optionsRef.current.activeSessionId)
    if (!client) return null
    return client.readFileText(path)
  }, [])

  // Directory listings for the Files pane's browse state, through the ACTIVE
  // session's client like the read above. Rejections propagate so the pane can
  // render its own error row.
  const listDir = useCallback(async (path: string) => {
    const client = clientsRef.current.get(optionsRef.current.activeSessionId)
    if (!client) return null
    return client.listDir(path)
  }, [])

  const listTree = useCallback(async (path: string, depth?: number) => {
    const client = clientsRef.current.get(optionsRef.current.activeSessionId)
    if (!client) return null
    return client.listTree(path, depth)
  }, [])

  const startFileSearch = useCallback(
    async (request: FileSearchRequest, onState: (state: FsxSearchState) => void) => {
      const client = clientsRef.current.get(optionsRef.current.activeSessionId)
      if (!client) return null
      return client.startFileSearch(request, onState)
    },
    [],
  )

  // Batched existence check for the transcript's auto-detected file paths.
  // Same "any client can stat any absolute path" rule as the read above (fs is
  // host-global). Resolves [] with no client, so paths simply stay plain text.
  const statFilePaths = useCallback(async (paths: string[]) => {
    const client = clientsRef.current.get(optionsRef.current.activeSessionId)
    if (!client) return []
    return client.statFilePaths(paths)
  }, [])

  // Write a file back to the host fs bridge via the ACTIVE session's client
  // (fs is host-global, like the read). Resolves false when there's no active
  // client; rejections propagate so the FilePanel can surface a save error.
  const writeFileText = useCallback(async (path: string, text: string) => {
    const client = clientsRef.current.get(optionsRef.current.activeSessionId)
    if (!client) return false
    await client.writeFileText(path, text)
    return true
  }, [])

  // Open the host's native multi-file picker (composer paperclip) via the
  // ACTIVE session's client, returning the chosen files as `File`s. Returns []
  // when no client is mounted or the user cancels. Forwards `allowImages` so
  // the dialog's default filter group mirrors the active model's image-input
  // capability (AssistantUiThread resolves it from the curated catalog).
  const pickComposerAttachmentFiles = useCallback(
    async (options?: { allowImages?: boolean }) => {
      const client = clientsRef.current.get(optionsRef.current.activeSessionId)
      if (!client) return []
      return client.pickComposerAttachmentFiles(options)
    },
    [],
  )

  const addPermissionRule = useCallback(
    async (params: { rule: string; toolCallId: string; persist: boolean }) => {
      const client = clientsRef.current.get(optionsRef.current.activeSessionId)
      await client?.addPermissionRule(params)
    },
    [],
  )

  const applyPermissionUpdate = useCallback(
    async (params: { update: RuleEdit; toolCallId?: string }) => {
      const client = clientsRef.current.get(optionsRef.current.activeSessionId)
      await client?.applyPermissionUpdate(params)
    },
    [],
  )

  const setModelSelection = useCallback(
    async (selection: BrowserLlmSelection) => {
      const activeSessionId = optionsRef.current.activeSessionId
      // Every page path that changes a model goes through here — the topbar
      // pick, the browser's profile-wide push (`session.applyAgentConfig`),
      // the adopt-default heals — and each one targets the ACTIVE tab, which
      // may be a teammate's. A teammate keeps the model it was spawned on
      // (see AgentRuntimeWorker, `worker.setModelSelection`).
      if (activeSessionId && isTeammateSessionId(activeSessionId)) return
      const client = clientsRef.current.get(activeSessionId)
      await client?.setModelSelection(selection)
    },
    [],
  )

  const setModelSelectionForSession = useCallback(
    async (sessionId: string, selection: BrowserLlmSelection) => {
      if (isTeammateSessionId(sessionId)) return
      await clientsRef.current.get(sessionId)?.setModelSelection(selection)
    },
    [],
  )

  const setAutoCompactWindowForSession = useCallback(
    async (sessionId: string, value: number | 'auto') => {
      await clientsRef.current.get(sessionId)?.setAutoCompactWindow(value)
    },
    [],
  )

  const setPermissionMode = useCallback(async (mode: string) => {
    const client = clientsRef.current.get(optionsRef.current.activeSessionId)
    await client?.setPermissionMode(mode)
  }, [])

  const setSkipDangerousMode = useCallback(async (value: boolean) => {
    const client = clientsRef.current.get(optionsRef.current.activeSessionId)
    await client?.setSkipDangerousMode(value)
  }, [])

  const clearPendingMessage = useCallback(() => {
    const client = clientsRef.current.get(optionsRef.current.activeSessionId)
    client?.clearPendingMessage()
  }, [])

  const removeInjectMessage = useCallback(async (uuid: string) => {
    const client = clientsRef.current.get(optionsRef.current.activeSessionId)
    return client ? client.removeInjectMessage(uuid) : { ok: false }
  }, [])

  const resolveToolUseConfirm = useCallback(
    async (params: {
      approvalCallId: string
      behavior: 'allow' | 'reject' | 'abort'
      updatedInput?: Record<string, unknown>
      feedback?: string
      ruleEdits?: RuleEdit[]
    }) => {
      const client = clientsRef.current.get(optionsRef.current.activeSessionId)
      await client?.resolveToolUseConfirm(params)
    },
    [],
  )

  const clearPlanApproval = useCallback(async (toolCallId?: string) => {
    const client = clientsRef.current.get(optionsRef.current.activeSessionId)
    await client?.clearPlanApproval(toolCallId)
  }, [])

  const refreshModelCatalog = useCallback(async () => {
    // Fan the refresh out to every live session's worker, not just the
    // active one. Background sessions stay warm across switches, so we want
    // their snapshots to reflect the new catalogue too — otherwise users
    // would see stale "no models" messaging after switching back.
    await Promise.all(
      Array.from(clientsRef.current.values()).map(client =>
        client.refreshModelCatalog().catch(() => undefined),
      ),
    )
  }, [])

  const refreshProjectBranch = useCallback(async () => {
    // `worker.getState` is what re-runs the worker's branch resolve, so asking
    // for state IS the refresh — no new protocol message needed. Active session
    // only (see the interface comment). Swallowed: a session whose worker is
    // still coming up rejects, and a stale chip is not worth surfacing.
    const client = clientsRef.current.get(optionsRef.current.activeSessionId)
    await client?.requestState().catch(() => undefined)
  }, [])

  const applyRuntimeSettings = useCallback(
    async (config: Record<string, unknown>) => {
      // Fan the config out to every live session's worker — global keys
      // (maxTurns) apply to all runtimes. Background sessions
      // stay warm across switches, so they must pick up the change too.
      await Promise.all(
        Array.from(clientsRef.current.values()).map(client =>
          client.applyRuntimeSettings(config).catch(() => undefined),
        ),
      )
    },
    [],
  )

  const interrupt = useCallback(async () => {
    const client = clientsRef.current.get(optionsRef.current.activeSessionId)
    await client?.interrupt()
  }, [])

  const updateSessionMetadata = useCallback(
    async (
      sessionId: string,
      metadata: Partial<BrowserSessionMetadata>,
    ) => {
      const client = clientsRef.current.get(sessionId)
      if (!client) return
      await client.updateSessionMetadata(metadata)
    },
    [],
  )

  const restartRuntime = useCallback(
    async (updates: Partial<AgentRuntimeWorkerInitPayload>) => {
      const client = clientsRef.current.get(optionsRef.current.activeSessionId)
      await client?.restartWithInitPayload(updates)
    },
    [],
  )

  const rebindProjectFolder = useCallback(
    async (sessionId: string, projectRoot: string): Promise<boolean> => {
      const client = clientsRef.current.get(sessionId)
      if (!client) return false
      // Lock-after-first-message: once a code session has messages its folder
      // is fixed. Re-binding then would rebuild the worker and orphan the live
      // transcript/turn, so refuse and let the caller fall back to "start a
      // new session". An empty session is safe to rebuild in place.
      const messageCount = client.getState().snapshot?.messageCount ?? 0
      if (messageCount > 0) return false
      // In-place re-init on the live worker (keeps its bridge wiring) — see
      // BrowserRuntimeClient.reinitWithProjectRoot.
      await client.reinitWithProjectRoot(projectRoot)
      return true
    },
    [],
  )


  const activeState =
    sessionStates.get(options.activeSessionId) ?? BLANK_CLIENT_STATE

  return {
    activeState,
    sessionStates,
    submitPrompt,
    submitActionMessage,
    continueConversation,
    submitComposerMessage,
    submitComposerMessageToSession,
    submitToolResult,
    loadToolCallDetail,
    loadTurnDiffDetail,
    requestTurnDiffHistory,
    loadBundledSkillBody,
    readFileText,
    listDir,
    listTree,
    startFileSearch,
    statFilePaths,
    writeFileText,
    pickComposerAttachmentFiles,
    setModelSelection,
    setModelSelectionForSession,
    setAutoCompactWindowForSession,
    setPermissionMode,
    setSkipDangerousMode,
    clearPendingMessage,
    removeInjectMessage,
    resolveToolUseConfirm,
    clearPlanApproval,
    addPermissionRule,
    applyPermissionUpdate,
    refreshModelCatalog,
    refreshProjectBranch,
    applyRuntimeSettings,
    restartRuntime,
    rebindProjectFolder,
    interrupt,
    updateSessionMetadata,
    disposeClient,
  }
}

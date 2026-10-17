/**
 * AgentModelController — model catalog cache, immediate selection, background catalog fetch +
 * reconcile, focus refresh, selection persistence and the tier fallback warning latch. One per
 * RuntimeScope; async entry points take an `isStale` callback from the worker.
 */
import type {
  BrowserLlmCatalog,
  BrowserLlmSelection,
} from '../bridge/browserBridgeProtocol'
import type { AgentRuntimeState } from '../runtime/AgentRuntimeState'
import type { AgentRuntimeWorkerInitPayload } from './workerProtocol'
import type { BrowserSessionMetadata } from '../../sessions/sessionStore'
import {
  resolveSelection,
  areSelectionsEqual,
  areSelectionsFullyEqual,
  mergeRequestedTier,
} from './modelSelection'
import { findConfiguredModelRule } from '../webview/configuredModels'
import { extractOnlineModelIds } from '../webview/modelCatalog'
import { getSessionTracer } from '../../utils/sessionTrace'
import { isModelUploadTraceEnabled } from '../../engine/turn/modelTrace'
import { publishHostModelCatalog } from '../../config/hostModelCatalog'
import { publishCatalogModelPool } from '../../config/nexusModelConfig/providerModelPool'

export type AgentModelSnapshot = {
  modelCatalog: BrowserLlmCatalog | null
  hasEngineSelection: boolean
}

export type ModelTraceContext = { traceId?: string; parentSpanId?: string }

/**
 * The selection Phase 1 lands on the engine. `commit` goes through
 * `applySelection` (persisted, reported, tier filled in); `engine` is a bare
 * model id set on the engine only.
 */
export type ImmediateSelection =
  | { kind: 'commit'; selection: BrowserLlmSelection; viaCatalog: boolean }
  | { kind: 'engine'; providerId?: string; modelId: string; thinkingTier?: string }

/** The engine's model, provider and effort once `selection` is applied. */
export function immediateSelectionView(
  selection: ImmediateSelection,
): { providerId?: string; modelId: string; thinkingTier?: string } {
  return selection.kind === 'commit' ? selection.selection : selection
}

/** The init payload's requested (provider, model) pair, or null. */
function requestedSelectionOf(
  payload: AgentRuntimeWorkerInitPayload,
): BrowserLlmSelection | null {
  return payload.userSpecifiedProviderId && payload.userSpecifiedModel
    ? {
        providerId: payload.userSpecifiedProviderId,
        modelId: payload.userSpecifiedModel,
        ...(payload.userSpecifiedThinkingTier
          ? { thinkingTier: payload.userSpecifiedThinkingTier }
          : {}),
      }
    : null
}

/** `selection` with the model's configured default effort when it names none. */
function withDefaultThinkingTier(selection: BrowserLlmSelection): BrowserLlmSelection {
  if (selection.thinkingTier) return selection
  const thinkingTier = findConfiguredModelRule(selection.providerId, {
    id: selection.modelId,
    label: selection.modelId,
  })?.defaultThinkingTier
  return thinkingTier ? { ...selection, thinkingTier } : selection
}

/**
 * The worker-provided seam the controller acts through. Kept intentionally
 * narrow: the controller never sees the message protocol, the snapshot
 * builder, or the Manager — only "give me the live runtime" and three
 * outbound notifications.
 */
export interface AgentModelControllerHost {
  /** The current-generation runtime, or null before bind / after dispose. */
  getRuntime(): AgentRuntimeState | null
  /** Push a fresh `worker.state` snapshot (picker repaint after catalog/selection changes). */
  emitState(): void
  /** Emit a `worker.debugLog` console line (catalog trace; already gated by caller). */
  emitDebugLog(level: 'info' | 'warn', message: string): void
  /** Report a committed selection so the Manager's cached model stays in sync. */
  reportModelChanged(selection: BrowserLlmSelection): void
}

export class AgentModelController {
  private catalog: BrowserLlmCatalog | null = null
  private initPromise: Promise<void> | null = null
  private hasEngineSelection = false
  /** One-shot latch for `warnIfTierFallbackEngaged` — both resolution passes
   *  (Phase-1 immediate + Phase-2 reconcile) call it for the same spawn. */
  private tierFallbackWarned = false
  /** THIS scope's runtime, pinned at install (mirrors the
   *  permissions/transcript/recovery bindRuntime pattern). `host.getRuntime()`
   *  is worker-live: on a stale (superseded) scope's controller it returns
   *  the SUCCESSOR scope's runtime, so a late async continuation could
   *  commit a stale selection into the new runtime's engine/metadata.
   *  Bound controllers only ever touch their own runtime. */
  private boundRuntime: AgentRuntimeState | null = null

  constructor(private readonly host: AgentModelControllerHost) {}

  /** Pin this controller to its scope's runtime — called at runtime install. */
  bindRuntime(runtime: AgentRuntimeState): void {
    this.boundRuntime = runtime
  }

  /** The runtime this controller acts on: its bound (scope-pinned) runtime,
   *  falling back to the worker-live getter only before install (the
   *  pre-init fallback controller path). */
  private currentRuntime(): AgentRuntimeState | null {
    return this.boundRuntime ?? this.host.getRuntime()
  }

  getCatalog(): BrowserLlmCatalog | null {
    return this.catalog
  }

  setCatalog(catalog: BrowserLlmCatalog | null): void {
    this.catalog = catalog
    // The boot payload (`initialModelCatalog`) never passes through
    // `BrowserHostBridge.getModelCatalog`, so publish here too — otherwise a
    // session that never refreshes its catalog leaves the survey blind.
    publishHostModelCatalog(catalog)
    publishCatalogModelPool(catalog)
  }

  getInitPromise(): Promise<void> | null {
    return this.initPromise
  }

  setInitPromise(promise: Promise<void> | null): void {
    this.initPromise = promise
  }

  getHasEngineSelection(): boolean {
    return this.hasEngineSelection
  }

  setHasEngineSelection(value: boolean): void {
    this.hasEngineSelection = value
  }

  getTierFallbackWarned(): boolean {
    return this.tierFallbackWarned
  }

  setTierFallbackWarned(value: boolean): void {
    this.tierFallbackWarned = value
  }

  snapshot(): AgentModelSnapshot {
    return {
      modelCatalog: this.catalog,
      hasEngineSelection: this.hasEngineSelection,
    }
  }

  reset(): void {
    this.catalog = null
    this.initPromise = null
    this.hasEngineSelection = false
    this.tierFallbackWarned = false
    // Deliberately KEEP `boundRuntime`: reset runs on scope
    // disposal, and a cleared bind would make this stale controller's late
    // async continuations fall back to the worker-live getter — i.e. the
    // SUCCESSOR scope's runtime — which is exactly the leak the bind exists
    // to prevent. Writes into the disposed runtime are inert.
  }

  /**
   * Phase 1 of model init, resolve half: the selection the engine starts on,
   * from what is already at hand (the catalog, the session's saved selection,
   * the requested pair). No I/O, no engine; null when nothing applies.
   */
  resolveImmediateSelection(
    payload: AgentRuntimeWorkerInitPayload,
    metadata: Pick<BrowserSessionMetadata, 'llmSelection'> | undefined,
    catalog: BrowserLlmCatalog | null = this.catalog,
  ): ImmediateSelection | null {
    const persistedSelection = metadata?.llmSelection ?? null
    const requestedSelection = requestedSelectionOf(payload)

    if (catalog) {
      const resolved = resolveSelection(catalog, {
        requestedSelection,
        requestedModelId: payload.userSpecifiedProviderId
          ? undefined
          : payload.userSpecifiedModel,
        persistedSelection,
        fallbackSelection: payload.modelFallbackSelection ?? null,
      })
      if (resolved) {
        return {
          kind: 'commit',
          selection: withDefaultThinkingTier(
            mergeRequestedTier(resolved, requestedSelection),
          ),
          viaCatalog: true,
        }
      }
    }

    // No catalog yet — apply persisted or requested as-is. The engine
    // only needs {providerId, modelId} strings to route requests; the
    // catalog is for the picker UI.
    if (persistedSelection) {
      return {
        kind: 'commit',
        selection: withDefaultThinkingTier(
          mergeRequestedTier(persistedSelection, requestedSelection),
        ),
        viaCatalog: false,
      }
    }
    if (requestedSelection) {
      return {
        kind: 'commit',
        selection: withDefaultThinkingTier(requestedSelection),
        viaCatalog: false,
      }
    }
    if (payload.userSpecifiedModel) {
      return {
        kind: 'engine',
        ...(payload.userSpecifiedProviderId
          ? { providerId: payload.userSpecifiedProviderId }
          : {}),
        modelId: payload.userSpecifiedModel,
        ...(payload.userSpecifiedThinkingTier
          ? { thinkingTier: payload.userSpecifiedThinkingTier }
          : {}),
      }
    }
    return null
  }

  /**
   * Phase 1 of model init, apply half: land `resolved` (or, when omitted, a
   * selection resolved now from the runtime's store) on the engine so the
   * first Send never waits on the slow catalog fetch. Returns true when a
   * selection landed on the engine.
   */
  async applyImmediateSelection(
    payload: AgentRuntimeWorkerInitPayload,
    resolved?: ImmediateSelection | null,
  ): Promise<boolean> {
    const runtime = this.currentRuntime()
    if (!runtime) {
      return false
    }

    const selection =
      resolved !== undefined
        ? resolved
        : this.resolveImmediateSelection(
            payload,
            await runtime.conversationStore.getSessionMetadata?.(),
          )
    if (!selection) return false
    if (selection.kind === 'commit') {
      if (selection.viaCatalog) {
        this.warnIfTierFallbackEngaged(
          payload,
          requestedSelectionOf(payload),
          selection.selection,
        )
      }
      await this.applySelection(selection.selection)
    } else {
      runtime.engine.setModelSelection({
        providerId: selection.providerId,
        model: selection.modelId,
        ...(selection.thinkingTier ? { thinkingTier: selection.thinkingTier } : {}),
      })
    }
    this.hasEngineSelection = true
    return true
  }

  /**
   * Surfaces the sub-agent tier-fallback (see `modelFallbackSelection` in
   * workerProtocol.ts): the spawn requested a concrete (provider, model)
   * pair that the live catalog doesn't have enabled, and resolution landed
   * elsewhere (the parent's selection, or — if that too is disabled — the
   * generic default). Scoped to tier spawns only: `modelFallbackSelection`
   * is set exclusively by tier-resolved `spawnSubAgentSession` calls.
   */
  private warnIfTierFallbackEngaged(
    payload: AgentRuntimeWorkerInitPayload,
    requestedSelection: BrowserLlmSelection | null,
    resolved: BrowserLlmSelection,
  ): void {
    if (!payload.modelFallbackSelection || !requestedSelection) return
    if (areSelectionsEqual(resolved, requestedSelection)) return
    // One-shot: both resolution passes (Phase-1 applyImmediateSelection
    // and the Phase-2 catalog reconcile) call this for the same spawn — warn
    // and trace once, not twice.
    if (this.tierFallbackWarned) return
    this.tierFallbackWarned = true
    // eslint-disable-next-line no-console
    console.warn(
      '[subagent] requested model %s/%s is not enabled in the catalog — falling back to %s/%s',
      requestedSelection.providerId,
      requestedSelection.modelId,
      resolved.providerId,
      resolved.modelId,
    )
    getSessionTracer().event('worker.model.tierFallback', {
      attrs: {
        requestedProviderId: requestedSelection.providerId,
        requestedModelId: requestedSelection.modelId,
        resolvedProviderId: resolved.providerId,
        resolvedModelId: resolved.modelId,
      },
    })
  }

  /**
   * Phase 2 of model init: fetch the catalog from the host (slow), reconcile against the
   * persisted/requested selection and push a worker.state. A stale scope's late fetch is not adopted.
   */
  async fetchAndReconcileCatalog(
    payload: AgentRuntimeWorkerInitPayload,
    traceCtx?: ModelTraceContext,
    isStale?: () => boolean,
  ): Promise<void> {
    const runtime = this.currentRuntime()
    if (!runtime) {
      return
    }
    const tracer = getSessionTracer()

    const catalogSpan = tracer.span('worker.model.catalogFetch.async', {
      traceId: traceCtx?.traceId,
      parentSpanId: traceCtx?.parentSpanId,
    })
    try {
      const nextCatalog = await runtime.hostBridge.getModelCatalog()
      // Generation guard: discard stale catalog results from an older scope.
      if (isStale?.()) {
        catalogSpan.end({ ok: false, stale: true })
        return
      }
      // Adopt only a POPULATED catalog: a late null/empty result (host not ready) must not blank a
      // catalog a concurrent refresh already adopted.
      if (nextCatalog && nextCatalog.providers.length > 0) {
        this.catalog = nextCatalog
        this.logFetchedCatalogModels('initCatalogFetch')
      }
      catalogSpan.end({
        providers: this.catalog?.providers.length ?? 0,
      })
    } catch {
      // Keep whatever we have — a failed fetch must not blank the UI (mirrors
      // the refresh handler's catch; do NOT force `this.catalog = null`.
      catalogSpan.end({ ok: false })
      return
    }

    // Reconcile: with the catalog now in hand, see if the resolved
    // selection differs from what Phase 1 applied. Common case is
    // identity → no-op. Rare case: the persisted provider was
    // disabled in settings since last boot → fall through to a
    // different enabled model.
    const metadata = await runtime.conversationStore.getSessionMetadata?.()
    const persistedSelection = metadata?.llmSelection ?? null
    const requestedSelection = requestedSelectionOf(payload)
    const resolved = resolveSelection(this.catalog, {
      requestedSelection,
      requestedModelId: payload.userSpecifiedProviderId
        ? undefined
        : payload.userSpecifiedModel,
      persistedSelection,
      fallbackSelection: payload.modelFallbackSelection ?? null,
    })
    if (resolved) {
      this.warnIfTierFallbackEngaged(payload, requestedSelection, resolved)
    }
    const currentProviderId = runtime.options.userSpecifiedProviderId
    const currentModelId = runtime.options.userSpecifiedModel
    const current: BrowserLlmSelection | null =
      currentProviderId && currentModelId
        ? { providerId: currentProviderId, modelId: currentModelId }
        : null
    if (resolved && !areSelectionsEqual(resolved, current)) {
      await this.applySelection(
        mergeRequestedTier(resolved, requestedSelection),
      )
    }

    // Tell the UI the catalog is in — picker can paint enabled
    // providers / models now.
    this.host.emitState()
  }

  /**
   * Start Phase 2 of model initialization without blocking worker.ready.
   * The controller owns both the catalog operation and its submit-gate
   * promise, keeping that state inside the per-runtime scope.
   */
  startBackgroundCatalogFetch(
    payload: AgentRuntimeWorkerInitPayload,
    traceCtx: ModelTraceContext,
    isStale: () => boolean,
  ): void {
    if (this.catalog) {
      return
    }
    const catalogPromise = this.fetchAndReconcileCatalog(
      payload,
      traceCtx,
      isStale,
    ).catch(error => {
      // Never store a rejectable promise: submit's bounded grace window races
      // this operation. A late reconcile failure is a degraded-catalog
      // condition, not a turn error.
      this.host.emitDebugLog(
        'warn',
        `[NexusModelCatalog] background reconcile failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    })
    this.initPromise = catalogPromise
    void catalogPromise.finally(() => {
      if (this.initPromise === catalogPromise) {
        this.initPromise = null
      }
    })
  }

  /**
   * Focus-driven catalog re-fetch (`worker.refreshModelCatalog`). Adopts only a populated catalog, and
   * seeds an engine selection if none exists, so the next Send never goes out as 'inherit'.
   */
  async refreshCatalog(): Promise<void> {
    const runtime = this.currentRuntime()
    if (!runtime) {
      return
    }
    try {
      const nextCatalog = await runtime.hostBridge.getModelCatalog()
      // Only adopt a POPULATED catalog: a real catalog always lists every registered provider, so an
      // empty/null result means "host not ready", and adopting it would blank the picker.
      if (nextCatalog && nextCatalog.providers.length > 0) {
        this.catalog = nextCatalog
        this.logFetchedCatalogModels('refreshModelCatalog')
      }
    } catch {
      // Keep whatever we had — a failed refresh shouldn't blank out the
      // UI.
    }
    // If the engine still has no committed selection (cold-boot
    // race where applyImmediateSelection couldn't resolve
    // anything because the catalog was empty/null at init), use
    // the freshly-loaded catalog to seed one.
    if (!this.hasEngineSelection && this.catalog) {
      const metadata = await runtime.conversationStore.getSessionMetadata?.()
      const persistedSelection = metadata?.llmSelection ?? null
      const resolved = resolveSelection(this.catalog, {
        requestedSelection: null,
        persistedSelection,
      })
      if (resolved) {
        await this.applySelection(resolved)
      }
    }
  }

  /**
   * Commit a selection: engine routing, runtime-options mirror, session-
   * metadata persistence, and the Manager's cached-model report. Fills in the
   * model's configured `defaultThinkingTier` when the caller didn't specify
   * one (covers the init path where the UI hasn't picked a pill yet).
   */
  async applySelection(selection: BrowserLlmSelection): Promise<void> {
    const runtime = this.currentRuntime()
    if (!runtime) {
      return
    }

    // Fall back to the model's configured `defaultThinkingTier` whenever the
    // caller didn't specify one. Covers the init path (persisted selection or
    // prefs-seeded model) where the UI hasn't had a chance to pick a pill
    // yet; without this, the first Send of a session on e.g. Opus 4.7 would
    // go out with no `thinking` block even though the model expects
    // extra-high reasoning by default.
    const resolvedTier = withDefaultThinkingTier(selection).thinkingTier
    runtime.options.userSpecifiedProviderId = selection.providerId
    runtime.options.userSpecifiedModel = selection.modelId
    // Tier lives on the engine config too; the query loop reads it at
    // iteration time to build `providerBodyExtension`. Keep the runtime
    // options snapshot in sync for any consumer (e.g. settings UI) that
    // mirrors options rather than asking the engine directly.
    runtime.options.userSpecifiedThinkingTier = resolvedTier
    runtime.engine.setModelSelection({
      providerId: selection.providerId,
      model: selection.modelId,
      thinkingTier: resolvedTier,
    })
    // Keep the submit-gate flag in sync. Any path that lands a
    // selection on the engine — Phase 1, Phase 2 reconcile, or a
    // user-driven setModelSelection — flips this true so subsequent
    // submits stop waiting on modelInitPromise.
    this.hasEngineSelection = true
    const metadata = await runtime.conversationStore.getSessionMetadata()
    // Persist the effort the session RUNS at, the model's default included:
    // a tier-less record would be read on reopen as "no effort picked yet"
    // and take the page's global default (`mergeRequestedTier`), silently
    // changing this session's effort.
    const persisted: BrowserLlmSelection = resolvedTier
      ? { ...selection, thinkingTier: resolvedTier }
      : selection
    // FULL equality (tier included): a tier-only change must
    // persist — the identity comparator silently dropped it, so the picked
    // effort reverted on reload while the topbar (which compares tier)
    // showed it as applied.
    if (!areSelectionsFullyEqual(metadata?.llmSelection, persisted)) {
      await runtime.conversationStore.updateSessionMetadata({
        llmSelection: persisted,
      })
    }
    // Refresh the manager's cached model so the unified topbar feed
    // emits a delta with the new selection.
    this.host.reportModelChanged({
      providerId: selection.providerId,
      modelId: selection.modelId,
      ...(resolvedTier ? { thinkingTier: resolvedTier } : {}),
    })
  }

  /**
   * Log the model lists of a freshly fetched catalog per provider (`onlineModels` from the raw catalog,
   * `catalogModels`, `curatedOnlyModels`) to the session tracer and `worker.debugLog`. Only when the
   * user opted into tracing; both gates off → no work.
   */
  private logFetchedCatalogModels(source: string): void {
    const catalog = this.catalog
    if (!catalog) {
      return
    }
    const uploadTraceOn = isModelUploadTraceEnabled()
    const tracer = getSessionTracer()
    if (!uploadTraceOn && !tracer.isEnabled()) {
      return
    }
    const rawCatalogs = catalog.rawCatalogs
    const currentProviderId = this.currentRuntime()?.engine.getCurrentProviderId()
    const providers = catalog.providers.map(provider => {
      const catalogModels = provider.models.map(model => model.id)
      const rawJson = rawCatalogs?.[provider.id]
      const onlineModels =
        rawJson !== undefined ? extractOnlineModelIds(rawJson) : undefined
      return {
        providerId: provider.id,
        enabled: provider.enabled,
        onlineModels,
        catalogModels,
        curatedOnlyModels: onlineModels
          ? catalogModels.filter(id => !onlineModels.includes(id))
          : undefined,
      }
    })
    tracer.event('worker.model.catalogModels', {
      attrs: { source, currentProviderId, providers },
    })
    if (!uploadTraceOn) {
      return
    }
    const current = providers.find(
      entry => entry.providerId === currentProviderId,
    )
    // No committed selection yet (cold boot before Phase 1 resolves, or a
    // catalog that dropped the selected provider) → log every provider's
    // lists instead of one, so the fetch is still fully inspectable.
    const scope = current ? [current] : providers
    const lists = scope
      .map(entry => {
        const online = entry.onlineModels
          ? `[${entry.onlineModels.join(', ')}]`
          : '<unavailable>'
        return (
          `${entry.providerId}: online=${online} ` +
          `catalog=[${entry.catalogModels.join(', ')}]`
        )
      })
      .join(' | ')
    this.host.emitDebugLog(
      'info',
      `[NexusModelCatalog] source=${source} ` +
        `currentProvider=${currentProviderId ?? '<none>'} ` +
        `providers=${providers.length} ${lists}`,
    )
  }
}

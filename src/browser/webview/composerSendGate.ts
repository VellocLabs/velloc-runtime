import type { BrowserLlmSelection } from '../bridge/browserBridgeProtocol'
import type { AgentRuntimeWorkerSnapshot } from '../worker/workerProtocol'
import { createConfiguredModelCatalog, isSelectionEnabled } from './modelCatalog'

/**
 * What a composer submit is allowed to do, given the session's current state.
 *
 * `send` is the only outcome that reaches the runtime; every other outcome is a
 * refusal the caller must pair with a composer-text restore, because
 * `composer.send()` has already cleared the composer by the time `onNew` runs.
 */
export type ComposerSendGateDecision =
  | { kind: 'send' }
  /** Snapshot hasn't arrived — we can't tell whether a provider is configured. */
  | { kind: 'not-ready' }
  /** This thread isn't the one the submit callbacks are bound to. */
  | { kind: 'wrong-session' }
  /** Halted on a permission / plan approval; a message can't unblock it. */
  | { kind: 'awaiting-confirm' }
  /** A code session must bind a real project folder before it can send. */
  | { kind: 'needs-project-folder' }
  /** The pinned model is gone but the catalog still has a usable default. */
  | { kind: 'adopt-default'; selection: BrowserLlmSelection }
  /** No usable provider at all — the set-up-a-provider dialog. */
  | { kind: 'provider-missing' }
  /** The model catalog has not loaded yet; see `resolveComposerSendGateOnceCatalogLoads`. */
  | { kind: 'awaiting-catalog' }

/** How long a send waits for the model catalog before going to the runtime regardless. */
export const COMPOSER_CATALOG_WAIT_MS = 3_000

/**
 * The send gate, re-run as snapshots arrive while the catalog is still loading.
 * Never returns `awaiting-catalog`: past `timeoutMs` the send goes to the
 * runtime, which holds a first submit for the catalog itself.
 * `waitForSnapshot(ms)` resolves on the next snapshot or after `ms`.
 */
export async function resolveComposerSendGateOnceCatalogLoads(params: {
  readSnapshot: () => AgentRuntimeWorkerSnapshot | null | undefined
  waitForSnapshot: (ms: number) => Promise<void>
  activeSessionId?: string
  canAdoptDefault: boolean
  timeoutMs?: number
  now?: () => number
}): Promise<Exclude<ComposerSendGateDecision, { kind: 'awaiting-catalog' }>> {
  const now = params.now ?? Date.now
  const deadline = now() + (params.timeoutMs ?? COMPOSER_CATALOG_WAIT_MS)
  for (;;) {
    const decision = resolveComposerSendGate({
      snapshot: params.readSnapshot(),
      activeSessionId: params.activeSessionId,
      canAdoptDefault: params.canAdoptDefault,
    })
    if (decision.kind !== 'awaiting-catalog') return decision
    const remaining = deadline - now()
    if (remaining <= 0) return { kind: 'send' }
    await params.waitForSnapshot(remaining)
  }
}

/**
 * Pure send gate. `wrong-session` guards against validating THIS thread's snapshot while
 * the shell's submit callbacks target the ACTIVE session's client.
 */
export function resolveComposerSendGate(params: {
  snapshot: AgentRuntimeWorkerSnapshot | null | undefined
  activeSessionId?: string
  canAdoptDefault: boolean
}): ComposerSendGateDecision {
  const { snapshot, activeSessionId, canAdoptDefault } = params
  if (!snapshot) return { kind: 'not-ready' }
  if (activeSessionId != null && snapshot.sessionId !== activeSessionId) {
    return { kind: 'wrong-session' }
  }
  if ((snapshot.approvalQueue?.length ?? 0) > 0) {
    return { kind: 'awaiting-confirm' }
  }
  if (snapshot.needsProjectFolder) return { kind: 'needs-project-folder' }
  // A loaded catalog lists every registered provider, so `null` means it has
  // not arrived yet: no grounds yet to say a provider is missing.
  if (snapshot.modelCatalog == null) return { kind: 'awaiting-catalog' }
  const catalog = createConfiguredModelCatalog(snapshot.modelCatalog)
  if (!isSelectionEnabled(catalog, snapshot.currentSelection)) {
    // `createConfiguredModelCatalog` only keeps `defaultSelection` when it
    // resolves to an ENABLED provider+model, so its presence distinguishes
    // "this session's pinned model went away but providers are fine" (adopt
    // the default + pop the picker so the user can change it) from "no usable
    // provider at all" (the set-up-a-provider dialog). Without the split, a
    // stale pinned model re-opened the provider dialog on every send even
    // after settings were configured — an endless loop, because opening
    // settings can never fix a stale per-session pin.
    const fallback = catalog?.defaultSelection
    if (fallback && canAdoptDefault) {
      return { kind: 'adopt-default', selection: fallback }
    }
    return { kind: 'provider-missing' }
  }
  return { kind: 'send' }
}

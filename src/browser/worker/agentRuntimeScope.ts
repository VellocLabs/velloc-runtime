import type { AgentRuntimeState } from '../runtime/AgentRuntimeState'
import type { AgentModelController } from './AgentModelController'
import type { AgentPermissionCoordinator } from './AgentPermissionCoordinator'
import type { AgentRuntimeRecovery } from './AgentRuntimeRecovery'
import type { AgentTranscriptService, TranscriptSource } from './AgentTranscriptService'

/**
 * Per-init/reinit runtime scope. Each `worker.init` creates a fresh scope
 * with a new generation; async work captures the scope and re-checks it is
 * still current before mutating worker state. Owned by AgentRuntimeWorker;
 * disposal is shared via `disposeScopeResources`.
 */
export type RuntimeScope = {
  generation: number
  abortController: AbortController
  runtime: AgentRuntimeState | null
  disposeCallbacks: Array<() => void | Promise<void>>
  models: AgentModelController
  permissions: AgentPermissionCoordinator
  recovery: AgentRuntimeRecovery
  transcript: AgentTranscriptService
  /** Settles the worker's display-ready latch for this scope (F-32). */
  markDisplayReady?: () => void
  /** The transcript view bound at the provisional publish, when there was one. */
  transcriptView?: TranscriptSource
  /** Git branch of the bound project folder (per-scope, cleared on reinit). */
  projectBranch: string | undefined
  /** Whether this scope's critical bind-metadata write landed before ready. */
  bindPersisted?: boolean
  /** Release for this scope's call-model trace lease, when active. */
  callModelTraceDispose?: () => void
  /** The effective template/folder this scope's runtime was built from. */
  effectiveInit?: { templateType?: string; projectRoot?: string }
}

export type DisposeScopeOptions = {
  reason: string
  /** Seals the scope's bridge generation on the shared transport. */
  cancelGeneration: (generation: number) => void
}

/**
 * Release everything a scope owns. Shared by both dispose paths (current
 * and detached) so their teardown steps cannot drift. Idempotent.
 */
export async function disposeScopeResources(
  scope: RuntimeScope,
  options: DisposeScopeOptions,
): Promise<void> {
  if (!scope.abortController.signal.aborted) {
    scope.abortController.abort(options.reason)
  }
  // Seal the bridge generation BEFORE any callback runs: in-flight requests
  // must reject now, and a dispose callback awaiting a bridge call the host
  // will never answer must fail fast instead of hanging teardown.
  options.cancelGeneration(scope.generation)
  scope.callModelTraceDispose?.()
  scope.callModelTraceDispose = undefined
  scope.permissions.abortAllConfirmations(options.reason)
  scope.models.reset()
  scope.recovery.reset()
  scope.transcript.reset()
  // LIFO, each best-effort — one failing callback must not skip the rest.
  for (const dispose of scope.disposeCallbacks.reverse()) {
    try {
      await dispose()
    } catch {
      // best-effort
    }
  }
  try {
    await (
      scope.runtime?.engine as { dispose?: () => Promise<void> }
    )?.dispose?.()
  } catch {
    // best-effort
  }
}

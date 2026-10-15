/**
 * Security: build a worker init payload from a client's `session.open` (pure). Layers, lowest first:
 * the published host environment; `open.init` (`full` only); per-session answers; the folder (named —
 * any at `full`, below it a known project in the runtime's spelling — else the persisted binding, else
 * the last folder of a forced-folder type). Per-session keys never leak from a lower layer.
 */
import { isForcedFolderTemplateType } from '../../utils/conversationStoragePaths'
import {
  hostEnvironmentOf,
  type HostEnvironment,
  type SessionOpenPayload,
} from '../runtimeHub/sessionSurface'
import type { AgentRuntimeWorkerInitPayload } from './workerProtocol'

export { hostEnvironmentOf }

export type ComposeSessionInitInput = {
  open: SessionOpenPayload
  hostEnvironment: HostEnvironment | null
  /** The last UI init (`lastInitTemplate`), used for its host half when nothing was published. */
  lastInitTemplate: AgentRuntimeWorkerInitPayload | null
  /** What the session's persisted summary says, when the manager has it at hand. */
  persisted?: { projectRoot?: string; templateType?: string }
}

export type ComposedSessionInit =
  | {
      payload: AgentRuntimeWorkerInitPayload
      /** Set when the folder must come from the user's last folder of this type. */
      needsLastFolderFor: string | null
    }
  | { payload: null; reason: string }

export function composeSessionInit(input: ComposeSessionInitInput): ComposedSessionInit {
  const { open } = input
  const init = open.init ?? {}
  const base =
    input.hostEnvironment ?? (input.lastInitTemplate ? hostEnvironmentOf(input.lastInitTemplate) : null)
  const merged: Record<string, unknown> = { ...(base ?? {}), ...hostEnvironmentOf(init) }
  if (typeof merged.cwd !== 'string') {
    return { payload: null, reason: 'no host environment has been published to build the session from' }
  }

  const templateType =
    open.templateType ?? init.templateType ?? input.persisted?.templateType ?? (merged.templateType as string | undefined)
  const explicitRoot = open.projectRoot ?? init.projectRoot ?? input.persisted?.projectRoot
  const payload: AgentRuntimeWorkerInitPayload = {
    ...(merged as AgentRuntimeWorkerInitPayload),
    sessionId: open.sessionId,
    ...(templateType !== undefined ? { templateType } : {}),
    ...(explicitRoot ? { projectRoot: explicitRoot } : {}),
    ...(open.selection
      ? {
          userSpecifiedProviderId: open.selection.providerId,
          userSpecifiedModel: open.selection.modelId,
          ...(open.selection.thinkingTier ? { userSpecifiedThinkingTier: open.selection.thinkingTier } : {}),
        }
      : {}),
    ...(open.restored || init.restoredSessionId ? { restoredSessionId: true } : {}),
    ...(open.reinit || init.forceReinit ? { forceReinit: true } : {}),
    ...(init.traceId ? { traceId: init.traceId } : {}),
  }
  // Only a forced-folder type (`code` / `safe_code`) inherits a folder; every
  // other type opens in its per-type shared workspace. Applying it to other
  // types is the "agent session opened blank" bug.
  const needsLastFolderFor = !explicitRoot && isForcedFolderTemplateType(templateType) ? templateType! : null
  return { payload, needsLastFolderFor }
}

/**
 * The display state of a session before its run-time build (F-32): the
 * resolve halves of the model, permission-mode, plan-approval and
 * terminal-state restores, read from the session's own store, rows and
 * settings. The snapshot shows it while the runtime is unbuilt; the install
 * applies the same values to the engine.
 */
import type { BrowserLlmCatalog } from '../bridge/browserBridgeProtocol'
import type { AutoCompactWindowSettings } from '../../context/compaction/windowSettings'
import {
  applyPermissionRulesBySource,
  type PermissionSettingsBySource,
} from '../../permissions/seedPermissionContext'
import { withPermissionMode } from '../../permissions/sessionModes'
import type { Message, PendingPlanApproval } from '../../runtime/RuntimeTypes'
import type { BrowserSessionMetadata } from '../../sessions/sessionStore'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import { createInitialBrowserAppState } from '../runtime/AgentRuntimeState'
import {
  immediateSelectionView,
  type AgentModelController,
  type ImmediateSelection,
} from './AgentModelController'
import type {
  AgentPermissionCoordinator,
  PersistedModeResolution,
} from './AgentPermissionCoordinator'
import {
  pendingPlanApprovalEntry,
  resolvePendingPlanApproval,
  resolveTerminalState,
  type PlanApprovalResolution,
  type TerminalStateResolution,
} from './AgentRuntimeRecovery'
import type { AgentRuntimeWorkerInitPayload } from './workerProtocol'

/** What the install applies to the engine: the resolve halves' results. */
export type SessionRestore = {
  selection: ImmediateSelection | null
  persistedMode: PersistedModeResolution
  planApproval: PlanApprovalResolution
  terminal: TerminalStateResolution
}

/** The composer and topbar fields a built runtime would report. */
export type SessionDisplayView = {
  activeModelId: string
  currentProviderId?: string
  currentThinkingTier?: string
  permissionMode: string
  bypassPermissionsModeDisabled: boolean
  pendingPlanApproval?: Record<string, PendingPlanApproval>
  autoCompactWindows?: AutoCompactWindowSettings
}

export type SessionDisplayState = {
  restore: SessionRestore
  view: SessionDisplayView
}

export type SessionDisplayInput = {
  payload: AgentRuntimeWorkerInitPayload
  /** The building session's own store. */
  conversationStore: { getSessionMetadata?: () => Promise<BrowserSessionMetadata | undefined> }
  /** The rows the engine is seeded with. */
  rows: readonly Message[]
  cwd: string
  sessionId: string
  fs: Pick<RuntimeFs, 'readFile'>
  catalog: BrowserLlmCatalog | null
  /** The settings the build seeds its permission rules from. */
  permissionSettings: Promise<PermissionSettingsBySource> | undefined
  /** The build's auto-compact reader; loaded here. */
  autoCompactWindows: AutoCompactWindowSettings | undefined
  models: Pick<AgentModelController, 'resolveImmediateSelection'>
  permissions: Pick<AgentPermissionCoordinator, 'resolvePersistedMode'>
  now?: () => number
}

/**
 * Resolves the display state. The permission rules are seeded the way the
 * build seeds them (initial rules, then the settings), then the saved mode
 * is entered with the engine's own transition. Rejects only when the
 * session's metadata cannot be read.
 */
export async function resolveSessionDisplayState(
  input: SessionDisplayInput,
): Promise<SessionDisplayState> {
  const [metadata, permissionSources] = await Promise.all([
    input.conversationStore.getSessionMetadata?.(),
    input.permissionSettings ?? Promise.resolve<PermissionSettingsBySource>([]),
    input.autoCompactWindows?.load(),
  ])

  const selection = input.models.resolveImmediateSelection(
    input.payload,
    metadata,
    input.catalog,
  )
  const persistedMode = input.permissions.resolvePersistedMode(metadata)
  let rules = createInitialBrowserAppState().permissionRules
  if (permissionSources.some(entry => entry.permissions)) {
    rules = applyPermissionRulesBySource(rules, permissionSources)
  }
  if (persistedMode.mode) rules = withPermissionMode(rules, persistedMode.mode)

  const planApproval = await resolvePendingPlanApproval({
    metadata,
    cwd: input.cwd,
    sessionId: input.sessionId,
    fs: input.fs,
  })
  const terminal = resolveTerminalState(metadata, () => input.rows, input.now)

  // With nothing to apply, the engine keeps the model and provider it was
  // built with: the init payload's.
  const model = selection
    ? immediateSelectionView(selection)
    : {
        providerId: input.payload.userSpecifiedProviderId,
        modelId: 'inherit',
        thinkingTier: input.payload.userSpecifiedThinkingTier,
      }

  return {
    restore: { selection, persistedMode, planApproval, terminal },
    view: {
      activeModelId: model.modelId,
      ...(model.providerId ? { currentProviderId: model.providerId } : {}),
      ...(model.thinkingTier ? { currentThinkingTier: model.thinkingTier } : {}),
      permissionMode: rules.mode,
      bypassPermissionsModeDisabled: rules.bypassPermissionsModeDisabled === true,
      ...(planApproval?.kind === 'pending'
        ? { pendingPlanApproval: pendingPlanApprovalEntry(planApproval, rules.modeBeforePlan) }
        : {}),
      ...(input.autoCompactWindows ? { autoCompactWindows: input.autoCompactWindows } : {}),
    },
  }
}

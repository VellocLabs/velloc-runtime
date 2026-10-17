/**
 * AgentPermissionCoordinator — tool-confirmation queue and resolvers, permission mode (applied and
 * persisted), allow rules, dangerous-mode acknowledgment and the pending plan-approval marker.
 * One per RuntimeScope, bound to its runtime via `bindRuntime`, so a detached scope can never touch
 * the current scope's confirmations.
 */
import type { AgentRuntimeState } from '../runtime/AgentRuntimeState'
import type {
  PendingApproval,
  ToolUseConfirmOptions,
  ToolUseConfirmResolution,
} from '../../runtime/RuntimeTypes'
import {
  permissionUpdateToSettingsPatch,
  type RuleEdit,
} from '../../permissions/ruleUpdates'
import { coerceSessionMode, type SessionMode } from '../../permissions/sessionModes'
import type { BrowserSessionMetadata } from '../../sessions/sessionStore'
import { PLAN_OFF_TOOL_ID } from '../../toolkit/builtin/planExit'
import {
  unsafeModeAckGiven,
  updateSectionInSource,
} from '../../settings/settingsStore'

/** A saved permission mode, resolved; `mode` is absent when none is saved. */
export type PersistedModeResolution = { mode?: SessionMode }

export type AgentPermissionSnapshot = {
  skipDangerousModePermissionPrompt: boolean
}

export type ToolUseConfirmResolvePayload = {
  approvalCallId: string
  behavior: 'allow' | 'reject' | 'abort'
  updatedInput?: Record<string, unknown>
  feedback?: string
  ruleEdits?: RuleEdit[]
}

/**
 * The worker-provided seam the coordinator acts through. Runtime access is
 * NOT part of it — the coordinator is bound to its own scope's runtime via
 * `bindRuntime`, which is what keeps detached-scope disposal isolated.
 */
export interface AgentPermissionCoordinatorHost {
  /** Push a fresh `worker.state` snapshot (confirm queue / flag changes). */
  emitState(): void
  /** Emit a `worker.error` (e.g. resolving an unknown confirmation id). */
  emitError(code: string, message: string): void
}

export class AgentPermissionCoordinator {
  private toolUseConfirmResolvers = new Map<
    string,
    (resolution: ToolUseConfirmResolution) => void
  >()
  private skipDangerousModePermissionPrompt = false
  private runtime: AgentRuntimeState | null = null

  constructor(private readonly host: AgentPermissionCoordinatorHost) {}

  bindRuntime(runtime: AgentRuntimeState): void {
    this.runtime = runtime
  }

  getResolvers(): Map<string, (resolution: ToolUseConfirmResolution) => void> {
    return this.toolUseConfirmResolvers
  }

  getSkipDangerousMode(): boolean {
    return this.skipDangerousModePermissionPrompt
  }

  setSkipDangerousMode(value: boolean): void {
    this.skipDangerousModePermissionPrompt = value
  }

  snapshot(): AgentPermissionSnapshot {
    return {
      skipDangerousModePermissionPrompt: this.skipDangerousModePermissionPrompt,
    }
  }

  reset(): void {
    this.toolUseConfirmResolvers.clear()
    this.skipDangerousModePermissionPrompt = false
    this.runtime = null
  }

  // --- Tool confirmations ---

  /**
   * The engine's confirmation callback: parks the resolver, enqueues the item and pushes a snapshot.
   * A `PermissionRequest` hook's answer (`options.decided`) settles it like the person's, with
   * `decidedBy: 'hook'`.
   */
  request = (
    item: PendingApproval,
    options?: ToolUseConfirmOptions,
  ): Promise<ToolUseConfirmResolution> => {
    if (!this.runtime) {
      return Promise.resolve({
        approvalCallId: item.approvalCallId,
        behavior: 'abort',
        feedback: 'Runtime is not initialized.',
      })
    }

    // Persist a metadata marker for ExitPlanMode so the approval can be
    // restored after a restart (the transcript never gets the tool_use
    // because the turn halts before flushing).
    if (item.toolName === PLAN_OFF_TOOL_ID) {
      void this.runtime.conversationStore.updateSessionMetadata?.({
        pendingPlanApprovalToolCallId: item.approvalCallId,
      }).catch(() => {})
    }

    return new Promise(resolve => {
      this.toolUseConfirmResolvers.set(item.approvalCallId, resolve)
      this.runtime?.setAppState(prev => {
        const queue = prev.approvalQueue ?? []
        if (queue.some(entry => entry.approvalCallId === item.approvalCallId)) {
          return prev
        }
        return {
          ...prev,
          approvalQueue: [...queue, item],
        }
      })
      this.host.emitState()
      options?.decided?.then(
        decision => {
          // Settled already (the person answered, or the turn was aborted).
          if (!decision || this.toolUseConfirmResolvers.get(item.approvalCallId) !== resolve) return
          void this.resolveConfirm({ approvalCallId: item.approvalCallId, ...decision }, 'hook')
        },
        () => {},
      )
    })
  }

  private clearFromQueue(approvalCallId: string): void {
    this.runtime?.setAppState(prev => {
      const queue = prev.approvalQueue ?? []
      if (queue.length === 0) return prev
      const next = queue.filter(item => item.approvalCallId !== approvalCallId)
      if (next.length === queue.length) return prev
      return {
        ...prev,
        approvalQueue: next,
      }
    })
  }

  /**
   * User-interrupt path: abort every pending confirmation AND clear the
   * persisted pending-plan-approval marker (the user walked away from the
   * approval). Dispose paths use `abortAllConfirmations` instead — a
   * superseded scope must NOT clear the marker the new scope may restore.
   */
  resolveAllAsAbort(): void {
    if (this.toolUseConfirmResolvers.size === 0) return
    const entries = [...this.toolUseConfirmResolvers.entries()]
    this.toolUseConfirmResolvers.clear()
    this.runtime?.setAppState(prev => ({
      ...prev,
      approvalQueue: [],
    }))
    // Clear the persisted pending-plan-approval marker (abort path).
    void this.clearPendingPlanApprovalMarker()
    for (const [approvalCallId, resolve] of entries) {
      resolve({
        approvalCallId,
        behavior: 'abort',
        feedback: 'User aborted',
      })
    }
  }

  /** Dispose/teardown path: abort pending confirmations without touching the
   *  persisted plan-approval marker. */
  abortAllConfirmations(reason: string): void {
    if (this.toolUseConfirmResolvers.size === 0) return
    const entries = [...this.toolUseConfirmResolvers.entries()]
    this.toolUseConfirmResolvers.clear()
    this.runtime?.setAppState(prev => ({
      ...prev,
      approvalQueue: [],
    }))
    for (const [approvalCallId, resolve] of entries) {
      resolve({
        approvalCallId,
        behavior: 'abort',
        feedback: reason,
      })
    }
  }

  /** Clear the persisted `pendingPlanApprovalToolCallId` metadata marker. */
  async clearPendingPlanApprovalMarker(approvalCallId?: string): Promise<void> {
    // Capture locally: `reset()` nulls `this.runtime` on scope
    // disposal, so a re-read after the await below could TypeError mid-flight.
    // Same pattern in every async method of this file and the recovery module.
    const runtime = this.runtime
    if (!runtime) return
    try {
      const metadata =
        await runtime.conversationStore.getSessionMetadata?.()
      const stored = metadata?.pendingPlanApprovalToolCallId
      // Only clear if it matches (or unconditionally when no id given).
      if (stored && (!approvalCallId || stored === approvalCallId)) {
        await runtime.conversationStore.updateSessionMetadata?.({
          pendingPlanApprovalToolCallId: undefined,
        })
      }
    } catch {
      // best-effort
    }
  }

  private async applyConfirmPermissionUpdates(
    updates: RuleEdit[] | undefined,
  ): Promise<void> {
    const runtime = this.runtime
    if (!updates || updates.length === 0 || !runtime) return
    for (const update of updates) {
      runtime.engine.applyRuleChange(update)
      const dest = 'destination' in update ? update.destination : undefined
      if (
        dest !== 'userSettings' &&
        dest !== 'projectSettings' &&
        dest !== 'localSettings'
      ) {
        continue
      }
      const projectRoot = runtime.options.projectRoot
      const source =
        dest !== 'userSettings' && !projectRoot ? 'userSettings' : dest
      const homeDir = runtime.options.settingsHomeDir ?? ''
      try {
        await updateSectionInSource(
          source,
          { homeDir, projectRoot },
          runtime.installedFs,
          'permissions',
          prev => permissionUpdateToSettingsPatch(prev, update) ?? prev ?? {},
        )
      } catch {
        /* non-fatal — the in-session update still applies */
      }
    }
  }

  /** Resolve an interactive tool confirmation (worker.resolveToolUseConfirm). */
  async resolveConfirm(
    payload: ToolUseConfirmResolvePayload,
    decidedBy?: 'hook',
  ): Promise<void> {
    const resolve = this.toolUseConfirmResolvers.get(payload.approvalCallId)
    if (!resolve) {
      this.host.emitError(
        'tool_use_confirm_not_found',
        `No pending tool confirmation for '${payload.approvalCallId}'.`,
      )
      return
    }
    this.toolUseConfirmResolvers.delete(payload.approvalCallId)
    this.clearFromQueue(payload.approvalCallId)
    // Clear the persisted pending-plan-approval marker if this was the
    // ExitPlanMode approval (so a later restart doesn't re-offer it).
    void this.clearPendingPlanApprovalMarker(payload.approvalCallId)
    await this.applyConfirmPermissionUpdates(payload.ruleEdits)
    resolve({
      approvalCallId: payload.approvalCallId,
      behavior: payload.behavior,
      updatedInput: payload.updatedInput,
      feedback: payload.feedback,
      ...(decidedBy ? { decidedBy } : {}),
    })
    this.host.emitState()
  }

  // --- Permission mode ---

  /**
   * Apply a user-picked permission mode (coerced; unknown → `default`) and persist the mode the engine
   * ENDED UP in, which differs when the `disableBypassPermissionsMode` killswitch refuses it.
   */
  async applyMode(requestedMode: string): Promise<void> {
    const runtime = this.runtime
    if (!runtime) {
      return
    }
    const requested = coerceSessionMode(requestedMode)
    runtime.engine.setPermissionMode(requested)
    const mode = runtime.engine.getCurrentPermissionMode?.() ?? requested
    const metadata =
      await runtime.conversationStore.getSessionMetadata?.()
    if (metadata?.permissionMode !== mode) {
      await runtime.conversationStore.updateSessionMetadata?.({
        permissionMode: mode,
      })
    }
  }

  /**
   * Persist the engine's current permission mode to session metadata when it
   * has drifted from what's stored. Picker changes already persist via
   * applyMode; this covers the model-driven path — EnterPlanMode /
   * ExitPlanMode flip the mode through the tool's setAppState, which no persist
   * step observes. Called at the turn boundary. Best-effort: a metadata write
   * must never break turn completion.
   */
  async persistModeIfChanged(): Promise<void> {
    const runtime = this.runtime
    if (!runtime) {
      return
    }
    const mode = runtime.engine.getCurrentPermissionMode?.()
    if (!mode) {
      return
    }
    try {
      const metadata =
        await runtime.conversationStore.getSessionMetadata?.()
      if (metadata?.permissionMode !== mode) {
        await runtime.conversationStore.updateSessionMetadata?.({
          permissionMode: mode,
        })
      }
    } catch {
      // Best-effort — never fail turn completion on a metadata write.
    }
  }

  /**
   * The session's saved permission mode, read as a mode id; `mode` is absent
   * when none is saved. The resolve half of `applyPersistedMode`.
   */
  resolvePersistedMode(
    metadata: Pick<BrowserSessionMetadata, 'permissionMode'> | undefined,
  ): PersistedModeResolution {
    const persistedMode = metadata?.permissionMode
    return typeof persistedMode === 'string' && persistedMode
      ? { mode: coerceSessionMode(persistedMode) }
      : {}
  }

  /**
   * Re-apply the persisted permission mode (if any) at init — the mode
   * analogue of the model controller's persisted-llmSelection restore.
   * `resolved` is a mode resolved earlier; when omitted it is read now.
   */
  async applyPersistedMode(resolved?: PersistedModeResolution): Promise<void> {
    const runtime = this.runtime
    if (!runtime) {
      return
    }
    const { mode } =
      resolved ??
      this.resolvePersistedMode(await runtime.conversationStore.getSessionMetadata?.())
    if (mode) {
      runtime.engine.setPermissionMode(mode)
    }
  }

  // --- Permission rules / updates ---

  /**
   * "Always allow" from the permission banner (worker.addPermissionRule):
   * live-add so the model's retry of the gated tool passes THIS session,
   * clear the pending prompt, and (when `persist`) write the rule to
   * settings.
   */
  async addAllowRule(
    rule: string,
    toolCallId: string,
    persist: boolean,
  ): Promise<void> {
    if (!this.runtime) return
    // Live add so the model's retry of the gated tool passes THIS session.
    this.runtime.engine.addAllowRule(rule)
    this.runtime.engine.clearPendingPermission(toolCallId)
    if (persist) {
      // "Always allow" persists to `localSettings`
      // (`<projectRoot>/.velloc/settings.local.json`), the project-local,
      // gitignored scope. Falls
      // back to `userSettings` when there's no project root — otherwise the
      // local file would never be read back (`loadEffectiveSettings` skips
      // project/local without a projectRoot). Best-effort; the live rule
      // already applies this session regardless.
      const projectRoot = this.runtime.options.projectRoot
      const source = projectRoot ? 'localSettings' : 'userSettings'
      // `userSettings` resolves under `homeDir` → use the real settings
      // home (not cwd/workspace) so the rule lands in ~/.velloc and is read
      // back next boot. (For `localSettings` the root is projectRoot, so
      // homeDir is irrelevant there.)
      const homeDir = this.runtime.options.settingsHomeDir ?? ''
      try {
        await updateSectionInSource(
          source,
          { homeDir, projectRoot },
          this.runtime.installedFs,
          'permissions',
          // Unified through the RuleEdit persist mapping (F-13) so
          // the banner's "Always allow" writes via the same path richer
          // updates (deny/ask/dirs) will use. `source` is always persisted
          // here, so the patch is never null.
          prev =>
            permissionUpdateToSettingsPatch(prev, {
              type: 'addRules',
              behavior: 'allow',
              rules: [rule],
              destination: source,
            }) ?? prev ?? { allow: [rule] },
        )
      } catch {
        /* non-fatal — the in-session rule still applies */
      }
    }
  }

  /**
   * General RuleEdit (F-13, worker.applyRuleEdit): live
   * apply, optional pending-prompt clear, and persistence for a
   * settings-backed destination (mirrors addAllowRule's fallback rules).
   */
  async applyUpdate(update: RuleEdit, toolCallId?: string): Promise<void> {
    if (!this.runtime) return
    // Live apply so the model's retry of the gated tool passes THIS session.
    this.runtime.engine.applyRuleChange(update)
    if (toolCallId) {
      this.runtime.engine.clearPendingPermission(toolCallId)
    }
    // Persist for a settings-backed destination (mirrors addAllowRule):
    // localSettings/projectSettings need a projectRoot, else fall back to
    // userSettings so the change is read back next boot.
    const dest = 'destination' in update ? update.destination : undefined
    if (
      dest === 'userSettings' ||
      dest === 'projectSettings' ||
      dest === 'localSettings'
    ) {
      const projectRoot = this.runtime.options.projectRoot
      const source =
        dest !== 'userSettings' && !projectRoot ? 'userSettings' : dest
      const homeDir = this.runtime.options.settingsHomeDir ?? ''
      try {
        await updateSectionInSource(
          source,
          { homeDir, projectRoot },
          this.runtime.installedFs,
          'permissions',
          prev => permissionUpdateToSettingsPatch(prev, update) ?? prev ?? {},
        )
      } catch {
        /* non-fatal — the in-session update still applies */
      }
    }
  }

  // --- Dangerous-mode acknowledgment ---

  /**
   * Persist the bypass-warning acknowledgment (F-13) to
   * userSettings — the trusted, user-scope source the acknowledgment is read
   * from (projectSettings is intentionally never a source: RCE risk).
   */
  async persistSkipDangerousMode(value: boolean): Promise<void> {
    if (!this.runtime) return
    const homeDir = this.runtime.options.settingsHomeDir ?? ''
    try {
      await updateSectionInSource(
        'userSettings',
        { homeDir },
        this.runtime.installedFs,
        'skipDangerousModePermissionPrompt',
        () => value,
      )
      this.skipDangerousModePermissionPrompt = value
    } catch (err) {
      // Non-fatal: the cached flag stays unchanged (so the emitted snapshot
      // matches disk — the UI sees the ack did NOT persist and will
      // re-prompt next time), but surface it rather than swallowing silently.
      console.error('[skipDangerousMode] failed to persist', err)
    }
  }

  /** Load the bypass-warning acknowledgment flag (F-13) at init so the
   *  first switch into bypassPermissions this session knows whether to warn.
   *  Best-effort. */
  async loadSkipDangerousMode(): Promise<void> {
    if (!this.runtime) return
    const homeDir = this.runtime.options.settingsHomeDir
    this.skipDangerousModePermissionPrompt = homeDir
      ? await unsafeModeAckGiven(homeDir, this.runtime.installedFs)
      : false
  }
}

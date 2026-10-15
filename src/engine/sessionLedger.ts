/**
 * The state one conversation engine keeps between turns: the transcript
 * rows, the conversation epoch, the counters a result reports, the
 * agent-loop ledger, the halts waiting on the user, the permission mode, the
 * model selection and the app-state accessors. Every other engine part reads
 * and writes the session through this object.
 */
import type {
  AgentProfile,
  WorkingState,
  ReadFileLedger,
  Message,
} from '../runtime/RuntimeTypes'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { isMemoryMaintenanceMode, type ResolvedMemorySettings } from '../memory/memoryPaths'
import { applyPermissionUpdate, type RuleEdit } from '../permissions/ruleUpdates'
import { mayEnterMode } from '../permissions/sessionModes'
import { mergeAgentLoopSettings } from '../config/agentLoopConfig'
import { createAgentLoopState, type AgentLoopState } from './loop/agentLoopState'
import { getSessionId as storeSessionId } from '../sessions/sessionStore'
import { clearMainInvokedSkills } from '../skillLibrary/invokedSkillsStore'
import { setSessionModelSettingsSnapshot } from '../models/tierSettingsSnapshot'
import { normalizeModelTiers, normalizeSessionModelPolicy } from '../settings/sessionModelSettings'
import type { SessionStartSource } from '../lifecycleHooks/sessionLifecycleHooks'
import { buildCallContext } from './callContextFactory'
import {
  MAIN_SESSION_STEP_CEILING,
  type ConversationEngineConfig,
  type ModelSelection,
} from './engineConfig'

/** The three kinds of record a halted tool call leaves for the user. */
type HaltField = 'pendingPermissions' | 'pendingPlanApproval' | 'pendingUserInteraction'

const MEMORY_SWITCHES = ['autoMemoryEnabled', 'autoExtractEnabled', 'memoryRecallEnabled'] as const

export class SessionLedger {
  readonly config: ConversationEngineConfig
  rows: Message[]
  /** Bumped whenever the conversation is replaced by a new one (`/clear`),
   *  so a copy of the stream knows to replace itself. */
  epoch = 0
  /** Submits since the session (or the last `/clear`) began. */
  turnCount = 0
  cancelSource: AbortController
  deniedCalls: Array<Record<string, unknown>> = []
  usageSoFar: Record<string, unknown> = {}
  readonly fileReadLedger: ReadFileLedger
  readonly postCompactReads: ReadFileLedger = new Map()
  readonly recentReadPaths: Set<string>
  /** Rule files already brought in; emptied on compaction. */
  readonly nestedMemoryPathsSeen = new Set<string>()
  /** Instruction files the current system prompt carries; updated in place
   *  each render and kept across compaction. */
  readonly promptInstructionPaths = new Set<string>()
  agentLoopState: AgentLoopState
  /** The source the next model-bound turn raises `SessionStart` with:
   *  undefined before the first submit, null once raised. */
  sessionStartSource: SessionStartSource | null | undefined = undefined
  /** The id `turn.start` gave the turn in flight. */
  runningTurnId: string | undefined
  /** Settles when the turn in flight ends; reloads wait for it. */
  turnEnded: Promise<void> | undefined
  /** The extension reload that follows a turn, while it runs. */
  modsSettling: Promise<void> | undefined
  /** The extensions coming back after an idle unload, while that runs. */
  modsArriving: Promise<void> | undefined
  /** Told of every submit before anything is awaited. */
  afterSubmit: (() => void) | undefined
  private readonly fixedCeiling: boolean
  /** Whether host settings were pushed yet. The first push of every engine
   *  drops the host's page-observation baseline, which may belong to an
   *  earlier life of the same session id. */
  private pushedOnce = false

  constructor(config: ConversationEngineConfig) {
    this.config = config
    this.rows = config.seedTranscript ? [...config.seedTranscript] : []
    this.cancelSource = config.cancelSource ?? new AbortController()
    this.fileReadLedger = config.fileReadSeed
    this.recentReadPaths = config.recentReadPaths ?? new Set<string>()
    config.recentReadPaths = this.recentReadPaths
    this.fixedCeiling = config.isSubAgent !== true
    if (this.fixedCeiling) config.maxTurns = MAIN_SESSION_STEP_CEILING
    this.agentLoopState = createAgentLoopState(mergeAgentLoopSettings(config.agentLoopSettings))
  }

  sessionId(): string {
    return storeSessionId(this.config.conversationStore)
  }

  activeModel(): string {
    return this.config.pickedModel ?? 'inherit'
  }

  /** A call context over this session's live holders, its rows attached. */
  callContext(model: string = this.activeModel(), cancelSource = new AbortController()): ToolCallContext {
    const context = buildCallContext(this.config, model, cancelSource, {
      agentLoopState: this.agentLoopState,
      nestedMemoryPathsSeen: this.nestedMemoryPathsSeen,
      promptInstructionPaths: this.promptInstructionPaths,
      postCompactReads: this.postCompactReads,
    })
    context.messages = this.rows
    return context
  }

  /** A fresh cancel source when the last one was used up. */
  renewCancelSource(): void {
    if (this.cancelSource.signal.aborted) this.cancelSource = new AbortController()
  }

  /** Pushes the action timeout and the working directory to the host's tool
   *  session. Not awaited by callers; a host without the route is ignored. */
  async pushHostSettings(options?: { clearReadState?: boolean; clearBrowserObservationCache?: boolean }): Promise<void> {
    const session = this.config.platformCapabilities?.session
    const setter = session?.setAgentLoopSettings
    if (!setter) return
    // Claimed before the await, so a racing second push is not also first.
    const firstPush = !this.pushedOnce
    this.pushedOnce = true
    try {
      await setter.call(session, {
        actionTimeoutMs: this.agentLoopState.settings.actionTimeoutMs,
        cwd: this.config.cwd,
        clearReadState: options?.clearReadState,
        browserObservationDiffOptIn: true,
        clearBrowserObservationCache: firstPush || options?.clearBrowserObservationCache === true ? true : undefined,
        executionContext: { sessionId: this.sessionId() },
      })
    } catch {
      // Older hosts and test hosts lack the route; their defaults apply.
    }
  }

  /** Starts the conversation over after the store opened a new one. */
  startOver(): void {
    this.rows = []
    clearMainInvokedSkills(this.sessionId())
    this.epoch++
    this.turnCount = 0
    this.deniedCalls = []
    this.usageSoFar = {}
    this.agentLoopState = createAgentLoopState(mergeAgentLoopSettings(this.config.agentLoopSettings))
    this.fileReadLedger.clear?.()
    this.postCompactReads.clear?.()
    void this.pushHostSettings({ clearReadState: true, clearBrowserObservationCache: true })
  }

  /** Applies host-pushed agent settings; only `maxTurns` is read, and a main
   *  session keeps its fixed ceiling. */
  applyRuntimeSettings(settings: Record<string, unknown>): void {
    if (!settings || typeof settings !== 'object') return
    if (this.fixedCeiling) {
      this.config.maxTurns = MAIN_SESSION_STEP_CEILING
      return
    }
    const maxTurns = settings.maxTurns
    if (typeof maxTurns === 'number' && Number.isFinite(maxTurns)) {
      this.config.maxTurns = Math.min(10000, Math.max(10, Math.trunc(maxTurns)))
    }
  }

  /** Applies the memory switches for the next turn. The memory directory is
   *  left alone: moving it mid-session would split reads from writes. */
  applyMemorySettings(settings: Record<string, unknown>): void {
    if (!settings || typeof settings !== 'object') return
    const next: ResolvedMemorySettings = { ...(this.config.memorySettings ?? {}) }
    for (const name of MEMORY_SWITCHES) {
      const value = settings[name]
      if (typeof value === 'boolean') next[name] = value
      else if (value === null) delete next[name]
    }
    const mode = settings.memoryMaintenance
    if (isMemoryMaintenanceMode(mode)) next.memoryMaintenance = mode
    else if (mode === null) delete next.memoryMaintenance
    this.config.memorySettings = next
  }

  /** Replaces the realm-wide tier and routing tables, validated the way a
   *  settings read validates them. */
  applySessionModelSettings(settings: Record<string, unknown>): void {
    if (!settings || typeof settings !== 'object') return
    setSessionModelSettingsSnapshot({
      modelTiers: normalizeModelTiers(settings.modelTiers),
      sessionModelPolicy: normalizeSessionModelPolicy(settings.sessionModelPolicy),
    })
  }

  modelSelection(): ModelSelection {
    return {
      providerId: this.config.userSpecifiedProviderId,
      model: this.activeModel(),
      thinkingTier: this.config.userSpecifiedThinkingTier,
    }
  }

  setModelSelection(selection: ModelSelection): void {
    this.config.userSpecifiedProviderId = selection.providerId
    this.config.pickedModel = selection.model
    this.config.userSpecifiedThinkingTier = selection.thinkingTier
  }

  modeInEffect(): string {
    return this.config.readAppState().permissionRules.mode
  }

  /** Changes the permission mode, remembering the mode plan mode was entered
   *  from. A mode the settings forbid is refused. */
  setPermissionMode(mode: string): void {
    this.config.writeAppState(prev => {
      const oldMode = prev.permissionRules.mode
      if (oldMode === mode) return prev
      if (!mayEnterMode(mode, prev.permissionRules)) return prev
      let modeBeforePlan = prev.permissionRules.modeBeforePlan
      if (mode === 'plan' && oldMode !== 'plan') modeBeforePlan = oldMode
      else if (oldMode === 'plan' && mode !== 'plan') modeBeforePlan = undefined
      return { ...prev, permissionRules: { ...prev.permissionRules, mode, modeBeforePlan } }
    })
  }

  applyRuleChange(update: RuleEdit): void {
    this.config.writeAppState(prev => ({
      ...prev,
      permissionRules: applyPermissionUpdate(prev.permissionRules, update),
    }))
  }

  pending<F extends HaltField>(field: F): WorkingState[F] | undefined {
    return this.config.readAppState()[field]
  }

  /** Drops one halt record by tool-call id, or all of that kind. */
  dropPending(field: HaltField, toolCallId?: string): void {
    this.config.writeAppState(prev => {
      const records = prev[field] as Record<string, unknown> | undefined
      if (!records) return prev
      if (toolCallId === undefined) return { ...prev, [field]: {} }
      if (!(toolCallId in records)) return prev
      const next = { ...records }
      delete next[toolCallId]
      return { ...prev, [field]: next }
    })
  }

  /** A cancelled turn takes its halts with it: the answer that would clear
   *  them can no longer arrive. */
  dropAllPending(): void {
    this.dropPending('pendingUserInteraction')
    this.dropPending('pendingPlanApproval')
    this.dropPending('pendingPermissions')
  }

  /** Prompts the user typed: neither generated rows nor tool answers. */
  countUserTurns(): number {
    let turns = 0
    for (const message of this.rows) {
      if (message.type !== 'user') continue
      const user = message as { isMeta?: boolean; message?: { content?: unknown } }
      if (user.isMeta) continue
      const content = user.message?.content
      if (typeof content === 'string') turns += 1
      else if (Array.isArray(content) && content.some(block => (block as { type?: unknown })?.type === 'text')) turns += 1
    }
    return turns
  }

  /** The model the newest reply names. */
  lastResponseModel(): string | undefined {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const message = this.rows[i]!
      if (message.type !== 'assistant') continue
      const model = (message as { message?: { model?: unknown } }).message?.model
      if (typeof model === 'string' && model !== '') return model
    }
    return undefined
  }

  /** Makes the next turn wait for `arriving`, which never rejects into it. */
  waitForMods(arriving: Promise<void>): void {
    const settled = arriving.catch(() => undefined)
    this.modsArriving = settled
    void settled.then(() => {
      if (this.modsArriving === settled) this.modsArriving = undefined
    })
  }

  /** Remembers the post-turn extension reload until it settles. */
  noteSettling(work: Promise<unknown>): void {
    const settling: Promise<void> = work.then(() => undefined, () => undefined)
    this.modsSettling = settling
    void settling.then(() => {
      if (this.modsSettling === settling) this.modsSettling = undefined
    })
  }

  /** Reloads the extensions whose module text changed, after the turn in
   *  flight. False when there is nothing to reload. */
  async reloadMods(): Promise<boolean> {
    if (this.turnEnded) await this.turnEnded
    const mods = this.config.mods
    if (!mods?.reload) return false
    await mods.reload()
    return true
  }

  /** Re-runs plugin discovery after the turn in flight and swaps in what it
   *  found; agents an extension registered are kept. */
  async refreshPluginSet(activePluginSet: string[] | undefined, registeredAgents: () => AgentProfile[]): Promise<boolean> {
    if (this.turnEnded) await this.turnEnded
    const reloaded = await this.config.onReloadPlugins?.(activePluginSet)
    if (!reloaded) return false
    this.config.commands = reloaded.commands
    this.config.deniedSkillNames = reloaded.deniedSkillNames ?? []
    this.config.agents = [...reloaded.agents, ...registeredAgents()]
    this.config.plugins = reloaded.plugins
    return true
  }

  /** Throws while a model turn runs: it holds its own copy of the rows. */
  refuseDuringModelTurn(call: string): void {
    if (this.runningTurnId === undefined) return
    const error = new Error(`${call} cannot run while a model turn runs (${this.runningTurnId}); call it between turns`)
    error.name = 'InvalidStateError'
    throw error
  }
}

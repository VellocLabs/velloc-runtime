/**
 * The conversation engine, one per session; each call is answered by one of its parts: SessionLedger,
 * turnRunner, TranscriptWriter, SessionTitler, ExtensionHosts.
 */
import type { WorkingState, ContentBlockParam, ReadFileLedger, Message, StreamRecord } from '../runtime/RuntimeTypes'
import type { RuleEdit } from '../permissions/ruleUpdates'
import type { CommandDescribeInput, CommandDescription } from '../mods/describeEvents'
import { splitCommandWord } from '../input/slashCommandCatalog'
import { sanitizeMessageForPersistence } from '../utils/toolCallDetails'
import { runNotificationHooks, type HookNotification } from '../lifecycleHooks/sessionLifecycleHooks'
import type { ConversationEngineConfig, ModelSelection, SubmitTurnOptions } from './engineConfig'
import { SessionLedger } from './sessionLedger'
import { TranscriptWriter } from './transcriptWriter'
import { SessionTitler } from './autoTitle'
import { ExtensionHosts } from './extensionHosts'
import { runTurn, type EngineParts } from './turnRunner'

export type { ConversationEngineConfig, ModelSelection, SubmitTurnOptions } from './engineConfig'

export class ConversationEngine {
  private readonly ledger: SessionLedger
  private readonly titler: SessionTitler
  private readonly hosts: ExtensionHosts
  private readonly parts: EngineParts

  constructor(config: ConversationEngineConfig) {
    this.ledger = new SessionLedger(config)
    const writer = new TranscriptWriter(this.ledger)
    this.titler = new SessionTitler(
      { store: config.conversationStore, rows: () => this.ledger.rows, sessionId: () => this.ledger.sessionId() },
      config.titleServices,
    )
    this.hosts = new ExtensionHosts(this.ledger, writer)
    this.parts = { ledger: this.ledger, writer, titler: this.titler, hosts: this.hosts }
  }

  // Turns

  /** Runs one turn for `prompt`, yielding every row the stream shows. */
  submitTurn(prompt: string | Array<ContentBlockParam>, options?: SubmitTurnOptions): AsyncGenerator<StreamRecord, void, unknown> {
    return runTurn(this.parts, prompt, options)
  }

  /** Cancels the turn in flight and the halts that belonged to it. */
  cancelTurn(): void {
    this.ledger.cancelSource.abort()
    this.ledger.dropAllPending()
  }

  /** An extension's `$.turn.abort`: rejects unless `turnId` is running. */
  abortTurn(turnId: string): void {
    const running = this.ledger.runningTurnId
    if (running === undefined || running !== turnId) {
      throw new Error(`$.turn.abort: ${turnId} is not the running turn${running ? ` (${running})` : ' (none is running)'}`)
    }
    this.cancelTurn()
  }

  /** Hears every submit, synchronously, before anything is awaited. */
  setOnSubmit(onSubmit: (() => void) | undefined): void {
    this.ledger.afterSubmit = onSubmit
  }

  // Transcript

  transcriptRows(): readonly Message[] {
    return this.ledger.rows
  }

  /** Changes whenever the conversation is replaced (`/clear`). */
  getConversationEpoch(): number {
    return this.ledger.epoch
  }

  /** Between turns: drops the tool payloads the rows hold, keeping their
   *  stored shape. The caller checked that the store has every row. */
  releaseToolPayloads(): void {
    this.ledger.rows = this.ledger.rows.map(sanitizeMessageForPersistence)
  }

  fileReadLedgerSnapshot(): ReadFileLedger {
    return this.ledger.fileReadLedger
  }

  boundSessionId(): string {
    return this.ledger.sessionId()
  }

  /** Prompts the user typed this session (`$.session.turns`). */
  countUserTurns(): number {
    return this.ledger.countUserTurns()
  }

  /** Cancels a background title attempt (a manual rename supersedes it). */
  cancelAutoTitleGeneration(): void {
    this.titler.cancel()
  }

  /** The `Notification` hooks for a notice about this session; never rejects. */
  async runNotificationHooks(notification: HookNotification): Promise<void> {
    await runNotificationHooks(notification, this.ledger.callContext())
  }

  // Settings

  applyRuntimeSettings(settings: Record<string, unknown>): void {
    this.ledger.applyRuntimeSettings(settings)
  }

  applyMemorySettings(settings: Record<string, unknown>): void {
    this.ledger.applyMemorySettings(settings)
  }

  applySessionModelSettings(settings: Record<string, unknown>): void {
    this.ledger.applySessionModelSettings(settings)
  }

  /** The step ceiling the next turn runs under. */
  getCurrentMaxTurns(): number | undefined {
    return this.ledger.config.maxTurns
  }

  // Model selection

  getCurrentModel(): string {
    return this.ledger.activeModel()
  }

  getCurrentProviderId(): string | undefined {
    return this.ledger.config.userSpecifiedProviderId
  }

  getCurrentThinkingTier(): string | undefined {
    return this.ledger.config.userSpecifiedThinkingTier
  }

  getCurrentModelSelection(): ModelSelection {
    return this.ledger.modelSelection()
  }

  switchModel(model: string): void {
    this.ledger.config.pickedModel = model
  }

  setModelSelection(selection: ModelSelection): void {
    this.ledger.setModelSelection(selection)
  }

  // Permissions and halts

  getCurrentPermissionMode(): string {
    return this.ledger.modeInEffect()
  }

  setPermissionMode(mode: string): void {
    this.ledger.setPermissionMode(mode)
  }

  /** Applies a rule change to the live session (storing it is the caller's). */
  applyRuleChange(update: RuleEdit): void {
    this.ledger.applyRuleChange(update)
  }

  /** Adds a session allow rule; an empty rule is ignored. */
  addAllowRule(rule: string): void {
    if (!rule) return
    this.ledger.applyRuleChange({ type: 'addRules', behavior: 'allow', rules: [rule], destination: 'session' })
  }

  getPendingPermissions(): WorkingState['pendingPermissions'] | undefined {
    return this.ledger.pending('pendingPermissions')
  }

  getPendingPlanApproval(): WorkingState['pendingPlanApproval'] | undefined {
    return this.ledger.pending('pendingPlanApproval')
  }

  getPendingUserInteraction(): WorkingState['pendingUserInteraction'] | undefined {
    return this.ledger.pending('pendingUserInteraction')
  }

  clearPendingPermission(toolCallId?: string): void {
    this.ledger.dropPending('pendingPermissions', toolCallId)
  }

  clearPendingPlanApproval(toolCallId?: string): void {
    this.ledger.dropPending('pendingPlanApproval', toolCallId)
  }

  clearPendingUserInteraction(toolCallId?: string): void {
    this.ledger.dropPending('pendingUserInteraction', toolCallId)
  }

  // Plugins and extensions

  /** Re-runs plugin discovery (after the turn in flight) and swaps in what
   *  it found. Without a list the enabled-plugin files are read again. */
  refreshPluginSet(activePluginSet?: string[]): Promise<boolean> {
    return this.ledger.refreshPluginSet(activePluginSet, () => this.hosts.registeredAgents.list())
  }

  /** Reloads the extensions whose module changed, after the turn in flight. */
  reloadMods(): Promise<boolean> {
    return this.ledger.reloadMods()
  }

  setMods(mods: ConversationEngineConfig['mods']): void {
    this.ledger.config.mods = mods
  }

  /** The next turn starts once `arriving` settled. */
  waitForMods(arriving: Promise<void>): void {
    this.ledger.waitForMods(arriving)
  }

  get modTools(): ExtensionHosts['tools'] {
    return this.hosts.tools
  }

  get modModel(): ExtensionHosts['model'] {
    return this.hosts.model
  }

  get modAgents(): ExtensionHosts['agents'] {
    return this.hosts.agents
  }

  get modTranscript(): ExtensionHosts['transcript'] {
    return this.hosts.transcript
  }

  get modConversation(): ExtensionHosts['conversation'] {
    return this.hosts.conversation
  }

  get modPrompt(): ExtensionHosts['prompt'] {
    return this.hosts.prompt
  }

  /** Told when an extension changed the conversation outside the stream. */
  setConversationRewrittenListener(listener: (() => void) | undefined): void {
    this.hosts.setRewrittenListener(listener)
  }

  /** `command.describe`: the extensions' view of the picker's commands.
   *  `inputs` is built only when a hook will read it. */
  describeCommands(inputs: () => readonly CommandDescribeInput[]): Map<string, CommandDescription> {
    const mods = this.ledger.config.mods
    if (!mods?.commandDescriptions || mods.hasCommandDescribeHooks?.() === false) return new Map()
    try {
      return mods.commandDescriptions(inputs())
    } catch {
      return new Map()
    }
  }

  /** Whether `/name args` names an extension command that runs at once,
   *  even while a turn is in flight. */
  isImmediateCommand(prompt: string): boolean {
    if (!prompt.trimStart().startsWith('/')) return false
    const { command } = splitCommandWord(prompt.trim())
    return command !== '' && this.ledger.config.mods?.isImmediateCommand?.(command) === true
  }

  /** Runs such a command beside the turn: its hook chain only, no rows. */
  async runImmediateCommand(prompt: string): Promise<void> {
    const { command, args } = splitCommandWord(prompt.trim())
    await this.ledger.config.mods?.commandRunImmediate?.({ command, args })
  }

  /** The slash commands the extensions registered, for the picker. */
  listModCommands(): ReadonlyArray<{ name: string; description: string; argumentHint?: string; plugin: string }> {
    return this.ledger.config.mods?.listRegisteredCommands?.() ?? []
  }
}

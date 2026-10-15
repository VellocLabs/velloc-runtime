/**
 * The engine-side half of the built-in slash commands. Input processing
 * decides which command a prompt is and returns its rows; the entry in this
 * table then does what the command does to the session (wipe it, compact
 * it, reload plugins, open settings, store a title) and yields any rows the
 * live stream has to show straight away.
 */
import type { Message } from '../runtime/RuntimeTypes'
import type { ProcessUserInputResult } from '../runtime/interfaces/UserInputPipeline'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { DispatchContext } from '../mods/modTypes'
import type { SessionCompactSettlement } from '../mods/sessionCompactEvent'
import { makeFoldLine, createLocalizedSystemMessage } from '../messages/messageFactories'
import {
  collectPostCompactPlanRows,
  createPostCompactReadRestoreMessage,
} from '../messages/contextAttachments'
import { key } from '../input/systemMessageParts'
import { storeUserTitle } from '../sessions/sessionStore'
import { runSessionEndHooks, runSessionStartHooks } from '../lifecycleHooks/sessionLifecycleHooks'
import { runCompactionDoneHooks, runCompactionStartHooks } from '../lifecycleHooks/compactionHooks'
import { assembleTurnDependencies } from './turn/turnDependencies'
import { contextWindowOf } from './contextWindow'
import { estimateTranscriptTokens } from './tokenCounts'
import type { SessionLedger } from './sessionLedger'
import type { TranscriptWriter } from './transcriptWriter'
import type { SessionTitler } from './autoTitle'

/** What a command entry works with. `result` is the processed input; an
 *  entry may take rows out of it that it already yielded. */
export type CommandContext = {
  readonly ledger: SessionLedger
  readonly writer: TranscriptWriter
  readonly titler: SessionTitler
  readonly result: ProcessUserInputResult
  readonly callContext: ToolCallContext
  readonly refreshPlugins: (activePluginSet?: string[]) => Promise<boolean>
}

export type BuiltinCommand = (ctx: CommandContext) => AsyncGenerator<Message, void, unknown>

type BuiltinAction = 'clear' | 'compact' | 'reload-plugins' | 'open-settings' | 'rename'

export type CompactRequest = {
  trigger: 'manual' | 'plugin'
  instructions?: string
  callContext: ToolCallContext
  /** Present when an extension asked: the hooks run with its context. */
  raise?: { context: DispatchContext; signal?: AbortSignal }
}

export type CompactOutcome = { rows: Message[]; didCompact: boolean; settled?: SessionCompactSettlement }

function noticeRows(ledger: SessionLedger, message: Parameters<typeof key>[0], params?: Parameters<typeof key>[1]): CompactOutcome {
  return { rows: [createLocalizedSystemMessage(ledger.config.runtimeConfig, [key(message, params)])], didCompact: false }
}

/** The rows that follow a summary: the plan rows, the files read back, and what
 *  the `SessionStart` hooks add for a compaction. */
async function rowsAfterSummary(ledger: SessionLedger, context: ToolCallContext, model: string): Promise<Message[]> {
  const { config } = ledger
  const readsBefore = new Map(ledger.fileReadLedger)
  const rows: Message[] = []
  rows.push(...(await collectPostCompactPlanRows(context, config.runtimeConfig)))
  const restore = await createPostCompactReadRestoreMessage({
    readPaths: ledger.recentReadPaths,
    readFileState: readsBefore,
    toolUseContext: context,
    contextWindow: contextWindowOf(model, config.userSpecifiedProviderId),
  })
  if (restore) rows.push(restore)
  rows.push(...(await runSessionStartHooks('compact', context)))
  return rows
}

/**
 * One compaction of the main conversation, for `/compact` and for an
 * extension's own call: for `/compact` the `PreCompact` hooks, then the
 * extensions' `session.compact` around the summarizer, then the boundary,
 * the summary, the `PostCompact` hooks' note and what follows it, or the
 * notice saying why not. With `didCompact` the rows replace the
 * conversation; otherwise they join it.
 */
export async function compactTranscriptNow(ledger: SessionLedger, request: CompactRequest): Promise<CompactOutcome> {
  const { config } = ledger
  const deps = config.queryRuntimeDeps ?? assembleTurnDependencies(config.runtimeConfig)
  if (!deps.forceCompact) return noticeRows(ledger, 'slash.out.compactUnavailable')
  if (ledger.rows.length === 0) return noticeRows(ledger, 'slash.out.compactNoMessages')
  // `/compact` runs the `PreCompact` hooks first (8-3-2); one that blocks
  // calls the compaction off before anything else hears of it. An
  // extension's own request owns that decision and raises none.
  const manual = request.trigger === 'manual'
  if (manual) {
    const start = await runCompactionStartHooks(request.callContext, 'manual', request.instructions)
    if (!start.proceed) {
      return start.reasons.length > 0
        ? noticeRows(ledger, 'slash.out.compactBlockedByHook', { reason: start.reasons.join('; ') })
        : noticeRows(ledger, 'slash.out.compactBlockedByHookNoReason')
    }
  }
  const summarize = deps.forceCompact
  const model = ledger.activeModel()
  const run = (e: { instructions?: string; messages: Message[] }) =>
    summarize({
      messages: e.messages,
      mainLoopModel: model,
      providerId: config.userSpecifiedProviderId,
      customInstructions: e.instructions,
    })
  const input = {
    ...(request.instructions !== undefined ? { instructions: request.instructions } : {}),
    messages: ledger.rows,
  }
  const settled: SessionCompactSettlement | undefined = config.mods?.sessionCompact
    ? await config.mods.sessionCompact(
        { trigger: request.trigger, ...input },
        {
          run: e => run(e as { instructions?: string; messages: Message[] }),
          boundary: messages =>
            makeFoldLine(
              'manual',
              estimateTranscriptTokens(messages as Message[]),
              messages.at(-1)?.uuid as string | undefined,
            ),
        },
        request.raise?.signal,
        request.raise?.context,
      )
    : ((await run(input)) as SessionCompactSettlement | undefined)
  if (settled && 'skip' in settled) {
    return { ...noticeRows(ledger, 'slash.out.compactSkipped', { reason: settled.skip }), settled }
  }
  if (settled && 'boundaryMarker' in settled) {
    const rows = [settled.boundaryMarker, ...settled.summaryMessages] as Message[]
    if (manual) {
      rows.push(...(await runCompactionDoneHooks(request.callContext, 'manual', settled.summaryMessages as Message[])))
    }
    rows.push(...(await rowsAfterSummary(ledger, request.callContext, model)))
    ledger.fileReadLedger.clear?.()
    void ledger.pushHostSettings({ clearReadState: true, clearBrowserObservationCache: true })
    return { rows, didCompact: true, settled }
  }
  const reason = settled && 'error' in settled ? settled.error : 'unknown error'
  return { ...noticeRows(ledger, 'slash.out.compactFailed', { reason }), ...(settled ? { settled } : {}) }
}

/** `/clear`: the conversation ends (extensions and hooks hear it first),
 *  the store opens a new one, and the session starts over. */
async function* clearCommand(ctx: CommandContext): AsyncGenerator<Message, void, unknown> {
  const { ledger } = ctx
  await ledger.config.mods?.sessionEnd?.('clear')
  await runSessionEndHooks('clear', ctx.callContext)
  ledger.sessionStartSource = 'clear'
  // The store first: every turn starts from what it holds, and if it fails
  // the engine still agrees with it.
  await ledger.config.conversationStore.startNewConversation?.()
  ledger.startOver()
  ctx.callContext.skillsFound?.clear()
}

/** `/compact`: the typed command goes in ahead of the boundary, and the
 *  outcome is yielded at once. The command row itself is not yielded: the
 *  page already shows it as the pending prompt. */
async function* compactCommand(ctx: CommandContext): AsyncGenerator<Message, void, unknown> {
  const { ledger, result } = ctx
  const { rows, didCompact } = await compactTranscriptNow(ledger, {
    trigger: 'manual',
    instructions: result.compactInstructions,
    callContext: ctx.callContext,
  })
  const kept = await ctx.writer.appendRows([...result.messages, ...rows])
  if (didCompact) ledger.rows = kept
  else ledger.rows.push(...kept)
  result.messages = []
  for (const row of rows) yield row
}

/** `/plugins enable|disable`: discovery runs again with the new list. */
async function* reloadPluginsCommand(ctx: CommandContext): AsyncGenerator<Message, void, unknown> {
  await ctx.refreshPlugins(ctx.result.enabledPlugins ?? [])
}

/** `/mcp` and friends: the host's settings page, where it has one. */
async function* openSettingsCommand(ctx: CommandContext): AsyncGenerator<Message, void, unknown> {
  try {
    await ctx.ledger.config.onOpenSettings?.(ctx.result.settingsSection ?? 'models')
  } catch (error) {
    console.warn('[nexus] open-settings action failed:', error)
  }
}

/** `/rename`: the title is stored before the confirmation row, so the
 *  sidebar refresh that row triggers reads it; a background title attempt
 *  is cancelled. */
async function* renameCommand(ctx: CommandContext): AsyncGenerator<Message, void, unknown> {
  const title = ctx.result.renameTitle
  if (!title) return
  try {
    await storeUserTitle(title, 'user', ctx.ledger.config.conversationStore)
    ctx.titler.cancel()
  } catch (error) {
    console.warn('[nexus] rename action failed:', error)
  }
}

export const builtinCommands: Readonly<Record<BuiltinAction, BuiltinCommand>> = {
  clear: clearCommand,
  compact: compactCommand,
  'reload-plugins': reloadPluginsCommand,
  'open-settings': openSettingsCommand,
  rename: renameCommand,
}

/** The table entry for the processed input's action, if it has one. */
export function commandFor(result: ProcessUserInputResult): BuiltinCommand | undefined {
  const action = result.action as string | undefined
  return action !== undefined && Object.prototype.hasOwnProperty.call(builtinCommands, action)
    ? builtinCommands[action as BuiltinAction]
    : undefined
}

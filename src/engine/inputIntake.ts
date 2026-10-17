/**
 * How a submitted prompt becomes the rows of a turn: the extensions'
 * `prompt.submit` (may rewrite, annotate or drop a typed prompt), their
 * `command.run` (a registered or hooked slash command), and otherwise the
 * input pipeline. The result is then labelled: a plugin's turn carries its
 * name, a slash command's output rows carry the command, and the
 * extensions' context follows the prompt as a generated row.
 */
import type { ContentBlockParam, Message, NoticeRow, UserRow } from '../runtime/RuntimeTypes'
import type { ProcessUserInputResult } from '../runtime/interfaces/UserInputPipeline'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import {
  createGeneratedUserMessage,
  createLocalizedSystemMessage,
  makeNoticeRow,
  makeUserRow,
} from '../messages/messageFactories'
import { splitCommandWord } from '../input/slashCommandCatalog'
import { key } from '../input/systemMessageParts'
import { traceLine } from '../utils/debugLog'
import { pluginPromptText } from '../mods/promptNouns'
import { processUserInput } from '../input/submitUserInput'
import type { SubmitTurnOptions } from './engineConfig'
import type { SessionLedger } from './sessionLedger'

export type Prompt = string | Array<ContentBlockParam>

/** A prompt after `prompt.submit`: its text, the context the hooks attached,
 *  and the rows that replace the turn when a hook dropped it. */
export type SubmittedPrompt = { prompt: Prompt; context: string[]; dropped?: ProcessUserInputResult }

export function intakeUserInput(
  ledger: SessionLedger,
  prompt: Prompt,
  callContext: ToolCallContext,
  options?: SubmitTurnOptions,
): Promise<ProcessUserInputResult> {
  return processUserInput(
    {
      input: prompt,
      mode: 'prompt',
      context: callContext,
      messages: ledger.rows,
      uuid: options?.uuid,
      querySource: 'sdk',
      isMeta: options?.isMeta,
      origin: options?.origin,
    },
    { userInputPipeline: ledger.config.userInputPipeline },
  )
}

function droppedWith(ledger: SessionLedger, parts: Parameters<typeof createLocalizedSystemMessage>[1]): ProcessUserInputResult {
  return { messages: [createLocalizedSystemMessage(ledger.config.runtimeConfig, parts)], shouldQuery: false }
}

/** Raises `prompt.submit` for a prompt the user typed. Every other prompt
 *  passes as it is, after the extensions finished loading: whether a hook
 *  selects the turn's later events is only known then. A failing hook lets
 *  the prompt in as typed; a Stop during the hooks lets nothing in. */
export async function passPromptHooks(ledger: SessionLedger, prompt: Prompt, options?: SubmitTurnOptions): Promise<SubmittedPrompt> {
  if (options?.plugin) {
    return { prompt: pluginPromptText(options.plugin), context: [...options.plugin.context] }
  }
  const mods = ledger.config.mods
  const typed: SubmittedPrompt = { prompt, context: [] }
  if (!mods || typeof prompt !== 'string' || options?.isMeta || options?.origin || prompt.trimStart().startsWith('/')) {
    if (mods) await mods.ready
    return typed
  }
  const signal = ledger.cancelSource.signal
  try {
    await mods.ready
    const outcome = await mods.promptSubmit(prompt, signal)
    if (outcome.entered) return { prompt: outcome.text, context: outcome.context }
    const parts = outcome.unreachable
      ? [key('slash.out.modPromptUnreachable', { name: outcome.unreachable })]
      : outcome.reason
        ? [key('slash.out.modPromptDropped', { reason: outcome.reason })]
        : [key('slash.out.modPromptDroppedNoReason')]
    return { ...typed, dropped: droppedWith(ledger, parts) }
  } catch (error) {
    if (ledger.cancelSource.signal.aborted) {
      return { ...typed, dropped: droppedWith(ledger, [key('slash.out.modPromptInterrupted')]) }
    }
    traceLine(`[mods] prompt.submit could not run: ${error instanceof Error ? error.message : String(error)}`, {
      level: 'warn',
    })
    return typed
  }
}

function systemText(rows: readonly Message[]): string {
  return rows
    .filter(m => m.type === 'system')
    .map(m => (m as { message?: unknown }).message)
    .filter((m): m is string => typeof m === 'string')
    .join('\n')
}

type CommandSettlement = { text?: string; context?: readonly string[]; ref?: number }

/** The rows a settled `command.run` chain leaves: the engine's own run when
 *  the chain ended on it (with the hook's text in place of what it printed,
 *  if the hook changed that), otherwise the typed line and the hook's text. */
function rowsOfSettlement(
  ledger: SessionLedger,
  prompt: string,
  options: SubmitTurnOptions | undefined,
  settlement: { result: CommandSettlement; unanswered?: boolean; registered: boolean; runs: Map<number, ProcessUserInputResult> },
): ProcessUserInputResult {
  const { runtimeConfig } = ledger.config
  const { result, unanswered, registered, runs } = settlement
  const echo = makeUserRow(runtimeConfig, prompt, options?.uuid)
  const contextRows = (result.context ?? [])
    .filter(c => typeof c === 'string' && c !== '')
    .map(text => createGeneratedUserMessage([{ type: 'text' as const, text }], { isMeta: true }))
  const typedRows = (output: Message | undefined): ProcessUserInputResult => ({
    messages: [echo, ...(output ? [output] : []), ...contextRows],
    shouldQuery: false,
    resultText: prompt,
  })
  const ownText = () =>
    typeof result.text === 'string' && result.text !== '' ? makeNoticeRow(runtimeConfig, result.text) : undefined
  if (registered) {
    return typedRows(
      unanswered ? createLocalizedSystemMessage(runtimeConfig, [key('slash.out.modCommandUnanswered', { command: splitCommandWord(prompt.trim()).command })]) : ownText(),
    )
  }
  const run = result.ref !== undefined ? runs.get(result.ref) : undefined
  if (!run) return typedRows(ownText())
  if (typeof result.text === 'string' && result.text !== systemText(run.messages)) {
    const kept = run.messages.filter(m => m.type !== 'system')
    return { ...run, messages: [...kept, makeNoticeRow(runtimeConfig, result.text), ...contextRows] }
  }
  return contextRows.length > 0 ? { ...run, messages: [...run.messages, ...contextRows] } : run
}

/** Raises `command.run` for a typed slash command an extension registered
 *  or a hook selects. Undefined: run the command as typed (not raised,
 *  abandoned, or the extension runtime failed). */
export async function passCommandHooks(
  ledger: SessionLedger,
  prompt: Prompt,
  callContext: ToolCallContext,
  options?: SubmitTurnOptions,
): Promise<ProcessUserInputResult | undefined> {
  const mods = ledger.config.mods
  if (!mods?.commandRun || typeof prompt !== 'string' || options?.isMeta || options?.origin || options?.plugin || !prompt.trimStart().startsWith('/')) {
    return undefined
  }
  const { command, args } = splitCommandWord(prompt.trim())
  if (command === '') return undefined
  let registered: boolean
  try {
    await mods.ready
    registered = mods.registeredCommand?.(command) !== undefined
    if (!registered && !mods.hasCommandRunHooks?.()) return undefined
  } catch {
    return undefined
  }
  // Each run of the engine's own command is kept under a ref; the chain
  // names the one it settled on.
  const runs = new Map<number, ProcessUserInputResult>()
  let nextRef = 0
  const core = registered
    ? undefined
    : async (arrivedArgs: string): Promise<{ text?: string; context?: string[] }> => {
        const typed = arrivedArgs === '' ? `/${command}` : `/${command} ${arrivedArgs}`
        const result = await intakeUserInput(ledger, typed, callContext, options)
        runs.set(++nextRef, result)
        const text = systemText(result.messages)
        return { text: text === '' ? undefined : text }
      }
  const settlement = await mods.commandRun({ command, args }, core, ledger.cancelSource.signal)
  if (!settlement.settled) return undefined
  return rowsOfSettlement(ledger, prompt, options, { result: settlement.result, unanswered: settlement.unanswered, registered, runs })
}

/** Labels the turn's rows: the plugin that submitted it, the slash command
 *  its output rows answer, and the extensions' context after the prompt. */
export function labelIntake(result: ProcessUserInputResult, submitted: SubmittedPrompt, options?: SubmitTurnOptions): void {
  const plugin = options?.plugin
  if (plugin) {
    const stamp = { plugin: plugin.plugin, ...(plugin.asUser ? { asUser: true as const } : {}) }
    result.messages = result.messages.map(message =>
      message.type === 'user' && !(message as UserRow).isMeta && (options.uuid === undefined || message.uuid === options.uuid)
        ? ({ ...(message as UserRow), pluginPrompt: stamp } satisfies UserRow)
        : message,
    )
  }
  const text = submitted.prompt
  if (typeof text === 'string' && !options?.isMeta && text.trimStart().startsWith('/')) {
    const { command, args } = splitCommandWord(text.trim())
    if (command !== '') {
      result.messages = result.messages.map(message =>
        message.type === 'system' && (message as NoticeRow).subtype === 'informational'
          ? ({ ...(message as NoticeRow), slashCommand: { name: command, args } } satisfies NoticeRow)
          : message,
      )
    }
  }
  if (submitted.context.length > 0 && result.shouldQuery) {
    result.messages = [
      ...result.messages,
      createGeneratedUserMessage(submitted.context.map(entry => ({ type: 'text' as const, text: entry })), { isMeta: true }),
    ]
  }
}

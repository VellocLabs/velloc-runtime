/**
 * The rows a turn reports about itself: the session-init row, the closing
 * result row, and the small readers that classify its terminal and rows.
 */
import type { Message, QueryTerminal, StreamRecord, TurnResultRecord } from '../runtime/RuntimeTypes'
import type { ChromiumSkillSummary } from '../runtime/CommandTypes'
import type { BuildSystemInitMessageParams } from '../runtime/interfaces/SystemInitEmitter'
import {
  MSG_TYPE_ASSISTANT,
  MSG_TYPE_RESULT,
  MSG_TYPE_STREAM_EVENT,
  MSG_TYPE_STREAM_REQUEST_START,
  MSG_TYPE_TOMBSTONE,
  TERMINAL_AWAITING_USER,
  TERMINAL_COMPLETED,
  TERMINAL_MAX_TURNS,
  TERMINAL_STOP_HOOK_PREVENTED,
} from '../runtime/VercelModelConstants'
import type { SessionLedger } from './sessionLedger'

export function isSuccessfulTerminal(terminal: QueryTerminal): boolean {
  switch (terminal.reason) {
    case TERMINAL_COMPLETED:
    case TERMINAL_AWAITING_USER:
    case TERMINAL_STOP_HOOK_PREVENTED:
    case TERMINAL_MAX_TURNS:
      return true
    default:
      return false
  }
}

export function resultSubtype(terminal: QueryTerminal): string {
  if (terminal.reason === TERMINAL_AWAITING_USER) return TERMINAL_AWAITING_USER
  return isSuccessfulTerminal(terminal) ? 'success' : `error_${terminal.reason}`
}

/** Rows the store keeps: everything but stream plumbing. */
export function isStoredRow(message: Message): boolean {
  return message.type !== MSG_TYPE_STREAM_REQUEST_START && message.type !== MSG_TYPE_STREAM_EVENT && message.type !== MSG_TYPE_TOMBSTONE
}

/** The last visible reply text since row `since` (`turn.complete`'s answer). */
export function answerSince(rows: readonly Message[], since: number): string {
  for (let i = rows.length - 1; i >= since; i -= 1) {
    const row = rows[i]
    if (!row || row.type !== MSG_TYPE_ASSISTANT) continue
    const content = (row as { message?: { content?: unknown } }).message?.content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) continue
    const text = content
      .filter((block): block is { type: 'text'; text: string } => !!block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('')
    if (text !== '') return text
  }
  return ''
}

/** The closing row of a turn; `extras` keeps the key order callers read. */
export function resultRow(ledger: SessionLedger, subtype: string, isError: boolean, extras: Record<string, unknown>): TurnResultRecord {
  return {
    type: MSG_TYPE_RESULT,
    subtype,
    is_error: isError,
    session_id: ledger.sessionId(),
    uuid: ledger.config.runtimeConfig.createUUID(),
    ...extras,
  }
}

export async function sessionInitRow(ledger: SessionLedger, model: string): Promise<StreamRecord> {
  const { config } = ledger
  const appState = config.readAppState()
  const skills: ChromiumSkillSummary[] = config.commands
    .filter(command => !command.hiddenFromModel)
    .map(command => ({ name: command.name, description: command.description, shortId: command.name }))
  const params: BuildSystemInitMessageParams = {
    tools: config.tools,
    mcpClients: config.mcpClients,
    model,
    permissionMode: appState.permissionRules.mode,
    commands: config.commands,
    agents: config.agents,
    skills,
    plugins: config.plugins ?? [],
    fastMode: appState.fastMode,
    sessionId: ledger.sessionId(),
  }
  return config.systemInitEmitter.buildSystemInitMessage(params)
}

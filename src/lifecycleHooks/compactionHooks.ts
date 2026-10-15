/**
 * The classic hooks around one compaction (F-3): `PreCompact` (can call it off)
 * and `PostCompact` (cannot). The trigger (`manual` / `auto`) is both the
 * `trigger` field and the matcher subject. Through `classic.*` (F-25); nothing
 * runs without a session id.
 */

import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { Message } from '../runtime/RuntimeTypes'
import { createGeneratedUserMessage } from '../messages/messageFactories'
import { runClassicHooks } from './classicThroughMods'
import { fireAfterFold, fireBeforeFold } from './runHooks'
import { buildHookInput } from './hookInput'
import { createBashHookCommandRunner } from './hookCommandRunner'
import { createModelHookPromptRunner } from './hookPromptRunner'
import { createForkedAgentHookRunner } from './hookAgentRunner'
import { createNetworkHookHttpRunner } from './hookHttpRunner'

/** What started a compaction, as the hooks see it. */
export type CompactionHookTrigger = 'auto' | 'manual'

/** `PreCompact`'s answer: go ahead, or stop with the hooks' reasons (empty
 *  when the blocking hook gave none). */
export type CompactionStartVerdict = { proceed: true } | { proceed: false; reasons: string[] }

function runnersFor(callContext: ToolCallContext, sessionId: string) {
  const appState = callContext.readAppState()
  return {
    sessionId,
    appState,
    setAppState: callContext.writeAppState,
    signal: callContext.cancelSource.signal,
    commandRunner: createBashHookCommandRunner(callContext),
    promptRunner: createModelHookPromptRunner(callContext),
    agentRunner: createForkedAgentHookRunner(callContext),
    httpRunner: createNetworkHookHttpRunner(callContext),
    hookInput: {
      cwd: callContext.options.cwd,
      projectRoot: callContext.options.projectRoot,
      permissionMode: appState.permissionRules?.mode,
    },
  }
}

/**
 * `PreCompact` for a compaction about to summarize. `instructions` is what
 * the person typed after `/compact`; the hooks read `null` when there is
 * none.
 */
export async function runCompactionStartHooks(
  callContext: ToolCallContext,
  trigger: CompactionHookTrigger,
  instructions?: string,
): Promise<CompactionStartVerdict> {
  const sessionId = callContext.options.sessionId
  if (!sessionId) return { proceed: true }
  const runners = runnersFor(callContext, sessionId)
  const foldGuidance = instructions ?? null
  const verdict = await runClassicHooks(
    callContext.options.mods,
    'PreCompact',
    () => ({
      ...buildHookInput({
        event: 'PreCompact',
        sessionId,
        cwd: runners.hookInput.cwd,
        permissionMode: runners.hookInput.permissionMode,
        toolName: trigger,
        foldGuidance,
      }),
    }),
    () =>
      fireBeforeFold({
        ...runners,
        reason: trigger,
        hookInput: { ...runners.hookInput, foldGuidance },
      }),
    runners.signal,
  )
  if (!verdict.blocked) return { proceed: true }
  return { proceed: false, reasons: verdict.errors.filter(reason => reason.trim().length > 0) }
}

/** The text of the summary rows, as `PostCompact`'s `compact_summary`. */
export function summaryTextOf(summaryRows: readonly Message[]): string {
  return summaryRows
    .map(message => {
      const content = (message as { message?: { content?: unknown } }).message?.content
      if (typeof content === 'string') return content
      if (Array.isArray(content)) {
        return content
          .map(block =>
            (block as { type?: string; text?: string })?.type === 'text'
              ? (block as { text?: string }).text ?? ''
              : '',
          )
          .join('')
      }
      return ''
    })
    .join('\n')
}

/**
 * `PostCompact` after a summary landed. The compaction stands whatever the
 * hooks say; a blocking outcome becomes one meta row for the model to read
 * after the summary. Returns the rows to add (none when nothing blocked).
 */
export async function runCompactionDoneHooks(
  callContext: ToolCallContext,
  trigger: CompactionHookTrigger,
  summaryRows: readonly Message[],
): Promise<Message[]> {
  const sessionId = callContext.options.sessionId
  if (!sessionId) return []
  const runners = runnersFor(callContext, sessionId)
  const compactSummary = summaryTextOf(summaryRows)
  const verdict = await runClassicHooks(
    callContext.options.mods,
    'PostCompact',
    () => ({
      ...buildHookInput({
        event: 'PostCompact',
        sessionId,
        cwd: runners.hookInput.cwd,
        permissionMode: runners.hookInput.permissionMode,
        toolName: trigger,
        compactSummary,
      }),
    }),
    () =>
      fireAfterFold({
        ...runners,
        reason: trigger,
        hookInput: { ...runners.hookInput, compactSummary },
      }),
    runners.signal,
  )
  if (!verdict.blocked) return []
  const body = verdict.errors.length > 0 ? verdict.errors.join('\n') : 'Compaction flagged by a PostCompact hook.'
  return [createGeneratedUserMessage(`[PostCompact hook]: ${body}`, { isMeta: true })]
}

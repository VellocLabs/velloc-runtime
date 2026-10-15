/**
 * Turn admission: what happens between `begin` and the first model request.
 * The main agent's prompt goes through the prompt-submit hooks first (a
 * block ends the turn as `prompt_rejected`; added context joins the
 * conversation); then the turn-start rows are gathered and the memory
 * prefetch is started in the background.
 */
import type { Message } from '../runtime/RuntimeTypes'
import { TERMINAL_PROMPT_REJECTED } from '../runtime/VercelModelConstants'
import type { TurnEvent, TurnPolicies, TurnState, Transition } from './turnEffects'
import { emit, finish, openDraft, patchState, request, seal, type Draft } from './turnStep'
import { openRequest } from './turnRequest'

export function onBegin(state: TurnState): Transition {
  const d = openDraft(state)
  if (state.caller.isMainAgent) {
    request(d, { kind: 'runPromptSubmitHooks', prompt: state.messages })
  } else {
    gatherTurnStart(d)
  }
  return seal(d)
}

export function onPromptHooks(
  state: TurnState,
  event: Extract<TurnEvent, { type: 'promptSubmitHooksDone' }>,
): Transition {
  const d = openDraft(state)
  for (const row of event.rows) emit(d, row, 'extension')
  if (event.blocked) {
    finish(d, { reason: TERMINAL_PROMPT_REJECTED })
    return seal(d)
  }
  appendRows(d, event.rows)
  gatherTurnStart(d)
  return seal(d)
}

export function onTurnStartRows(state: TurnState, rows: readonly Message[]): Transition {
  const d = openDraft(state)
  for (const row of rows) emit(d, row, 'context')
  appendRows(d, rows)
  const identity = request(d, {
    kind: 'startBackground',
    background: 'memoryPrefetch',
    input: { messages: d.state.messages },
  })
  patchState(d, { background: [...d.state.background, { identity, kind: 'memoryPrefetch' }] })
  return seal(d)
}

/** The prefetch is running (or was not needed): the first request opens. */
export function onPrefetchStarted(state: TurnState, policies: TurnPolicies): Transition {
  const d = openDraft(state)
  openRequest(d, policies)
  return seal(d)
}

function gatherTurnStart(d: Draft): void {
  request(d, { kind: 'gatherRows', stage: 'turnStart', messages: d.state.messages })
}

function appendRows(d: Draft, rows: readonly Message[]): void {
  if (rows.length > 0) patchState(d, { messages: [...d.state.messages, ...rows] })
}

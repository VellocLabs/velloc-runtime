/**
 * `$.ui.view({ agentId })` (F-25): the page shows that agent's transcript in
 * its main view; `$.ui.view({})` goes back. Raised as `ui.view`: a hook above
 * may rewrite the id, answer, or `{ deny }` it. The request is published as
 * the slot's `view` (with a sequence number, one per call) on the session's
 * mods UI state; the page acts on each new number.
 */

/** The event's `e`: `agentId` absent asks for the view the person had. */
export type UiViewArgs = { agentId?: string }

/** `{}` once the view is asked for, `{ deny }` saying why it is not. */
export type UiViewResult = { deny?: string }

/** Where an agent's transcript lives: a subagent's in the Tasks view, by its
 *  task id; a teammate's in its own session. */
export type ModAgentViewTarget = { kind: 'subagent' | 'teammate'; sessionId: string }

/** The view the page is asked to show; `agentId` absent: back to the view
 *  before. `seq` grows with each call. */
export type ModAgentView = { seq: number; agentId?: string; kind?: ModAgentViewTarget['kind']; sessionId?: string }

/** What `$.ui.view` needs of the engine: the session's own subagents and
 *  teammates by id, undefined for any other. */
export type ModAgentViewHost = {
  viewTarget?(agentId: string): ModAgentViewTarget | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `e` from the call's argument; each refusal names the field. */
export function uiViewArgsOf(arg: unknown): UiViewArgs {
  if (!isRecord(arg)) throw new TypeError('$.ui.view(target): target must be { agentId } or {}')
  const { agentId } = arg
  if (agentId !== undefined && (typeof agentId !== 'string' || agentId === '')) {
    throw new TypeError('$.ui.view: agentId must be a non-empty string, or left out to go back')
  }
  return agentId !== undefined ? { agentId } : {}
}

/** Whether a hook's answer is one `ui.view` takes. */
export function isUiViewResult(value: unknown): value is UiViewResult {
  return isRecord(value) && (value.deny === undefined || typeof value.deny === 'string')
}

/** Core of `ui.view`: the target looked up, then the view published. */
export function uiViewCore(
  e: unknown,
  host: ModAgentViewHost | undefined,
  publish: (view: Omit<ModAgentView, 'seq'>) => void,
): UiViewResult {
  const agentId = isRecord(e) && typeof e.agentId === 'string' && e.agentId !== '' ? e.agentId : undefined
  if (agentId === undefined) {
    publish({})
    return {}
  }
  const target = host?.viewTarget?.(agentId)
  if (!target) return { deny: `no subagent or teammate of this session has the id ${agentId}` }
  publish({ agentId, ...target })
  return {}
}

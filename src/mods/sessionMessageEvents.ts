/**
 * `session.send` (rewrite `text`, readdress `to` (judged again), or refuse) and
 * `session.receive` (rewrite, or `{ consumed }`: nothing queued, shown or read)
 * (F-25). Pure shapes and checks.
 */

export type SessionSendOrigin = { kind: 'model' } | { kind: 'plugin'; name: string }

export type SessionSendInput = {
  to: string
  text: string
  origin: SessionSendOrigin
  agentId?: string
}

export type SessionSendResult = { isDelivered: true } | { isDelivered: false; reason: string }

/** What a send site hands the runtime: the delivery of what the chain hands
 *  down, and what the chain resolves to. */
export type SessionSendCore = (e: { to: string; text: string }) => Promise<SessionSendResult> | SessionSendResult

export type SessionReceiveOriginKind =
  | 'bridge'
  | 'task-notification'
  | 'scheduled-trigger'
  | 'peer-send-message'
  | 'projects-relay'
  | 'slack-ping'
  | 'unclassified'
  | 'peer'
  | 'coordinator'

export type SessionReceiveInput = {
  origin: { kind: SessionReceiveOriginKind; plugin?: string }
  text: string
  agentId?: string
}

export type SessionReceiveSettlement = { text: string } | { consumed: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isSessionSendResult(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.isDelivered === true) return true
  return value.isDelivered === false && typeof value.reason === 'string' && value.reason !== ''
}

/** A rewritten `session.send` event: `to` and `text` strings, `origin` and
 *  `agentId` pinned. Returns the reason it is refused, or null. */
export function sendInputProblem(original: SessionSendInput, e: unknown): string | null {
  if (!isRecord(e)) return 'the event argument is not an object'
  if (typeof e.to !== 'string' || e.to.trim() === '') return 'to is not a name'
  if (typeof e.text !== 'string' || e.text.trim() === '') return 'text is not a non-empty string'
  if (e.origin !== undefined && JSON.stringify(e.origin) !== JSON.stringify(original.origin)) return 'origin is pinned'
  if (e.agentId !== undefined && e.agentId !== original.agentId) return 'agentId is pinned'
  return null
}

export function isSessionReceiveResult(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value.consumed === 'string') return value.consumed !== ''
  return typeof value.text === 'string'
}

/** A rewritten `session.receive` event: `text` a string, `origin` and
 *  `agentId` pinned. Returns the reason it is refused, or null. */
export function receiveInputProblem(original: SessionReceiveInput, e: unknown): string | null {
  if (!isRecord(e)) return 'the event argument is not an object'
  if (typeof e.text !== 'string') return 'text is not a string'
  if (e.origin !== undefined && JSON.stringify(e.origin) !== JSON.stringify(original.origin)) return 'origin is pinned'
  if (e.agentId !== undefined && e.agentId !== original.agentId) return 'agentId is pinned'
  return null
}

/** The text of a prompt as the model would read it: a string, or its text
 *  blocks joined. */
export function promptTextOf(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt
  if (!Array.isArray(prompt)) return ''
  return prompt
    .map(block => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('')
}

/** The prompt with its text replaced: a string stays a string; in a block
 *  list the first text block carries the new text and the other text blocks
 *  are dropped (media and the rest stay in place). */
export function withPromptText(prompt: unknown, text: string): unknown {
  if (typeof prompt === 'string' || !Array.isArray(prompt)) return text
  let placed = false
  const blocks: unknown[] = []
  for (const block of prompt) {
    if (isRecord(block) && block.type === 'text') {
      if (placed) continue
      placed = true
      blocks.push({ ...block, text })
      continue
    }
    blocks.push(block)
  }
  if (!placed) blocks.unshift({ type: 'text', text })
  return blocks
}

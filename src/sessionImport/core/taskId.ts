/**
 * Deterministic sub-agent task-id derivation, shared by any provider that
 * imports background sub-agents. Pure.
 */

function djb2(text: string): number {
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0
  }
  return hash
}

/** `a<8 base36>` — Velloc's public sub-agent task id shape (TASK_ID_PATTERN),
 *  derived from the agent id so a re-import produces the same token. */
export function deriveTaskId(agentId: string): string {
  const head = djb2(agentId).toString(36).padStart(7, '0').slice(-7)
  const tail = (djb2(`${agentId}#`) % 36).toString(36)
  return `a${head}${tail}`
}

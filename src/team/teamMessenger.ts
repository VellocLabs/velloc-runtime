/**
 * Leaf indirection (avoids an import cycle) for inter-agent messaging and
 * teammate shutdown: the manager registers a `TeamMessenger`; tools read
 * `getTeamMessenger()`.
 */

export type DeliverResult = { ok: boolean; reason?: string }

/**
 * One row of a lead's teammate roster, as `AgentList` / `TaskOutput` show it.
 * `active` = mid-turn, `idle` = parked on its mailbox between turns (its
 * report for the last turn is on its way to the lead, or already arrived),
 * `stopped` = torn down.
 */
export type TeammateRosterEntry = {
  /** The child's session id (`teammate-…`) — what the spawn ack names. */
  sessionId: string
  /** Display name — the one the lead spawned it under and addresses it by. */
  name: string
  /** `lost`: it was running when the browser restarted and did not survive
   *  it (teammates are not resumed). Its transcript is kept, read-only. */
  status: 'active' | 'idle' | 'stopped' | 'lost'
  /** Unix ms of the spawn. */
  startedAt: number
}

export type TeamMessenger = {
  /** Route `body` to team member `to` (from `from`) as their next turn. */
  deliver(args: {
    team: string
    to: string
    from: string
    body: string
    /** The sender's model response called other tools besides SendMessage,
     *  so this message cannot restate their results (the turn-end report
     *  still has to carry them). */
    withOtherTools?: boolean
  }): DeliverResult
  /** Forcefully shut down teammate `name` in `team` (lead-initiated, v1). */
  shutdownMember(args: { team: string; name: string }): DeliverResult
  /**
   * The teammates a lead session has spawned and not yet torn down. Optional
   * so a messenger stub that only routes messages stays a valid messenger;
   * a missing implementation reads as "no roster", not as an error.
   */
  listMembers?(headSessionId: string): TeammateRosterEntry[]
}

let messenger: TeamMessenger | null = null

export function setTeamMessenger(m: TeamMessenger | null): void {
  messenger = m
}

export function getTeamMessenger(): TeamMessenger | null {
  return messenger
}

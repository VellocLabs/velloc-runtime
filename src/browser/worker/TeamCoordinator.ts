/**
 * Contract: TeamCoordinator — teammate registry, mailbox, abort controllers, spawn / deliver / shutdown /
 * teardown and the lead inbox drain. Invariants:
 * - teammate shutdown/teardown is idempotent
 * - a failed turn does NOT kill the idle loop
 * - a lead drain never preempts an in-flight turn
 */
import type { AgentRuntimeWorkerHandle } from './AgentRuntimeWorkerHandle'
import type {
  AgentRuntimeWorkerInitPayload,
  AgentWorkerInboundMessage,
} from './workerProtocol'
import type { SessionWorkerInboundMessage } from './sharedWorkerProtocol'
import type { BrowserConversationStorageBackend } from '../../sessions/sessionStore'
import { setConversationStore } from '../../sessions/sessionStore'
import { installProcessFs } from '../../utils/fs/runtimeFs'
import { setActiveSidechainStore } from '../../utils/sidechainTranscripts'
import { teammateSpawnTimeFromId } from '../../utils/sidechainStoragePaths'
import type { OwnerRuntimeGlobals } from './taskTypes'
import type { SpawnTeammateParams } from '../../team/teamTypes'
import { implicitTeamIdFor } from '../../team/teamTypes'
import type {
  DeliverResult,
  TeammateRosterEntry,
} from '../../team/teamMessenger'
import type { BrowserBridgeTransport } from '../bridge/protocol/core'
import { getTeamRegistry } from '../../team/TeamRegistry'
import { TeamMailbox } from '../../team/TeamMailbox'
import type { MailboxEntry } from '../../team/TeamMailbox'
import { TeamMailboxStore } from '../../team/TeamMailboxStore'
import type { AppendableFrame } from '../../team/TeamMailboxStore'
import { MailboxPoller } from '../../team/MailboxPoller'
import type { MailboxRecipient } from '../../team/MailboxPoller'
import { renderTeamFrame } from '../../team/renderTeamFrame'
import { parseTeamMessageEnvelope } from '../../team/parseTeamFrame'
import { allocateMemberKey } from '../../team/memberKey'
import { TeammateNameInUseError } from '../../team/teammateSpawner'
import type {
  TeamMessageFrame,
  TeamMessageTrust,
} from '../../team/teamTypes'
import type { installSessionTracer } from '../../utils/sessionTrace'

type SessionTracer = ReturnType<typeof installSessionTracer>

/** In-memory record of a spawned teammate, keyed by its sessionId. */
export type TeammateEntry = {
  teamName: string
  /** Display name — what the lead typed and the user sees; any language. */
  name: string
  /** Member key (`memberKey.ts`): session id, mailbox dir, frame address.
   *  Unique among this lead's running teammates. */
  key: string
  spawnerSessionId?: string
  status: 'active' | 'idle' | 'stopped'
  startedAt: number
  /** Trust of the provider this teammate was spawned onto, captured AT SPAWN
   *  so a later settings flip cannot retroactively re-label a session that is
   *  already running (and has already read files) under the old answer. */
  trust?: TeamMessageTrust
  /** Release the teammate's isolated worktree, if it got one. Run at
   *  teardown. */
  onCleanup?: () => void | Promise<void>
  /** The RAW final text (no interrupted prefix) of the last `turn_end`
   *  reported for this teammate, and the uuid of the assistant message it
   *  came from when the host can name one — see `reportTurnEnd`. */
  lastReportedText?: string
  lastReportedUuid?: string
  /**
   * Set when a Stop on the lead interrupted this teammate's CURRENT turn
   * (`interruptTeammatesOf`). The turn does not always resolve `aborted` — an
   * interrupt that lands between two steps lets it settle `completed` — so
   * the loop reads this flag as well as the status before it reports. Reset
   * at the start of every turn.
   */
  interruptRequested?: boolean
  /** Counts turns and tool starts, so `reportTurnEnd` can tell whether this
   *  turn's last tool call was the `SendMessage` that already reported to
   *  the lead (see there). */
  turnSeq?: number
  toolSeq?: number
  /** `turnSeq` / `toolSeq` at this teammate's latest `SendMessage` to the
   *  lead. */
  leadMessageAt?: { turnSeq: number; toolSeq: number }
  /** False from spawn until `retireStaleInbox` has cleared frames left for an
   *  EARLIER teammate under the same member key; the poller skips it until
   *  then. Absent = ready. */
  inboxReady?: boolean
  /**
   * The LEAD's process-global runtime singletons, snapshotted at spawn and
   * reinstalled at `teardown` — see `restoreLeadGlobals`.
   */
  leadGlobals?: OwnerRuntimeGlobals
}

/** Prefix on a report whose turn was cut short by a Stop on the lead. The
 *  text after it is a fragment, not an answer, and the lead must not treat
 *  it as finished work. */
export const TURN_INTERRUPTED_PREFIX =
  '[turn interrupted — the work below is unfinished] '

/** The member name a lead's own inbox is filed under. */
export const TEAM_LEAD_MEMBER_KEY = 'team-lead'

/** A teammate that did not survive a browser restart (see `reconcileLost`). */
type LostTeammate = {
  sessionId: string
  teamName: string
  name: string
  key: string
  lostAt: number
}

/** The member key inside a teammate id: `teammate-<team>-<key>-<ts>`
 *  (`TeamCoordinator.spawn`). Null when the id is not of that team. */
export function memberKeyFromTeammateId(
  sessionId: string,
  teamName: string,
): string | null {
  const prefix = `teammate-${teamName}-`
  if (!sessionId.startsWith(prefix)) return null
  const key = sessionId.slice(prefix.length).replace(/-\d+$/, '')
  return key || null
}

/** How long a lead with no running teammate stays polled after its last one
 *  stopped — long enough for that teammate's final writes to land. */
const LEAD_DRAIN_GRACE_MS = 10_000

/** Cap on how long a lead's delete waits for its teammates' teardown to
 *  settle (`abortTeammatesOf`) before proceeding regardless. */
const TEAMMATE_TEARDOWN_WAIT_MS = 15_000

/**
 * A teammate this coordinator ended ITSELF (`teardown`), kept after its live
 * entry is deleted. Per realm, like `lost`: a browser restart forgets it,
 * which is exactly what "lost to a restart" means.
 */
type RetiredTeammate = {
  headSessionId?: string
  /** Trust captured at spawn — see `TeammateEntry.trust`. */
  trust: TeamMessageTrust
}

/**
 * Security: prepended to a report when the LEAD itself is on an untrusted provider (its provider can
 * change after spawn, where the trusted-lead rule is checked). A warning, not a refusal; a NEW spawn
 * is still refused.
 */
export const UNTRUSTED_LEAD_BANNER =
  '<untrusted-lead-warning>\n' +
  'THIS SESSION IS NO LONGER A TRUSTED REVIEWER. Its own provider is marked\n' +
  'untrusted, so everything you read below - and everything you read to check\n' +
  'it - goes to a third-party relay. You must NOT accept, apply, commit, merge\n' +
  'or publish this work, and you must not treat your own review of it as the\n' +
  'trusted review the user is expecting.\n' +
  'Tell the user, in your next message, that this session changed to an\n' +
  'untrusted provider and that the work is unreviewed. They can move the\n' +
  'session back to a trusted provider (Settings -> Models) and ask again.\n' +
  '</untrusted-lead-warning>\n\n'

export interface TeamCoordinatorHost {
  /** The reusable UI init payload; null before any UI session booted. */
  getInitTemplate(): AgentRuntimeWorkerInitPayload | null
  /** Route + stamp the teammate's per-session storage backend. The lead id
   *  is what nests the teammate's directory under it (`teammates/`), so the
   *  lead's delete sweeps its children's files. */
  prepareWorkerStorage(
    sessionId: string,
    payload: AgentRuntimeWorkerInitPayload,
    spawnerSessionId?: string,
  ): BrowserConversationStorageBackend | null
  /** Allocate a worker via the SessionWorkerFactory recipe. */
  createWorker(
    sessionId: string,
    backend: BrowserConversationStorageBackend | null,
  ): { worker: AgentRuntimeWorkerHandle; instanceId: string }
  /**
   * Register the teammate's session entry (no ports). `identity` is required: sidebar and tab strip
   * place the child by `spawnerSessionId` from the live entry.
   */
  registerSessionEntry(
    sessionId: string,
    worker: AgentRuntimeWorkerHandle,
    instanceId: string,
    identity: {
      spawnerSessionId?: string
      teammateName: string
      templateType?: string
      /** The folder the teammate BOOTS on (its init payload's), so it can
       *  answer `getParentSessionBinding` for a sub-agent IT spawns. */
      projectRoot?: string
    },
  ): void
  getSessionWorker(sessionId: string): AgentRuntimeWorkerHandle | undefined
  /** Unified disposal (fire C++ stop, clear ports, await dispose, delete). */
  disposeManagedSession(
    sessionId: string,
    opts: { fireStop: boolean },
  ): Promise<void>
  /** Announce the new teammate session to list subscribers. */
  notifySessionUpserted(sessionId: string): void
  /** Persist the durable read-only shutdown marker before disposal. `lost`
   *  records that the teammate did not survive a restart, as opposed to being
   *  shut down on purpose — see `BrowserSessionMetadata.lostAt`. */
  markSessionShutdown?: (
    sessionId: string,
    shutdownAt: number,
    opts?: { lost?: boolean },
  ) => Promise<boolean>
  /** Broadcast `session.removed` to the torn-down teammate's subscribers. */
  broadcastSessionRemoved(sessionId: string): void
  /** Enqueue a drained lead-inbox message through the submit queue at
   *  mailbox priority (serializes with user input + task deliveries).
   *  False when the session has no live runtime to take it — the caller
   *  keeps the message rather than counting it delivered. */
  enqueueMailboxTurn(sessionId: string, prompt: string): boolean
  /** The direct bridge transport, or null before the port is installed.
   *  Null means the mailbox degrades to its in-memory path. */
  getDirectBridgeTransport(): BrowserBridgeTransport | null
  /** The session's own storage directory, or null when it is not routed. */
  getSessionDirectory(sessionId: string): string | null
  /** Whether a session's worker is mid-turn. */
  isSessionBusy(sessionId: string): boolean
  /**
   * Whether delivery INTO this session is suppressed because the user hit
   * Stop (`TaskDeliveryQueue.isSuppressed`, lifted by the next genuine user
   * submit). A halted conversation must not be revived by work that settles
   * moments later — the rule background sub-agent results already follow.
   */
  isDeliverySuppressed(sessionId: string): boolean
  /**
   * Whether the session is parked on a question to the user (a pending
   * `AskUserQuestion` or permission ask). A lead in that state is NOT free for
   * a mailbox turn: the turn would run over the question — two
   * of a lead's questions were buried this way and never answered, and the
   * lead concluded the tool was broken. Optional: absent reads as "no".
   */
  sessionNeedsAnswer?(sessionId: string): boolean
  /**
   * The LEAD session's OWN per-runtime snapshot of the process-global
   * singletons (`SessionEntry.runtimeGlobals`, captured at its
   * `worker.ready`) — never the shared slot, which a sibling teammate's boot
   * may already have clobbered. See `restoreLeadGlobals`.
   */
  getOwnerGlobals(spawnerSessionId: string): OwnerRuntimeGlobals | undefined
  /** Trust class of a session's provider, from settings (never the model). */
  getSessionTrust(sessionId: string): TeamMessageTrust
  /**
   * Re-read the settings behind `getSessionTrust`. Awaited before a frame is
   * delivered to a LEAD: its trust is read live on purpose (a lead that moved
   * onto a relay mid-run is the case the banner exists for), and a cache
   * loaded once at boot answered from the old settings for the realm's life.
   * Optional: absent means the host's answer is already live.
   */
  refreshSessionTrust?(): Promise<void>
  /** The session's last assistant text, for the turn-end report. */
  getFinalAssistantText(sessionId: string): string
  /**
   * The uuid of the assistant message `getFinalAssistantText` reads, so the
   * turn-end report can tell "this turn produced no text" (the same MESSAGE
   * again) from a new turn whose answer merely reads the same. Optional: a
   * host without it falls back to comparing the text.
   */
  getFinalAssistantMessageUuid?(sessionId: string): string | undefined
  /**
   * The LEAD's own project binding — the seed for the child's `projectRoot`
   * / `templateType`. The init template is the most recent UI `worker.init`
   * of ANY session, so without this a teammate spawned from a lead in
   * project A booted in whatever project the user opened last. Null for an
   * unknown session (the template's fields then stand, as before). Same seam
   * as `SubAgentHost.getParentSessionBinding`.
   */
  getParentSessionBinding?(
    spawnerSessionId: string,
  ): { projectRoot?: string; templateType?: string; cwd?: string } | null
  tracer: SessionTracer
}

export class TeamCoordinator {
  // Spawned teammate sessions, keyed by sessionId.
  // Entries persist while the teammate runs; `teardown` removes them. Used
  // to attribute team identity + route messages.
  private readonly teammates = new Map<string, TeammateEntry>()
  // Inter-agent mailbox (Phases C/D) — drives the teammate idle loop.
  private readonly mailbox = new TeamMailbox()
  // Per-teammate abort controllers (Phase C/E) — aborting one breaks its
  // idle-wait and exits the loop into teardown.
  private readonly aborts = new Map<string, AbortController>()
  // Each running teammate's idle loop, settled once its `teardown` has run
  // to completion. `abortTeammatesOf` awaits these so a lead's delete does
  // not race the children's teardown (marker writes, disposal, retirement)
  // against its own storage sweep.
  private readonly loops = new Map<string, Promise<void>>()
  // Durable mailbox (WP-C). Built lazily: the bridge port installs after the
  // manager, so there is a window in which no transport exists yet.
  private store: TeamMailboxStore | null = null
  private poller: MailboxPoller | null = null
  // Teammates this coordinator tore down, by session id, KEPT after the live
  // entry goes. Two readers: a teammate's last report is routinely read after
  // its teardown (Shutdown right after the report), and a sender the live map
  // no longer knew was rendered UNTRUSTED — a trusted teammate's report
  // arrived in the quarantine envelope; and the per-tab init gate asks it
  // whether an unmarked teammate id was ended on purpose or lost to a
  // restart. Keyed by SESSION id, never by member key: a key is reused by
  // the next teammate spawned under the same name.
  private readonly retired = new Map<string, RetiredTeammate>()
  // Leads whose inbox is still polled although they have no running teammate:
  // the last one just stopped, and its final frames may not have been read
  // yet. Value = when it was added; dropped after an empty pass once
  // `LEAD_DRAIN_GRACE_MS` has passed.
  private readonly drainingLeads = new Map<string, number>()
  // Teammates a lead had on record that were no longer running when it came
  // back — lost to a browser restart. Kept so the roster and every address
  // attempt can SAY so: without it a message to one came back "no member",
  // which a lead read as a provider outage and re-spawned around.
  private readonly lost = new Map<string, LostTeammate[]>()

  constructor(private readonly host: TeamCoordinatorHost) {}

  /**
   * The file-backed mailbox, or null while the bridge has no transport. Null
   * is not an error: every caller falls back to the in-memory queue, which is
   * exactly the pre-WP-C behaviour.
   */
  private ensureStore(): TeamMailboxStore | null {
    if (this.store) return this.store
    const transport = this.host.getDirectBridgeTransport()
    if (!transport) {
      this.host.tracer.event('nexus_team_mailbox_no_transport', {})
      return null
    }
    // The store resolves the transport PER REQUEST: `BridgeRequestRouter.
    // setHostPort` disposes the direct transport and creates a new one on
    // every page boot, so a store built over the first one failed every
    // write with `transport_disposed` after a reload with a live team —
    // reports, `[not delivered]` notices and inbox retirement all lost, while
    // the poller's `hasTransport` (which already read the getter) said fine.
    this.store = new TeamMailboxStore({
      getTransport: () => this.host.getDirectBridgeTransport(),
      createRequestId: () =>
        globalThis.crypto?.randomUUID?.() ?? `team-${Date.now()}`,
    })
    this.poller = new MailboxPoller(this.store, {
      hasTransport: () => this.host.getDirectBridgeTransport() !== null,
      listRecipients: () => this.listRecipients(),
      onFrames: (recipient, frames) => this.deliverFrames(recipient, frames),
      onInboxIdle: recipient => {
        if (recipient.memberKey !== TEAM_LEAD_MEMBER_KEY) return
        const since = this.drainingLeads.get(recipient.headSessionId)
        if (since !== undefined && Date.now() - since >= LEAD_DRAIN_GRACE_MS) {
          this.drainingLeads.delete(recipient.headSessionId)
        }
      },
    })
    this.poller.start()
    return this.store
  }

  /**
   * Every inbox worth reading this pass: each running teammate, plus each
   * lead that owns one. A lead with no teammates has nobody who could write
   * to it, so it is not polled at all.
   */
  private listRecipients(): MailboxRecipient[] {
    const out: MailboxRecipient[] = []
    const leads = new Set<string>()
    for (const [, tm] of this.teammates) {
      if (tm.status === 'stopped' || !tm.spawnerSessionId) continue
      if (tm.inboxReady === false) continue
      const leadDir = this.host.getSessionDirectory(tm.spawnerSessionId)
      if (!leadDir) continue
      out.push({
        leadSessionDir: leadDir,
        headSessionId: tm.spawnerSessionId,
        memberKey: tm.key,
        idle: tm.status === 'idle',
      })
      leads.add(tm.spawnerSessionId)
    }
    for (const headSessionId of this.drainingLeads.keys()) leads.add(headSessionId)
    for (const headSessionId of leads) {
      const leadDir = this.host.getSessionDirectory(headSessionId)
      if (!leadDir) {
        // A draining lead is only ever dropped by an idle pass over its
        // inbox — which never comes once its directory is gone (deleted, or
        // unrouted). Without this it was polled, and skipped, for good.
        this.drainingLeads.delete(headSessionId)
        continue
      }
      out.push({
        leadSessionDir: leadDir,
        headSessionId,
        memberKey: TEAM_LEAD_MEMBER_KEY,
        idle: this.leadCanTakeTurnNow(headSessionId),
      })
    }
    return out
  }

  /** Turn delivered frames into turns for whoever they were addressed to. */
  private async deliverFrames(
    recipient: MailboxRecipient,
    frames: readonly TeamMessageFrame[],
  ): Promise<void> {
    const { memberKey, headSessionId } = recipient
    // The lead's trust is read LIVE below (its own banner, and the envelope
    // on frames it sent). "Live" has to mean the settings as they are now,
    // not as they were when the realm booted: a provider marked untrusted in
    // Settings after boot, with the lead then falling over to it, was
    // delivered banner-free from the stale cache. Awaited, so the poller
    // hands off the next batch only after this one is placed — the order of
    // frames within an inbox is the order of their turns.
    try {
      await this.host.refreshSessionTrust?.()
    } catch {
      // The previous answer stands; a refresh failure must not drop frames.
    }
    // Resolved WITHIN this inbox's own team. Member names are unique per
    // team, not globally: resolving `team-lead` (or a common teammate name
    // like `worker-a`) against the whole registry returned the FIRST match,
    // so with two leads open one team's frames were delivered into the
    // other's session — an untrusted child's report landing in an unrelated
    // conversation — and never reached their real addressee.
    const recipientSessionId = this.sessionIdForMemberOfLead(
      memberKey,
      headSessionId,
    )
    if (!recipientSessionId) return
    for (const frame of frames) {
      // Marks the frame READ once it reaches a turn — never on arrival here
      // (see MailboxPoller). Frames of one inbox are consumed in order, so
      // acking a frame's own seq is acking everything before it too.
      const ack = () => {
        void this.poller?.ack(recipient, frame.seq).catch(() => {})
      }
      // Re-derive the SENDER's trust here rather than believing the frame:
      // the value in the file was written by the sending side.
      let text = renderTeamFrame(frame, this.senderTrust(frame, headSessionId))
      if (memberKey === TEAM_LEAD_MEMBER_KEY) {
        // The lead's OWN trust, re-read at delivery: it is not fixed for the
        // session's life the way a teammate's is (that one is captured at
        // spawn on purpose), and a lead that moved onto a relay mid-run is
        // exactly the case worth catching.
        if (this.host.getSessionTrust(recipientSessionId) === 'untrusted') {
          text = `${UNTRUSTED_LEAD_BANNER}${text}`
        }
        // An idle lead gets the message as a new turn now; a busy, suppressed (Stop) or parked lead, or
        // an older queued frame, keeps it queued for the next boundary. Acked only once the runtime took it.
        if (
          this.leadCanTakeTurnNow(recipientSessionId) &&
          this.host.enqueueMailboxTurn(recipientSessionId, text)
        ) {
          ack()
        } else {
          this.mailbox.enqueue(recipientSessionId, text, ack)
        }
      } else {
        this.mailbox.enqueue(recipientSessionId, text, ack)
      }
    }
  }

  /**
   * Whether a mailbox frame may become the lead's next turn right now: not
   * mid-turn, not under a Stop, not parked on a question to the user, and
   * with nothing older still queued ahead of it.
   */
  private leadCanTakeTurnNow(headSessionId: string): boolean {
    return (
      !this.host.isSessionBusy(headSessionId) &&
      !this.host.isDeliverySuppressed(headSessionId) &&
      !(this.host.sessionNeedsAnswer?.(headSessionId) ?? false) &&
      !this.mailbox.hasPending(headSessionId)
    )
  }

  /**
   * A session's trust class. A teammate's answer is the one CAPTURED at
   * spawn, not a fresh read: the child is already running under the rules
   * that answer produced, so re-deriving it mid-flight could label a
   * locked-down session trusted because the user flipped a setting after it
   * started. Anything else (the lead) falls through to the live settings.
   */
  private trustOf(sessionId: string): TeamMessageTrust {
    return (
      this.teammates.get(sessionId)?.trust ??
      this.retired.get(sessionId)?.trust ??
      this.host.getSessionTrust(sessionId)
    )
  }

  /**
   * Security: the trust a reader gives a frame's sender, from the stamped SESSION id, never the reusable
   * member key. The lead is read live; a teammate's is captured at spawn. No sender session → untrusted.
   */
  private senderTrust(
    frame: TeamMessageFrame,
    headSessionId: string,
  ): TeamMessageTrust {
    const sender = frame.from.sessionId
    if (!sender) return 'untrusted'
    if (sender === headSessionId) return this.host.getSessionTrust(sender)
    return (
      this.teammates.get(sender)?.trust ??
      this.retired.get(sender)?.trust ??
      'untrusted'
    )
  }

  /**
   * Member NAME to running sessionId WITHIN one lead's team. `team-lead` (or
   * the lead's own member name) is the lead itself; anything else is one of
   * that lead's teammates.
   *
   * Scoped by lead on purpose — see `deliverFrames`.
   */
  private sessionIdForMemberOfLead(
    memberName: string,
    headSessionId: string,
  ): string | null {
    if (
      memberName === TEAM_LEAD_MEMBER_KEY ||
      memberName === 'lead' ||
      memberName ===
        getTeamRegistry()
          ?.listTeams()
          .find(t => t.headSessionId === headSessionId)
          ?.members.find(m => m.isLead)?.name
    ) {
      return headSessionId
    }
    for (const [sid, tm] of this.teammates) {
      if (
        this.isAddressedAs(tm, memberName) &&
        tm.spawnerSessionId === headSessionId &&
        tm.status !== 'stopped'
      ) {
        return sid
      }
    }
    return null
  }

  /** A teammate answers to its member KEY (what frames carry) and to its
   *  DISPLAY name (what the model and the user call it). */
  private isAddressedAs(tm: TeammateEntry, memberName: string): boolean {
    return tm.key === memberName || tm.name === memberName
  }

  /** Member NAME to running sessionId; 'team-lead' resolves to the lead.
   *  Team-scoped by the TEAM id (the `deliver` path, which knows one). */
  private sessionIdForMember(memberName: string): string | null {
    for (const [sid, tm] of this.teammates) {
      if (this.isAddressedAs(tm, memberName) && tm.status !== 'stopped') return sid
    }
    const reg = getTeamRegistry()
    for (const team of reg?.listTeams() ?? []) {
      const lead = team.members.find(m => m.isLead)
      if (
        lead &&
        (memberName === lead.name ||
          memberName === TEAM_LEAD_MEMBER_KEY ||
          memberName === 'lead')
      ) {
        return team.headSessionId ?? null
      }
    }
    return null
  }

  /** The lead session directory that owns a team's mailbox tree. */
  private leadDirFor(team: string): string | null {
    const headSessionId = getTeamRegistry()?.getTeam(team)?.headSessionId
    return headSessionId ? this.host.getSessionDirectory(headSessionId) : null
  }

  /** Write a frame, then poll immediately so a same-process send does not
   *  wait out the interval. A failed write is traced, never silent. */
  private appendFrame(
    leadDir: string,
    store: TeamMailboxStore,
    frame: AppendableFrame,
    /** Session to fall back to when the write fails, so a message the tool
     *  already reported as sent still arrives. */
    fallbackSessionId?: string,
  ): void {
    void store
      .append(leadDir, frame)
      .then(() => this.poller?.kick())
      .catch(err => {
        this.host.tracer.event('nexus_team_mailbox_append_failed', {
          attrs: {
            to: frame.to.name,
            error: err instanceof Error ? err.message : String(err),
          },
        })
        // `deliver` answers the model synchronously ("Message sent to X"),
        // before this write is known to have landed. Rather than leave that
        // answer false — the lead waiting on a reply that cannot come — fall
        // back to the in-memory queue, which is the same path used when there
        // is no transport at all.
        if (fallbackSessionId) {
          this.mailbox.enqueue(fallbackSessionId, this.renderUnstored(frame))
        }
      })
  }

  /**
   * A frame that never reaches the inbox file, rendered for the in-memory
   * queue — the SAME text the stored path produces, envelope included, so an
   * untrusted sender is quarantined on this path too. The reader trust is
   * the frame's own: it was stamped by this coordinator a moment ago from
   * the same `trustOf` the stored path re-derives.
   */
  private renderUnstored(frame: AppendableFrame): string {
    return renderTeamFrame(
      { ...frame, v: 1, id: 'fallback', seq: 0, ts: Date.now() },
      frame.trust,
    )
  }

  /**
   * Spawn a teammate session (fresh portless worker with team identity); returns the sessionId
   * synchronously. It runs its first turn, then idles on the mailbox until a message or shutdown.
   * Null with no init template.
   */
  spawn(params: SpawnTeammateParams): string | null {
    const template = this.host.getInitTemplate()
    if (!template) return null
    const { teamName, teammateName, prompt, spawnerSessionId, model } = params
    // The display name is the model's and the user's; the KEY is ours. One
    // live teammate per display name per lead — SendMessage / Shutdown
    // address by that name, and two answering to it would be ambiguous.
    const siblings = [...this.teammates.values()].filter(
      tm => tm.spawnerSessionId === spawnerSessionId && tm.status !== 'stopped',
    )
    if (siblings.some(tm => tm.name === teammateName)) {
      throw new TeammateNameInUseError(teammateName)
    }
    const key = allocateMemberKey(
      teammateName,
      new Set(siblings.map(tm => tm.key)),
    )
    // The trailing `Date.now()` is not decoration: it is the ONLY creation
    // time a teammate has (`meta.json` keeps an activity clock and no birth
    // time), and both `memberKeyFromTeammateId` and the topbar tab strip's
    // `teammateSpawnTimeFromId` read it back off the id. Changing this shape
    // reorders the strip.
    const sessionId = `teammate-${teamName}-${key}-${Date.now()}`
    if (spawnerSessionId) {
      // A new teammate under a lost one's name supersedes its marker: the name
      // now means the new one, and once that one ends, the old loss is not
      // the reason it is gone.
      const lost = this.lost.get(spawnerSessionId)
      if (lost) {
        this.lost.set(
          spawnerSessionId,
          lost.filter(l => l.name !== teammateName && l.key !== key),
        )
      }
    }

    this.teammates.set(sessionId, {
      teamName,
      name: teammateName,
      key,
      spawnerSessionId,
      status: 'active',
      startedAt: Date.now(),
      // A child with a read boundary is, by construction, one on an
      // untrusted provider — captured here so its messages stay labelled
      // that way for its whole life, whatever the setting does later.
      trust: params.untrustedReadRoot ? 'untrusted' : 'trusted',
      inboxReady: false,
      ...(params.onCleanup ? { onCleanup: params.onCleanup } : {}),
      // Snapshot the LEAD's globals BEFORE this teammate's `worker.init`
      // below installs its own over them (see `restoreLeadGlobals`). Taken
      // from the lead's own captured report rather than the live slot: a
      // sibling teammate spawned moments earlier already owns the slot, and
      // restoring THAT at teardown would hand the lead a transport belonging
      // to a session that may be reaped first.
      ...(spawnerSessionId
        ? (() => {
            const leadGlobals = this.host.getOwnerGlobals(spawnerSessionId)
            return leadGlobals ? { leadGlobals } : {}
          })()
        : {}),
    })

    // Security: project binding comes from the LEAD, not the template (the last init of any session);
    // an explicit `projectRoot` / `templateType` still wins.
    const parent = spawnerSessionId
      ? (this.host.getParentSessionBinding?.(spawnerSessionId) ?? null)
      : null
    const boundProjectRoot = params.projectRoot ?? parent?.projectRoot
    // A DERIVED template (safe_code for an untrusted child); absent means
    // inherit the lead's.
    const boundTemplateType = params.templateType ?? parent?.templateType

    const initPayload: AgentRuntimeWorkerInitPayload = {
      ...template,
      sessionId,
      isTeammate: true,
      teamName,
      teammateName,
      // Identity: nests the storage AND persists into the session meta at
      // bind, which is what hides the child from the sidebar after a reload.
      ...(spawnerSessionId ? { spawnerSessionId } : {}),
      // With a live lead these OVERRIDE the template's (possibly foreign)
      // values — `undefined` included, so an unbound lead's teammate does not
      // inherit another session's folder or type.
      ...(parent
        ? { projectRoot: boundProjectRoot, templateType: boundTemplateType }
        : {
            ...(boundProjectRoot ? { projectRoot: boundProjectRoot } : {}),
            ...(boundTemplateType ? { templateType: boundTemplateType } : {}),
          }),
      // Security: the provider is stamped whenever resolved (it is what isolation was decided for);
      // without a model, the template's model is CLEARED, not inherited.
      ...(params.providerId
        ? {
            userSpecifiedProviderId: params.providerId,
            userSpecifiedModel: model,
            ...(params.thinkingTier
              ? { userSpecifiedThinkingTier: params.thinkingTier }
              : {}),
          }
        : model
          ? { userSpecifiedModel: model }
          : {}),
      // The lead-prepared directory, else — for a lead that is itself
      // worktree-isolated — the lead's own working dir, so the child does not
      // land in the template's `cwd` (another session's) either.
      ...(params.cwd
        ? { cwdOverride: params.cwd }
        : parent?.cwd
          ? { cwdOverride: parent.cwd }
          : {}),
      // The read boundary. Deliberately NOT `isSubAgent` — that flag turns
      // off file snapshots and rewrites maxTurns, neither of which a real
      // child session wants.
      ...(params.untrustedReadRoot
        ? { untrustedReadRoot: params.untrustedReadRoot }
        : {}),
      // Own trace lineage; not a routine run.
      traceId: undefined,
      isHeadless: undefined,
      routineId: undefined,
      // Routine PROVENANCE is inherited though — a teammate spawned by
      // routine-driven work is still routine-driven, and the recursion guard
      // reads this (same reasoning as SubAgentCoordinator.spawn).
      routineOriginId: params.routineOriginId,
    }

    const teammateBackend = this.host.prepareWorkerStorage(
      sessionId,
      initPayload,
      spawnerSessionId,
    )
    const { worker, instanceId } = this.host.createWorker(
      sessionId,
      teammateBackend,
    )
    this.host.registerSessionEntry(sessionId, worker, instanceId, {
      ...(spawnerSessionId ? { spawnerSessionId } : {}),
      teammateName,
      // The binding the worker BOOTS on (derived safe_code, else the lead's;
      // the template's with no live lead), so the row icon and any
      // template-gated UI agree with it — and so a sub-agent this teammate
      // spawns inherits it. Without `projectRoot` here the teammate's own
      // binding read `{templateType}` and its sub-agent booted unbound.
      ...(initPayload.templateType
        ? { templateType: initPayload.templateType }
        : {}),
      ...(initPayload.projectRoot
        ? { projectRoot: initPayload.projectRoot }
        : {}),
    })
    this.host.notifySessionUpserted(sessionId)

    const abort = new AbortController()
    this.aborts.set(sessionId, abort)
    void this.retireStaleInbox(sessionId)

    // Idle loop: run the first turn, then idle on the mailbox.
    // Each turn uses submitAndWait which resolves when the turn's
    // executeSubmit settles — NOT on enqueue. "Staying alive" is the gap
    // BETWEEN turns - owned here, event-driven (no poll); a delivered
    // message or a shutdown abort resolves the wait.
    // the next turn restarts the actor from a clean (warm) state.
    const loop = (async () => {
      try {
        await worker.receiveFrame({
          type: 'worker.init',
          sessionId,
          payload: initPayload,
        } as SessionWorkerInboundMessage)
      } catch (err) {
        this.host.tracer.event('nexus_teammate_init_failed', {
          attrs: {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          },
        })
        await this.teardown(sessionId)
        return
      }

      let nextPrompt: string | null = prompt
      while (nextPrompt !== null && !abort.signal.aborted) {
        this.markStatus(sessionId, 'active')
        const current = this.teammates.get(sessionId)
        if (current) {
          current.interruptRequested = false
          current.turnSeq = (current.turnSeq ?? 0) + 1
        }
        // Set when this turn is cut short by a Stop on the lead and the
        // teammate survives it (see the `aborted` branch below).
        let interrupted = false
        try {
          if (worker.submitAndWait) {
            const result = await worker.submitAndWait(
              { type: 'worker.submitMessage', payload: { prompt: nextPrompt } } as Extract<AgentWorkerInboundMessage, { type: 'worker.submitMessage' }>,
              'mailbox',
            )
            // `failed` and `aborted` are normal RESOLUTIONS of
            // submitAndWait (never the catch path). A failed turn is logged
            // but keeps the loop alive, because a follow-up message can
            // recover. An aborted turn means the worker was interrupted /
            // reset / disposed out from under us — exit into teardown rather
            // than idling on the mailbox against a dead worker.
            if (result.status === 'failed') {
              this.host.tracer.event('nexus_teammate_turn_failed', {
                attrs: {
                  sessionId,
                  error: `${result.code} — ${result.message}`,
                },
              })
            }
            if (result.status === 'aborted') {
              // Two kinds of abort reach here. A SHUTDOWN (abort controller
              // fired — Shutdown tool, lead deleted) or a worker that is
              // gone: exit into teardown. A user Stop on the lead
              // (`interruptTeammatesOf`) only interrupts the in-flight turn:
              // the teammate stays alive and parks on its mailbox, so the
              // lead can brief it again — Stop halts activity, Shutdown
              // removes a teammate, and the two must not collapse into one.
              if (
                abort.signal.aborted ||
                !this.host.getSessionWorker(sessionId)
              ) {
                break
              }
              // Survived: the turn was cut short, so whatever text it had
              // produced is a fragment, not an answer. Mark the report —
              // unmarked it reads exactly like a completed turn and a lead
              // would build on work that did not finish.
              interrupted = true
            }
          } else {
            await worker.receiveFrame({
              type: 'worker.submitMessage',
              sessionId,
              payload: { prompt: nextPrompt },
            } as SessionWorkerInboundMessage)
          }
        } catch (err) {
          // A thrown turn must NOT kill the loop either — log and
          // keep idling so a follow-up message can recover.
          this.host.tracer.event('nexus_teammate_turn_failed', {
            attrs: {
              sessionId,
              error: err instanceof Error ? err.message : String(err),
            },
          })
        }
        this.markStatus(sessionId, 'idle')
        // A shutdown that landed mid-turn: the teammate is going away, and a
        // "report" now is a fragment the lead would read after it had already
        // decided to end the teammate.
        if (abort.signal.aborted) break
        // A Stop can interrupt a turn that still RESOLVES `completed` (the
        // interrupt landed between two steps). Unmarked, its fragment read
        // exactly like a finished answer, and a lead shut a teammate down
        // over a half-written "need to reconcile" it took as current.
        if (this.teammates.get(sessionId)?.interruptRequested) interrupted = true
        // Report the turn to the lead. This is the ONLY upward channel a
        // locked-down child has: `safe_code` carries no SendMessage, so
        // without this a lead would never learn its teammate had finished.
        this.reportTurnEnd(sessionId, interrupted)
        nextPrompt = await this.mailbox.awaitInboxOrStop(
          sessionId,
          abort.signal,
        )
      }
      await this.teardown(sessionId)
    })()
    // Tracked until it settles. The loop is not expected to reject (`teardown`
    // guards its own fallible steps, and an init failure above tears down and
    // returns) — if it does, record it rather than leave an unhandled
    // rejection, and still let the waiters go.
    const tracked = loop.catch((err: unknown) => {
      this.host.tracer.event('nexus_teammate_loop_failed', {
        attrs: {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    })
    this.loops.set(sessionId, tracked)
    void tracked.then(() => {
      if (this.loops.get(sessionId) === tracked) this.loops.delete(sessionId)
    })

    return sessionId
  }

  /**
   * Append a `turn_end` frame to the lead's inbox with the teammate's final
   * assistant text. Silent when the teammate has no lead directory or the
   * turn produced no text — an empty report is noise, not information.
   */
  private reportTurnEnd(sessionId: string, interrupted = false): void {
    const tm = this.teammates.get(sessionId)
    if (!tm?.spawnerSessionId) return
    const leadDir = this.host.getSessionDirectory(tm.spawnerSessionId)
    const store = this.ensureStore()
    if (!leadDir || !store) return
    // The teammate already reported with `SendMessage`, and that was the
    // LAST thing it did this turn: the final text is a restatement of it.
    // Sending it too cost the lead a whole turn per report ("same content,
    // nothing new") — every SendMessage-capable teammate of one run did
    // it. A SendMessage followed by more work still reports: the
    // final text then carries what came after.
    if (
      !interrupted &&
      tm.leadMessageAt !== undefined &&
      tm.leadMessageAt.turnSeq === tm.turnSeq &&
      tm.leadMessageAt.toolSeq === (tm.toolSeq ?? 0)
    ) {
      this.host.tracer.event('nexus_teammate_report_already_sent', {
        attrs: { sessionId },
      })
      return
    }
    const text = this.host.getFinalAssistantText(sessionId)
    if (!text) return
    // Do not re-report an earlier turn's text as a new completion: compare by message uuid when the
    // host names it (else the raw text).
    const uuid = this.host.getFinalAssistantMessageUuid?.(sessionId)
    const sameAsReported =
      uuid !== undefined
        ? uuid === tm.lastReportedUuid
        : text === tm.lastReportedText
    if (sameAsReported) return
    tm.lastReportedText = text
    tm.lastReportedUuid = uuid
    const body = interrupted ? `${TURN_INTERRUPTED_PREFIX}${text}` : text

    this.appendFrame(leadDir, store, {
      from: { name: tm.key, role: 'member', display: tm.name, sessionId },
      to: { name: TEAM_LEAD_MEMBER_KEY },
      kind: 'turn_end',
      trust: this.trustOf(sessionId),
      body,
      meta: { childSessionId: sessionId },
    })
  }

  /**
   * Tell the lead which messages a stopping teammate never read, then mark
   * them read so they cannot surface later under the same member key. Before
   * this they vanished silently: the lead believed a rebase request had
   * arrived, waited on it, and did the rebase itself 80 minutes later.
   * Senders only — the bodies may be a peer's untrusted text.
   */
  private reportUndelivered(
    tm: TeammateEntry,
    sessionId: string,
    unread: readonly MailboxEntry[],
  ): void {
    if (unread.length === 0) return
    for (const entry of unread) {
      try {
        entry.ack?.()
      } catch {
        // cursor only
      }
    }
    this.noticeUndelivered(
      tm,
      sessionId,
      unread.map(e => parseTeamMessageEnvelope(e.prompt)?.fromDisplay ?? 'unknown'),
      `were still unread when it stopped. It never saw them`,
    )
  }

  /**
   * Frames left unread under this member key BEFORE the teammate was spawned belonged to an earlier
   * teammate: mark them read and tell the lead before the poller serves the inbox. Later frames are kept.
   */
  private async retireStaleInbox(sessionId: string): Promise<void> {
    const tm = this.teammates.get(sessionId)
    if (!tm) return
    try {
      const leadDir = tm.spawnerSessionId
        ? this.host.getSessionDirectory(tm.spawnerSessionId)
        : null
      const store = this.ensureStore()
      if (!leadDir || !store || !this.poller) return
      const cursor = await store.readCursor(leadDir, tm.key)
      const stale = (await store.readAfter(leadDir, tm.key, cursor.deliveredSeq))
        .filter(frame => frame.ts < tm.startedAt)
      if (stale.length === 0) return
      await this.poller.ack(
        { leadSessionDir: leadDir, memberKey: tm.key },
        stale[stale.length - 1]!.seq,
      )
      this.noticeUndelivered(
        tm,
        sessionId,
        stale.map(frame => frame.from.display ?? frame.from.name),
        `were addressed to an EARLIER teammate named ${tm.name} and never read. The new ${tm.name} will not see them`,
      )
    } catch (err) {
      this.host.tracer.event('nexus_teammate_inbox_retire_failed', {
        attrs: {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    } finally {
      tm.inboxReady = true
      this.poller?.kick()
    }
  }

  /** One `[not delivered]` notice to a teammate's lead: how many frames,
   *  from whom (never their bodies — a body may be a peer's untrusted text),
   *  and what became of them. */
  private noticeUndelivered(
    tm: TeammateEntry,
    sessionId: string,
    senders: readonly string[],
    fate: string,
  ): void {
    const leadDir = tm.spawnerSessionId
      ? this.host.getSessionDirectory(tm.spawnerSessionId)
      : null
    const store = this.ensureStore()
    if (!leadDir || !store) return
    this.appendFrame(leadDir, store, {
      from: { name: tm.key, role: 'member', display: tm.name, sessionId },
      to: { name: TEAM_LEAD_MEMBER_KEY },
      kind: 'system',
      trust: this.trustOf(sessionId),
      body:
        `[not delivered] ${senders.length} message(s) sent to ${tm.name} ${fate} ` +
        `(from: ${[...new Set(senders)].join(', ')}). Send again whatever still matters — to another teammate, or handle it yourself.`,
      meta: { childSessionId: sessionId, undelivered: senders.length },
    })
  }

  private markStatus(sessionId: string, status: 'active' | 'idle'): void {
    const tm = this.teammates.get(sessionId)
    if (tm && tm.status !== 'stopped') {
      tm.status = status
    }
  }

  /**
   * Resolve a `(team, memberName)` to a running session id. Teammates are
   * found in the `teammates` map; the lead resolves to the team record's
   * `headSessionId` (member name matches the lead, or the literal
   * "team-lead" / "lead").
   */
  private resolveMemberSessionId(
    team: string,
    memberName: string,
  ): string | null {
    for (const [sid, tm] of this.teammates) {
      if (
        tm.teamName === team &&
        this.isAddressedAs(tm, memberName) &&
        tm.status !== 'stopped'
      ) {
        return sid
      }
    }
    const reg = getTeamRegistry()
    const t = reg?.getTeam(team)
    if (t) {
      const lead = t.members.find((m) => m.isLead)
      if (
        lead &&
        (memberName === lead.name ||
          memberName === 'team-lead' ||
          memberName === 'lead')
      ) {
        return t.headSessionId ?? null
      }
    }
    return null
  }

  /** TeamMessenger.deliver impl: enqueue a message as the recipient's next turn. */
  deliver(args: {
    team: string
    to: string
    from: string
    body: string
    withOtherTools?: boolean
  }): DeliverResult {
    const sid = this.resolveMemberSessionId(args.team, args.to)
    if (!sid) {
      return {
        ok: false,
        reason:
          this.lostReason(args.team, args.to) ??
          `no member "${args.to}" in team "${args.team}"`,
      }
    }
    if (!this.host.getSessionWorker(sid)) {
      return { ok: false, reason: `member "${args.to}" is not currently running` }
    }
    const fromSessionId = this.resolveMemberSessionId(args.team, args.from)
    // Frames are addressed by member KEY: the recipient's inbox path is
    // `to.name`, and a lead resolved through any of its aliases ('lead', its
    // member name) must still land in the ONE inbox the poller reads.
    const toEntry = this.teammates.get(sid)
    const fromEntry = fromSessionId ? this.teammates.get(fromSessionId) : undefined
    const frame: AppendableFrame = {
      from: {
        ...(fromEntry
          ? { name: fromEntry.key, role: 'member' as const, display: fromEntry.name }
          : {
              name: args.from,
              role: args.from === TEAM_LEAD_MEMBER_KEY ? ('lead' as const) : ('member' as const),
            }),
        // The sender's SESSION, for the reader's trust decision (see
        // `senderTrust`); absent when the sender could not be resolved.
        ...(fromSessionId ? { sessionId: fromSessionId } : {}),
      },
      to: toEntry
        ? { name: toEntry.key, display: toEntry.name }
        : { name: TEAM_LEAD_MEMBER_KEY },
      kind: 'message',
      // Unknown sender reads as untrusted: the strict answer is the safe one,
      // and the reader re-derives this anyway.
      trust: fromSessionId ? this.trustOf(fromSessionId) : 'untrusted',
      body: args.body,
    }
    const leadDir = this.leadDirFor(args.team)
    const store = this.ensureStore()
    if (!leadDir || !store) {
      // No transport (or an unrouted lead): keep the pre-WP-C in-memory
      // delivery rather than dropping the message — through the SAME
      // envelope as the stored path. A bare `[message from X]: body` here
      // let an untrusted sender skip its quarantine whenever the port was
      // late, and named it by display name where every other frame carries
      // its key.
      this.mailbox.enqueue(sid, this.renderUnstored(frame))
    } else {
      this.appendFrame(leadDir, store, frame, sid)
    }
    if (fromEntry && !toEntry) {
      // A message written alongside other tool calls cannot carry their
      // results, so it never stands in for the turn-end report.
      fromEntry.leadMessageAt = args.withOtherTools
        ? undefined
        : {
            turnSeq: fromEntry.turnSeq ?? 0,
            toolSeq: fromEntry.toolSeq ?? 0,
          }
    }
    return { ok: true }
  }

  /** A tool started in `sessionId` (every tool — see `reportTurnEnd`). */
  noteToolStart(sessionId: string): void {
    const tm = this.teammates.get(sessionId)
    if (tm) tm.toolSeq = (tm.toolSeq ?? 0) + 1
  }

  /**
   * Mid-turn delivery: every frame queued for `sessionId`, taken (and acked)
   * between two tool rounds of its RUNNING turn, so the running turn sees it
   * now rather than at a boundary it may not reach for hours — a teammate
   * that waits inside one long turn got the lead's 21:39 message at 00:26.
   * The runtime asks for these after every tool round. Nothing while the session is under a
   * Stop: that hold is lifted by the user's next submit, not by a turn.
   */
  takeMidTurnMessages(sessionId: string): MailboxEntry[] {
    if (this.host.isDeliverySuppressed(sessionId)) return []
    return this.mailbox.takeAll(sessionId)
  }

  /** TeamMessenger.shutdownMember impl: forcefully stop a running teammate. */
  shutdownMember(args: { team: string; name: string }): DeliverResult {
    const sid = this.resolveMemberSessionId(args.team, args.name)
    if (!sid) {
      return {
        ok: false,
        reason:
          this.lostReason(args.team, args.name) ??
          `no member "${args.name}" in team "${args.team}"`,
      }
    }
    const abort = this.aborts.get(sid)
    if (!abort) {
      return { ok: false, reason: `"${args.name}" is not a running teammate` }
    }
    abort.abort()
    // If mid-turn, interrupt so the in-flight model call unwinds; the
    // idle-loop wait (if idle) is already resolved by the abort.
    const worker = this.host.getSessionWorker(sid)
    if (worker) {
      void worker.receiveFrame({
        type: 'worker.interrupt',
        sessionId: sid,
        payload: {},
      } as SessionWorkerInboundMessage)
    }
    return { ok: true }
  }

  /**
   * Tear down a teammate session: release its actor task + tagged tabs via
   * `fireSessionDeletedStop` (the same 'session_deleted' cascade the UI
   * delete uses), drop the worker, and notify list subscribers. The
   * teammate's transcript stays on disk (a record of what it did).
   */
  async teardown(sessionId: string): Promise<void> {
    const tm = this.teammates.get(sessionId)
    if (tm) {
      tm.status = 'stopped'
      // Recorded FIRST, before anything below can fail: from here on this id
      // was ended on purpose, whatever becomes of the marker write.
      this.retired.set(sessionId, {
        headSessionId: tm.spawnerSessionId,
        trust: tm.trust ?? 'untrusted',
      })
    }
    if (tm?.onCleanup) {
      try {
        await tm.onCleanup()
      } catch (err) {
        // A leaked worktree is recoverable; a teardown that throws here
        // would leave the session entry behind, which is not.
        this.host.tracer.event('nexus_teammate_cleanup_failed', {
          attrs: {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      }
    }
    this.aborts.delete(sessionId)
    const unread = this.mailbox.clear(sessionId)
    if (tm?.spawnerSessionId) {
      // Its final frames (a report, the notice below) are written after this
      // point, and may be the last traffic the lead's inbox ever gets: keep
      // it polled until they are read.
      this.drainingLeads.set(tm.spawnerSessionId, Date.now())
      this.reportUndelivered(tm, sessionId, unread)
    }
    // The marker is what keeps the tab a READ-ONLY transcript instead of a
    // session `worker.init` would boot afresh. Guarded: a storage failure here
    // must not skip the disposal below (a leaked worker, a stale teammate
    // entry, unrestored lead globals, unreleased tasks).
    let marked = false
    try {
      marked = (await this.host.markSessionShutdown?.(sessionId, Date.now())) === true
    } catch (err) {
      this.host.tracer.event('nexus_teammate_shutdown_mark_failed', {
        attrs: {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }
    // Unified disposal (fire C++ stop, clear ports, await dispose, delete).
    await this.host.disposeManagedSession(sessionId, { fireStop: true })
    // Re-asserted AFTER disposal: a late meta write from the live runtime could erase the first
    // marker; after `disposeManagedSession` nothing of the runtime can write again.
    if (marked) {
      try {
        marked = (await this.host.markSessionShutdown?.(sessionId, Date.now())) === true
      } catch (err) {
        this.host.tracer.event('nexus_teammate_shutdown_mark_failed', {
          attrs: {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      }
    }
    // AFTER disposal, BEFORE anything else touches the filesystem: the slot
    // this teammate installed now points at a transport that rejects.
    this.restoreLeadGlobals(tm)
    // Ordered after the restore on purpose — this writes through the fs.
    //
    // Not when a NAMESAKE is already running: `spawn` admits a new teammate
    // under this one's display name as soon as its status is `stopped` (set
    // at the top of this method), and a lead can Shutdown("Ada") then
    // SpawnTeammate("Ada") in the same turn. Tasks are owned by NAME, so the
    // release here would take the new Ada's claims off a live teammate — the
    // guard `reconcileLost` already applies to a recovered marker.
    if (!this.hasLiveNamesake(tm)) await this.releaseTasksOf(tm)
    this.teammates.delete(sessionId)
    // Marked → the persisted session stays listed as a read-only tab. Not
    // marked (no meta yet, or the write failed) → there is nothing durable
    // that says "do not boot this", so remove the tab rather than leave one
    // whose click would start a fresh, uncoordinated runtime.
    if (marked) this.host.notifySessionUpserted(sessionId)
    else this.host.broadcastSessionRemoved(sessionId)
  }

  /**
   * Reinstall the LEAD's process-global runtime singletons (its own captured snapshot) after a
   * teammate in the same realm is disposed. Security: this cannot widen a surviving untrusted teammate's
   * boundary; that check reads the teammate's own session options, and the fs can only add a denial.
   */
  private restoreLeadGlobals(tm: TeammateEntry | undefined): void {
    const lead = tm?.leadGlobals
    if (!lead) return
    installProcessFs(lead.fs)
    if (lead.conversationStore) setConversationStore(lead.conversationStore)
    setActiveSidechainStore(lead.sidechainStore)
  }

  /**
   * Return a departing teammate's unfinished claimed tasks to `pending` with the owner cleared to `''`
   * (not `undefined`, which JSON drops). Completed rows and others' claims are untouched.
   */
  private async releaseTasksOf(tm: TeammateEntry | undefined): Promise<void> {
    if (!tm) return
    const registry = getTeamRegistry()
    if (!registry || !registry.getTeam(tm.teamName)) return
    // Both spellings: the lead assigns by DISPLAY name, and a name with no
    // ASCII of its own claims under its derived member key.
    const mine = new Set([tm.name, tm.key].filter(Boolean))
    for (const task of registry.listTasks(tm.teamName)) {
      if (!task.owner || !mine.has(task.owner)) continue
      if (task.status === 'completed') continue
      try {
        await registry.updateTask(tm.teamName, task.id, {
          owner: '',
          status: 'pending',
        })
      } catch (err) {
        // A stale row is a worse outcome than a noisy log, but not worth
        // failing a teardown over.
        this.host.tracer.event('nexus_teammate_task_release_failed', {
          attrs: {
            sessionId: tm.key,
            task: task.id,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      }
    }
  }

  /**
   * Whether another RUNNING teammate of the same lead answers to this one's
   * display name or member key — the successor spawned under its name while
   * its teardown was still in flight (see `teardown`).
   */
  private hasLiveNamesake(tm: TeammateEntry | undefined): boolean {
    if (!tm) return false
    for (const other of this.teammates.values()) {
      if (other === tm || other.status === 'stopped') continue
      if (other.spawnerSessionId !== tm.spawnerSessionId) continue
      if (other.name === tm.name || other.key === tm.key) return true
    }
    return false
  }

  /**
   * Whether this coordinator ended `sessionId` itself — as opposed to a
   * teammate that simply is not here, which after a restart is every one
   * the lead had. The per-tab init gate asks before it writes `lost` onto an
   * unmarked teammate: a deliberate teardown whose marker write failed was
   * otherwise re-marked as lost, and its lead told it was lost to a restart.
   */
  wasTornDown(sessionId: string): boolean {
    return this.retired.has(sessionId)
  }

  /**
   * Drop everything remembered about a lead that is being DELETED: its drain
   * entry, its lost teammates, and the trust of the teammates it retired.
   * None of it is reachable once the session is gone — `reconcileLost` runs
   * for a lead that binds, and a deleted one never does — and none of it was
   * ever pruned, so it grew per lead for the realm's life.
   */
  forgetLead(headSessionId: string): void {
    this.drainingLeads.delete(headSessionId)
    this.lost.delete(headSessionId)
    for (const [sid, gone] of this.retired) {
      if (gone.headSessionId === headSessionId) this.retired.delete(sid)
    }
  }

  /**
   * Cascade a lead's deletion: abort every teammate and interrupt its worker, resolving once every
   * affected teammate's TEARDOWN has settled (not when the aborts fired).
   */
  async abortTeammatesOf(spawnerSessionId: string): Promise<void> {
    const settling: Promise<void>[] = []
    for (const [tid, tm] of [...this.teammates]) {
      if (tm.spawnerSessionId === spawnerSessionId) {
        this.aborts.get(tid)?.abort()
        const worker = this.host.getSessionWorker(tid)
        if (worker) {
          void worker.receiveFrame({
            type: 'worker.interrupt',
            sessionId: tid,
            payload: {},
          } as SessionWorkerInboundMessage)
        }
        const loop = this.loops.get(tid)
        if (loop) settling.push(loop)
      }
    }
    if (settling.length === 0) return
    // Bounded: a child whose worker never settles its interrupted turn must
    // not pin the lead's delete forever — past the cap the delete proceeds
    // as it always did (best-effort), instead of hanging the UI.
    let timer: ReturnType<typeof setTimeout> | undefined
    const capped = new Promise<void>(resolve => {
      timer = setTimeout(resolve, TEAMMATE_TEARDOWN_WAIT_MS)
    })
    try {
      await Promise.race([Promise.all(settling).then(() => undefined), capped])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * Cascade a Stop on the lead: interrupt every in-flight teammate turn WITHOUT shutting teammates down;
   * the abort controller is left alone, so each parks on its mailbox.
   */
  interruptTeammatesOf(spawnerSessionId: string): void {
    for (const [tid, tm] of [...this.teammates]) {
      if (tm.spawnerSessionId !== spawnerSessionId || tm.status !== 'active') {
        continue
      }
      tm.interruptRequested = true
      const worker = this.host.getSessionWorker(tid)
      if (worker) {
        void worker.receiveFrame({
          type: 'worker.interrupt',
          sessionId: tid,
          payload: {},
        } as SessionWorkerInboundMessage)
      }
    }
  }

  /** Status of every teammate on record, any lead (restart readiness). */
  teammateStatuses(): Array<TeammateEntry['status']> {
    return [...this.teammates.values()].map(tm => tm.status)
  }

  /**
   * The roster a lead's `AgentList` shows: every teammate it spawned and has
   * not torn down, newest last. `stopped` entries are gone from the map by
   * then (`teardown` deletes them), so the statuses seen here are `active`
   * and `idle`.
   */
  listTeammatesOf(spawnerSessionId: string): TeammateRosterEntry[] {
    const out: TeammateRosterEntry[] = []
    for (const [sid, tm] of this.teammates) {
      if (tm.spawnerSessionId !== spawnerSessionId) continue
      out.push({
        sessionId: sid,
        name: tm.name,
        status: tm.status,
        startedAt: tm.startedAt,
      })
    }
    for (const gone of this.lost.get(spawnerSessionId) ?? []) {
      out.push({
        sessionId: gone.sessionId,
        name: gone.name,
        status: 'lost',
        startedAt: gone.lostAt,
      })
    }
    return out.sort((a, b) => a.startedAt - b.startedAt)
  }

  /**
   * A bound lead's teammates on record that are not running (lost to a restart): mark each shutdown with
   * `lostAt`, hand back its tasks and remember it for `AgentList` / `SendMessage` / `Shutdown`. A
   * `shutdown` child with `lostAt` is recovered again; one without was ended on purpose. Returns the
   * display names it settled.
   */
  async reconcileLost(
    headSessionId: string,
    children: ReadonlyArray<{
      sessionId: string
      teammateName?: string
      shutdown: boolean
      lostAt?: number
    }>,
  ): Promise<string[]> {
    const teamName = implicitTeamIdFor(headSessionId)
    const known = new Set((this.lost.get(headSessionId) ?? []).map(l => l.sessionId))
    // Names a RUNNING teammate of this lead answers to. A recovered marker is
    // historical: releasing "worker-a"'s tasks when a NEW worker-a already
    // holds them would take the work off a live teammate.
    const live = new Set<string>()
    for (const tm of this.teammates.values()) {
      if (tm.spawnerSessionId !== headSessionId) continue
      live.add(tm.name)
      live.add(tm.key)
    }
    // The newest spawn per member key among this lead's children: a marker
    // recovered from an earlier restart is superseded by any later namesake
    // (see `spawn`), whatever became of that one.
    const newestSpawn = new Map<string, number>()
    for (const child of children) {
      const key = memberKeyFromTeammateId(child.sessionId, teamName)
      const at = teammateSpawnTimeFromId(child.sessionId)
      if (key && at !== null && at > (newestSpawn.get(key) ?? -1)) newestSpawn.set(key, at)
    }
    /** Lost now — nothing on disk says so yet. */
    const found: LostTeammate[] = []
    /** Lost on an earlier restart; only the REASON has to come back. */
    const recovered: LostTeammate[] = []
    for (const child of children) {
      if (this.teammates.has(child.sessionId)) continue
      if (known.has(child.sessionId)) continue
      if (this.host.getSessionWorker(child.sessionId)) continue
      // Marked shutdown with no `lostAt` = its lead ended it on purpose.
      if (child.shutdown && typeof child.lostAt !== 'number') continue
      const key = memberKeyFromTeammateId(child.sessionId, teamName)
      if (!key) continue
      if (
        child.shutdown &&
        (newestSpawn.get(key) ?? -1) > (teammateSpawnTimeFromId(child.sessionId) ?? -1)
      ) {
        continue
      }
      const entry: LostTeammate = {
        sessionId: child.sessionId,
        teamName,
        name: child.teammateName || key,
        key,
        // Keep a recovered one's ORIGINAL loss time: the roster sorts by it,
        // and re-stamping it would reorder the strip on every restart.
        lostAt: child.lostAt ?? Date.now(),
      }
      if (child.shutdown) recovered.push(entry)
      else found.push(entry)
    }
    const settled = [...found, ...recovered]
    if (settled.length === 0) return []
    this.lost.set(headSessionId, [
      ...(this.lost.get(headSessionId) ?? []),
      ...settled,
    ])
    for (const gone of found) {
      try {
        if (
          await this.host.markSessionShutdown?.(gone.sessionId, gone.lostAt, {
            lost: true,
          })
        ) {
          this.host.notifySessionUpserted(gone.sessionId)
        }
      } catch (err) {
        this.host.tracer.event('nexus_teammate_shutdown_mark_failed', {
          attrs: {
            sessionId: gone.sessionId,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      }
    }
    for (const gone of settled) {
      if (live.has(gone.name) || live.has(gone.key)) continue
      // Idempotent (a second pass finds no task under that owner), and it is
      // the ONLY release a teammate the per-tab gate marked ever gets: that
      // path writes the marker and disposes nothing, so its tasks would
      // otherwise sit `in_progress` under a dead owner for good.
      await this.releaseTasksOf({
        teamName: gone.teamName,
        name: gone.name,
        key: gone.key,
        spawnerSessionId: headSessionId,
        status: 'stopped',
        startedAt: gone.lostAt,
      })
    }
    this.host.tracer.event('nexus_teammates_lost_to_restart', {
      attrs: {
        headSessionId,
        count: found.length,
        recovered: recovered.length,
      },
    })
    return settled.map(g => g.name)
  }

  /** The reason to give for an address that names a lost teammate. */
  private lostReason(team: string, memberName: string): string | null {
    for (const list of this.lost.values()) {
      const gone = list.find(
        l => l.teamName === team && (l.name === memberName || l.key === memberName),
      )
      if (gone) {
        return (
          `"${gone.name}" is no longer running: it was lost when the app restarted ` +
          `(teammates do not survive a restart — this is not a provider failure). ` +
          `Its transcript is kept read-only and its tasks were released; spawn a new teammate to continue.`
        )
      }
    }
    return null
  }

  /**
   * Drain one queued teammate→lead message at the lead's turn boundary.
   * Only fires for an actual team lead (a team's `headSessionId`), and only
   * when the session isn't mid-stream (user/agent wins an in-flight turn;
   * the message stays queued for the next boundary). A drained message
   * reaches the lead as a new conversation turn.
   */
  maybeDrainLeadInbox(sessionId: string): void {
    if (!this.mailbox.hasPending(sessionId)) return
    // The idle transition that FOLLOWS a Stop is still part of the stop: it
    // must not flush a queued report into a new turn (see `deliverFrames`).
    if (this.host.isDeliverySuppressed(sessionId)) return
    // A question parked on the user is not a boundary to deliver at.
    if (this.host.sessionNeedsAnswer?.(sessionId)) return
    const reg = getTeamRegistry()
    const isLead =
      reg?.listTeams().some((t) => t.headSessionId === sessionId) ?? false
    if (!isLead) return
    const worker = this.host.getSessionWorker(sessionId)
    if (!worker || worker.isBusy()) return
    const prompt = this.mailbox.takePending(sessionId)
    if (prompt === null) return
    // Through the submit queue (mailbox priority) so it serializes with user
    // input + sub-agent deliveries rather than racing them for the worker.
    this.host.enqueueMailboxTurn(sessionId, prompt)
  }

  // --- Lifecycle ---

  dispose(): void {
    this.poller?.stop()
    this.poller = null
    this.store = null
    for (const abort of this.aborts.values()) {
      abort.abort()
    }
    this.aborts.clear()
    this.loops.clear()
    this.teammates.clear()
  }
}

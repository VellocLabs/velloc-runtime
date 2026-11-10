import type {
  AgentRuntimeWorkerSnapshot,
  InjectMessageView,
} from '../worker/workerProtocol'
import type { Message } from '../../runtime/RuntimeTypes'
import { randomUuid } from '../../utils/randomUuid'
import { joinPassagePrompts } from './capturedPassages'
import type {
  BrowserRuntimeClientState,
  InjectBubble,
  InjectRemoveResult,
  InjectRestoreDraft,
} from './browserRuntimeClientState'
import type {
  BrowserWorkerClientInboundMessage,
  BrowserWorkerClientTransport,
} from './sharedWorkerTransport'

/** What the parked-input tracker reads and writes on its client: the state
 *  (replaced whole, never mutated), the live transport, and whether this page
 *  asked for the interrupt in flight. */
export interface ParkedInputHost {
  state: BrowserRuntimeClientState
  readonly transport: BrowserWorkerClientTransport | null
  readonly interruptRequested: boolean
  emitState(): void
}

/** The worker messages that change parked input. */
export type ParkedInputMessage = Extract<
  BrowserWorkerClientInboundMessage,
  {
    type:
      | 'worker.pendingMessageUpdated'
      | 'worker.injectMessagesUpdated'
      | 'worker.injectMessagesLanded'
      | 'worker.injectMessageRemoved'
      | 'worker.injectMessagesCleared'
      | 'worker.pendingMessageCleared'
  }
>

/**
 * Contract: a session client's parked mid-turn input — the inject bubbles
 * (plain-Enter sends during a running turn) and the "next message" strip.
 * Owns the pending remove requests, the attachment drafts this page sent and
 * the re-arm anchor; the state itself stays on the client, read and replaced
 * through the host, which emits after every change.
 */
export class RuntimeClientParkedInput {
  constructor(private readonly host: ParkedInputHost) {}

  /** Pending `removeInjectMessage` replies, keyed by requestId. */
  private readonly injectRemoveWaiters = new Map<
    string,
    (result: InjectRemoveResult) => void
  >()
  /** Attachment-carrying inject messages this page sent, by bubble uuid —
   *  kept while their bubble is shown (`pruneInjectDrafts`). */
  readonly injectDrafts = new Map<string, InjectRestoreDraft>()
  /** The turn uuid the last re-arm (strip consume or inject landing) armed. */
  private injectRearmTurnUuid: string | null = null

  /**
   * Remove one parked inject message (its × in the conversation). Hidden at
   * once; resolves with the worker's verdict. `ok:true` carries the text the
   * caller hands back to the composer; `ok:false` means it already landed or
   * another window removed it first — the caller must NOT restore it.
   */
  removeInjectMessage(uuid: string): Promise<InjectRemoveResult> {
    const requestId = randomUuid()
    this.setInjectBubbles(
      (this.host.state.injectBubbles ?? []).map(bubble =>
        bubble.uuid === uuid ? { ...bubble, removing: true } : bubble,
      ),
    )
    const result = new Promise<InjectRemoveResult>(resolve => {
      this.injectRemoveWaiters.set(requestId, resolve)
    })
    void this.host.transport?.postMessage({
      type: 'worker.removeInjectMessage',
      payload: { uuid, requestId },
    })
    return result
  }

  private setInjectBubbles(next: InjectBubble[]): void {
    this.host.state = { ...this.host.state, injectBubbles: next }
    this.host.emitState()
  }

  /** Replace the pending half of the bubble list with the worker's list;
   *  landed bubbles and not-yet-confirmed optimistic ones are kept. */
  private reconcileInjectEntries(entries: readonly InjectMessageView[]): InjectBubble[] {
    const byUuid = new Map(entries.map(entry => [entry.uuid, entry]))
    const current = this.host.state.injectBubbles ?? []
    const next: InjectBubble[] = []
    const seen = new Set<string>()
    for (const bubble of current) {
      const entry = byUuid.get(bubble.uuid)
      if (entry) {
        next.push({
          ...bubble,
          text: entry.text,
          hasAttachments: entry.hasAttachments,
          state: 'pending',
          optimistic: false,
        })
        seen.add(bubble.uuid)
        continue
      }
      if (bubble.state === 'landed' || bubble.optimistic) {
        next.push(bubble)
      }
    }
    for (const entry of entries) {
      if (seen.has(entry.uuid)) continue
      next.push({
        uuid: entry.uuid,
        text: entry.text,
        hasAttachments: entry.hasAttachments,
        state: 'pending',
      })
    }
    return next
  }

  /** Bubbles whose message the transcript now carries — as the persisted
   *  user message (its own uuid or the merged turn's) or as a mid-turn
   *  `queued_command` attachment — are no longer needed. */
  pruneInjectBubbles(
    bubbles: readonly InjectBubble[],
    transcript: readonly Message[],
  ): InjectBubble[] {
    if (bubbles.length === 0) return bubbles as InjectBubble[]
    const ids = new Set<string>()
    for (const message of transcript) {
      const record = message as { uuid?: string; type?: string; attachment?: { source_uuid?: unknown } }
      if (typeof record.uuid === 'string') ids.add(record.uuid)
      const source = record.attachment?.source_uuid
      if (record.type === 'attachment' && typeof source === 'string') ids.add(source)
    }
    return bubbles.filter(
      bubble =>
        !ids.has(bubble.uuid) &&
        !(bubble.turnUuid !== undefined && ids.has(bubble.turnUuid)),
    )
  }

  /**
   * Optimistically clear the saved "next message": hide the strip now, ignore stale
   * `pendingMessageUpdated` events while the clear is in flight, then ask the manager to drop
   * the text. Composer-text restore is the strip's own (UI-local) job.
   */
  clearPendingMessage(): void {
    this.host.state = {
      ...this.host.state,
      pendingMessage: null,
      pendingMessageEntries: null,
      pendingClearInFlight: true,
    }
    this.host.emitState()
    void this.host.transport?.postMessage({ type: 'worker.clearPendingMessage' })
  }

  /**
   * Re-arm the optimistic user bubble for a turn the worker built from parked
   * input (a consumed next message, or inject messages merged into the next
   * turn). Its user message is persisted but never streamed back, and the
   * transcript isn't refetched until the turn ends.
   */
  private rearmPendingPrompt(
    text: string,
    promptUuid: string | null,
  ): Partial<BrowserRuntimeClientState> {
    // Any re-arm (a consumed strip batch OR an inject next-turn landing) is
    // what a later landing from the same consume must not displace.
    this.injectRearmTurnUuid = promptUuid
    return {
      pendingPrompt: text,
      pendingPromptId: promptUuid,
      // The finished turn's own optimistic bubble may still be the
      // only render of ITS user message (same reconcile gap) —
      // promote it to the pre-split slot instead of overwriting it,
      // so the thread transition is a pure append. Dropping it here
      // blanked the previous user message until the reconcile AND
      // reshaped every message index, which could crash the thread
      // mid-render (see `preSplitPrompt` in the state type).
      preSplitPrompt: this.host.state.pendingPrompt,
      preSplitPromptId: this.host.state.pendingPromptId,
      // Everything in `liveEvents` right now belongs to the turn(s)
      // that just FINISHED (the consume fires at their boundary) —
      // their transcript reconcile may not have landed yet, so they
      // must keep rendering, but BEFORE the re-armed bubble. Record
      // the split; the combine layer renders pre-split events ahead
      // of the bubble so the picked-up message never jumps above
      // the tool block it followed.
      liveEventsTurnStart: this.host.state.liveEvents.length,
    }
  }

  /** True while the bubble armed by a re-arm (a consumed strip batch or an
   *  inject next-turn landing) still stands for a turn that has not streamed
   *  anything yet — a later landing from the same consume (a send that became
   *  its own later turn) must not displace it. */
  private injectRearmActive(): boolean {
    return (
      this.injectRearmTurnUuid !== null &&
      this.host.state.pendingPromptId === this.injectRearmTurnUuid &&
      this.host.state.liveEvents.length === (this.host.state.liveEventsTurnStart ?? 0)
    )
  }

  /**
   * Parked mid-turn input is runtime state carried by every snapshot: a page
   * that attached (or reloaded) after it was parked restores the pending
   * bubbles and the next-message strip from here instead of showing nothing
   * until the next change event.
   */
  restoreParkedInputFromSnapshot(
    snapshot: AgentRuntimeWorkerSnapshot,
  ): Partial<BrowserRuntimeClientState> {
    const patch: Partial<BrowserRuntimeClientState> = {}
    if (snapshot.injectMessages) {
      const next = this.reconcileInjectEntries(snapshot.injectMessages)
      const current = this.host.state.injectBubbles ?? []
      const same =
        next.length === current.length &&
        next.every((bubble, i) => {
          const other = current[i]!
          return other.uuid === bubble.uuid && other.state === bubble.state &&
            other.text === bubble.text && other.optimistic === bubble.optimistic
        })
      if (!same) patch.injectBubbles = next
    }
    if (
      snapshot.nextMessages &&
      snapshot.nextMessages.length > 0 &&
      !this.host.state.pendingMessage &&
      !this.host.state.pendingClearInFlight
    ) {
      patch.pendingMessage = joinPassagePrompts(snapshot.nextMessages)
      patch.pendingMessageEntries = [...snapshot.nextMessages]
    }
    return patch
  }

  /** Apply one parked-input worker message to the client's state. */
  handleMessage(message: ParkedInputMessage): void {
    switch (message.type) {
      // Manager-sourced "next message" feed. The pending text always arrives
      // in FULL (never a delta) — render it verbatim.
      case 'worker.pendingMessageUpdated': {
        // Ignore stale updates while a clear is in flight: the manager may have
        // already queued an append before it processes our clear request, and
        // replaying it would re-flash the strip the user just dismissed.
        if (this.host.state.pendingClearInFlight) return
        const { promptUuids, consumed } = message.payload
        // The worker is authoritative about whether a submit started a turn or
        // was parked. `submitInput` guesses from `snapshot.isBusy`, which lags
        // the worker by a postMessage — when it guessed wrong we are showing an
        // optimistic bubble for a message the worker actually parked, and the
        // same text renders twice (bubble + strip) for the rest of the turn.
        // The worker names the parked uuids, so retract the bubble here.
        const bubbleWasParked =
          this.host.state.pendingPromptId !== null &&
          promptUuids?.includes(this.host.state.pendingPromptId) === true
        // Same for a plain-Enter bubble the worker routed to the strip (a
        // slash command it recognised, or an older worker without the inject
        // queue): the strip is then its only surface.
        const injectBubbles = (this.host.state.injectBubbles ?? []).filter(
          bubble => !(bubble.optimistic && promptUuids?.includes(bubble.uuid) === true),
        )
        // A consumed batch becomes a persisted but never-streamed turn: re-arm the optimistic
        // bubble with its uuid, unless the transcript already carries it (nothing would clear it).
        const rearm =
          consumed?.text != null &&
          consumed.text.length > 0 &&
          !(
            consumed.promptUuid != null &&
            this.host.state.transcriptMessages.some(
              m => (m as { uuid?: string }).uuid === consumed.promptUuid,
            )
          )
        this.host.state = {
          ...this.host.state,
          injectBubbles,
          pendingMessage: message.payload.text ? message.payload.text : null,
          // Kept in lockstep with the text: a `consumed` event carries neither,
          // and it is the text going empty that hides the strip.
          pendingMessageEntries: message.payload.text
            ? (message.payload.entries ?? null)
            : null,
          ...(rearm
            ? this.rearmPendingPrompt(consumed!.text, consumed!.promptUuid ?? null)
            : bubbleWasParked
              ? { pendingPrompt: null, pendingPromptId: null }
              : {}),
        }
        this.host.emitState()
        return
      }

      case 'worker.injectMessagesUpdated': {
        const injectBubbles = this.reconcileInjectEntries(message.payload.entries)
        // `submitInput` guessed idle and armed the optimistic user bubble, but
        // the worker parked the submit: the pending bubble is now its only
        // surface (same as `bubbleWasParked` for the strip).
        const parkedPrompt =
          this.host.state.pendingPromptId !== null &&
          message.payload.entries.some(entry => entry.uuid === this.host.state.pendingPromptId)
        this.host.state = {
          ...this.host.state,
          injectBubbles,
          ...(parkedPrompt ? { pendingPrompt: null, pendingPromptId: null } : {}),
        }
        this.host.emitState()
        return
      }

      case 'worker.injectMessagesLanded': {
        const { uuids, via, turnUuid, text } = message.payload
        const landedSet = new Set(uuids)
        let bubbles = (this.host.state.injectBubbles ?? []).map(bubble =>
          landedSet.has(bubble.uuid)
            ? {
                ...bubble,
                state: 'landed' as const,
                landedVia: via,
                optimistic: false,
                removing: false,
                ...(turnUuid !== undefined ? { turnUuid } : {}),
              }
            : bubble,
        )
        let rearm: Partial<BrowserRuntimeClientState> = {}
        if (via === 'nextturn' && turnUuid !== undefined && text) {
          const persisted = this.host.state.transcriptMessages.some(
            m => (m as { uuid?: string }).uuid === turnUuid,
          )
          if (this.host.state.pendingPromptId === turnUuid) {
            // The strip's `consumed` already armed this turn's bubble (a
            // merged Enter + Ctrl+Enter batch): show the whole merged text and
            // let that one bubble stand for all of them.
            rearm = { pendingPrompt: text }
            bubbles = bubbles.filter(bubble => !landedSet.has(bubble.uuid))
          } else if (!persisted && !this.injectRearmActive()) {
            // Inject-only next turn: arm the optimistic user bubble exactly
            // like a consumed next message (stable anchor for the new turn's
            // live assistant ids).
            rearm = this.rearmPendingPrompt(text, turnUuid)
            bubbles = bubbles.filter(bubble => !landedSet.has(bubble.uuid))
          }
        }
        this.host.state = { ...this.host.state, ...rearm, injectBubbles: bubbles }
        this.host.emitState()
        return
      }

      case 'worker.injectMessageRemoved': {
        const { uuid, requestId, ok, text } = message.payload
        const waiter = this.injectRemoveWaiters.get(requestId)
        // Read before the bubble goes (pruning drops the draft with it).
        const draft = this.injectDrafts.get(uuid)
        if (ok) {
          this.setInjectBubbles(
            (this.host.state.injectBubbles ?? []).filter(bubble => bubble.uuid !== uuid),
          )
        } else if (waiter) {
          this.setInjectBubbles(
            (this.host.state.injectBubbles ?? []).map(bubble =>
              bubble.uuid === uuid ? { ...bubble, removing: false } : bubble,
            ),
          )
        }
        if (waiter) {
          this.injectRemoveWaiters.delete(requestId)
          waiter(
            !ok
              ? { ok }
              : draft
                ? { ok, text: draft.text, files: draft.files }
                : { ok, ...(text !== undefined ? { text } : {}) },
          )
        }
        return
      }

      case 'worker.injectMessagesCleared': {
        const cleared = new Set(message.payload.entries.map(entry => entry.uuid))
        // This page's own attachment sends come back as typed (text + files),
        // not as the worker's display text (the file names).
        const drafts = message.payload.entries.map(entry =>
          this.injectDrafts.get(entry.uuid),
        )
        const restoreText = joinPassagePrompts(
          message.payload.entries
            .map((entry, index) => drafts[index]?.text ?? entry.text)
            .filter(text => text.length > 0),
        )
        const restoreFiles = drafts.flatMap(draft => draft?.files ?? [])
        this.host.state = {
          ...this.host.state,
          injectBubbles: (this.host.state.injectBubbles ?? []).filter(
            bubble => bubble.state === 'landed' || !cleared.has(bubble.uuid),
          ),
          ...(this.host.interruptRequested && (restoreText || restoreFiles.length > 0)
            ? {
                injectRestore: {
                  id: randomUuid(),
                  text: restoreText,
                  ...(restoreFiles.length > 0 ? { files: restoreFiles } : {}),
                },
              }
            : {}),
        }
        this.host.emitState()
        return
      }

      case 'worker.pendingMessageCleared': {
        this.host.state = {
          ...this.host.state,
          pendingMessage: null,
          pendingMessageEntries: null,
          pendingClearInFlight: false,
        }
        this.host.emitState()
        return
      }
    }
  }

  /** Drop the drafts whose bubble is gone (landed into the transcript,
   *  removed, cleared): nothing can hand them back any more. */
  pruneInjectDrafts(): void {
    const shown = new Set((this.host.state.injectBubbles ?? []).map(bubble => bubble.uuid))
    for (const uuid of [...this.injectDrafts.keys()]) {
      if (!shown.has(uuid)) this.injectDrafts.delete(uuid)
    }
  }
}

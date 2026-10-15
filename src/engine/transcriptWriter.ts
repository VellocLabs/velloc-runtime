/**
 * Everything that joins the conversation goes through here: each row passes
 * the extensions' `session.append` hook on its way in, the session's rows are
 * stored, and the stored form of a rewritten row is remembered so a request
 * is never built from the form the hook replaced.
 */
import type { Message } from '../runtime/RuntimeTypes'
import {
  drainWrites,
  isEphemeral,
  saveTranscriptRows,
} from '../sessions/sessionStore'
import type { SessionLedger } from './sessionLedger'

/** When set, every store is followed by a flush to disk (crash safety at
 *  the cost of a write per row). */
const EAGER_FLUSH_ENV = 'VELLOC_EAGER_FLUSH'

export class TranscriptWriter {
  /** A row as yielded → the form the append hook kept. */
  private readonly keptRows = new WeakMap<Message, Message>()

  constructor(private readonly ledger: SessionLedger) {}

  /** The rows as the append hook kept them; unchanged without a hook. */
  async appendRows(rows: readonly Message[]): Promise<Message[]> {
    const mods = this.ledger.config.mods
    if (rows.length === 0 || !mods?.hasSessionAppendHooks?.() || !mods.sessionAppend) return [...rows]
    const out: Message[] = []
    for (const row of rows) {
      const kept = (await mods.sessionAppend(row)) as Message
      if (kept !== row) this.keptRows.set(row, kept)
      out.push(kept)
    }
    return out
  }

  /** The stored form of a row the turn yielded. */
  keptRow(row: Message): Message {
    return this.keptRows.get(row) ?? row
  }

  /** Whether requests have to be built from stored forms at all. */
  rewritesRows(): boolean {
    return !!this.ledger.config.mods?.sessionAppend
  }

  /** Passes `rows` through the hook and adds them to the session's rows. */
  async admit(rows: readonly Message[]): Promise<Message[]> {
    const kept = await this.appendRows(rows)
    this.ledger.rows.push(...kept)
    return kept
  }

  /** Stores the session's rows (the store skips rows it already holds). */
  async persist(): Promise<void> {
    const store = this.ledger.config.conversationStore
    if (isEphemeral(store)) return
    await saveTranscriptRows(this.ledger.rows, store)
    if (this.ledger.config.runtimeConfig.flagOn(EAGER_FLUSH_ENV)) {
      await drainWrites(store)
    }
  }

  /** Admits and stores the rows a turn yielded so far, emptying `pending`. */
  async flush(pending: Message[]): Promise<void> {
    if (pending.length === 0) return
    this.ledger.rows.push(...(await this.appendRows(pending.splice(0))))
    await this.persist()
  }
}

/**
 * Durable mailbox: frames appended one JSON line each to
 * `{leadSessionDir}/team/mailbox/{memberKey}/inbox.jsonl`, with `cursor.json`
 * as the served position. A single host append per frame needs no lock.
 */
import type { BrowserBridgeTransport } from '../browser/bridge/protocol/core'
import { createBridgeRoute } from '../browser/bridge/protocol/core'
import {
  getMemberCursorPath,
  getMemberInboxPath,
  getMemberMailboxDirectoryPath,
} from './teamPaths'
import type { MailboxCursor, TeamMessageFrame } from './teamTypes'

const TEXT_ENCODER = new TextEncoder()
const TEXT_DECODER = new TextDecoder()

/** The caller supplies everything except the fields the store owns. */
export type AppendableFrame = Omit<TeamMessageFrame, 'v' | 'id' | 'seq' | 'ts'>

function isFrame(value: unknown): value is TeamMessageFrame {
  if (!value || typeof value !== 'object') return false
  const f = value as Partial<TeamMessageFrame>
  return (
    f.v === 1 &&
    typeof f.seq === 'number' &&
    typeof f.body === 'string' &&
    typeof f.from?.name === 'string' &&
    typeof f.to?.name === 'string'
  )
}

/** Every frame in an inbox file with `seq > afterSeq`. A corrupt line is
 *  SKIPPED, never fatal: one torn write must not wedge a mailbox forever. */
function parseFrames(text: string, afterSeq: number): TeamMessageFrame[] {
  if (!text) return []
  const out: TeamMessageFrame[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (isFrame(parsed) && parsed.seq > afterSeq) out.push(parsed)
    } catch {
      // torn or foreign line — skip it
    }
  }
  return out
}

/** The host reports a missing file as an ENOENT-style error; anything else
 *  is a read that FAILED (`BridgeFsSessionStorage` draws the same line). */
function isMissingFileError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /ENOENT|not[ _]found|no such file/i.test(message)
}

export class TeamMailboxStore {
  /** Next `seq` per inbox path. Seeded from the file the first time an inbox
   *  is written, so a restart continues the sequence instead of restarting
   *  it (which would make every old frame look undelivered). */
  private readonly nextSeq = new Map<string, number>()
  /** Inbox dirs already `mkdir`ed this session. */
  private readonly ensuredDirs = new Set<string>()
  /** In-flight append chain per inbox path. Appends to ONE inbox are
   *  serialized on it — see `append`. */
  private readonly appendChains = new Map<string, Promise<unknown>>()

  constructor(
    private readonly opts: {
      /**
       * Resolved PER REQUEST. The direct bridge transport is replaced on every
       * `bridge.setPort` (each page boot disposes the old one), so a store
       * that captured it once failed every call with `transport_disposed`
       * after the first reload while a team was live. Null while the bridge
       * has no port: the request fails and the caller's in-memory fallback
       * applies.
       */
      getTransport?: () => BrowserBridgeTransport | null
      /** A fixed transport (tests, single-boot callers). `getTransport`
       *  wins when both are given. */
      transport?: BrowserBridgeTransport
      createRequestId: () => string
    },
  ) {}

  /**
   * Append one frame to a member's inbox, assigning `v`/`id`/`seq`/`ts`.
   * Returns the frame as written (the caller may want its `seq`).
   */
  async append(
    leadSessionDir: string,
    frame: AppendableFrame,
  ): Promise<TeamMessageFrame> {
    const memberKey = frame.to.name
    const path = getMemberInboxPath(leadSessionDir, memberKey)
    // Serialized per inbox. `seq` is allocated before an awaited write, so two
    // concurrent appends could otherwise write their LINES in the opposite
    // order to their numbers — and the reader's cursor only moves forward, so
    // a pass that saw seq 2 first would set the cursor past the seq 1 line
    // that landed a moment later and skip it for good. Two `SendMessage`
    // calls in the same turn were enough to lose one silently.
    const chain = (this.appendChains.get(path) ?? Promise.resolve()).then(
      () => this.appendLocked(leadSessionDir, memberKey, path, frame),
      () => this.appendLocked(leadSessionDir, memberKey, path, frame),
    )
    // Keep the chain alive past a rejection so one failed write does not wedge
    // the inbox; the rejection is still delivered to THIS caller.
    this.appendChains.set(
      path,
      chain.catch(() => undefined),
    )
    return chain
  }

  /** One append, with the inbox's chain already held. */
  private async appendLocked(
    leadSessionDir: string,
    memberKey: string,
    path: string,
    frame: AppendableFrame,
  ): Promise<TeamMessageFrame> {
    await this.ensureDir(leadSessionDir, memberKey)
    const seq = await this.allocateSeq(leadSessionDir, memberKey, path)
    const full: TeamMessageFrame = {
      v: 1,
      id: globalThis.crypto?.randomUUID?.() ?? `frame-${Date.now()}-${seq}`,
      seq,
      ts: Date.now(),
      ...frame,
    }
    await this.send(createBridgeRoute('fs', 'appendFile'), {
      path,
      data: TEXT_ENCODER.encode(`${JSON.stringify(full)}\n`),
    })
    return full
  }

  /**
   * Every frame with `seq > afterSeq`. A corrupt line is SKIPPED, never
   * fatal: one torn write must not wedge a mailbox forever.
   */
  async readAfter(
    leadSessionDir: string,
    memberKey: string,
    afterSeq: number,
  ): Promise<TeamMessageFrame[]> {
    const text = await this.readTextOrEmpty(
      getMemberInboxPath(leadSessionDir, memberKey),
    )
    return parseFrames(text, afterSeq)
  }

  /** The recipient's delivery position; a missing/corrupt cursor reads as 0
   *  (which re-delivers the whole inbox — safe on a fresh mailbox, and the
   *  only answer that cannot silently swallow mail). */
  async readCursor(
    leadSessionDir: string,
    memberKey: string,
  ): Promise<MailboxCursor> {
    const text = await this.readTextOrEmpty(
      getMemberCursorPath(leadSessionDir, memberKey),
    )
    if (text) {
      try {
        const parsed = JSON.parse(text) as Partial<MailboxCursor>
        if (parsed.v === 1 && typeof parsed.deliveredSeq === 'number') {
          return { v: 1, deliveredSeq: parsed.deliveredSeq }
        }
      } catch {
        // fall through to the default
      }
    }
    return { v: 1, deliveredSeq: 0 }
  }

  /** Atomic (temp+replace on hosts that support it): a torn cursor would
   *  re-deliver, and re-delivery is the thing this file exists to prevent. */
  async writeCursor(
    leadSessionDir: string,
    memberKey: string,
    cursor: MailboxCursor,
  ): Promise<void> {
    await this.ensureDir(leadSessionDir, memberKey)
    await this.send(createBridgeRoute('fs', 'writeFile'), {
      path: getMemberCursorPath(leadSessionDir, memberKey),
      content: TEXT_ENCODER.encode(JSON.stringify(cursor)),
      atomic: true,
    })
  }

  private async allocateSeq(
    leadSessionDir: string,
    memberKey: string,
    path: string,
  ): Promise<number> {
    const known = this.nextSeq.get(path)
    if (known !== undefined) {
      this.nextSeq.set(path, known + 1)
      return known
    }
    // First write this process: continue from the file's last seq. A missing file
    // starts at 1; any other read failure fails the append and caches nothing.
    let text = ''
    try {
      text = await this.readText(path)
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
    const existing = parseFrames(text, 0)
    const highest = existing.reduce((max, f) => (f.seq > max ? f.seq : max), 0)
    this.nextSeq.set(path, highest + 2)
    return highest + 1
  }

  private async ensureDir(
    leadSessionDir: string,
    memberKey: string,
  ): Promise<void> {
    const dir = getMemberMailboxDirectoryPath(leadSessionDir, memberKey)
    if (this.ensuredDirs.has(dir)) return
    try {
      await this.send(createBridgeRoute('fs', 'mkdir'), { path: dir })
    } catch {
      // already exists
    }
    this.ensuredDirs.add(dir)
  }

  /** Read a file as text; a missing file (or any read failure) is ''. For the
   *  readers — a failed read is retried on the next pass, and a cursor that
   *  reads as 0 re-delivers rather than swallows. Not for `allocateSeq`. */
  private async readTextOrEmpty(path: string): Promise<string> {
    try {
      return await this.readText(path)
    } catch {
      return ''
    }
  }

  /** Read a file as text; a missing file and a failed read both THROW. */
  private async readText(path: string): Promise<string> {
    const bytes = await this.send<Uint8Array>(
      createBridgeRoute('fs', 'readFile'),
      { path },
    )
    return TEXT_DECODER.decode(bytes)
  }

  private async send<TResult>(
    route: ReturnType<typeof createBridgeRoute>,
    payload: unknown,
  ): Promise<TResult> {
    const transport = this.opts.getTransport
      ? this.opts.getTransport()
      : (this.opts.transport ?? null)
    if (!transport) {
      throw new Error('transport_unavailable: the bridge has no port')
    }
    const response = (await transport.request({
      id: this.opts.createRequestId(),
      route,
      payload,
    } as never)) as
      | { ok: true; result: TResult }
      | { ok: false; error: { code: string; message: string } }
    if (!response.ok) {
      throw new Error(`${response.error.code}: ${response.error.message}`)
    }
    return response.result
  }
}

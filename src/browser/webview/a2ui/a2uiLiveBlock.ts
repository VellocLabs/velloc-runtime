// The A2UI blocks the model is writing (F-1). Each body is read line by line as
// it streams, so its surface draws before the block is finished; when the stored
// copy of the block arrives, `finish` reads only what is left of it.

import { A2UI_CLOSE_TAG, blockSurfaceIds } from '@/toolkit/builtin/a2ui/express/a2uiBlocks'
import type { A2uiBlockStream } from '@/toolkit/builtin/a2ui/express/a2uiExpressCompiler'

export type A2uiLiveSnapshot = {
  /** The block's `a2uiBlockKey` as the chat draws it. */
  blockKey: string
  /** The surface the block draws, once known. */
  surfaceId: string | null
  /** The mention its card uses: a live key while open, `blockKey` once closed. */
  mentionKey: string
}

/** How the stored copy of a block relates to what streamed (`finish`). */
export type A2uiLiveFinish =
  /** It did not stream here: compile it as usual. */
  | { kind: 'not-streamed' }
  /** It streamed and is now complete and drawn: nothing more to apply. */
  | { kind: 'drawn' }
  /** It streamed but was rejected; `created` when the stream made its surface. */
  | { kind: 'failed'; created: boolean }

export type A2uiLiveBlocks = {
  /** A block changed; `closed` once its closing tag arrived. */
  feed(blockKey: string, body: string, closed: boolean): void
  /**
   * The stored block `body` for `surfaceId` arrived under `blockKey`: read
   * what is left of it, once. The streaming row's key can differ from the
   * stored one, so a block is also found by its surface and what it read.
   */
  finish(blockKey: string, surfaceId: string, body: string): A2uiLiveFinish
  snapshot(): A2uiLiveSnapshot | null
  subscribe(listener: () => void): () => void
}

export function liveMentionKey(blockKey: string): string {
  return `live:${blockKey}`
}

function messageSurfaceId(message: unknown): string | null {
  for (const value of Object.values((message ?? {}) as Record<string, unknown>)) {
    const id = (value as { surfaceId?: unknown } | null)?.surfaceId
    if (typeof id === 'string') return id
  }
  return null
}

type LiveBlock = {
  blockKey: string
  /** The complete lines read so far. */
  fed: string
  stream: A2uiBlockStream
  surfaceId: string | null
  closed: boolean
  failed: boolean
  created: boolean
}

// The text read so far, with a closing newline once the block is closed. The
// body is read up to its end, so the last statement draws without waiting for
// the next line: only a trailing fragment that could still turn into a closing
// tag or a fence is held back, since those are not Express and a half-read one
// cannot be taken back.
function readableText(body: string, closed: boolean): string {
  if (closed) return body.endsWith('\n') ? body : `${body}\n`
  const lineStart = body.lastIndexOf('\n') + 1
  const fragment = body.slice(lineStart).trimStart()
  if (fragment && (A2UI_CLOSE_TAG.startsWith(fragment) || '```'.startsWith(fragment))) return body.slice(0, lineStart)
  return body
}

export function createA2uiLiveBlocks(openStream: () => A2uiBlockStream): A2uiLiveBlocks {
  // Blocks that streamed here and whose stored copy has not arrived yet, oldest
  // first. A reply can hold several, and the next reply can start before the
  // last one is stored.
  const blocks: LiveBlock[] = []
  let snapshot: A2uiLiveSnapshot | null = null
  const listeners = new Set<() => void>()

  const publish = (next: A2uiLiveSnapshot) => {
    if (
      snapshot &&
      snapshot.blockKey === next.blockKey &&
      snapshot.surfaceId === next.surfaceId &&
      snapshot.mentionKey === next.mentionKey
    ) {
      return
    }
    snapshot = next
    for (const listener of listeners) listener()
  }

  const read = (block: LiveBlock, text: string) => {
    const result = block.stream.feed(text)
    if (!result.ok) block.failed = true
    for (const message of result.messages) {
      block.surfaceId ??= messageSurfaceId(message)
      if ('createSurface' in (message as object)) block.created = true
    }
  }

  return {
    feed(blockKey, body, closed) {
      let block = blocks.find(candidate => candidate.blockKey === blockKey)
      if (closed) {
        // Only a block that was streaming takes its finished key; a block
        // already finished when it was first drawn is the feeder's alone.
        if (!block || block.closed) return
        block.closed = true
        block.surfaceId ??= blockSurfaceIds(body).targets[0] ?? null
        if (snapshot?.blockKey === blockKey) publish({ blockKey, surfaceId: block.surfaceId, mentionKey: blockKey })
        return
      }
      const lines = readableText(body, false)
      if (block && !block.closed && !lines.startsWith(block.fed)) {
        // Text that shrank (a trailing fence stripped) adds nothing; text that
        // was rewritten starts the block over.
        if (block.fed.startsWith(lines)) return
        blocks.splice(blocks.indexOf(block), 1)
        block = undefined
      }
      if (!block || block.closed) {
        if (block) blocks.splice(blocks.indexOf(block), 1)
        block = { blockKey, fed: '', stream: openStream(), surfaceId: null, closed: false, failed: false, created: false }
        blocks.push(block)
      }
      const chunk = lines.slice(block.fed.length)
      block.fed = lines
      if (chunk) read(block, chunk)
      block.surfaceId ??= blockSurfaceIds(body).targets[0] ?? null
      publish({ blockKey, surfaceId: block.surfaceId, mentionKey: liveMentionKey(blockKey) })
    },
    finish(blockKey, surfaceId, body) {
      const full = readableText(body, true)
      const block =
        blocks.find(candidate => candidate.blockKey === blockKey && full.startsWith(candidate.fed)) ??
        blocks.find(candidate => candidate.surfaceId === surfaceId && full.startsWith(candidate.fed))
      if (!block) return { kind: 'not-streamed' }
      blocks.splice(blocks.indexOf(block), 1)
      const rest = full.slice(block.fed.length)
      block.fed = full
      if (rest && !block.failed) read(block, rest)
      if (!block.failed) {
        const result = block.stream.close()
        if (!result.ok) block.failed = true
        if (result.messages.some(message => 'createSurface' in (message as object))) block.created = true
      }
      return block.failed ? { kind: 'failed', created: block.created } : { kind: 'drawn' }
    },
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/**
 * The presentation with the streaming block's mention on top, until the
 * transcript catches up: once its own mention of that surface changes from
 * `baseMention` (what it held when the block started), the live entry goes.
 */
export function withLiveMention<T extends { latestMentionBySurface: ReadonlyMap<string, string>; deletedSurfaceIds: ReadonlySet<string> }>(
  derived: T,
  live: A2uiLiveSnapshot | null,
  baseMention: string | undefined,
): T {
  if (!live?.surfaceId) return derived
  const id = live.surfaceId
  if (derived.latestMentionBySurface.get(id) !== baseMention) return derived
  if (derived.latestMentionBySurface.get(id) === live.mentionKey) return derived
  const latestMentionBySurface = new Map(derived.latestMentionBySurface)
  latestMentionBySurface.set(id, live.mentionKey)
  const deletedSurfaceIds = new Set(derived.deletedSurfaceIds)
  deletedSurfaceIds.delete(id)
  return { ...derived, latestMentionBySurface, deletedSurfaceIds }
}

// The A2UI blocks the model is writing (F-1). Each body is read line by line as
// it streams, so its surface draws before the block is finished; the stored copy
// of the finished block completes it (`finish`) instead of being compiled again.

import { a2uiBlockKey, blockSurfaceIds } from '@/toolkit/builtin/a2ui/express/a2uiBlocks'
import type { A2uiBlockStream } from '@/toolkit/builtin/a2ui/express/a2uiExpressCompiler'

export type A2uiLiveSnapshot = {
  /** The reply segment holding the block: message, part and block index. */
  segmentKey: string
  /** The surface the block draws, once known. */
  surfaceId: string | null
  /** The mention its card uses: a live key while open, the block key once closed. */
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
  /** A block segment changed; `closed` once its closing tag arrived. */
  feed(segmentKey: string, body: string, closed: boolean): void
  /** The stored block `body` for `surfaceId` arrived: read what is left of it, once. */
  finish(surfaceId: string, body: string): A2uiLiveFinish
  snapshot(): A2uiLiveSnapshot | null
  subscribe(listener: () => void): () => void
}

export function liveMentionKey(segmentKey: string): string {
  return `live:${segmentKey}`
}

function messageSurfaceId(message: unknown): string | null {
  for (const value of Object.values((message ?? {}) as Record<string, unknown>)) {
    const id = (value as { surfaceId?: unknown } | null)?.surfaceId
    if (typeof id === 'string') return id
  }
  return null
}

type LiveBlock = {
  segmentKey: string
  /** The complete lines read so far. */
  fed: string
  stream: A2uiBlockStream
  surfaceId: string | null
  closed: boolean
  failed: boolean
  created: boolean
}

// Only complete lines are read: a statement, a fence or the closing tag can
// arrive split across chunks, and a half-read one cannot be taken back.
function completeLines(body: string, closed: boolean): string {
  if (closed) return body.endsWith('\n') ? body : `${body}\n`
  return body.slice(0, body.lastIndexOf('\n') + 1)
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
      snapshot.segmentKey === next.segmentKey &&
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
    feed(segmentKey, body, closed) {
      let block = blocks.find(candidate => candidate.segmentKey === segmentKey)
      if (closed) {
        // Only a block that was streaming takes its finished key; a block
        // already finished when it was first drawn is the feeder's alone.
        if (!block || block.closed) return
        block.closed = true
        block.surfaceId ??= blockSurfaceIds(body).targets[0] ?? null
        if (snapshot?.segmentKey === segmentKey) {
          const surfaceId = block.surfaceId
          publish({ segmentKey, surfaceId, mentionKey: surfaceId ? a2uiBlockKey(surfaceId, body) : liveMentionKey(segmentKey) })
        }
        return
      }
      const lines = completeLines(body, false)
      if (block && !block.closed && !lines.startsWith(block.fed)) {
        // Text that shrank (a trailing fence stripped) adds nothing; text that
        // was rewritten starts the block over.
        if (block.fed.startsWith(lines)) return
        blocks.splice(blocks.indexOf(block), 1)
        block = undefined
      }
      if (!block || block.closed) {
        if (block) blocks.splice(blocks.indexOf(block), 1)
        block = { segmentKey, fed: '', stream: openStream(), surfaceId: null, closed: false, failed: false, created: false }
        blocks.push(block)
      }
      const chunk = lines.slice(block.fed.length)
      block.fed = lines
      if (chunk) read(block, chunk)
      block.surfaceId ??= blockSurfaceIds(body).targets[0] ?? null
      publish({ segmentKey, surfaceId: block.surfaceId, mentionKey: liveMentionKey(segmentKey) })
    },
    finish(surfaceId, body) {
      const full = completeLines(body, true)
      const block = blocks.find(candidate => candidate.surfaceId === surfaceId && full.startsWith(candidate.fed))
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

// The A2UI block the model is writing right now (F-1). Its body is read as it
// streams, so its surface draws before the block is finished; the transcript's
// copy of the finished block is compiled again by the feeder, as an update.

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

export function createA2uiLiveBlocks(openStream: () => A2uiBlockStream): A2uiLiveBlocks {
  let current: {
    segmentKey: string
    fed: string
    stream: A2uiBlockStream
    closed: boolean
    finished: boolean
    failed: boolean
    created: boolean
  } | null = null
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

  return {
    feed(segmentKey, body, closed) {
      if (closed) {
        // Only the block that was streaming takes its finished key; a block
        // already finished when it was first drawn is the feeder's alone.
        if (!current || current.segmentKey !== segmentKey || current.closed) return
        current.closed = true
        const surfaceId = snapshot?.surfaceId ?? blockSurfaceIds(body).targets[0] ?? null
        publish({ segmentKey, surfaceId, mentionKey: surfaceId ? a2uiBlockKey(surfaceId, body) : liveMentionKey(segmentKey) })
        return
      }
      if (!current || current.segmentKey !== segmentKey || current.closed || !body.startsWith(current.fed)) {
        current = { segmentKey, fed: '', stream: openStream(), closed: false, finished: false, failed: false, created: false }
        snapshot = null
      }
      const chunk = body.slice(current.fed.length)
      current.fed = body
      let surfaceId = snapshot?.segmentKey === segmentKey ? snapshot.surfaceId : null
      if (chunk) {
        const result = current.stream.feed(chunk)
        if (!result.ok) current.failed = true
        for (const message of result.messages) {
          surfaceId ??= messageSurfaceId(message)
          if ('createSurface' in (message as object)) current.created = true
        }
      }
      surfaceId ??= blockSurfaceIds(body).targets[0] ?? null
      publish({ segmentKey, surfaceId, mentionKey: liveMentionKey(segmentKey) })
    },
    finish(surfaceId, body) {
      const block = current
      if (!block || block.finished || snapshot?.surfaceId !== surfaceId || !body.startsWith(block.fed)) {
        return { kind: 'not-streamed' }
      }
      block.finished = true
      const rest = body.slice(block.fed.length)
      block.fed = body
      for (const result of [rest ? block.stream.feed(rest) : null, block.stream.close()]) {
        if (!result) continue
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

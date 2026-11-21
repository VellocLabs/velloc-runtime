// One surface of an app that names the studio catalog (F-1): the app's build
// compiled here, followed by its data and text. A later board extends the
// same operation list (the top-level data keys its patches touch, or the data
// whole), so the engine applies only what is new; a new build starts fresh.

import { useRef, type ReactElement } from 'react'
import { exportA2UICatalog } from '@copilotkit/react-core/v2/generative-ui'
import type { AppSurfaceState } from '../../../runtimeProtocol/modApps'
import { createStudioExpressCompiler, type StudioExpressCompiler } from '../../../../toolkit/builtin/a2ui/express/studioExpress'
import { A2UI_PROTOCOL_VERSION } from '../toA2uiMessages'
import { studioUI } from './studioCatalog'
import { StudioSurfaceHost, type StudioEvent } from './StudioSurfaceHost'

let shared: StudioExpressCompiler | null = null

function compiler(): StudioExpressCompiler {
  shared ??= createStudioExpressCompiler(exportA2UICatalog(studioUI as never) as Record<string, unknown>)
  return shared
}

function surfaceOf(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  for (const value of Object.values(message)) {
    const id = typeof value === 'object' && value !== null ? (value as { surfaceId?: unknown }).surfaceId : undefined
    if (typeof id === 'string') return id
  }
  return undefined
}

/**
 * The operations that draw `surfaceId` of the board: its part of the build,
 * then `/data` and `/text`. Empty when the build does not compile here.
 */
export function studioAppOperations(board: AppSurfaceState, surfaceId: string): unknown[] {
  if (!board.surface) return []
  const compiled = compiler().compile(board.surface.body)
  if (!compiled.ok) {
    console.warn('[a2ui] studio build rejected', compiled.message)
    return []
  }
  const operations: unknown[] = compiled.messages.filter(message => surfaceOf(message) === surfaceId)
  if (operations.length === 0) return []
  if (board.text) operations.push({ version: A2UI_PROTOCOL_VERSION, updateDataModel: { surfaceId, path: '/text', value: board.text } })
  if (board.data !== undefined) operations.push({ version: A2UI_PROTOCOL_VERSION, updateDataModel: { surfaceId, path: '/data', value: board.data } })
  return operations
}

/** Past this many operations the next board starts a fresh list, so a long session does not keep every patch. */
export const STUDIO_FEED_LIMIT = 400

/** The operation list a surface host holds, and what it was built from. */
export type StudioFeed = {
  surfaceId: string
  hash: string
  operations: readonly unknown[]
  dataSeq?: number
  /** The data value drawn, compared when a board carries no `dataSeq`. */
  data: unknown
  text: string
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The top-level data keys `patches` touch, in order; undefined when one replaces the whole value. */
function topKeys(patches: readonly { path: string }[]): string[] | undefined {
  const keys: string[] = []
  for (const { path } of patches) {
    if (!path.startsWith('/')) return undefined
    const raw = path.slice(1).split('/')[0]!
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (key === '') return undefined
    if (!keys.includes(key)) keys.push(key)
  }
  return keys
}

const textKey = (text: AppSurfaceState['text']): string => (text === undefined ? '' : JSON.stringify(text))

/**
 * The feed for `board`: `previous` itself when nothing it shows changed, the
 * previous list extended when only data or text did, a fresh list on a new
 * build. Null when the board has no build.
 */
export function nextStudioFeed(previous: StudioFeed | null, board: AppSurfaceState, surfaceId: string): StudioFeed | null {
  if (!board.surface) return null
  const fresh = (): StudioFeed => ({
    surfaceId,
    hash: board.surface!.hash,
    operations: studioAppOperations(board, surfaceId),
    dataSeq: board.dataSeq,
    data: board.data,
    text: textKey(board.text),
  })
  if (!previous || previous.surfaceId !== surfaceId || previous.hash !== board.surface.hash || previous.operations.length === 0) return fresh()
  const added: unknown[] = []
  const text = textKey(board.text)
  if (text !== previous.text) {
    added.push({ version: A2UI_PROTOCOL_VERSION, updateDataModel: { surfaceId, path: '/text', ...(board.text !== undefined ? { value: board.text } : {}) } })
  }
  if (board.dataSeq !== previous.dataSeq || (board.dataSeq === undefined && board.data !== previous.data)) {
    const patches = board.dataPatches && previous.dataSeq !== undefined && board.dataPatches.from === previous.dataSeq ? board.dataPatches.patches : undefined
    const tops = patches && isRecord(board.data) ? topKeys(patches) : undefined
    if (tops) {
      // A component bound to `/data/x` redraws on a write at or above its path, not below it: each patch is sent as its top-level key.
      const value = board.data as Record<string, unknown>
      for (const key of tops) {
        const path = `/data/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`
        added.push({ version: A2UI_PROTOCOL_VERSION, updateDataModel: { surfaceId, path, ...(Object.hasOwn(value, key) ? { value: value[key] } : {}) } })
      }
    } else {
      added.push({ version: A2UI_PROTOCOL_VERSION, updateDataModel: { surfaceId, path: '/data', ...(board.data !== undefined ? { value: board.data } : {}) } })
    }
  }
  if (added.length === 0) return previous
  if (previous.operations.length + added.length > STUDIO_FEED_LIMIT) return fresh()
  return { ...previous, operations: [...previous.operations, ...added], dataSeq: board.dataSeq, data: board.data, text }
}

export function StudioAppSurface({
  board,
  surfaceId,
  onEvent,
}: {
  board: AppSurfaceState
  surfaceId: string
  onEvent: (event: StudioEvent) => void
}): ReactElement | null {
  const feedRef = useRef<StudioFeed | null>(null)
  const feed = nextStudioFeed(feedRef.current, board, surfaceId)
  feedRef.current = feed
  if (!feed || feed.operations.length === 0) return null
  return <StudioSurfaceHost surfaceId={surfaceId} operations={feed.operations} onEvent={onEvent} dataFromApp appData={board.data} />
}

export default StudioAppSurface

// A2UI surface store: PURE derivations over the transcript's A2UI sources —
// `<a2ui>` Express blocks in assistant text, and the `a2ui_*` command tool-calls
// of older sessions — so load-replay and live-update share one code path (F-1).
// No React here.

import type { Message } from '../../../runtime/RuntimeTypes'
import {
  A2UI_CREATE_SURFACE,
  A2UI_DELETE_SURFACE,
} from '../../../toolkit/builtin/a2ui/a2uiToolNames'
import {
  a2uiBlockKey,
  blockSurfaceIds,
  hasA2uiBlock,
  splitA2uiText,
} from '../../../toolkit/builtin/a2ui/express/a2uiBlocks'
import { a2uiToolNameOf, messageHasA2uiContent } from './hasA2uiSurface'

export type A2uiCommand = { name: string; args: Record<string, unknown> }

/** One finished `<a2ui>` block, with the surfaces it targets and deletes. */
export type A2uiBlockSource = {
  body: string
  targets: string[]
  deletes: string[]
}

/** Every A2UI source in transcript order. */
export type A2uiSource =
  | { kind: 'command'; command: A2uiCommand; toolCallId?: string }
  | { kind: 'block'; block: A2uiBlockSource }

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null
}

/** Pull every A2UI source out of the transcript, in order. Unfinished blocks are skipped. */
export function extractA2uiSources(messages: readonly Message[]): A2uiSource[] {
  const sources: A2uiSource[] = []
  for (const message of messages) {
    if (message.type !== 'assistant') continue
    const content = asRecord(message.message)?.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      const record = asRecord(part)
      if (!record) continue
      if (record.type === 'text' && typeof record.text === 'string' && hasA2uiBlock(record.text)) {
        for (const segment of splitA2uiText(record.text)) {
          if (segment.kind !== 'block' || !segment.closed) continue
          sources.push({ kind: 'block', block: { body: segment.body, ...blockSurfaceIds(segment.body) } })
        }
        continue
      }
      const toolName = a2uiToolNameOf(part)
      if (!toolName) continue
      const args = asRecord(record.args) ?? asRecord(record.input) ?? {}
      const toolCallId = typeof record.toolCallId === 'string' ? record.toolCallId : undefined
      sources.push({ kind: 'command', command: { name: toolName, args }, toolCallId })
    }
  }
  return sources
}

/** Pull the ordered list of `a2ui_*` command tool-calls out of the transcript. */
export function extractA2uiCommands(messages: readonly Message[]): A2uiCommand[] {
  return extractA2uiSources(messages).flatMap(source =>
    source.kind === 'command' ? [source.command] : [],
  )
}

export type A2uiToolCallRef = {
  toolCallId: string
  name: string
  surfaceId: string
}

/**
 * Like extractA2uiCommands but keyed by tool-call: returns each `a2ui_*`
 * tool-call's id + name + surfaceId in transcript order. Used by the inline
 * presentation to decide which tool-call position renders the LIVE surface
 * (the latest per surfaceId) vs a "jump to latest" breadcrumb.
 */
export function extractA2uiToolCalls(
  messages: readonly Message[],
): A2uiToolCallRef[] {
  const out: A2uiToolCallRef[] = []
  for (const message of messages) {
    if (message.type !== 'assistant') continue
    const inner = asRecord(message.message)
    const content = inner?.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      const toolName = a2uiToolNameOf(part)
      if (!toolName) continue
      const record = part as Record<string, unknown>
      const toolCallId =
        typeof record.toolCallId === 'string' ? record.toolCallId : undefined
      const args = asRecord(record.args) ?? asRecord(record.input) ?? {}
      const surfaceId = typeof args.surfaceId === 'string' ? args.surfaceId : undefined
      if (!toolCallId || !surfaceId) continue
      out.push({ toolCallId, name: toolName, surfaceId })
    }
  }
  return out
}

/**
 * For each surfaceId, the key of its LATEST mention — a block key
 * (`a2uiBlockKey`) or a tool-call id — where its card renders; every earlier
 * mention renders an update note. Plus the surfaces whose net state is
 * deleted. A data patch also moves the card.
 */
export function deriveA2uiPresentation(messages: readonly Message[]): {
  latestMentionBySurface: Map<string, string>
  deletedSurfaceIds: Set<string>
} {
  const latestMentionBySurface = new Map<string, string>()
  const deletedSurfaceIds = new Set<string>()
  const remove = (surfaceId: string) => {
    deletedSurfaceIds.add(surfaceId)
    latestMentionBySurface.delete(surfaceId)
  }
  for (const source of extractA2uiSources(messages)) {
    if (source.kind === 'block') {
      const { body, targets, deletes } = source.block
      for (const surfaceId of deletes) remove(surfaceId)
      for (const surfaceId of targets) {
        // A block that targets a deleted surface builds it anew.
        deletedSurfaceIds.delete(surfaceId)
        latestMentionBySurface.set(surfaceId, a2uiBlockKey(surfaceId, body))
      }
      continue
    }
    const { name, args } = source.command
    const surfaceId = typeof args.surfaceId === 'string' ? args.surfaceId : undefined
    if (!source.toolCallId || !surfaceId) continue
    if (name === A2UI_DELETE_SURFACE) {
      remove(surfaceId)
      continue
    }
    if (name === A2UI_CREATE_SURFACE) {
      // A delete is a tombstone: only a re-create revives the surface.
      deletedSurfaceIds.delete(surfaceId)
    } else if (deletedSurfaceIds.has(surfaceId)) {
      // An update after a delete is ignored: the processor already removed the
      // surface, so it gets no render position.
      continue
    }
    latestMentionBySurface.set(surfaceId, source.toolCallId)
  }
  return { latestMentionBySurface, deletedSurfaceIds }
}

/**
 * Epoch ms of the newest assistant message holding an A2UI source, or
 * null when there is none or it carries no parseable timestamp.
 */
export function latestA2uiMentionTime(messages: readonly Message[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!messageHasA2uiContent(message)) continue
    const time = typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : NaN
    return Number.isFinite(time) ? time : null
  }
  return null
}

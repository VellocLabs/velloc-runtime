// A2UI surface store: PURE derivations over the transcript's `a2ui_*` command
// tool-calls, so load-replay and live-update share one code path. No React here.

import type { Message } from '../../../runtime/RuntimeTypes'
import {
  A2UI_CREATE_SURFACE,
  A2UI_DELETE_SURFACE,
  isA2uiToolName,
} from '../../../toolkit/builtin/a2ui/a2uiToolNames'

export type A2uiCommand = { name: string; args: Record<string, unknown> }

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null
}

/** Pull the ordered list of `a2ui_*` command tool-calls out of the transcript. */
export function extractA2uiCommands(messages: readonly Message[]): A2uiCommand[] {
  const commands: A2uiCommand[] = []
  for (const message of messages) {
    if (message.type !== 'assistant') continue
    const inner = asRecord(message.message)
    const content = inner?.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      const record = asRecord(part)
      if (!record || record.type !== 'tool-call') continue
      const toolName =
        typeof record.toolName === 'string'
          ? record.toolName
          : typeof record.name === 'string'
            ? record.name
            : undefined
      if (!toolName || !isA2uiToolName(toolName)) continue
      const args = asRecord(record.args) ?? asRecord(record.input) ?? {}
      commands.push({ name: toolName, args })
    }
  }
  return commands
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
      const record = asRecord(part)
      if (!record || record.type !== 'tool-call') continue
      const toolName =
        typeof record.toolName === 'string'
          ? record.toolName
          : typeof record.name === 'string'
            ? record.name
            : undefined
      if (!toolName || !isA2uiToolName(toolName)) continue
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
 * For each surfaceId, the toolCallId of its LATEST mention (create /
 * update_components / update_data_model) — only that position renders the live
 * surface, every earlier one a "jump to latest" breadcrumb — plus the set of
 * surfaces whose net state is deleted. A data patch also relocates the surface.
 */
export function deriveA2uiPresentation(messages: readonly Message[]): {
  latestToolCallIdBySurface: Map<string, string>
  deletedSurfaceIds: Set<string>
} {
  const latestToolCallIdBySurface = new Map<string, string>()
  const deletedSurfaceIds = new Set<string>()
  for (const { toolCallId, name, surfaceId } of extractA2uiToolCalls(messages)) {
    if (name === A2UI_DELETE_SURFACE) {
      deletedSurfaceIds.add(surfaceId)
      latestToolCallIdBySurface.delete(surfaceId)
      continue
    }
    if (name === A2UI_CREATE_SURFACE) {
      // A delete is a tombstone: only a re-create revives the surface.
      deletedSurfaceIds.delete(surfaceId)
    } else if (deletedSurfaceIds.has(surfaceId)) {
      // update_components / update_data_model after a delete: ignored. The
      // surface stays deleted (the processor already removed it), so it never
      // gets a live render position to resurrect a half-built surface.
      continue
    }
    // create / update_components / update_data_model → newest render position;
    // every older position for this surface becomes a breadcrumb link.
    latestToolCallIdBySurface.set(surfaceId, toolCallId)
  }
  return { latestToolCallIdBySurface, deletedSurfaceIds }
}

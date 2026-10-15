/**
 * The describe events (F-25): `tool.describe` (once per tool per session,
 * `{ description, isDeferred? }`) and `command.describe` (`{ description,
 * argumentHint, isHidden }`), both cached until `$.ui.invalidate`. Pure shapes.
 */

import type { Origin } from './modTypes'

export type ToolDescribeInput = {
  tool: string
  description: string
  isDeferred?: true
  provider: Origin
}

export type ToolDescribeResult = { description: string; isDeferred?: boolean }

export type CommandDescribeInput = {
  command: string
  description: string
  argumentHint?: string
  isHidden: boolean
  immediate: boolean
  provider: Origin
}

export type CommandDescribeResult = { description: string; argumentHint?: string; isHidden: boolean }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isToolDescribeResult(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value.description !== 'string') return false
  return value.isDeferred === undefined || typeof value.isDeferred === 'boolean'
}

export function isCommandDescribeResult(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value.description !== 'string') return false
  if (value.argumentHint !== undefined && typeof value.argumentHint !== 'string') return false
  return typeof value.isHidden === 'boolean'
}

/** A rewritten `tool.describe` event: `tool` and `provider` pinned. */
export function toolDescribeProblem(original: ToolDescribeInput, e: unknown): string | null {
  if (!isRecord(e)) return 'the event argument is not an object'
  if (e.tool !== undefined && e.tool !== original.tool) return 'tool is pinned'
  if (e.provider !== undefined && JSON.stringify(e.provider) !== JSON.stringify(original.provider)) return 'provider is pinned'
  if (e.description !== undefined && typeof e.description !== 'string') return 'description is not a string'
  return null
}

/** A rewritten `command.describe` event: `command`, `immediate`, `provider`
 *  pinned. */
export function commandDescribeProblem(original: CommandDescribeInput, e: unknown): string | null {
  if (!isRecord(e)) return 'the event argument is not an object'
  if (e.command !== undefined && e.command !== original.command) return 'command is pinned'
  if (e.immediate !== undefined && e.immediate !== original.immediate) return 'immediate is pinned'
  if (e.provider !== undefined && JSON.stringify(e.provider) !== JSON.stringify(original.provider)) return 'provider is pinned'
  if (e.description !== undefined && typeof e.description !== 'string') return 'description is not a string'
  if (e.argumentHint !== undefined && typeof e.argumentHint !== 'string') return 'argumentHint is not a string'
  if (e.isHidden !== undefined && typeof e.isHidden !== 'boolean') return 'isHidden is not a boolean'
  return null
}

/** What the picker's list is told per command, once the chain answered. */
export type CommandDescription = CommandDescribeResult

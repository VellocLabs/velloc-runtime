/**
 * `$.ui.blit` (F-25): the desktop surface has no `Raster` / `Image`, so core answers
 * `{ deny }`. The argument is still checked and raised as `ui.blit`, where a hook
 * may rewrite cells or source but never the address or kind.
 */
import type { ModDispatcher } from './ModDispatcher'
import type { DispatchContext } from './modTypes'

/** `RasterBlitArgs` / `ImageBlitArgs`: one of `cells` or `source`. */
export type UiBlitArgs = {
  requestId: string
  key: string
  columns?: number
  rows?: number
} & ({ cells: string; source?: undefined } | { source: Record<string, unknown>; cells?: undefined })

/** `UiBlitResult`: `{}` once taken, else why not. */
export type UiBlitResult = { deny?: string }

/** What `$.ui.blit` runs with (`modNouns.ts`). */
export type ModBlitCall = {
  plugin: string
  context: DispatchContext
  signal?: AbortSignal
  dispatcher: Pick<ModDispatcher, 'dispatch' | 'hasHooksFor'>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cellCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 255
}

/** `$.ui.blit(args)`, checked: a bad argument throws, naming the field. */
export function uiBlitArgsOf(value: unknown): UiBlitArgs {
  const shape = '$.ui.blit({ requestId, key, cells | source })'
  if (!isRecord(value)) throw new TypeError(`${shape}: takes an object`)
  if (typeof value.requestId !== 'string' || value.requestId === '') {
    throw new TypeError(`${shape}: requestId must be a non-empty string`)
  }
  if (typeof value.key !== 'string' || value.key === '') {
    throw new TypeError(`${shape}: key must be a non-empty string`)
  }
  const hasCells = value.cells !== undefined
  const hasSource = value.source !== undefined
  if (hasCells === hasSource) throw new TypeError(`${shape}: give exactly one of cells (a Raster) or source (an Image)`)
  if (hasCells && typeof value.cells !== 'string') throw new TypeError(`${shape}: cells must be a string`)
  if (hasSource && !isRecord(value.source)) throw new TypeError(`${shape}: source must be an ImageSource object`)
  for (const field of ['columns', 'rows'] as const) {
    if (value[field] !== undefined && !cellCount(value[field])) {
      throw new TypeError(`${shape}: ${field} must be a whole number from 1 to 255`)
    }
  }
  const size = {
    ...(value.columns !== undefined ? { columns: value.columns as number } : {}),
    ...(value.rows !== undefined ? { rows: value.rows as number } : {}),
  }
  return hasCells
    ? { requestId: value.requestId, key: value.key, cells: value.cells as string, ...size }
    : { requestId: value.requestId, key: value.key, source: value.source as Record<string, unknown>, ...size }
}

function isBlitResult(value: unknown): value is UiBlitResult {
  return isRecord(value) && (value.deny === undefined || (typeof value.deny === 'string' && value.deny !== ''))
}

/** Why the desktop takes no blit: neither element is in its table. */
export function blitDenial(plugin: string, args: UiBlitArgs): string {
  const element = args.cells !== undefined ? 'Raster' : 'Image'
  return (
    `nothing of ${plugin}'s is mounted at ${args.requestId} / ${args.key}: ` +
    `the desktop surface draws no ${element} (Raster and Image are the terminal's)`
  )
}

/** A hook's rewrite, held to the contract: the address and the kind pinned. */
function arrivedArgs(arrived: unknown, args: UiBlitArgs): UiBlitArgs {
  const got = uiBlitArgsOf(arrived)
  if (got.requestId !== args.requestId || got.key !== args.key) {
    throw new Error('the rewritten event is refused: requestId and key are pinned')
  }
  if ((got.cells !== undefined) !== (args.cells !== undefined)) {
    throw new Error('the rewritten event is refused: a blit cannot change between cells and source')
  }
  return got
}

/**
 * `$.ui.blit`: `ui.blit` raised with the caller's context, core the desktop's
 * answer — `{ deny }`, since nothing it draws takes one. A hook's `{ deny }`
 * rejects the call (`DeniedError`); its `{ value }` is the call's answer.
 */
export async function uiBlit(args: UiBlitArgs, call: ModBlitCall): Promise<UiBlitResult> {
  const core = (arrived: unknown): UiBlitResult => ({ deny: blitDenial(call.plugin, arrivedArgs(arrived, args)) })
  if (!call.dispatcher.hasHooksFor('ui.blit')) return core(args)
  const result = (await call.dispatcher.dispatch('ui.blit', { ...args }, async arrived => ({ value: core(arrived) }), {
    context: call.context,
    ...(call.signal ? { signal: call.signal } : {}),
    accepts: r =>
      isRecord(r) &&
      (typeof r.deny === 'string' ? r.deny !== '' && r.value === undefined : r.deny === undefined && isBlitResult(r.value)),
  })) as { value?: UiBlitResult; deny?: string }
  if (typeof result.deny === 'string') {
    const error = new Error(result.deny)
    error.name = 'DeniedError'
    throw error
  }
  const value = result.value as UiBlitResult
  return value.deny !== undefined ? { deny: value.deny } : {}
}

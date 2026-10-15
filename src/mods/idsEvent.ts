/**
 * `ids.next`: the engine's own ids (message, turn, run), raised only while a module
 * hooks it; ids are then drawn ahead into a small reserve. A colliding or unusable
 * hook id is refused and the engine's own used. Pure shapes and the check.
 */

export type IdKind = 'message' | 'turn' | 'run'

export type IdsNextInput = { kind: IdKind; hint?: string }

export type IdsNextResult = { id: string }

/** Each hook's own-time budget on `ids.next`: an id must be fast. A hook
 *  past it is absent and the chain goes on beneath it (the budget rule). */
export const IDS_NEXT_BUDGET_MS = 250

/** The longest id the engine takes. */
export const ID_MAX_LENGTH = 128

/** Whether `id` is one the engine can store: non-empty, at most
 *  `ID_MAX_LENGTH` characters, no whitespace or control characters. */
export function isUsableId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= ID_MAX_LENGTH && !/[\s\u0000-\u001f\u007f]/.test(id)
}

export function isIdsNextResult(value: unknown): value is IdsNextResult {
  return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string'
}

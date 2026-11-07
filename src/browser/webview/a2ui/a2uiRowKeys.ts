// The `<a2ui>` block keys a chat row carries (F-1): `a2uiBlockKey` of the
// transcript message and the block's ordinal in it, in the order of the row's
// text parts' blocks. A row's id is not that uuid (the closing reply is
// turn-anchored, and a row can merge several messages), so the adapter stamps
// the keys on the row and the text part reads the key at its block's ordinal.

import { messageA2uiBlockKeys } from '../../../toolkit/builtin/a2ui/express/a2uiBlocks'

export const A2UI_BLOCK_KEYS_KEY = 'a2uiBlockKeys'

type RowLike = { metadata?: unknown }

/** The row metadata for a transcript message's blocks; nothing for a row without a uuid or a block. */
export function a2uiBlockKeysOf(uuid: string | undefined, content: unknown): { a2uiBlockKeys?: string[] } {
  // A row without a uuid (a reply still streaming) keys its blocks by row id.
  const keys = uuid ? messageA2uiBlockKeys(uuid, content) : []
  return keys.length > 0 ? { a2uiBlockKeys: keys } : {}
}

/**
 * The keys a row carries, or none. The stored array itself is returned, never
 * a copy: a state selector compares it by identity on every render.
 */
export function a2uiBlockKeysOfRow(custom: Record<string, unknown> | undefined): readonly string[] | undefined {
  const value = custom?.[A2UI_BLOCK_KEYS_KEY]
  return Array.isArray(value) && value.every(key => typeof key === 'string') ? (value as string[]) : undefined
}

/** Concatenates two rows' block keys, in the order their content is concatenated. */
export function mergeA2uiBlockKeys(a: RowLike, b: RowLike): { a2uiBlockKeys?: string[] } {
  const read = (row: RowLike): readonly string[] =>
    a2uiBlockKeysOfRow((row.metadata as { custom?: Record<string, unknown> } | undefined)?.custom) ?? []
  const joined = [...read(a), ...read(b)]
  return joined.length > 0 ? { a2uiBlockKeys: joined } : {}
}

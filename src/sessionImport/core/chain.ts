/**
 * The provider-neutral conversation-chain primitives every importer shares:
 * the `Participant` node (a parent-linked log record), the `Converted` message
 * (a Velloc message plus the uuid it chains under), and `selectChain` (latest
 * leaf → root walk). Pure.
 */

import type { Message } from '../../runtime/RuntimeTypes'
import type { RawRecord } from './json'

export type Participant = {
  uuid: string
  parentUuid: string | null
  raw: RawRecord
}

/** A converted message plus the uuid it should be chained under. */
export type Converted = { message: Message; uuid: string }

/** Latest leaf → root, or null when the walk hits a parent that is not in
 *  the list (the caller then falls back to list order). A provider whose log
 *  is already linear (no DAG) can skip this and hand its records in order. */
export function selectChain(
  participants: readonly Participant[],
): Participant[] | null {
  if (participants.length === 0) return []
  const byUuid = new Map<string, Participant>()
  const parented = new Set<string>()
  for (const p of participants) {
    byUuid.set(p.uuid, p)
    if (p.parentUuid) parented.add(p.parentUuid)
  }
  let leaf: Participant | undefined
  for (let i = participants.length - 1; i >= 0; i--) {
    if (!parented.has(participants[i]!.uuid)) {
      leaf = participants[i]
      break
    }
  }
  leaf ??= participants[participants.length - 1]
  const chain: Participant[] = []
  const seen = new Set<string>()
  let current: Participant | undefined = leaf
  while (current) {
    if (seen.has(current.uuid)) break
    seen.add(current.uuid)
    chain.push(current)
    if (current.parentUuid === null) break
    const parent = byUuid.get(current.parentUuid)
    if (!parent) return null
    current = parent
  }
  chain.reverse()
  return chain
}

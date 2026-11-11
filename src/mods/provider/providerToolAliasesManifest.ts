/**
 * The manifest's `providers.<key>.wire` block (F-27): what every model of the
 * provider needs on the wire beyond its format.
 *
 * Security: the block is untrusted and checked strictly: an unknown property or
 * an unusable alias map is a problem, and a problem refuses the provider.
 */
import { readToolAliases, type ToolAliases } from '../../models/drivers/toolAliases'

export type ProviderWireManifest = {
  /** `{ <wire name>: <tool name> }`, one-to-one; a model row's own map replaces it. */
  toolAliases?: ToolAliases
}

const WIRE_KEYS: readonly string[] = ['toolAliases']

/** The checked block, or undefined when it holds nothing (or has a problem,
 *  each reported through `bad`). */
export function checkProviderWire(
  value: unknown,
  bad: (message: string) => void,
): ProviderWireManifest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    bad('wire: expected an object')
    return undefined
  }
  const raw = value as Record<string, unknown>
  const extra = Object.keys(raw).filter(key => !WIRE_KEYS.includes(key))
  if (extra.length > 0) {
    bad(`wire: unknown ${extra.length === 1 ? 'property' : 'properties'} ${extra.map(key => `"${key}"`).join(', ')}`)
  }
  if (raw.toolAliases === undefined) return undefined
  const read = readToolAliases(raw.toolAliases)
  if (read.problem) {
    bad(`wire.toolAliases: ${read.problem}`)
    return undefined
  }
  return read.aliases ? { toolAliases: read.aliases } : undefined
}

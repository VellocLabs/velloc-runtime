import type { NexusTaskRunStats } from '../browser/bridge/protocol/ui'

/** Field equality for two optional run stats. */
export function runStatsEqual(a: NexusTaskRunStats | undefined, b: NexusTaskRunStats | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.toolUses === b.toolUses &&
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.cacheWriteTokens === b.cacheWriteTokens
  )
}

/** A token count in at most four characters: 950, 1.2k, 45k, 1.23M. */
export function compactTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/** True when the run has made a tool call or reported any token. */
export function hasRunStats(stats: NexusTaskRunStats | undefined): stats is NexusTaskRunStats {
  if (!stats) return false
  return (
    stats.toolUses + stats.inputTokens + stats.outputTokens + stats.cacheReadTokens + stats.cacheWriteTokens > 0
  )
}

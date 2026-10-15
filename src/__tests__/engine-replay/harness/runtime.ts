import type { RuntimeConfig } from '../../../runtime/interfaces/RuntimeConfig'

/** The fixed instant every scenario runs at. Normalization zeroes timestamps
 *  anyway; a fixed clock keeps durations (`now() - start`) at 0 as well. */
export const FIXED_NOW = Date.UTC(2026, 0, 1)

/**
 * A runtime config whose ids and clock are deterministic: ids are `id-<n>` in
 * the order they are minted, the clock never moves. Ids minted elsewhere
 * (straight from `crypto.randomUUID`) are mapped by the normalizer.
 */
export class ReplayRuntimeConfig implements RuntimeConfig {
  private next = 0
  constructor(private readonly env: Record<string, string> = {}) {}

  getEnv(name: string): string | undefined {
    return this.env[name]
  }

  flagOn(name: string): boolean {
    const value = this.getEnv(name)?.toLowerCase().trim()
    return value === '1' || value === 'true' || value === 'yes'
  }

  now(): number {
    return FIXED_NOW
  }

  createUUID(): string {
    this.next += 1
    return `id-${this.next}`
  }

  createTimestamp(): string {
    return new Date(FIXED_NOW).toISOString()
  }

  getMaxStructuredOutputRetries(): number {
    return 5
  }
}

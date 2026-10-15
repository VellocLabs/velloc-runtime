export interface RuntimeConfig {
  getEnv(name: string): string | undefined
  flagOn(name: string): boolean
  now(): number
  createUUID(): string
  createTimestamp(): string
  getMaxStructuredOutputRetries(): number
}

/**
 * Small JSON-value coercers shared by every import provider's parse pass.
 * Pure; no fs, no bridge, no runtime imports.
 */

export type RawRecord = Record<string, unknown>

export function asRecord(value: unknown): RawRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RawRecord)
    : null
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function isTrue(value: unknown): boolean {
  return value === true
}

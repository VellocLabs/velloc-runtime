import type { RuntimeConfig } from '../../runtime/interfaces/RuntimeConfig'

export function createFallbackUUID(): string {
  return `uuid-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`
}

export function createUUID(runtimeConfig?: RuntimeConfig): string {
  if (runtimeConfig) {
    return runtimeConfig.createUUID()
  }

  return globalThis.crypto?.randomUUID?.() ?? createFallbackUUID()
}

export function createTimestamp(runtimeConfig?: RuntimeConfig): string {
  if (runtimeConfig) {
    return runtimeConfig.createTimestamp()
  }

  return new Date().toISOString()
}

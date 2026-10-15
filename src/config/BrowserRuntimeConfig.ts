import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'

function createFallbackUUID(): string {
  return `runtime-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`
}

export type BrowserRuntimeConfigOptions = {
  env?: Record<string, string>
  envProvider?: (name: string) => string | undefined
  now?: () => number
  runtimeName?: string
  locale?: string
  timezone?: string
  userAgent?: string
}

export class BrowserRuntimeConfig implements RuntimeConfig {
  private readonly env: Record<string, string>
  private readonly envProvider?: (name: string) => string | undefined
  private readonly nowProvider: () => number
  private readonly runtimeName: string
  private readonly locale?: string
  private readonly timezone?: string
  private readonly userAgent?: string

  constructor(options: BrowserRuntimeConfigOptions = {}) {
    this.env = options.env ?? {}
    this.envProvider = options.envProvider
    this.nowProvider = options.now ?? (() => Date.now())
    this.runtimeName = options.runtimeName ?? 'chromium-runtime-browser'
    this.locale = options.locale
    this.timezone = options.timezone
    this.userAgent = options.userAgent
  }

  getEnv(name: string): string | undefined {
    return this.envProvider?.(name) ?? this.env[name]
  }

  flagOn(name: string): boolean {
    const value = this.getEnv(name)
    if (!value) {
      return false
    }

    const normalized = value.toLowerCase().trim()
    return normalized === '1' || normalized === 'true' || normalized === 'yes'
  }

  now(): number {
    return this.nowProvider()
  }

  createUUID(): string {
    return globalThis.crypto?.randomUUID?.() ?? createFallbackUUID()
  }

  createTimestamp(): string {
    return new Date(this.now()).toISOString()
  }

  getMaxStructuredOutputRetries(): number {
    const raw = this.getEnv('MAX_STRUCTURED_OUTPUT_RETRIES')
    if (!raw) {
      return 5
    }

    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 5
  }

  getRuntimeName(): string {
    return this.runtimeName
  }

  getLocale(): string {
    if (this.locale) {
      return this.locale
    }

    if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') {
      return navigator.language
    }

    return 'en-US'
  }

  getTimezone(): string {
    if (this.timezone) {
      return this.timezone
    }

    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
  }

  browserAgentString(): string {
    if (this.userAgent) {
      return this.userAgent
    }

    if (typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string') {
      return navigator.userAgent
    }

    return this.runtimeName
  }
}

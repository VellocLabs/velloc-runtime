/**
 * Lazy, cached fetcher for system-prompt templates served at
 * `<base>/system_prompts/<variant>.md`; nothing is fetched at module load.
 */

import type { SystemPromptVariant } from './systemPromptLoader.types'

type CacheEntry = { template: string; fetchedAt: number }

const cache = new Map<SystemPromptVariant, CacheEntry>()
const inflight = new Map<SystemPromptVariant, Promise<string>>()

export class PromptUnavailableError extends Error {
  readonly variant: SystemPromptVariant
  readonly cause?: unknown
  constructor(variant: SystemPromptVariant, cause?: unknown) {
    super(`System prompt template "${variant}" could not be loaded`)
    this.name = 'PromptUnavailableError'
    this.variant = variant
    this.cause = cause
  }
}

function resolveBaseUrl(): string {
  // import.meta.env.BASE_URL is populated by Vite from `base` in vite.config
  // (e.g. '/' for root or '/repo-name/' for GitHub Pages). Falling back to
  // '/' keeps environments without a Vite-injected BASE_URL working.
  const fromEnv = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL
  return fromEnv && fromEnv.length > 0 ? fromEnv : '/'
}

function buildUrl(variant: SystemPromptVariant): string {
  const base = resolveBaseUrl()
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base
  const path = `${trimmed}/system_prompts/${variant}.md`
  // In a browser context, fetch resolves relative paths against the page
  // origin. In Node-based test runners (vitest with environment:'node'),
  // fetch requires an absolute URL — anchor to window.location.origin
  // when available, else a localhost placeholder so URL parsing doesn't
  // throw before the test's fetch stub runs.
  const origin =
    (typeof window !== 'undefined' && window.location?.origin) ||
    (typeof globalThis !== 'undefined' &&
      (globalThis as unknown as { location?: { origin?: string } }).location?.origin) ||
    'http://localhost'
  return new URL(path, origin).toString()
}

export async function fetchPromptTemplate(
  variant: SystemPromptVariant,
): Promise<string> {
  const cached = cache.get(variant)
  if (cached) return cached.template

  const existing = inflight.get(variant)
  if (existing) return existing

  const url = buildUrl(variant)
  const promise = (async () => {
    try {
      const response = await fetch(url, { cache: 'default' })
      if (!response.ok) {
        throw new PromptUnavailableError(
          variant,
          new Error(`HTTP ${response.status} ${response.statusText}`),
        )
      }
      const text = await response.text()
      cache.set(variant, { template: text, fetchedAt: Date.now() })
      return text
    } catch (cause) {
      // Stale cache fallback: if a previous turn cached this variant and the
      // refresh fails (transient 5xx, server hiccup), reuse the cached copy.
      const stale = cache.get(variant)
      if (stale) return stale.template
      if (cause instanceof PromptUnavailableError) throw cause
      throw new PromptUnavailableError(variant, cause)
    }
  })().finally(() => {
    inflight.delete(variant)
  })

  inflight.set(variant, promise)
  return promise
}

export function __resetPromptCacheForTest(): void {
  cache.clear()
  inflight.clear()
}

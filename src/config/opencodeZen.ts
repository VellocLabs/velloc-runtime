/**
 * OpenCode Zen connection constants — a dependency-free leaf so the provider
 * registry and publish paths can use them without an import cycle. The
 * settings-page preset built on these lives in
 * `browser/webview/settings/opencodeZenPreset.ts`.
 */

export const OPENCODE_ZEN_BASE_URL = 'https://opencode.ai/zen/v1'

/**
 * Whether Velloc offers OpenCode Zen (the Add-provider row and first-run seed). Off:
 * the gateway refuses the keyless free tier outside its own app (403). Existing Zen
 * providers keep working as ordinary custom providers.
 */
export const OPENCODE_ZEN_ENABLED = false

/** The id a seeded Zen provider is stored under — what
 *  `generateCustomProviderId('OpenCode Zen', [])` yields. */
export const OPENCODE_ZEN_PROVIDER_ID = 'custom-opencode-zen'

/** The key OpenCode itself sends when the user has none: Zen's anonymous
 *  free tier (`zenApiKey === "public"` ⇒ no account, per-IP limits). */
export const OPENCODE_ZEN_PUBLIC_API_KEY = 'public'

/**
 * User-Agent sent to Zen, matching the OpenCode client's LLM requests
 * (`opencode/${version}`, `packages/opencode/src/session/llm/request.ts`).
 * Kept in step with OpenCode at the OpenCode team's request — the gateway may
 * gate on it. Bump with OpenCode releases (1.18.32).
 */
export const OPENCODE_ZEN_USER_AGENT = 'opencode/1.18.32'

/** Whether a base URL points at OpenCode Zen's OpenAI-compatible root.
 *  Same trimming as the settings form's `normaliseBaseUrl`. */
export function isOpencodeZenBaseUrl(url: string): boolean {
  return url.trim().replace(/\/+$/, '').toLowerCase() === OPENCODE_ZEN_BASE_URL
}

/**
 * The key to send for a custom-provider connection: the typed key, or — for
 * a Zen base URL with none — the anonymous `public` key.
 */
export function resolveOpencodeZenApiKey(baseUrl: string, apiKey: string): string {
  if (apiKey) return apiKey
  return isOpencodeZenBaseUrl(baseUrl) ? OPENCODE_ZEN_PUBLIC_API_KEY : ''
}

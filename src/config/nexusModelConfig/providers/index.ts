/**
 * The provider REGISTRY: every built-in in catalog order, plus one adapter definition
 * per enabled provider mod (registered at runtime). `getProviderDefinition` is the
 * one synchronous lookup; nothing here calls into a mod.
 */
import type { ProviderDefinition } from '../providerDefinition'
import { OPENAI_PROVIDER } from './openai'
import { CHATGPT_PRO_PROVIDER } from './chatgptPro'
import { ANTHROPIC_PROVIDER } from './anthropic'
import { GITHUB_COPILOT_PROVIDER } from './githubCopilot'
import { QWEN_CODE_PROVIDER } from './qwenCode'
import { GLM_PROVIDER } from './glm'
import { DEEPSEEK_PROVIDER } from './deepseek'
import { GOOGLE_PROVIDER } from './google'
import { OLLAMA_PROVIDER } from './ollama'
import { KIMI_PROVIDER } from './kimi'
import { MINIMAX_PROVIDER } from './minimax'
import { QWEN_PROVIDER } from './qwen'
import { OPENROUTER_PROVIDER } from './openrouter'
import { VERCEL_AI_GATEWAY_PROVIDER } from './vercelAiGateway'
import { CUSTOM_OPENAI_PROVIDER } from './customOpenai'
import { CUSTOM_ANTHROPIC_PROVIDER } from './customAnthropic'

/** The providers Velloc ships, in catalog order. Fixed at build time. */
export const BUILTIN_PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = [
  OPENAI_PROVIDER,
  // `chatgpt-pro` models are discovered dynamically from the Codex /models
  // endpoint (account-aware), but the entry is `filterMode: 'curated'`:
  // only the configured GPT-5.6-lineup ids surface in the picker, carrying
  // the Codex-backend token/context figures (otherwise they fall back to a
  // tiny 8192 default output budget). See createConfiguredProvider.
  CHATGPT_PRO_PROVIDER,
  ANTHROPIC_PROVIDER,
  // The two device-code OAuth providers: no curated rows (the account's own
  // listing, host discovery), on a runtime ModelProvider like chatgpt-pro.
  GITHUB_COPILOT_PROVIDER,
  QWEN_CODE_PROVIDER,
  GLM_PROVIDER,
  DEEPSEEK_PROVIDER,
  GOOGLE_PROVIDER,
  OLLAMA_PROVIDER,
  KIMI_PROVIDER,
  MINIMAX_PROVIDER,
  QWEN_PROVIDER,
  // Gateways served entirely by the runtime (they list their own models):
  // the host has no native provider for them.
  OPENROUTER_PROVIDER,
  VERCEL_AI_GATEWAY_PROVIDER,
  // User-configured custom endpoints (any OpenAI/Anthropic-compatible URL).
  // Passthrough: models come from the endpoint's own /v1/models discovery.
  CUSTOM_OPENAI_PROVIDER,
  CUSTOM_ANTHROPIC_PROVIDER,
]

const BUILTIN_BY_ID = new Map(BUILTIN_PROVIDER_DEFINITIONS.map(d => [d.config.providerId, d]))

/** Enabled provider mods, by registered id (`mod.<plugin>.<key>`). */
const modDefinitions = new Map<string, ProviderDefinition>()
/** Ids of providers whose plugin is installed but disabled. Their stored
 *  config stays; the catalog shows nothing for them. */
let disabledModIds: ReadonlySet<string> = new Set()
/** The first plugin scan has finished: until then the registry is empty
 *  because nothing was read yet, not because no plugin is installed. */
let modScanComplete = false
const listeners = new Set<() => void>()

function notifyRegistryChanged(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // A listener's failure is its own.
    }
  }
}

/** The provider with this id — a built-in or an enabled provider mod;
 *  undefined for custom providers. */
export function getProviderDefinition(providerId: string | undefined): ProviderDefinition | undefined {
  if (!providerId) return undefined
  return BUILTIN_BY_ID.get(providerId) ?? modDefinitions.get(providerId)
}

/** Whether `providerId` is one of the providers Velloc ships. */
export function isBuiltInProviderId(providerId: string | undefined): boolean {
  return !!providerId && BUILTIN_BY_ID.has(providerId)
}

/** Every provider definition: the built-ins in catalog order, then the mods
 *  in registration order. */
export function providerDefinitions(): readonly ProviderDefinition[] {
  return modDefinitions.size === 0 ? BUILTIN_PROVIDER_DEFINITIONS : [...BUILTIN_PROVIDER_DEFINITIONS, ...modDefinitions.values()]
}

/** The enabled provider mods' definitions, in registration order. */
export function modProviderDefinitions(): readonly ProviderDefinition[] {
  return [...modDefinitions.values()]
}

/**
 * Add (or replace) an enabled provider mod's definition. A mod provider's id
 * is `mod.<plugin>.<key>`, never a built-in's. Fires the change listeners.
 */
export function registerModProviderDefinition(definition: ProviderDefinition): void {
  const id = definition.config.providerId
  if (!id.startsWith('mod.')) throw new Error(`a mod provider id starts with "mod.": ${id}`)
  if (BUILTIN_BY_ID.has(id)) throw new Error(`${id} is a built-in provider`)
  modDefinitions.set(id, definition)
  notifyRegistryChanged()
}

/** Remove a mod provider's definition; whether there was one. */
export function unregisterModProviderDefinition(providerId: string): boolean {
  const removed = modDefinitions.delete(providerId)
  if (removed) notifyRegistryChanged()
  return removed
}

/** The ids of mod providers whose plugin is installed but disabled
 *  (replaces the previous set; fires the change listeners when it differs). */
export function setDisabledModProviderIds(ids: Iterable<string>): void {
  const next = new Set(ids)
  const same = next.size === disabledModIds.size && [...next].every(id => disabledModIds.has(id))
  disabledModIds = next
  if (!same) notifyRegistryChanged()
}

export function isDisabledModProviderId(providerId: string): boolean {
  return disabledModIds.has(providerId)
}

/** The plugin scan has run at least once (`isModProviderScanComplete`). */
export function markModProviderScanComplete(): void {
  if (modScanComplete) return
  modScanComplete = true
  notifyRegistryChanged()
}

export function isModProviderScanComplete(): boolean {
  return modScanComplete
}

/** Called after every registry change; returns the unsubscribe. */
export function onProviderRegistryChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test hook: back to the built-ins alone. */
export function resetModProviderDefinitions(): void {
  modDefinitions.clear()
  disabledModIds = new Set()
  modScanComplete = false
}

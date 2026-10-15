import type { NexusProviderConfig } from "../../../settings/settingsTypes";
import type { ProviderAuthProviderInfo } from "../../bridge/protocol/providerAuth";

/**
 * The two backend provider ids behind the single "Custom endpoint" settings
 * entry. The wire dialect IS the id: `custom-openai` speaks the OpenAI
 * chat-completions API, `custom-anthropic` speaks the Anthropic Messages API.
 * Both are registered in the C++ `LlmProviderFactory` with no default base URL
 * and no required API key.
 */
export const CUSTOM_PROVIDER_IDS = {
  openai: "custom-openai",
  anthropic: "custom-anthropic",
} as const;

export type CustomWireFormat = keyof typeof CUSTOM_PROVIDER_IDS;

export function isCustomProviderId(id: string | undefined): boolean {
  return (
    id === CUSTOM_PROVIDER_IDS.openai || id === CUSTOM_PROVIDER_IDS.anthropic
  );
}

/**
 * Registry-driven field gating for the Models page (no registry: both fields shown,
 * key required). `isOAuth` hides key and base URL; `supportsBaseUrl` needs a default
 * base URL or a custom endpoint; custom endpoints show the key field but never
 * require it. `providerId` forces custom-endpoint gating before the registry lands.
 */
export function deriveProviderGating(
  info: ProviderAuthProviderInfo | undefined,
  providerId?: string,
): {
  isOAuth: boolean;
  requiresApiKey: boolean;
  supportsBaseUrl: boolean;
  supportsApiKey: boolean;
} {
  if (isCustomProviderId(providerId ?? info?.id)) {
    return {
      isOAuth: false,
      requiresApiKey: false,
      supportsBaseUrl: true,
      supportsApiKey: true,
    };
  }
  const isOAuth = info?.authMode === "oauth";
  const requiresApiKey = info ? !isOAuth && info.type !== "local" : true;
  const supportsBaseUrl = info
    ? !isOAuth && (info.hasDefaultBaseUrl ?? true)
    : true;
  return { isOAuth, requiresApiKey, supportsBaseUrl, supportsApiKey: requiresApiKey };
}

/**
 * Whether a settings.json provider config carries something the USER set up — the
 * evidence the host's picker gate accepts (F-12): a key (`hasApiKey`), a base URL,
 * a default model, a non-empty enabled-model list, or a custom provider. A bare
 * `{trust}` marker or a verification stamp does not count.
 */
export function hasUserProviderSetup(
  config: NexusProviderConfig | undefined,
): boolean {
  if (!config) return false;
  return (
    !!config.apiKey ||
    config.hasApiKey === true ||
    !!config.baseUrl ||
    !!config.defaultModel ||
    !!config.model ||
    (config.enabledModels?.length ?? 0) > 0 ||
    config.isCustomProvider === true
  );
}

/**
 * Whether a built-in provider counts as ADDED on the Provider connection home page,
 * following the quick picker's rule: settings.json (`hasUserProviderSetup`) or the
 * broker reporting a key or verification (broker-pref and OAuth providers).
 */
export function isBuiltInProviderAdded(
  saved: NexusProviderConfig | undefined,
  info: ProviderAuthProviderInfo | undefined,
): boolean {
  return (
    hasUserProviderSetup(saved) ||
    info?.isVerified === true ||
    info?.hasStoredApiKey === true ||
    info?.connected === true
  );
}

/**
 * Whether a built-in provider reads as connected on its home-page row — the
 * same evidence the editor's status card treats as "ready".
 */
export function isBuiltInProviderConnected(
  saved: NexusProviderConfig | undefined,
  info: ProviderAuthProviderInfo | undefined,
): boolean {
  if (info?.authMode === "oauth") return info.connected === true;
  return saved?.lastVerification !== undefined || info?.isVerified === true;
}

/**
 * How a home-list row connects — the line under its name. It is what tells
 * "ChatGPT Plus/Pro" (a subscription sign-in) apart from "OpenAI" (an API
 * key) when both carry the same logo.
 */
export type ProviderConnectionKind = "subscription" | "apiKey" | "plugin" | "local" | "custom";

export function providerConnectionKind(
  info: ProviderAuthProviderInfo | undefined,
  custom: boolean,
): ProviderConnectionKind {
  if (custom) return "custom";
  if (info?.authMode === "oauth") return "subscription";
  if (info?.type === "local") return "local";
  return "apiKey";
}

/**
 * Pure decision helpers for the Models settings page (`ModelsSection`),
 * extracted so the auto-connect / placeholder behaviour is unit-testable
 * without rendering the whole component.
 */

/**
 * Whether the editor form differs from the persisted config — the same
 * comparison the status card uses to decide "Changes pending". Only the two
 * user-editable fields (apiKey / baseUrl) participate; verification metadata
 * is derived, not edited.
 */
export function isProviderFormDirty(
  form: NexusProviderConfig,
  saved: NexusProviderConfig | undefined,
): boolean {
  return (
    (form.apiKey ?? "") !== (saved?.apiKey ?? "") ||
    (form.baseUrl ?? "") !== (saved?.baseUrl ?? "")
  );
}

/**
 * Whether the form warrants an automatic verify+persist. Never for OAuth or an
 * unchanged form. Key-required providers need a typed or STORED key (the host fills
 * the stored key in); `save` persists only on a successful probe, so a half-typed
 * URL is never written. Local providers auto-connect on any base-URL edit.
 */
export function shouldAutoConnect(args: {
  form: NexusProviderConfig;
  saved: NexusProviderConfig | undefined;
  isOAuth: boolean;
  requiresApiKey: boolean;
  providerId?: string;
}): boolean {
  const { form, saved, isOAuth, requiresApiKey, providerId } = args;
  if (isOAuth) return false;
  if (!isProviderFormDirty(form, saved)) return false;
  if (requiresApiKey) {
    return (form.apiKey ?? "").trim().length > 0 || saved?.hasApiKey === true;
  }
  // Custom endpoints have no default base URL, so don't probe until the user
  // has entered one — an empty endpoint would just surface an error mid-typing.
  if (isCustomProviderId(providerId)) {
    return (form.baseUrl ?? "").trim().length > 0;
  }
  return true;
}

/**
 * The default Base URL placeholder: the registry's `baseUrl`, else
 * `fallbackBaseUrl` (a runtime-only provider's catalog default), else empty.
 */
export function providerBaseUrlPlaceholder(
  registryBaseUrl: string | undefined,
  fallbackBaseUrl?: string,
): string {
  return registryBaseUrl?.trim() || fallbackBaseUrl?.trim() || "";
}

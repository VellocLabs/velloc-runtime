import type { NexusProviderModelConfig } from '../../types'

// GitHub Copilot (OAuth device-code sign-in). The host signs in, stores the
// durable GitHub token, and before every call exchanges it for the
// short-lived Copilot session token api.githubcopilot.com accepts
// (`NexusOAuthManager::EnsureCopilotToken`). The model list is the
// account's own (host discovery): `passthrough`, no curated rows.

export const GITHUB_COPILOT_BASE_URL = 'https://api.githubcopilot.com'

/**
 * `OpenAiProvider` as the factory builds it for github-copilot
 * (llm_provider_factory.cc): chat/completions, `Authorization: Bearer
 * <Copilot session token>`, and the editor headers without which
 * api.githubcopilot.com answers 403. `{{oauth:access_token}}` is that session
 * token: the host runs the exchange before substituting it.
 */
export const GITHUB_COPILOT_WIRE: NonNullable<NexusProviderModelConfig['wire']> = {
  format: 'openai-chat',
  headers: {
    Authorization: 'Bearer {{oauth:access_token}}',
    'Copilot-Integration-Id': 'vscode-chat',
    'Editor-Version': 'vscode/1.96.0',
    'Editor-Plugin-Version': 'copilot-chat/0.23.0',
    'Openai-Intent': 'conversation-edits',
    'x-initiator': 'user',
  },
}

export const GITHUB_COPILOT_PROVIDER_MODEL_CONFIG: NexusProviderModelConfig = {
  providerId: 'github-copilot',
  filterMode: 'passthrough',
  // The backend (`OAuthProviderConfig::backend_base_url`, oauth_providers.cc).
  defaultBaseUrl: GITHUB_COPILOT_BASE_URL,
  // Runs on a runtime ModelProvider over `model.rawStream*`; a host without
  // the OAuth primitive cannot serve it (the native class is gone).
  wire: GITHUB_COPILOT_WIRE,
  // PDF input: an OpenAI-compatible chat wire with no document part.
  documentInput: 'rasterize',
  // No `catalog`: Copilot caps each model's window and output below the
  // vendor's, so the catalog's figures would overstate them.
  models: [],
}

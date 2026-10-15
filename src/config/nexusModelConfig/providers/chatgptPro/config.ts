import type { NexusProviderModelConfig } from '../../types'
import { createOpenAiModelPattern } from '../../patterns'

export const CHATGPT_PRO_BASE_URL = 'https://chatgpt.com/backend-api/codex'

/**
 * The chatgpt-pro request headers: `Authorization: Bearer <access token>`, the
 * `originator` / `OpenAI-Beta` headers and `ChatGPT-Account-Id`, omitted when the
 * token has no account id (`model.rawStreamOpen.oauthOptional`). The token is
 * required.
 */
export const CHATGPT_PRO_WIRE: NonNullable<NexusProviderModelConfig['wire']> = {
  format: 'openai-responses',
  headers: {
    Authorization: 'Bearer {{oauth:access_token}}',
    originator: 'browseros',
    'OpenAI-Beta': 'responses=experimental',
    'ChatGPT-Account-Id': '{{oauth:account_id}}',
  },
}

// ChatGPT Pro (Codex subscription backend), `curated`. Codex serves a 272K window,
// smaller than the API tier; overstating it is the dangerous direction, so keep the
// Codex values. They govern the JS budgeting only: `max_output_tokens` is not sent.
export const CHATGPT_PRO_PROVIDER_MODEL_CONFIG: NexusProviderModelConfig = {
  providerId: 'chatgpt-pro',
  filterMode: 'curated',
  // The Codex backend (`OAuthProviderConfig::backend_base_url`,
  // oauth_providers.cc). The host's class keeps the same default.
  defaultBaseUrl: CHATGPT_PRO_BASE_URL,
  // The Responses codec (with the Codex-backend body rules) over `model.rawStream*`,
  // with the host's `{{oauth:…}}` values. Needs `model.rawStreamOpen.oauth` +
  // `.oauthOptional`.
  wire: CHATGPT_PRO_WIRE,
  // PDF input: page images. The Codex backend (chatgpt.com/backend-api/codex)
  // takes input_text / input_image only, no `input_file` — the host keeps a
  // document part as a "cannot be shown" marker there (openai_provider.cc
  // IsCodexBackend).
  documentInput: 'rasterize',
  // No `catalog`: its `openai` records would overstate the Codex windows. Tier
  // fields are family keys, so each follows its line's latest.
  fastModel: 'gpt-*-luna',
  // The two GPT-6 rows the Codex catalog lists: Astra is
  // OpenAI's "frontier intelligence for the most demanding work", Sol the
  // "workhorse model for coding and everyday work" — best and balanced.
  balancedModel: 'gpt-*-sol',
  bestModel: 'gpt-*-astra',
  // The ChatGPT-subscription (Codex) backend enforces a per-account
  // concurrency ceiling and silently HANGS over-quota SSE connections (no
  // bytes, no close), which wedged background sub-agents forever before the
  // C++ stream guard existed. Pin this provider to serial. Pushed to the C++
  // provider via `publishProviderConfigs`; a `maxConcurrentStreams` override
  // in settings.json still wins.
  maxConcurrentStreams: 1,
  // Reasoning tiers: `availableThinkingTiers` / `defaultThinkingTier` override live
  // discovery, and let the turn drop a stale persisted tier before the wire. FAMILY
  // rows speak for every version in `minVersion`..`maxVersion`; `model` is the
  // verified version, `versions` holds differences. A row without `family` is FIXED.
  models: [
    // `ultra` is rejected on this backend as a reasoning effort, so no row lists it;
    // `max` is accepted. `gpt-6-luna` has no row until the Codex catalog lists it.
    {
      family: 'gpt-*-astra',
      // Frontier tier. The Codex catalog's own default effort for Astra is
      // `low` (unlike the API's medium) — followed here, since this provider
      // IS the Codex backend. No `none`: Astra rejects it (see openai.ts).
      model: createOpenAiModelPattern('gpt-6-astra'),
      name: 'GPT-6 Astra',
      minVersion: '6',
      // Current-generation flagship/balanced tier — no TodoWrite (see
      // `todoTools` in ../types.ts).
      todoTools: false,
      defaultThinkingTier: 'low',
      availableThinkingTiers: ['low', 'medium', 'high', 'xhigh', 'max'],
      contextWindow: 272_000,
      defaultMaxOutputTokens: 32_000,
      maxOutputTokens: 128_000,
      compactionTriggerCharCount: 80_000,
      supportsStrictTools: true,
    },
    {
      family: 'gpt-*-sol',
      // Workhorse tier — coding and everyday work. GPT-5.6 Sol (complex
      // coding-agent work; live-verified: the Codex backend
      // returns default_reasoning_level=medium for Sol) reads the same row.
      model: createOpenAiModelPattern('gpt-6-sol'),
      name: 'GPT-6 Sol',
      minVersion: '5.6',
      // Current-generation flagship/balanced tier — no TodoWrite (see
      // `todoTools` in ../types.ts).
      todoTools: false,
      defaultThinkingTier: 'medium',
      availableThinkingTiers: ['low', 'medium', 'high', 'xhigh', 'max'],
      contextWindow: 272_000,
      defaultMaxOutputTokens: 32_000,
      maxOutputTokens: 128_000,
      compactionTriggerCharCount: 80_000,
      supportsStrictTools: true,
      versions: {
        '5.6': { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
      },
    },
    {
      family: 'gpt-*-terra',
      // Default — best cost/performance balance.
      model: createOpenAiModelPattern('gpt-5\\.6-terra'),
      name: 'GPT-5.6 Terra',
      minVersion: '5.6',
      // Current-generation flagship/balanced tier — no TodoWrite (see
      // `todoTools` in ../types.ts).
      todoTools: false,
      defaultThinkingTier: 'medium',
      availableThinkingTiers: ['low', 'medium', 'high', 'xhigh', 'max'],
      contextWindow: 272_000,
      defaultMaxOutputTokens: 32_000,
      maxOutputTokens: 128_000,
      compactionTriggerCharCount: 80_000,
      supportsStrictTools: true,
    },
    {
      family: 'gpt-*-luna',
      // Low-cost coding-subagent tier. Verified at 5.6: `gpt-6-luna` is not
      // in the Codex catalog yet; the row follows it when it is.
      model: createOpenAiModelPattern('gpt-5\\.6-luna'),
      name: 'GPT-5.6 Luna',
      minVersion: '5.6',
      defaultThinkingTier: 'medium',
      availableThinkingTiers: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      contextWindow: 272_000,
      defaultMaxOutputTokens: 32_000,
      maxOutputTokens: 128_000,
      compactionTriggerCharCount: 80_000,
      supportsStrictTools: true,
    },
    // An id retired here must be retired under every provider: a curated id dropped
    // in one place only stays selectable but unsendable.
  ],
}

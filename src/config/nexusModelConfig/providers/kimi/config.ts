import type { NexusProviderModelConfig } from '../../types'
import { createExactModelPattern } from '../../patterns'

// Context windows and K3's `maxOutputTokens` (131,072) come from the model catalog
// (F-28); the documented 1,048,576 maximum is not adopted (it equals the whole
// window). The `kimi-for-coding` rows keep a conservative 32K reservation; the
// `none` pill disables thinking.
export const KIMI_PROVIDER_MODEL_CONFIG: NexusProviderModelConfig = {
  providerId: 'kimi',
  filterMode: 'curated',
  // The Kimi Code endpoint — it serves every curated row above; the Moonshot
  // open platform (api.moonshot.cn) serves none of them.
  defaultBaseUrl: 'https://api.kimi.com/coding/v1',
  // Runs on a runtime ModelProvider: the Chat Completions codec — the same one
  // every OpenAI-compatible provider reuses — over `model.rawStream*`. The
  // host class stays for discovery, the key check and the blocking fallback;
  // `usage.ts` reads its document with this codec's auth.
  wire: { format: 'openai-chat' },
  // PDF input: Kimi's chat API takes `image_url`; files go through a separate upload API.
  documentInput: 'rasterize',
  // Figures a row leaves unset come from the catalog's Kimi Code records
  // (global, then China), then the open platform's.
  catalog: { keys: ['kimi-code-plan-global', 'kimi-code-plan-cn', 'moonshotai'] },
  fastModel: 'kimi-for-coding',
  balancedModel: 'kimi-for-coding',
  // Best names the K FAMILY and follows its latest; `kimi-for-coding` is the
  // vendor's own moving alias (K2.7 Code → K2.8 Preview) — a fixed id.
  bestModel: 'k*',
  // FAMILY rows (`family`, ../../types.ts): each speaks for every version of
  // its line inside `minVersion`..`maxVersion`, so the version the vendor
  // ships next — the `latest` the picker follows — reads the same figures
  // and flags with no edit here. `model` names the version the figures were
  // verified against; a version that differs states only its difference
  // under `versions` (`undefined` takes a field away). A row without
  // `family` is FIXED: one model, offered as itself, followed by nothing.
  models: [
    {
      family: 'k*',
      model: createExactModelPattern('k3'),
      name: 'K3',
      minVersion: '3',
      // Current-generation flagship/balanced tier — no TodoWrite (see
      // `todoTools` in ../types.ts).
      todoTools: false,
      // The page's documented default moved `max` → `high`.
      defaultThinkingTier: 'high',
      availableThinkingTiers: ['none', 'low', 'high', 'max'],
      defaultMaxOutputTokens: 64_000,
    },
    {
      family: 'k*-256k',
      // Same model as `k3`, served with a 256K window (the page lists it for
      // non-premium members). Same tier vocabulary and defaults as `k3`;
      // the output figures follow the K3 row for the same reason.
      model: createExactModelPattern('k3-256k'),
      name: 'K3 256K',
      minVersion: '3',
      // Current-generation flagship/balanced tier — no TodoWrite (see
      // `todoTools` in ../types.ts).
      todoTools: false,
      defaultThinkingTier: 'high',
      availableThinkingTiers: ['none', 'low', 'high', 'max'],
      defaultMaxOutputTokens: 64_000,
    },
    {
      // FIXED. K2.8 Preview ("performance approaching K3, higher thinking
      // efficiency"), 1M context, effort low/high/max with default `max`.
      model: createExactModelPattern('kimi-for-coding'),
      name: 'K2.8 Preview',
      // Current-generation flagship/balanced tier — no TodoWrite (see
      // `todoTools` in ../types.ts).
      todoTools: false,
      defaultThinkingTier: 'max',
      availableThinkingTiers: ['none', 'low', 'high', 'max'],
      defaultMaxOutputTokens: 32_000,
      maxOutputTokens: 32_000,
    },
    {
      // FIXED.
      model: createExactModelPattern('kimi-for-coding-highspeed'),
      name: 'K2.7 Code Highspeed', /* 6x speed, 3x consumption */
      // Current-generation flagship/balanced tier — no TodoWrite (see
      // `todoTools` in ../types.ts).
      todoTools: false,
      defaultMaxOutputTokens: 32_000,
      maxOutputTokens: 32_000,
    },
  ],
}

import type { NexusConfiguredModel, NexusProviderModelConfig } from '../../types'
import { createExactModelPattern } from '../../patterns'

function gemini4Row(id: string, name: string, tiers: string[], defaultTier: string): NexusConfiguredModel {
  return {
    model: createExactModelPattern(id.replace(/\./g, '\.')),
    name,
    contextWindow: 1_048_576,
    defaultMaxOutputTokens: 32_768,
    maxOutputTokens: 65_536,
    supportsImageInput: true,
    availableThinkingTiers: tiers,
    defaultThinkingTier: defaultTier,
    compactionTriggerCharCount: 200_000,
  }
}

// The FAMILY rows' context window, output cap and image input come from the model
// catalog (F-28). The preview rows keep their own figures.
export const GOOGLE_PROVIDER_MODEL_CONFIG: NexusProviderModelConfig = {
  providerId: 'google',
  filterMode: 'curated',
  defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  // Runs on a runtime ModelProvider: the Gemini codec (the JS twin of the host's
  // `GoogleProvider`, `streamGenerateContent?alt=sse`, the key in the
  // `x-goog-api-key` header) over `model.rawStream*`. The host class stays for
  // discovery and the key check.
  wire: { format: 'gemini' },
  // PDF input: Gemini `inlineData` with `application/pdf`.
  documentInput: 'native',
  // Figures a row leaves unset come from the catalog's `google` records, the
  // effort tiers included (`thinkingLevel`, ./reasoning.ts). The API's own
  // default level is `high`. 2.5 records state a token budget, not levels, so
  // those versions show no effort control.
  catalog: { keys: ['google'], thinkingTiers: true, defaultThinkingTier: 'high' },
  // Designated fast model for `queryFastModel`. Flash-Lite is the
  // smallest / cheapest entry in the stable 3.x line.
  // A family key: the fast tier follows the stable Flash-Lite line.
  fastModel: 'gemini-*-flash-lite',
  // GA ids only: Hydrogen is the fast, cost-efficient Gemini 4 model.
  balancedModel: 'gemini-4-hydrogen',
  // Carbon is the Gemini 4 frontier model for deep reasoning and agent work.
  bestModel: 'gemini-4-carbon',
  // FAMILY rows (`family`, ../../types.ts): each speaks for every version of
  // its line inside `minVersion`..`maxVersion`, so the version the vendor
  // ships next — the `latest` the picker follows — reads the same figures
  // and flags with no edit here. `model` names the version the figures were
  // verified against; a version that differs states only its difference
  // under `versions` (`undefined` takes a field away; `id` makes the
  // version a known one, offered without the provider listing it). A row without
  // `family` is FIXED: one model, offered as itself, followed by nothing.
  models: [
    {
      family: 'gemini-*-flash',
      // Verified: Gemini 3.8 Flash. The stable Flash line; each version
      // below has had the family figures since it shipped.
      model: createExactModelPattern('gemini-3\\.8-flash'),
      name: 'Gemini 3.8 Flash',
      minVersion: '2.5',
      defaultMaxOutputTokens: 32_768,
      compactionTriggerCharCount: 200_000,
      versions: {
        '3.7': { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash' },
        '3.6': { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash' },
        '3.5': { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
        '2.5': { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
      },
    },
    {
      family: 'gemini-*-flash-lite',
      model: createExactModelPattern('gemini-3\\.5-flash-lite'),
      name: 'Gemini 3.5 Flash-Lite',
      minVersion: '2.5',
      defaultMaxOutputTokens: 32_768,
      compactionTriggerCharCount: 200_000,
      versions: {
        '3.1': { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite' },
        '2.5': { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite' },
      },
    },
    {
      family: 'gemini-*-pro',
      // Verified: Gemini 2.5 Pro, the newest STABLE Pro (deprecated: the API
      // routes it to Gemini 3.8 Flash). The 3.x Pro preview
      // reads the fixed row below.
      model: createExactModelPattern('gemini-2\\.5-pro'),
      name: 'Gemini 2.5 Pro',
      minVersion: '2.5',
      defaultMaxOutputTokens: 32_768,
      compactionTriggerCharCount: 200_000,
    },
    // FIXED rows, Gemini 4: one stable model each, no version line. They
    // state their own figures and effort tiers, so a catalog that does not
    // list them yet changes nothing.
    gemini4Row('gemini-4-carbon', 'Gemini 4 Carbon', ['low', 'medium', 'high'], 'medium'),
    gemini4Row('gemini-4-argon', 'Gemini 4 Argon', ['low', 'medium', 'high'], 'medium'),
    gemini4Row('gemini-4-neon', 'Gemini 4 Neon', ['low', 'medium', 'high', 'xhigh'], 'high'),
    gemini4Row('gemini-4-hydrogen', 'Gemini 4 Hydrogen', ['low', 'medium', 'high', 'xhigh'], 'high'),
    // FIXED rows: the preview ids, matched by pattern (a fixed row answers
    // before its family's row). They are offered when the provider lists
    // them and are never a family's `latest`, which is stable-only. They keep
    // their figures: a pattern speaks for preview ids the catalog does not list.
    {
      model: /gemini-3\.1-pro(?:-preview(?:-[\w-]+)?)?/i,
      name: 'Gemini 3.1 Pro Preview',
      contextWindow: 1_048_576,
      defaultMaxOutputTokens: 32_768,
      maxOutputTokens: 65_536,
      compactionTriggerCharCount: 200_000,
    },
    {
      model: /gemini-3-flash(?:-preview(?:-[\w-]+)?)?/i,
      name: 'Gemini 3 Flash Preview',
      contextWindow: 1_048_576,
      defaultMaxOutputTokens: 32_768,
      maxOutputTokens: 65_536,
      compactionTriggerCharCount: 200_000,
    },
  ],
}

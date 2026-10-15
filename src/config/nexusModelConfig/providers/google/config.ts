import type { NexusProviderModelConfig } from '../../types'
import { createExactModelPattern } from '../../patterns'

// The FAMILY rows' context window, output cap and image input come from the model
// catalog (F-28). The preview rows keep their own figures.
export const GOOGLE_PROVIDER_MODEL_CONFIG: NexusProviderModelConfig = {
  providerId: 'google',
  filterMode: 'curated',
  defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  // Runs on a runtime ModelProvider: the Gemini codec (the JS twin of the host's
  // `GoogleProvider`, `streamGenerateContent?alt=sse`, the key in the `key`
  // query parameter) over `model.rawStream*`. The host class stays for
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
  // GA ids only. That once meant the 2.5 family, because every
  // 3.x row was a preview-suffix pattern with no stable id to pin. The
  // stable Flash line lifts that for the two lower tiers, and each of them
  // moves WITHIN its own tier — Flash-Lite to Flash-Lite, Flash to Flash —
  // so those are generational refreshes, not a re-ranking.
  balancedModel: 'gemini-3.6-flash',
  // The Pro FAMILY: `latest` is the newest STABLE version, so the best tier stays on
  // the newest GA Pro while newer Pro versions are preview-only.
  bestModel: 'gemini-*-pro',
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
      // Current-generation flagship/balanced tier — no TodoWrite (see
      // `todoTools` in ../types.ts).
      todoTools: false,
      defaultMaxOutputTokens: 32_000,
      compactionTriggerCharCount: 200_000,
      versions: {
        '3.7': { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash' },
        '3.6': { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash' },
        // 3.5 and 2.5 Flash keep the todo tools.
        '3.5': { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', todoTools: undefined },
        '2.5': { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', todoTools: undefined },
      },
    },
    {
      family: 'gemini-*-flash-lite',
      model: createExactModelPattern('gemini-3\\.5-flash-lite'),
      name: 'Gemini 3.5 Flash-Lite',
      minVersion: '2.5',
      defaultMaxOutputTokens: 32_000,
      compactionTriggerCharCount: 200_000,
      versions: {
        '2.5': { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite' },
      },
    },
    {
      family: 'gemini-*-pro',
      // Verified: Gemini 2.5 Pro, the newest STABLE Pro. The 3.x Pro previews
      // read the fixed row below; a stable 3.x Pro, when it ships, reads this.
      model: createExactModelPattern('gemini-2\\.5-pro'),
      name: 'Gemini 2.5 Pro',
      minVersion: '2.5',
      defaultMaxOutputTokens: 32_000,
      compactionTriggerCharCount: 200_000,
    },
    // FIXED rows: the preview ids, matched by pattern (a fixed row answers
    // before its family's row). They are offered when the provider lists
    // them and are never a family's `latest`, which is stable-only. They keep
    // their figures: a pattern speaks for preview ids the catalog does not
    // list (`gemini-3-pro-preview`, `gemini-3-flash-lite-preview`).
    {
      model: /gemini-3(?:\.1)?-pro(?:-preview(?:-[\w-]+)?)?/i,
      name: 'Gemini 3.1 Pro Preview',
      // Current-generation flagship/balanced tier — no TodoWrite (see
      // `todoTools` in ../types.ts).
      todoTools: false,
      contextWindow: 1_048_576,
      defaultMaxOutputTokens: 32_000,
      maxOutputTokens: 65_536,
      compactionTriggerCharCount: 200_000,
    },
    {
      model: /gemini-3-flash(?:-preview(?:-[\w-]+)?)?/i,
      name: 'Gemini 3 Flash Preview',
      contextWindow: 1_048_576,
      defaultMaxOutputTokens: 32_000,
      maxOutputTokens: 65_536,
      compactionTriggerCharCount: 200_000,
    },
    {
      model: /gemini-3(?:\.1)?-flash-lite(?:-preview(?:-[\w-]+)?)?/i,
      name: 'Gemini 3.1 Flash-Lite Preview',
      contextWindow: 1_048_576,
      defaultMaxOutputTokens: 32_000,
      maxOutputTokens: 65_536,
      compactionTriggerCharCount: 200_000,
    },
  ],
}

import type { NexusProviderModelConfig } from '../../types'
import { createAnthropicModelPattern } from '../../patterns'

// Context window, output cap and image input come from the model catalog (F-28); a
// row states a figure only to differ. `promptProfile: 'lean'` is opt-in per row.
// `defaultMaxOutputTokens` is the initial-request value per tier; the turn loop
// escalates to `maxOutputTokens` on `stop_reason: 'max_tokens'`.
export const ANTHROPIC_PROVIDER_MODEL_CONFIG: NexusProviderModelConfig = {
  providerId: 'anthropic',
  filterMode: 'curated',
  defaultBaseUrl: 'https://api.anthropic.com',
  // Runs on a runtime ModelProvider: the Messages codec over
  // `model.rawStream*`. The host class stays for discovery, the key check
  // and the blocking fallback.
  wire: { format: 'anthropic-messages' },
  // PDF input: Messages API `document` block (base64 PDF).
  documentInput: 'native',
  // Figures a row leaves unset come from the catalog's `anthropic` records.
  catalog: { keys: ['anthropic'] },
  // FAMILY rows: each speaks for every version from `minVersion` up, flags
  // included; `model` is the verified version, `versions` holds differences, and
  // `maxVersion` caps a row whose contract a new version breaks. Tier fields name
  // families too.
  fastModel: 'claude-haiku-*',
  balancedModel: 'claude-sonnet-*',
  bestModel: 'claude-fable-*',
  models: [
    {
      family: 'claude-fable-*',
      // Verified: Fable 5.1. Fable 5 reads the same row.
      model: createAnthropicModelPattern('claude-fable-5-1'),
      name: 'Fable 5.1',
      minVersion: '5',
      // Trained on the lean prompt.
      promptProfile: 'lean',
      // Plans and tracks long work unaided — no TodoWrite (see `todoTools` in
      // ../types.ts).
      todoTools: false,
      // Thinking is always on for the Fable line (the legacy
      // `enabled`/`disabled` shapes both 400); adaptive + effort is the only
      // accepted shape. The default is the API's own default effort, `high`
      // (changed from `xhigh` at the user's call); `xhigh`
      // stays one pick away.
      defaultThinkingTier: 'high',
      availableThinkingTiers: ['low', 'medium', 'high', 'extra-high', 'max'],
      defaultMaxOutputTokens: 64_000,
      compactionTriggerCharCount: 200_000,
      supportsStrictTools: true,
      versions: {
        '5': { id: 'claude-fable-5', name: 'Fable 5' },
      },
    },
    {
      family: 'claude-opus-*',
      // Verified: Opus 5.5 — Anthropic's recommended default for most
      // workloads (model overview): "start with Claude Opus 5.5".
      // Opus-tier: 1M context, 128K output cap, adaptive thinking always on
      // (effort is the only control — `low`…`max`), API default effort
      // `medium`, which is what we send.
      model: createAnthropicModelPattern('claude-opus-5-5'),
      name: 'Opus 5.5',
      // The lean-prompt line starts at 4.8 — where the old
      // `claude-opus-4(?:-[0-7])?` standard regex drew it. 4.6 and 4.7
      // (2026, still served) read this row's figures but take back the
      // lean prompt and the todo opt-out under `versions`. Older is not
      // this row's (Opus 4.5 is extended-thinking only).
      minVersion: '4.6',
      // Trained on the lean prompt.
      promptProfile: 'lean',
      // Plans and tracks long work unaided — no TodoWrite (see `todoTools` in
      // ../types.ts).
      todoTools: false,
      defaultThinkingTier: 'medium',
      availableThinkingTiers: ['low', 'medium', 'high', 'extra-high', 'max'],
      defaultMaxOutputTokens: 64_000,
      compactionTriggerCharCount: 200_000,
      supportsStrictTools: true,
      versions: {
        // Legacy but still served (model overview's "Legacy models (still
        // available)" list). Their API default effort is `high`.
        '5': { id: 'claude-opus-5', name: 'Opus 5', defaultThinkingTier: 'high' },
        '4.8': { id: 'claude-opus-4-8', name: 'Opus 4.8', defaultThinkingTier: 'high' },
        // Opus 4.7 and 4.6: 1M context, 128K
        // output, adaptive thinking, API default `high` (their model pages). 4.6 has `max` but no `xhigh` (effort doc: "Not
        // every model that supports `max` supports `xhigh`").
        '4.7': {
          id: 'claude-opus-4-7',
          name: 'Opus 4.7',
          defaultThinkingTier: 'high',
          promptProfile: undefined,
          todoTools: undefined,
        },
        '4.6': {
          id: 'claude-opus-4-6',
          name: 'Opus 4.6',
          defaultThinkingTier: 'high',
          availableThinkingTiers: ['low', 'medium', 'high', 'max'],
          promptProfile: undefined,
          todoTools: undefined,
        },
      },
    },
    {
      family: 'claude-sonnet-*',
      // Verified: Sonnet 5.5 (model page read): 1M context, 128K output, adaptive thinking, all five
      // efforts, API default `high` — Sonnet 5's figures. Its breaking
      // changes need no host change, as for Opus 5.5 above (forced
      // `tool_choice` 400s — the host sends `auto`; thinking blocks bound to
      // the model; the host never sends non-default sampling params).
      model: createAnthropicModelPattern('claude-sonnet-5-5'),
      name: 'Sonnet 5.5',
      // Sonnet 5 is the first Sonnet with `xhigh` and without the todo
      // tools; Sonnet 4.6 (still served) states its difference
      // under `versions`. Sonnet 4.5 and older are not this row's.
      minVersion: '4.6',
      // Sonnet and Haiku get the long sectioned prompt.
      promptProfile: 'standard',
      // Plans and tracks long work unaided — no TodoWrite (see `todoTools` in
      // ../types.ts).
      todoTools: false,
      // Default stays at `high` (the API default) per the migration guide.
      defaultThinkingTier: 'high',
      availableThinkingTiers: ['low', 'medium', 'high', 'extra-high', 'max'],
      defaultMaxOutputTokens: 32_000,
      compactionTriggerCharCount: 200_000,
      supportsStrictTools: true,
      versions: {
        '5': { id: 'claude-sonnet-5', name: 'Sonnet 5' },
        // 1M / 128K, adaptive, default `high`; `max` but no `xhigh`.
        '4.6': {
          id: 'claude-sonnet-4-6',
          name: 'Sonnet 4.6',
          availableThinkingTiers: ['low', 'medium', 'high', 'max'],
          todoTools: undefined,
        },
      },
    },
    {
      family: 'claude-haiku-*',
      model: createAnthropicModelPattern('claude-haiku-4-5'),
      name: 'Haiku 4.5',
      minVersion: '4.5',
      promptProfile: 'standard',
      defaultMaxOutputTokens: 32_000,
      compactionTriggerCharCount: 40_000,
      supportsStrictTools: true,
    },
  ],
}

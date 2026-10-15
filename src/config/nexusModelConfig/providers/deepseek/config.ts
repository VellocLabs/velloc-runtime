import type { NexusProviderModelConfig } from '../../types'
import { createExactModelPattern } from '../../patterns'

// Context window and output cap come from the model catalog (F-28). Thinking is
// surfaced as tier pills: `reasoning_effort` rejects `none`, so the `none` pill
// becomes `thinking.type: disabled` (`buildThinkingBodyExtension`).
export const DEEPSEEK_PROVIDER_MODEL_CONFIG: NexusProviderModelConfig = {
  providerId: 'deepseek',
  filterMode: 'curated',
  defaultBaseUrl: 'https://api.deepseek.com',
  // Runs on a runtime ModelProvider: the Chat Completions codec every
  // OpenAI-compatible provider reuses (the host built this one as an
  // `OpenAiProvider` on chat/completions), over `model.rawStream*`. The host
  // class stays for discovery and the key check.
  wire: { format: 'openai-chat' },
  // PDF input: No document part on the DeepSeek chat API; images on V4.1 Flash only.
  documentInput: 'rasterize',
  // Figures a row leaves unset come from the catalog's `deepseek` records.
  catalog: { keys: ['deepseek'] },
  // Designated fast model for `queryFastModel`. `deepseek-flash` is the
  // cheaper/faster of the two models — same role haiku/nano play elsewhere.
  // Moved off `deepseek-v4-flash`: Flash to Flash, a
  // within-tier generational refresh.
  fastModel: 'deepseek-flash',
  // Two-model catalog: flash doubles as the balanced pick.
  balancedModel: 'deepseek-flash',
  // The Pro line by family: best follows its latest. Flash has no version in
  // its id (`deepseek-flash` is the vendor's own moving alias) — a fixed id.
  bestModel: 'deepseek-v*-pro',
  // FAMILY rows (`family`, ../../types.ts): each speaks for every version of
  // its line inside `minVersion`..`maxVersion`, so the version the vendor
  // ships next — the `latest` the picker follows — reads the same figures
  // and flags with no edit here. `model` names the version the figures were
  // verified against; a version that differs states only its difference
  // under `versions` (`undefined` takes a field away). A row without
  // `family` is FIXED: one model, offered as itself, followed by nothing.
  models: [
    {
      family: 'deepseek-v*-pro',
      model: createExactModelPattern('deepseek-v4-pro'),
      name: 'V4 Pro',
      minVersion: '4',
      // Current-generation flagship/balanced tier — no TodoWrite (see
      // `todoTools` in ../types.ts).
      todoTools: false,
      defaultThinkingTier: 'high',
      availableThinkingTiers: ['none', 'low', 'high', 'max'],
      defaultMaxOutputTokens: 32_000,
      // Text-only: the pricing table's Vision column says "Not supported"
      // for V4 Pro (api-docs.deepseek.com/quick_start/pricing); only the
      // Flash row takes images.
      supportsImageInput: false,
    },
    {
      // FIXED. DeepSeek-V4.1-Flash. Takes image input (JPEG/PNG/GIF/WebP as
      // `image_url` content parts in user messages — the vision guide), so `supportsImageInput` stays at its default.
      model: createExactModelPattern('deepseek-flash'),
      name: 'V4.1 Flash',
      defaultThinkingTier: 'high',
      availableThinkingTiers: ['none', 'low', 'high', 'max'],
      defaultMaxOutputTokens: 32_000,
    },
  ],
}

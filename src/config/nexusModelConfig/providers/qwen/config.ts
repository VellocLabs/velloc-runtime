import type { NexusProviderModelConfig } from '../../types'
import { createExactModelPattern } from '../../patterns'

// Context window, output cap and image input come from the model catalog (F-28);
// rows keep 16K as the first-request reservation. Rows without
// `availableThinkingTiers` send no thinking params (a wrong tier set 400s).
export const QWEN_PROVIDER_MODEL_CONFIG: NexusProviderModelConfig = {
  providerId: 'qwen',
  filterMode: 'curated',
  defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  // Runs on a runtime ModelProvider: the Chat Completions codec every
  // OpenAI-compatible provider reuses (the host built this one as an
  // `OpenAiProvider` on chat/completions), over `model.rawStream*`. The host
  // class stays for discovery and the key check.
  wire: { format: 'openai-chat' },
  // PDF input: DashScope compatible-mode: `image_url` parts, no document part.
  documentInput: 'rasterize',
  // Figures a row leaves unset come from the catalog: DashScope China's
  // records (this provider's base URL), then the international ones. A row
  // states a figure only where the vendor's page differs from the catalog.
  catalog: { keys: ['alibaba-cn', 'alibaba'] },
  // Designated fast model for `queryFastModel` — the Flash row of the
  // current generation, the same role haiku/nano play elsewhere. Moved off
  // `qwen3.6-flash`: Flash to Flash, a within-tier
  // generational refresh. (This comment used to name `qwen-turbo`, a model
  // this catalog has never carried.)
  fastModel: 'qwen*-flash',
  balancedModel: 'qwen3.7-max',
  // Fast and best name families and follow their latest. Balanced is the
  // PREVIOUS Max, a version of the same family as best — a fixed id, or it
  // would collapse into best.
  bestModel: 'qwen*-max',
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
      family: 'qwen*-max',
      model: createExactModelPattern('qwen3\\.8-max'),
      name: '3.8 Max',
      minVersion: '3.7',
      // Current-generation flagship/balanced tier — no TodoWrite (see
      // `todoTools` in ../types.ts).
      todoTools: false,
      defaultMaxOutputTokens: 16_384,
      compactionTriggerCharCount: 60_000,
      defaultThinkingTier: 'max',
      // NO `none` pill: the DashScope / token-plan gateway RESTRICTS
      // `enable_thinking` to True for this model (live-verified
      // against token-plan.cn-beijing.maas.aliyuncs.com: `enable_thinking:
      // false` → HTTP 400 "The value of the enable_thinking parameter is
      // restricted to True."). Thinking cannot be turned off; a stale
      // persisted `none` tier is dropped by the deps.ts `availableTiers`
      // gate (no thinking params go out, which the endpoint accepts).
      availableThinkingTiers: ['max'],
      supportsStrictTools: true,
      versions: {
        // 3.7 Max: no tier set — it has not been probed, and without the
        // field no thinking params are sent, which every model on this
        // gateway accepts. The floating alias equals
        // qwen3.7-max-2026-05-20, Text only. NOTE
        // alias drift: the 06-08 snapshot IS Image/Text/Video.
        // Output cap: 131,072 per its model page (alibabacloud.com/help/en/
        // model-studio/qwen3-7-max, "Max Output Length 131072", verified);
        // the catalog's DashScope China record says 65,536.
        '3.7': { id: 'qwen3.7-max', name: '3.7 Max', defaultThinkingTier: undefined, availableThinkingTiers: undefined, maxOutputTokens: 131_072 },
      },
    },
    {
      family: 'qwen*-flash',
      model: createExactModelPattern('qwen3\\.8-flash'),
      name: '3.8 Flash',
      minVersion: '3.6',
      defaultMaxOutputTokens: 16_384,
      compactionTriggerCharCount: 60_000,
      versions: {
        '3.6': { id: 'qwen3.6-flash', name: '3.6 Flash' },
      },
    },
    {
      family: 'qwen*-plus',
      model: createExactModelPattern('qwen3\\.7-plus'),
      name: '3.7 Plus',
      minVersion: '3.7',
      defaultMaxOutputTokens: 16_384,
      // 131,072 per its model page (alibabacloud.com/help/en/model-studio/
      // qwen3-7-plus, "Max Output Length 131072"); the
      // catalog's DashScope China record says 64,000.
      maxOutputTokens: 131_072,
      compactionTriggerCharCount: 60_000,
      supportsStrictTools: true,
    },
  ],
}

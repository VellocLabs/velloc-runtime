import type { NexusProviderModelConfig } from '../../types'
import { createExactModelPattern } from '../../patterns'

// Context window and output cap come from the model catalog (F-28); a row states a
// figure only to differ. GLM-4.6 keeps its own 200,000 window (the catalog's
// 204,800 exceeds the model's position limit).
export const GLM_PROVIDER_MODEL_CONFIG: NexusProviderModelConfig = {
  providerId: 'glm',
  filterMode: 'curated',
  defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  // Runs on a runtime ModelProvider: the Chat Completions codec every
  // OpenAI-compatible provider reuses (the host built this one as an
  // `OpenAiProvider` on chat/completions), over `model.rawStream*`. The host
  // class stays for discovery and the key check.
  wire: { format: 'openai-chat' },
  // PDF input: Z.AI chat API: `image_url` on vision rows, no document part.
  documentInput: 'rasterize',
  // Figures a row leaves unset come from the catalog: the open platform's
  // records first, then the international and the coding-plan ones.
  catalog: { keys: ['zhipuai', 'zai', 'zhipuai-coding-plan', 'zai-coding-plan'] },
  // Designated fast model for `queryFastModel`. Moved off `glm-4-flash`
  // the legacy GLM-4.x rows cap at 4K output — unfit for
  // sub-agent work — and 5.3-Flash is the Flash row of the current line, so
  // this is a within-tier generational refresh.
  fastModel: 'glm-*-flash',
  // Both upper tiers used to share glm-4.6, because it was the only row
  // with a usable output cap. The 5.x line gives them distinct targets for
  // the first time: 5.3 is the current flagship, 5.2 the previous one.
  balancedModel: 'glm-5.2',
  // Fast and best name families and follow their latest. Balanced is the
  // PREVIOUS flagship, a version of the same family as best — a fixed id,
  // or it would collapse into best.
  bestModel: 'glm-*',
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
      family: 'glm-*',
      // Verified: GLM-5.3. Reasoning is ALWAYS on and cannot be disabled;
      // the effort knob is `low` / `high` / `max` (default `max`) — note
      // there is no `medium`. No tier affordance is surfaced: this provider
      // has no branch in `thinkingTierParams`, so no thinking params go out
      // and the model's own default applies. Surfacing the three levels
      // needs that branch first.
      model: createExactModelPattern('glm-5\\.3'),
      name: 'GLM-5.3',
      minVersion: '4',
      // Current-generation flagship/balanced tier — no TodoWrite (see
      // `todoTools` in ../types.ts).
      todoTools: false,
      defaultMaxOutputTokens: 32_000,
      supportsStrictTools: true,
      // Text-only per its model page, like every plain GLM row.
      supportsImageInput: false,
      versions: {
        // Previous flagship, still served. Same figures.
        '5.2': { id: 'glm-5.2', name: 'GLM-5.2' },
        // GLM-4.6: 200K context, 128K output (the catalog's 131,072). Hybrid thinking on by default
        // at the model level, with only a binary `thinking.type` toggle — no
        // effort gradient to surface. Honours `strict: true` (Z.AI developer
        // docs). Text-only (docs.z.ai/guides/llm/glm-4.6). Keeps the todo tools.
        '4.6': { id: 'glm-4.6', name: 'GLM-4.6', todoTools: undefined, contextWindow: 200_000 },
        // GLM-4: legacy, 4K output, no strict tools. Input modality: text
        // (docs.bigmodel.cn GLM-4 family page).
        '4': {
          id: 'glm-4',
          name: 'GLM-4',
          todoTools: undefined,
          contextWindow: 128_000,
          defaultMaxOutputTokens: 4_096,
          maxOutputTokens: 4_096,
          supportsStrictTools: undefined,
        },
      },
    },
    {
      family: 'glm-*-flash',
      // Verified: GLM-5.3 Flash — the one GLM-5 row that takes image input
      // (`type: image_url`, URL or base64 data URL). `thinking.type` accepts
      // only `enabled` here — thinking cannot be turned off.
      model: createExactModelPattern('glm-5\\.3-flash'),
      name: 'GLM-5.3 Flash',
      minVersion: '4',
      defaultMaxOutputTokens: 32_000,
      supportsStrictTools: true,
      versions: {
        // GLM-4 Flash: legacy, text-only, 4K output, no strict tools.
        '4': {
          id: 'glm-4-flash',
          name: 'GLM-4 Flash',
          contextWindow: 128_000,
          defaultMaxOutputTokens: 4_096,
          maxOutputTokens: 4_096,
          supportsStrictTools: undefined,
          supportsImageInput: false,
        },
      },
    },
    {
      family: 'glm-*-plus',
      model: createExactModelPattern('glm-4-plus'),
      name: 'GLM-4 Plus',
      minVersion: '4',
      contextWindow: 128_000,
      defaultMaxOutputTokens: 4_096,
      maxOutputTokens: 4_096,
      supportsImageInput: false,
    },
    {
      family: 'glm-*-air',
      model: createExactModelPattern('glm-4-air'),
      name: 'GLM-4 Air',
      minVersion: '4',
      contextWindow: 131_072,
      defaultMaxOutputTokens: 4_096,
      maxOutputTokens: 8_192,
      supportsImageInput: false,
    },
    {
      // FIXED (its id reads as no version). GLM-4V Plus is the one vision
      // row in this catalog (image + video input via URL or base64 per the
      // BigModel API reference) — `supportsImageInput`
      // stays at its default (true).
      model: createExactModelPattern('glm-4v-plus'),
      name: 'GLM-4V Plus',
      contextWindow: 8_192,
      defaultMaxOutputTokens: 1_024,
      maxOutputTokens: 1_024,
    },
  ],
}

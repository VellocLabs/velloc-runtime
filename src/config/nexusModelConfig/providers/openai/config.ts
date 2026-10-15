import type { NexusProviderModelConfig } from '../../types'
import { createOpenAiModelPattern } from '../../patterns'

// Curated OpenAI API lineup. Context window, output cap and image input come from
// the model catalog (F-28). Effort vocabulary per model: GPT-6 Astra has no `none`,
// GPT-5.5 Pro only the top three efforts.
export const OPENAI_PROVIDER_MODEL_CONFIG: NexusProviderModelConfig = {
  providerId: 'openai',
  filterMode: 'curated',
  defaultBaseUrl: 'https://api.openai.com/v1',
  // Runs on a runtime ModelProvider: the Responses codec (the wire the host's
  // OpenAiProvider speaks for `openai`) over `model.rawStream*`. The host
  // class stays for discovery, the key check and the blocking fallback.
  wire: { format: 'openai-responses' },
  // PDF input: Chat Completions `file` part / Responses `input_file` — official endpoint
  // only; `resolveDocumentInputMode` drops a relayed base URL to `rasterize`.
  documentInput: 'native',
  // Figures a row leaves unset come from the catalog's `openai` records.
  catalog: { keys: ['openai'] },
  // FAMILY rows (GPT-5.5 Pro stays FIXED). The tier ladder names families: fast =
  // Luna, balanced = Sol, best = Astra; not gpt-5.5-pro (restricted effort set).
  fastModel: 'gpt-*-luna',
  balancedModel: 'gpt-*-sol',
  bestModel: 'gpt-*-astra',
  models: [
    {
      family: 'gpt-*-astra',
      // Most capable — complex reasoning, computer use, research. $10/$50;
      // NOTE inputs past 272K tokens bill at 2x input / 1.5x output, which
      // the compaction trigger below keeps a typical session well under.
      model: createOpenAiModelPattern('gpt-6-astra'),
      name: 'GPT-6 Astra',
      minVersion: '6',
      // Current-generation flagship/balanced tier — no TodoWrite (see
      // `todoTools` in ../types.ts).
      todoTools: false,
      defaultThinkingTier: 'medium',
      // No `none`: Astra rejects it with HTTP 400 (reasoning guide). A stale persisted `none` from another row is dropped by
      // the deps.ts `availableTiers` gate before it reaches the wire.
      availableThinkingTiers: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultMaxOutputTokens: 32_000,
      compactionTriggerCharCount: 80_000,
      supportsStrictTools: true,
    },
    {
      family: 'gpt-*-sol',
      // Workhorse — coding and agentic workflows. Verified: GPT-6.1 Sol
      // ("near-Astra performance … at a lower cost"; model page read):
      // 1.05M context, 128K output, efforts `low`…`max`,
      // default `medium` — and like Astra NO `none` ("'none' and 'minimal'
      // reasoning efforts are not supported"). GPT-6 Sol and GPT-5.6 Sol
      // (still served) keep `none` under `versions`.
      model: createOpenAiModelPattern('gpt-6\\.1-sol'),
      name: 'GPT-6.1 Sol',
      minVersion: '5.6',
      // Current-generation flagship/balanced tier — no TodoWrite (see
      // `todoTools` in ../types.ts).
      todoTools: false,
      defaultThinkingTier: 'medium',
      availableThinkingTiers: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultMaxOutputTokens: 32_000,
      compactionTriggerCharCount: 80_000,
      supportsStrictTools: true,
      versions: {
        '6': {
          id: 'gpt-6-sol',
          name: 'GPT-6 Sol',
          availableThinkingTiers: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        },
        '5.6': {
          id: 'gpt-5.6-sol',
          name: 'GPT-5.6 Sol',
          availableThinkingTiers: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        },
      },
    },
    {
      family: 'gpt-*-luna',
      // Fast / low-cost — repeatable work at scale. $0.10/$0.50. GPT-5.6
      // Luna reads the same row.
      model: createOpenAiModelPattern('gpt-6-luna'),
      name: 'GPT-6 Luna',
      minVersion: '5.6',
      defaultThinkingTier: 'medium',
      availableThinkingTiers: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultMaxOutputTokens: 32_000,
      compactionTriggerCharCount: 80_000,
      supportsStrictTools: true,
      versions: {
        '5.6': { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
      },
    },
    {
      family: 'gpt-*-terra',
      // GPT-5.6 Terra — best cost/performance balance of the previous
      // generation, still served; no GPT-6 Terra exists yet.
      model: createOpenAiModelPattern('gpt-5\\.6-terra'),
      name: 'GPT-5.6 Terra',
      minVersion: '5.6',
      // Current-generation flagship/balanced tier — no TodoWrite (see
      // `todoTools` in ../types.ts).
      todoTools: false,
      defaultThinkingTier: 'medium',
      availableThinkingTiers: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultMaxOutputTokens: 32_000,
      compactionTriggerCharCount: 80_000,
      supportsStrictTools: true,
    },
    {
      family: 'gpt-*',
      // The un-suffixed GPT line. Verified: GPT-5.5 (snapshot
      // gpt-5.5-2026-04-23; model page read): 1.05M context,
      // 128K output, efforts `none`…`xhigh` (no `max`), default `medium`.
      // GPT-5.4 has the same figures but defaults to `none`.
      // Older (5.2 and before) is not this row's.
      model: createOpenAiModelPattern('gpt-5\\.5'),
      name: 'GPT-5.5',
      minVersion: '5.4',
      defaultThinkingTier: 'medium',
      availableThinkingTiers: ['none', 'low', 'medium', 'high', 'xhigh'],
      defaultMaxOutputTokens: 32_000,
      compactionTriggerCharCount: 80_000,
      supportsStrictTools: true,
      versions: {
        '5.4': { id: 'gpt-5.4', name: 'GPT-5.4', defaultThinkingTier: 'none' },
      },
    },
    {
      family: 'gpt-*-mini',
      // GPT-5.4 mini (snapshot gpt-5.4-mini-2026-03-17; model page read):
      // 400K context, 128K output, efforts `none`…`xhigh`,
      // default `none`. GPT-5 mini (2025) is not this row's.
      model: createOpenAiModelPattern('gpt-5\\.4-mini'),
      name: 'GPT-5.4 mini',
      minVersion: '5.4',
      defaultThinkingTier: 'none',
      availableThinkingTiers: ['none', 'low', 'medium', 'high', 'xhigh'],
      defaultMaxOutputTokens: 32_000,
      compactionTriggerCharCount: 80_000,
      supportsStrictTools: true,
    },
    {
      // FIXED. GPT-5.4 Pro (model page read): 1.05M
      // context, 128K output (catalog figures), efforts `medium` (default), `high`, `xhigh`.
      model: createOpenAiModelPattern('gpt-5\\.4-pro'),
      name: 'GPT-5.4 Pro',
      defaultThinkingTier: 'medium',
      availableThinkingTiers: ['medium', 'high', 'xhigh'],
      defaultMaxOutputTokens: 32_000,
      compactionTriggerCharCount: 80_000,
      supportsStrictTools: true,
    },
    {
      // FIXED. Manual advanced mode only. GPT-5.5 Pro is the strictest of
      // the family — only the top-three efforts are accepted. OpenAI:
      // "Supported values are: 'medium', 'high', and 'xhigh'." (No `none` /
      // `low` / `minimal`, so users can't dial reasoning down on this tier.)
      model: createOpenAiModelPattern('gpt-5\\.5-pro'),
      name: 'GPT-5.5 Pro',
      // Current-generation flagship/balanced tier — no TodoWrite (see
      // `todoTools` in ../types.ts).
      todoTools: false,
      defaultThinkingTier: 'high',
      availableThinkingTiers: ['medium', 'high', 'xhigh'],
      defaultMaxOutputTokens: 32_000,
      compactionTriggerCharCount: 80_000,
      supportsStrictTools: true,
    },
  ],
}
